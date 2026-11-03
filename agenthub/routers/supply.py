"""M3 数据供给路由：按名解析与最新版重定向（SDK / CI 的稳定入口）。"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from agenthub.db.base import get_db
from agenthub.db.models import Dataset, DatasetVersion
from agenthub.schemas.common import ok

router = APIRouter(prefix="/api/v1/supply", tags=["supply"])


def _latest_version(db: Session, name: str) -> tuple[Dataset, DatasetVersion | None]:
    ds = db.query(Dataset).filter(Dataset.name == name).first()
    if not ds:
        raise HTTPException(404, f"dataset '{name}' not found")
    ver = (
        db.query(DatasetVersion)
        .filter(DatasetVersion.dataset_id == ds.id)
        .order_by(DatasetVersion.version.desc())
        .first()
    )
    return ds, ver


@router.get("/datasets/{name}/resolve")
def resolve_dataset(name: str, db: Session = Depends(get_db)):
    """把数据集名解析为最新版本元信息（SDK 缓存决策用）。"""
    ds, ver = _latest_version(db, name)
    if ver is None:
        raise HTTPException(404, f"dataset '{name}' has no published version")
    return ok({
        "name": ds.name,
        "dataset_id": ds.id,
        "scene": ds.scene,
        "latest_version": ver.version,
        "item_count": ver.item_count,
    })


@router.get("/datasets/{name}/latest")
def latest_export(name: str, format: str = "jsonl", db: Session = Depends(get_db)):
    """302 到最新版本导出（CI 里可写死此 URL）。"""
    from urllib.parse import quote

    from agenthub.services.supply_service import EXPORT_FORMATS

    if format not in EXPORT_FORMATS:
        raise HTTPException(422, f"format must be one of {sorted(EXPORT_FORMATS)}")
    _, ver = _latest_version(db, name)
    if ver is None:
        raise HTTPException(404, f"dataset '{name}' has no published version")
    target = f"/api/v1/datasets/{quote(name)}/versions/{ver.version}/export?format={format}"
    return RedirectResponse(url=target, status_code=302)
