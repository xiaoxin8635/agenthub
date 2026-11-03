"""EvalRun：发起、托管执行、回传结果、查询与结果列表。"""
import threading
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy.orm import Session

from agenthub.db.base import get_db
from agenthub.db.models import Dataset, DatasetVersion, EvalResult, EvalRun, EvalTarget, MetricConfig
from agenthub.schemas.common import ok
from agenthub.services import eval_service

router = APIRouter(prefix="/api/v1/runs", tags=["runs"])


@router.get("")
def list_runs(
    status: str | None = None,
    dataset: str | None = None,  # 数据集 id 或 name
    target: str | None = None,  # Target id 或 name
    offset: int = 0,
    limit: int = 20,
    db: Session = Depends(get_db),
):
    """Run 列表摘要（不含 results），供控制台列表页/下拉选择使用。"""
    q = db.query(EvalRun)
    if status:
        q = q.filter(EvalRun.status == status)
    if dataset:
        ds = db.query(Dataset).filter((Dataset.id == dataset) | (Dataset.name == dataset)).first()
        ver_ids = (
            [v.id for v in db.query(DatasetVersion).filter(DatasetVersion.dataset_id == ds.id).all()]
            if ds
            else []
        )
        q = q.filter(EvalRun.dataset_version_id.in_(ver_ids or ["__none__"]))
    if target:
        tgt = db.query(EvalTarget).filter((EvalTarget.id == target) | (EvalTarget.name == target)).first()
        q = q.filter(EvalRun.target_id == (tgt.id if tgt else "__none__"))
    total = q.count()
    rows = q.order_by(EvalRun.created_at.desc()).offset(offset).limit(limit).all()
    items = []
    for r in rows:
        dv = db.get(DatasetVersion, r.dataset_version_id)
        ds = db.get(Dataset, dv.dataset_id) if dv else None
        tgt = db.get(EvalTarget, r.target_id)
        mc = db.get(MetricConfig, r.metric_config_id)
        s = r.summary or {}
        items.append({
            "id": r.id,
            "status": r.status,
            "dataset": f"{ds.name}@{dv.version}" if ds and dv else (f"(已删除)@{dv.version}" if dv else None),
            "dataset_version_id": r.dataset_version_id,
            "target": tgt.name if tgt else None,
            "metric_config": mc.name if mc else None,
            "agent_version": r.agent_version,
            "total": s.get("total"),
            "passed": s.get("passed"),
            "pass_rate": s.get("pass_rate"),
            "weighted_total": s.get("weighted_total"),
            "progress": r.progress,
            "created_at": r.created_at.isoformat(),
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        })
    return ok({"total": total, "items": items})


class RunCreate(BaseModel):
    dataset_version_id: str
    target_id: str
    metric_config_id: str
    agent_version: str = ""


class RunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    dataset_version_id: str
    target_id: str
    metric_config_id: str
    agent_version: str
    status: str
    summary: dict
    progress: dict | None = None  # 执行中 {"done": n, "total": m}
    error: str
    created_at: datetime


class ResultIn(BaseModel):
    item_id: str
    output: dict = {}
    trajectory: dict = {}
    error: str = ""


class ResultsIn(BaseModel):
    results: list[ResultIn]


class ResultOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    run_id: str
    item_id: str
    output: dict
    trajectory: dict
    scores: dict
    passed: bool | None
    error: str


def _run_or_404(db: Session, run_id: str) -> EvalRun:
    run = db.get(EvalRun, run_id)
    if not run:
        raise HTTPException(404, f"run {run_id} not found")
    return run


