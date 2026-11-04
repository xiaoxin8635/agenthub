import json

from fastapi import APIRouter, Depends, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from agenthub.config import get_settings
from agenthub.db.base import SessionLocal, get_db
from agenthub.db.models import Asset
from agenthub.schemas.asset import (
    ASSET_SOURCES,
    ASSET_TYPES,
    AssetCreate,
    AssetImportItem,
    AssetImportResult,
    AssetListOut,
    AssetOut,
    AssetPatch,
)
from agenthub.schemas.common import ok
from agenthub.services import asset_service

router = APIRouter(prefix="/api/v1/assets", tags=["assets"])


# ---------- AI 生成评测集 ----------


@router.post("/generate")
async def generate_evalset(file: UploadFile, per_chunk: int = Form(1)):
    """上传文档（md/txt），后台 LLM 出题生成 rag 评测资产（内置代码去重）。"""
    raw = (await file.read()).decode("utf-8", errors="replace")
    if len(raw.strip()) < 50:
        raise HTTPException(422, "文档内容太短（至少 50 字）")
    s = get_settings()
    if not (s.llm_base_url and s.llm_model):
        raise HTTPException(409, "LLM 未配置：需要 AGENTHUB_LLM_BASE_URL / AGENTHUB_LLM_MODEL")
    from agenthub.services import generator

    job_id = generator.start_job(file.filename or "doc.md", raw, max(1, min(per_chunk, 5)))
    return ok({"job_id": job_id})


@router.get("/generate/{job_id}")
def generate_job_status(job_id: str):
    from agenthub.services import generator

    job = generator.JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "job not found（服务重启后任务状态失效，但已生成的资产仍保留）")
    return ok(job)


def _get_asset_or_404(db: Session, asset_id: str) -> Asset:
    asset = db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(404, f"asset {asset_id} not found")
    return asset


@router.post("", response_model=None)
def create_asset(body: AssetCreate, db: Session = Depends(get_db)):
    if body.type not in ASSET_TYPES:
        raise HTTPException(422, f"type must be one of {sorted(ASSET_TYPES)}")
    if body.source not in ASSET_SOURCES:
        raise HTTPException(422, f"source must be one of {sorted(ASSET_SOURCES)}")
    try:
        asset = asset_service.create_asset(db, body)
    except asset_service.DuplicateAssetError:
        raise HTTPException(409, "duplicate asset content (same content_hash exists)")
    return ok(AssetOut.model_validate(asset).model_dump(mode="json"))


@router.post("/import")
async def import_assets(
    file: UploadFile,
    source: str = Form("trace_import"),
    tags: str = Form(""),  # 逗号分隔
    db: Session = Depends(get_db),
):
    if source not in ASSET_SOURCES:
        raise HTTPException(422, f"source must be one of {sorted(ASSET_SOURCES)}")
    raw = (await file.read()).decode("utf-8-sig")
    items: list[AssetImportItem] = []
    errors: list[str] = []
    for lineno, line in enumerate(raw.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            items.append(AssetImportItem(**obj))
        except Exception as e:  # noqa: BLE001 — 逐行容错，坏行跳过并上报
            errors.append(f"line {lineno}: {e}")
    created, skipped = asset_service.import_assets(db, items, source=source, extra_tags=[t for t in tags.split(",") if t])
    result = AssetImportResult(total=len(items) + len(errors), created=created, skipped=skipped)
    payload = result.model_dump()
    if errors:
        payload["errors"] = errors
    return ok(payload)


@router.get("")
def list_assets(
    type: str | None = None,
    source: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    offset: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
):
    total, rows = asset_service.list_assets(db, type=type, source=source, tag=tag, q=q, offset=offset, limit=limit)
    out = AssetListOut(total=total, items=[AssetOut.model_validate(r) for r in rows])
    return ok(out.model_dump(mode="json"))


@router.get("/{asset_id}")
def get_asset(asset_id: str, db: Session = Depends(get_db)):
    asset = _get_asset_or_404(db, asset_id)
    return ok(AssetOut.model_validate(asset).model_dump(mode="json"))


@router.patch("/{asset_id}")
def patch_asset(asset_id: str, body: AssetPatch, db: Session = Depends(get_db)):
    asset = _get_asset_or_404(db, asset_id)
    updated = asset_service.patch_asset(db, asset, body.tags, body.meta)
    return ok(AssetOut.model_validate(updated).model_dump(mode="json"))


@router.delete("/{asset_id}")
def delete_asset(asset_id: str, db: Session = Depends(get_db)):
    asset = _get_asset_or_404(db, asset_id)
    db.delete(asset)
    db.commit()
    return ok({"deleted": asset_id})


class BatchDeleteIn(BaseModel):
    ids: list[str]


@router.post("/batch-delete")
def batch_delete_assets(body: BatchDeleteIn, db: Session = Depends(get_db)):
    """批量删除资产（已转入数据集的 item 保留但失去来源关联）。"""
    deleted: list[str] = []
    for aid in dict.fromkeys(body.ids):  # 去重保序
        asset = db.get(Asset, aid)
        if asset is not None:
            db.delete(asset)
            deleted.append(aid)
    db.commit()
    return ok({"deleted": deleted})
