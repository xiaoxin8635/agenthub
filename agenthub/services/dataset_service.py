import json
from collections import Counter
from pathlib import Path

from sqlalchemy.orm import Session

from agenthub.config import get_settings
from agenthub.db.models import Asset, Dataset, DatasetItem, DatasetVersion
from agenthub.schemas.dataset import DatasetItemCreate, FromAssetsRequest
from agenthub.schemas.scenes import asset_to_item_payload, validate_item
from agenthub.services.asset_service import list_assets


class DatasetNotFound(Exception):
    pass


class InvalidItems(Exception):
    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(f"{len(errors)} invalid item(s)")


class NoDraftItems(Exception):
    pass


# ---------- 数据集 CRUD ----------


def create_dataset(db: Session, name: str, scene: str, description: str) -> Dataset:
    ds = Dataset(name=name, scene=scene, description=description)
    db.add(ds)
    db.commit()
    db.refresh(ds)
    return ds


def get_dataset_or_raise(db: Session, dataset_id_or_name: str) -> Dataset:
    """按 id 或 name 定位数据集（name 唯一，CLI/人工调用常只有名字）。"""
    ds = db.get(Dataset, dataset_id_or_name)
    if not ds:
        ds = db.query(Dataset).filter(Dataset.name == dataset_id_or_name).first()
    if not ds:
        raise DatasetNotFound(dataset_id_or_name)
    return ds


def dataset_brief(db: Session, ds: Dataset) -> dict:
    ver_rows = db.query(DatasetVersion).filter(DatasetVersion.dataset_id == ds.id).all()
    total = db.query(DatasetItem).filter(DatasetItem.dataset_id == ds.id, DatasetItem.version_id.isnot(None)).count()
    draft = db.query(DatasetItem).filter(DatasetItem.dataset_id == ds.id, DatasetItem.version_id.is_(None)).count()
    return {
        "id": ds.id,
        "name": ds.name,
        "scene": ds.scene,
        "description": ds.description,
        "draft_count": draft,
        "total_items": total,
        "latest_version": max((v.version for v in ver_rows), default=None),
        "created_at": ds.created_at,
    }


# ---------- 草稿 items ----------


def add_draft_items(
    db: Session,
    ds: Dataset,
    items: list[DatasetItemCreate],
    *,
    skip_invalid: bool,
    extra_tags: list[str] | None = None,
) -> dict:
    """写入草稿 items（强校验场景 Schema，同一资产在数据集内去重）。"""
    errors: list[str] = []
    added = skipped_invalid = skipped_dup = 0
    # 已存在于本数据集的 source_asset_id（草稿或已发布）
    existing_assets = {
        aid for (aid,) in db.query(DatasetItem.source_asset_id)
        .filter(DatasetItem.dataset_id == ds.id, DatasetItem.source_asset_id.isnot(None)).all()
    }
    for idx, it in enumerate(items):
        payload = {"input": it.input, "expected": it.expected, "context": it.context}
        errs = validate_item(ds.scene, payload)
        if errs:
            if skip_invalid:
                skipped_invalid += 1
                errors.extend(f"item[{idx}]: {e}" for e in errs)
                continue
            raise InvalidItems([f"item[{idx}]: {e}" for e in errs])
        if it.source_asset_id and it.source_asset_id in existing_assets:
            skipped_dup += 1
            continue
        if it.source_asset_id:
            existing_assets.add(it.source_asset_id)
        db.add(DatasetItem(
            dataset_id=ds.id,
            input=it.input,
            expected=it.expected,
            context=it.context,
            tags=list({*it.tags, *(extra_tags or [])}),
            source_asset_id=it.source_asset_id,
        ))
        added += 1
    db.commit()
    return {"added": added, "skipped_invalid": skipped_invalid, "skipped_dup": skipped_dup, "errors": errors}


def add_from_assets(db: Session, ds: Dataset, req: FromAssetsRequest) -> dict:
    """圈选资产 → 映射为草稿 items。"""
    if req.asset_ids:
        assets = db.query(Asset).filter(Asset.id.in_(req.asset_ids)).all()
        by_id = {a.id: a for a in assets}
        assets = [by_id[i] for i in req.asset_ids if i in by_id]
    else:
        f = req.filters
        _, assets = list_assets(
            db,
            type=f.get("type"), source=f.get("source"), tag=f.get("tag"), q=f.get("q"),
            offset=0, limit=int(f.get("limit", 100)),
        )

    items: list[DatasetItemCreate] = []
    unmapped = 0
    for a in assets:
        payload = asset_to_item_payload(ds.scene, a.content)
        if payload is None:
            unmapped += 1
            continue
        items.append(DatasetItemCreate(
            **payload, tags=list(a.tags), source_asset_id=a.id,
        ))
    result = add_draft_items(db, ds, items, skip_invalid=True, extra_tags=req.tags)
    result["selected"] = len(assets)
    result["skipped_invalid"] += unmapped
    return result


