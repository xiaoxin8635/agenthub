"""评测服务：逐条算分（托管/回传共用）与 Run 聚合。"""
import statistics

from sqlalchemy.orm import Session

from agenthub.db.models import Asset, DatasetItem, DatasetVersion, EvalResult, EvalRun
from agenthub.metrics import MetricError, get_metric
from agenthub.metrics.turn_eval import evaluate_with_turn_scope


def evaluate_item(metric_specs: list[dict], item: dict, output: dict) -> tuple[dict, bool | None, str]:
    """对单个 item 执行全部指标。返回 (scores, passed, error)。

    scores = {"<type>": {"score": x, "detail": str, "passed": bool|None}, ...}
    passed = 所有可判指标均通过（N/A 忽略）；全部 N/A → None。
    spec.turn_scope 支持 multi_turn 逐轮评估（默认/last/each，见 metrics.turn_eval）。
    """
    scores: dict = {}
    passed_flags: list[bool] = []
    error = ""
    for spec in metric_specs:
        mtype = spec.get("type", "")
        try:
            ms = evaluate_with_turn_scope(get_metric(mtype), item, output, spec)
            scores[mtype] = ms.as_dict()
            if ms.passed is not None:
                passed_flags.append(ms.passed)
        except MetricError as e:
            scores[mtype] = {"score": None, "detail": f"metric error: {e}", "passed": None}
            error = error or f"{mtype}: {e}"
    passed = all(passed_flags) if passed_flags else None
    return scores, passed, error


def compute_summary(metric_specs: list[dict], results: list[EvalResult]) -> dict:
    """聚合 summary：逐指标 avg/pass_rate/n + 加权总分。"""
    per_metric: dict[str, dict] = {}
    weights: dict[str, float] = {}
    for spec in metric_specs:
        mtype = spec.get("type", "?")
        per_metric.setdefault(mtype, {"scores": [], "passed": 0, "judged": 0})
        weights[mtype] = float(spec.get("weight", 1))

    total = len(results)
    passed_count = 0
    for r in results:
        for mtype, s in (r.scores or {}).items():
            if mtype not in per_metric:
                continue
            if s.get("score") is not None:
                per_metric[mtype]["scores"].append(float(s["score"]))
            if s.get("passed") is not None:
                per_metric[mtype]["judged"] += 1
                per_metric[mtype]["passed"] += 1 if s["passed"] else 0
        if r.passed is True:
            passed_count += 1

    summary: dict = {"total": total, "passed": passed_count, "pass_rate": round(passed_count / total, 4) if total else None}
    metrics_out: dict = {}
    weighted_num, weighted_den = 0.0, 0.0
    for mtype, agg in per_metric.items():
        entry: dict = {"weight": weights[mtype]}
        if agg["scores"]:
            avg = statistics.fmean(agg["scores"])
            entry["avg"] = round(avg, 4)
            entry["pass_rate"] = round(agg["passed"] / agg["judged"], 4) if agg["judged"] else None
            entry["n"] = len(agg["scores"])
            weighted_num += avg * weights[mtype]
            weighted_den += weights[mtype]
        else:
            entry["avg"] = None
            entry["n"] = 0
        metrics_out[mtype] = entry
    summary["metrics"] = metrics_out
    summary["weighted_total"] = round(weighted_num / weighted_den, 4) if weighted_den else None
    return summary


def finalize_run(db: Session, run: EvalRun) -> EvalRun:
    """重算 summary 并落库（回传模式收齐 / 托管跑完时调用）。"""
    db.refresh(run)
    if run.status == "canceled":
        return run  # 已被用户取消：保留终态，禁止后台线程聚合覆盖
    mc = run.metric_config
    results = db.query(EvalResult).filter(EvalResult.run_id == run.id).all()
    summary = compute_summary(mc.metrics if mc else [], results)
    # 失败项 tag 分布（仪表盘/Run 详情的失败构成图）
    failed_ids = {r.item_id for r in results if not r.passed}
    if failed_ids:
        tag_counts: dict[str, int] = {}
        for it in load_snapshot_items(db, run.dataset_version):
            if it.id in failed_ids:
                for t in it.tags:
                    tag_counts[t] = tag_counts.get(t, 0) + 1
        summary["failed_tags"] = dict(sorted(tag_counts.items(), key=lambda kv: -kv[1])[:20])
    run.summary = summary
    run.status = "done"
    from datetime import datetime, timezone

    run.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)  # 与 server_default func.now()（UTC）一致
    db.commit()
    db.refresh(run)
    return run


