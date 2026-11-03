"""仪表盘统计聚合（GET /api/v1/stats，UI-100 专用）。"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from agenthub.db.base import get_db
from agenthub.db.models import Asset, Dataset, DatasetItem, DatasetVersion, EvalRun
from agenthub.schemas.common import ok

router = APIRouter(prefix="/api/v1/stats", tags=["stats"])


@router.get("")
def dashboard(db: Session = Depends(get_db)):
    # created_at 由 server_default func.now() 写入（SQLite 为 UTC），比较基准须同为 UTC
    since = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=30)
    done_runs = (
        db.query(EvalRun)
        .filter(EvalRun.status == "done")
        .order_by(EvalRun.created_at)
        .all()
    )

    # 近 30 天按日通过率（当日多个 Run 取均值）
    by_day: dict[str, list[float]] = {}
    for r in done_runs:
        if r.created_at < since:
            continue
        pr = (r.summary or {}).get("pass_rate")
        if pr is None:
            continue
        by_day.setdefault(r.created_at.date().isoformat(), []).append(float(pr))
    trend = [
        {"date": day, "pass_rate": round(sum(vals) / len(vals), 4), "runs": len(vals)}
        for day, vals in sorted(by_day.items())
    ]

    # 未回灌的失败 Run：有失败 case 且尚无 run:{id} 标签的回灌资产
    unfeedback_runs = 0
    for r in done_runs:
        s = r.summary or {}
        if s.get("total") and s.get("passed", 0) < s["total"]:
            tagged = db.query(Asset.id).filter(Asset.tags.contains(f"run:{r.id}")).first()
            if not tagged:
                unfeedback_runs += 1

    # 有草稿未发布的数据集数
    draft_dataset_ids = {
        row[0]
        for row in db.query(DatasetItem.dataset_id)
        .filter(DatasetItem.version_id.is_(None))
        .distinct()
        .all()
    }

    return ok({
        "counts": {
            "assets": db.query(Asset).count(),
            "datasets": db.query(Dataset).count(),
            "dataset_versions": db.query(DatasetVersion).count(),
            "runs": db.query(EvalRun).count(),
        },
        "trend_30d": trend,
        "draft_datasets": len(draft_dataset_ids),
        "unfeedback_runs": unfeedback_runs,
    })
