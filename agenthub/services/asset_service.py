import hashlib
import json

from sqlalchemy import Text, cast
from sqlalchemy import or_
from sqlalchemy.orm import Session

from agenthub.db.models import Asset
from agenthub.schemas.asset import AssetCreate, AssetImportItem


def content_fingerprint(content: dict) -> str:
    """canonical JSON 的 sha256，用于内容级去重。"""
    canonical = json.dumps(content, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def create_asset(db: Session, data: AssetCreate) -> Asset:
    asset_hash = content_fingerprint(data.content)
    exists = db.query(Asset).filter(Asset.content_hash == asset_hash).first()
    if exists:
        raise DuplicateAssetError(asset_hash)
    asset = Asset(
        type=data.type,
        source=data.source,
        content=data.content,
        content_hash=asset_hash,
        tags=data.tags,
        meta=data.meta,
    )
    db.add(asset)
    db.commit()
    db.refresh(asset)
    return asset


class DuplicateAssetError(Exception):
    pass


def import_assets(db: Session, items: list[AssetImportItem], source: str, extra_tags: list[str]) -> tuple[int, int]:
    """批量导入，按 content_hash 去重。返回 (created, skipped)。"""
    hashes = [content_fingerprint(it.content) for it in items]
    existing = {
        h for (h,) in db.query(Asset.content_hash).filter(Asset.content_hash.in_(hashes)).all()
    } if hashes else set()
    created = 0
    for item, asset_hash in zip(items, hashes):
        if asset_hash in existing:
            continue
        existing.add(asset_hash)
        db.add(Asset(
            type=item.type,
            source=source,
            content=item.content,
            content_hash=asset_hash,
            tags=list({*item.tags, *extra_tags}),
            meta=item.meta,
        ))
        created += 1
    db.commit()
    return created, len(items) - created


def list_assets(
    db: Session,
    *,
    type: str | None = None,
    tag: str | None = None,
    q: str | None = None,
    source: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> tuple[int, list[Asset]]:
    query = db.query(Asset)
    if type:
        query = query.filter(Asset.type == type)
    if source:
        query = query.filter(Asset.source == source)
    if tag:  # SQLite JSON 无原生查询，用 LIKE 匹配 tags 数组元素
        query = query.filter(cast(Asset.tags, Text).like(f'%"{tag}"%'))
    if q:
        like = f"%{q}%"
        query = query.filter(or_(
            cast(Asset.content, Text).like(like),
            cast(Asset.meta, Text).like(like),
        ))
    total = query.count()
    rows = query.order_by(Asset.created_at.desc(), Asset.id.desc()).offset(offset).limit(limit).all()
    return total, rows


def patch_asset(db: Session, asset: Asset, tags: list[str] | None, meta: dict | None) -> Asset:
    if tags is not None:
        asset.tags = tags
    if meta is not None:
        asset.meta = meta
    db.commit()
    db.refresh(asset)
    return asset