def load_snapshot_items(db: Session, version: DatasetVersion) -> list[DatasetItem]:
    """取某发布版本快照的完整 item 集合（首次引入版本 <= 该版本，顺序稳定）。"""
    from agenthub.db.models import Dataset

    ds = db.get(Dataset, version.dataset_id)
    ver_ids = [
        v.id
        for v in db.query(DatasetVersion)
        .filter(DatasetVersion.dataset_id == ds.id, DatasetVersion.version <= version.version)
        .all()
    ]
    return (
        db.query(DatasetItem)
        .filter(DatasetItem.dataset_id == ds.id, DatasetItem.version_id.in_(ver_ids))
        .order_by(DatasetItem.created_at, DatasetItem.id)
        .all()
    )


# ---------- M5 闭环：badcase 回灌与 Run 对比 ----------


def feedback_from_run(db: Session, run: EvalRun, dataset=None, extra_tags: list[str] | None = None) -> dict:
    """把 Run 的失败 case 回灌为资产（source=badcase_feedback），可选转入目标数据集草稿。

    资产 content 为结构化直通格式（input/expected/context + agent_output），可被任意场景数据集圈选。
    """
    from agenthub.schemas.asset import AssetCreate
    from agenthub.schemas.dataset import FromAssetsRequest
    from agenthub.services.asset_service import DuplicateAssetError, content_fingerprint, create_asset
    from agenthub.services.dataset_service import add_from_assets

    fails = db.query(EvalResult).filter(EvalResult.run_id == run.id, EvalResult.passed.is_(False)).all()
    items = {it.id: it for it in load_snapshot_items(db, run.dataset_version)}
    created = skipped = 0
    asset_ids: list[str] = []
    for r in fails:
        it = items.get(r.item_id)
        if not it:
            continue
        content = {
            "input": it.input,
            "expected": it.expected,
            "context": it.context,
            "agent_output": r.output,
            "error": r.error,
            "run_id": run.id,
        }
        payload = AssetCreate(
            type="custom",
            content=content,
            source="badcase_feedback",
            tags=[*(extra_tags or []), f"run:{run.id}", *it.tags],
            meta={"agent_version": run.agent_version, "source_item_id": it.id},
        )
        try:
            asset = create_asset(db, payload)
            created += 1
        except DuplicateAssetError:
            # 此前已回灌过：按内容指纹找回，保证仍可转入数据集草稿
            skipped += 1
            asset = db.query(Asset).filter(Asset.content_hash == content_fingerprint(content)).first()
            if not asset:
                continue
        asset_ids.append(asset.id)

    result = {"failed_cases": len(fails), "created_assets": created, "skipped_dup": skipped, "added_items": 0}
    if dataset and asset_ids:
        res = add_from_assets(db, dataset, FromAssetsRequest(asset_ids=asset_ids, tags=["badcase"]))
        result["added_items"] = res["added"]
    return result


def compare_runs(db: Session, base: EvalRun, other: EvalRun) -> dict:
    """对比两个 Run：逐指标差值 + 逐 case 回归（由过转败）/修复（由败转过）。"""
    base_results = {r.item_id: r for r in db.query(EvalResult).filter(EvalResult.run_id == base.id).all()}
    other_results = {r.item_id: r for r in db.query(EvalResult).filter(EvalResult.run_id == other.id).all()}
    common = set(base_results) & set(other_results)

    metric_diff: dict = {}
    base_metrics = (base.summary or {}).get("metrics") or {}
    other_metrics = (other.summary or {}).get("metrics") or {}
    for mtype, agg in base_metrics.items():
        b_avg, o_agg = agg.get("avg"), other_metrics.get(mtype, {})
        o_avg = (o_agg or {}).get("avg")
        metric_diff[mtype] = {
            "base": b_avg,
            "compare": o_avg,
            "delta": round(o_avg - b_avg, 4) if (b_avg is not None and o_avg is not None) else None,
        }

    regressions, fixed = [], []
    both_failed = both_passed = 0
    for iid in common:
        bp, op = base_results[iid].passed, other_results[iid].passed
        if bp is True and op is False:
            regressions.append({
                "item_id": iid,
                "base_scores": base_results[iid].scores,
                "compare_scores": other_results[iid].scores,
                "compare_output": other_results[iid].output,
            })
        elif bp is False and op is True:
            fixed.append({"item_id": iid})
        elif bp is False and op is False:
            both_failed += 1
        elif bp is True and op is True:
            both_passed += 1

    b_total = (base.summary or {}).get("weighted_total")
    o_total = (other.summary or {}).get("weighted_total")
    return {
        "base_run": base.id,
        "compare_run": other.id,
        "common_items": len(common),
        "metric_diff": metric_diff,
        "weighted_total": {
            "base": b_total,
            "compare": o_total,
            "delta": round(o_total - b_total, 4) if (b_total is not None and o_total is not None) else None,
        },
        "regressions": regressions,  # 由过转败
        "fixed": fixed,  # 由败转过
        "both_failed": both_failed,
        "both_passed": both_passed,
    }