def list_items(
    db: Session, ds: Dataset, *,
    draft: bool = False, version: int | None = None,
    offset: int = 0, limit: int = 100,
) -> tuple[int, list[DatasetItem]]:
    q = db.query(DatasetItem).filter(DatasetItem.dataset_id == ds.id)
    if draft:
        q = q.filter(DatasetItem.version_id.is_(None))
    elif version is not None:
        ver_ids = [
            v.id for v in db.query(DatasetVersion)
            .filter(DatasetVersion.dataset_id == ds.id, DatasetVersion.version <= version).all()
        ]
        q = q.filter(DatasetItem.version_id.in_(ver_ids))
    total = q.count()
    rows = q.order_by(DatasetItem.created_at, DatasetItem.id).offset(offset).limit(limit).all()
    return total, rows


def delete_draft_item(db: Session, ds: Dataset, item_id: str) -> DatasetItem:
    item = db.get(DatasetItem, item_id)
    if not item or item.dataset_id != ds.id:
        raise DatasetNotFound(item_id)
    if item.version_id is not None:
        raise ValueError("已发布版本的 item 不可删除（版本不可变）")
    db.delete(item)
    db.commit()
    return item


# ---------- 版本发布 ----------


def _items_of_version(db: Session, ds: Dataset, version: int) -> list[DatasetItem]:
    ver_ids = [
        v.id for v in db.query(DatasetVersion)
        .filter(DatasetVersion.dataset_id == ds.id, DatasetVersion.version <= version).all()
    ]
    return (
        db.query(DatasetItem)
        .filter(DatasetItem.dataset_id == ds.id, DatasetItem.version_id.in_(ver_ids))
        .order_by(DatasetItem.created_at, DatasetItem.id).all()
    )


def snapshot_path(ds_name: str, version: int) -> Path:
    return Path(get_settings().data_dir) / ds_name / f"v{version}.jsonl"


def publish(db: Session, ds: Dataset, changelog: str, skip_invalid: bool) -> DatasetVersion:
    drafts = (
        db.query(DatasetItem)
        .filter(DatasetItem.dataset_id == ds.id, DatasetItem.version_id.is_(None))
        .order_by(DatasetItem.created_at, DatasetItem.id).all()
    )
    ver_rows = db.query(DatasetVersion).filter(DatasetVersion.dataset_id == ds.id).all()
    latest = max((v.version for v in ver_rows), default=0)
    carried = _items_of_version(db, ds, latest) if latest else []

    if not drafts and not carried:
        raise NoDraftItems("数据集没有任何 item（草稿为空且无历史版本）")

    # 校验新增草稿，收集非法项
    errors: list[str] = []
    invalid_ids: set[str] = set()
    for it in drafts:
        errs = validate_item(ds.scene, {"input": it.input, "expected": it.expected, "context": it.context})
        if errs:
            invalid_ids.add(it.id)
            errors.extend(f"item({it.id}): {e}" for e in errs)
    if errors and not skip_invalid:
        raise InvalidItems(errors)

    version = latest + 1
    valid_drafts = [d for d in drafts if d.id not in invalid_ids]
    all_items = carried + valid_drafts

    # 写快照文件（文件即真相）
    path = snapshot_path(ds.name, version)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for it in all_items:
            f.write(json.dumps({
                "id": it.id,
                "input": it.input,
                "expected": it.expected,
                "context": it.context,
                "tags": it.tags,
                "source_asset_id": it.source_asset_id,
            }, ensure_ascii=False) + "\n")

    tag_counter = Counter(t for it in all_items for t in it.tags)
    ver = DatasetVersion(
        dataset_id=ds.id,
        version=version,
        snapshot_path=str(path),
        item_count=len(all_items),
        stats={
            "total": len(all_items),
            "carried": len(carried),
            "new": len(valid_drafts),
            "tags": dict(tag_counter),
        },
        changelog=changelog,
    )
    db.add(ver)
    db.flush()
    for d in valid_drafts:  # 草稿转正：标记首次引入版本
        d.version_id = ver.id
    db.commit()
    db.refresh(ver)
    return ver


def list_versions(db: Session, ds: Dataset) -> list[DatasetVersion]:
    return (
        db.query(DatasetVersion)
        .filter(DatasetVersion.dataset_id == ds.id)
        .order_by(DatasetVersion.version.desc()).all()
    )