@router.post("")
def create_run(body: RunCreate, db: Session = Depends(get_db)):
    from agenthub.db.models import DatasetVersion, EvalTarget, MetricConfig

    if not db.get(DatasetVersion, body.dataset_version_id):
        raise HTTPException(404, f"dataset_version {body.dataset_version_id} not found")
    target = db.get(EvalTarget, body.target_id)
    if not target:
        raise HTTPException(404, f"target {body.target_id} not found")
    if not db.get(MetricConfig, body.metric_config_id):
        raise HTTPException(404, f"metric_config {body.metric_config_id} not found")
    if target.kind == "http" and not target.endpoint_config.get("url"):
        raise HTTPException(422, "http target 缺少 endpoint_config.url，无法托管执行")
    run = EvalRun(
        dataset_version_id=body.dataset_version_id,
        target_id=body.target_id,
        metric_config_id=body.metric_config_id,
        agent_version=body.agent_version,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return ok(RunOut.model_validate(run).model_dump(mode="json"))


@router.post("/{run_id}/start")
def start_run(run_id: str, db: Session = Depends(get_db)):
    """托管模式：后台线程执行（调用被测 Agent 端点 + 算分）。立即返回，轮询 GET /runs/{id}。"""
    from agenthub.runners.http_runner import start_run_async

    run = _run_or_404(db, run_id)
    if run.target.kind != "http":
        raise HTTPException(422, "仅 http 目标支持托管执行；external 目标请用 POST /runs/{id}/results 回传")
    # 原子状态转移（WHERE status='pending'）：并发双击/重复启动只有一个请求能成功，
    # done/failed/running 一律拒绝，避免重复执行导致结果翻倍
    updated = (
        db.query(EvalRun)
        .filter(EvalRun.id == run_id, EvalRun.status == "pending")
        .update({"status": "running", "started_at": datetime.now()})
    )
    db.commit()
    if updated == 0:
        raise HTTPException(409, f"run 当前状态为 {run.status}，仅待执行（pending）可启动")
    start_run_async(run_id)
    return ok({"started": run_id})


# 回传模式 per-run 进程锁：并发回传同一 run 时串行化「幂等检查 + 插入 + 收齐判断」，
# 防止重复插入结果/提前 finalize（单进程部署下足够；多进程需改 DB 唯一约束）
_report_locks: dict[str, threading.Lock] = {}
_report_locks_guard = threading.Lock()


def _run_lock(run_id: str) -> threading.Lock:
    with _report_locks_guard:
        return _report_locks.setdefault(run_id, threading.Lock())


@router.post("/{run_id}/results")
def report_results(run_id: str, body: ResultsIn, db: Session = Depends(get_db)):
    """回传模式：外部系统提交逐条输出，服务端统一算分；收齐后自动聚合。"""
    run = _run_or_404(db, run_id)
    with _run_lock(run_id):
        if run.status == "done":
            raise HTTPException(409, "run already done")
        if run.status == "pending":
            run.status = "running"
            run.started_at = datetime.now()
            db.commit()

        items = eval_service.load_snapshot_items(db, run.dataset_version)
        by_id = {it.id: it for it in items}
        mc = run.metric_config
        known_ids = {r.item_id for r in db.query(EvalResult.item_id).filter(EvalResult.run_id == run.id).all()}

        for res in body.results:
            if res.item_id not in by_id:
                raise HTTPException(422, f"item {res.item_id} 不属于该数据集版本")
            if res.item_id in known_ids:
                continue  # 幂等：已收到的 item 跳过
            known_ids.add(res.item_id)
            item_dict = {
                "id": by_id[res.item_id].id,
                "input": by_id[res.item_id].input,
                "expected": by_id[res.item_id].expected,
                "context": by_id[res.item_id].context,
                "tags": by_id[res.item_id].tags,
            }
            scores, passed, metric_err = eval_service.evaluate_item(mc.metrics, item_dict, res.output)
            db.add(EvalResult(
                run_id=run.id, item_id=res.item_id, output=res.output,
                trajectory=res.trajectory, scores=scores,
                passed=None if res.error else passed, error=res.error or metric_err,
            ))
        db.commit()

        received = db.query(EvalResult).filter(EvalResult.run_id == run.id).count()
        if received >= len(items):
            eval_service.finalize_run(db, run)
            from agenthub.services.notify import notify_run_finished

            notify_run_finished(run.id, "done", run.summary or {})
    return ok({"received": received, "expected": len(items), "done": run.status == "done"})


@router.post("/{run_id}/finalize")
def finalize(run_id: str, db: Session = Depends(get_db)):
    """强制聚合（未收齐时也按现有结果出 summary）。"""
    run = _run_or_404(db, run_id)
    eval_service.finalize_run(db, run)
    return ok(RunOut.model_validate(run).model_dump(mode="json"))


@router.get("/{run_id}")
def get_run(run_id: str, db: Session = Depends(get_db)):
    """Run 详情：内联数据集@版本 / Target / 指标组合引用，前端无需遍历解析（原 N×M 次请求 → 0）。"""
    run = _run_or_404(db, run_id)
    data = RunOut.model_validate(run).model_dump(mode="json")
    ver = db.get(DatasetVersion, run.dataset_version_id)
    if ver is not None:
        ds = db.get(Dataset, ver.dataset_id)
        data["dataset"] = {"id": ds.id, "name": ds.name, "scene": ds.scene} if ds else None
        data["dataset_version"] = ver.version
    else:
        data["dataset"] = None  # 版本/数据集已删
        data["dataset_version"] = None
    target = db.get(EvalTarget, run.target_id)
    data["target_name"] = target.name if target else None
    config = db.get(MetricConfig, run.metric_config_id)
    data["metric_config_name"] = config.name if config else None
    return ok(data)


class FeedbackIn(BaseModel):
    dataset: str | None = None  # 目标数据集名（可选，提供则转入其草稿）
    tags: list[str] = []


@router.post("/{run_id}/feedback")
def feedback(run_id: str, body: FeedbackIn, db: Session = Depends(get_db)):
    """闭环回灌：把失败 case 沉淀为资产（source=badcase_feedback），可选转入数据集草稿。"""
    run = _run_or_404(db, run_id)
    dataset = None
    if body.dataset:
        dataset = db.query(Dataset).filter(Dataset.name == body.dataset).first()
        if not dataset:
            raise HTTPException(404, f"dataset '{body.dataset}' not found")
    result = eval_service.feedback_from_run(db, run, dataset=dataset, extra_tags=body.tags)
    return ok(result)


@router.get("/{run_id}/compare/{other_run_id}")
def compare_runs(run_id: str, other_run_id: str, db: Session = Depends(get_db)):
    """对比两个 Run：逐指标差值 + 逐 case 回归（由过转败）/修复（由败转过）。"""
    base = _run_or_404(db, run_id)
    other = _run_or_404(db, other_run_id)
    return ok(eval_service.compare_runs(db, base, other))


@router.get("/{run_id}/results")
def list_results(run_id: str, passed: bool | None = None, offset: int = 0, limit: int = 100, db: Session = Depends(get_db)):
    run = _run_or_404(db, run_id)
    q = db.query(EvalResult).filter(EvalResult.run_id == run.id)
    if passed is not None:
        q = q.filter(EvalResult.passed == passed)
    total = q.count()
    rows = q.order_by(EvalResult.created_at, EvalResult.id).offset(offset).limit(limit).all()
    return ok({
        "total": total,
        "items": [ResultOut.model_validate(r).model_dump(mode="json") for r in rows],
    })
