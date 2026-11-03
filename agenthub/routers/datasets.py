from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from agenthub.db.base import get_db
from agenthub.db.models import Dataset, DatasetItem, DatasetVersion
from agenthub.schemas.common import ok
from agenthub.schemas.dataset import (
    AddItemsRequest,
    DatasetCreate,
    DatasetItemOut,
    DatasetOut,
    DatasetVersionOut,
    FromAssetsRequest,
    ItemListOut,
    PublishRequest,
    VersionListOut,
    check_name,
    check_scene,
)
from agenthub.schemas.scenes import SCENES
from agenthub.services import dataset_service as svc

router = APIRouter(prefix="/api/v1/datasets", tags=["datasets"])


def _ds_or_404(db: Session, dataset_id: str) -> Dataset:
    try:
        return svc.get_dataset_or_raise(db, dataset_id)
    except svc.DatasetNotFound:
        raise HTTPException(404, f"dataset {dataset_id} not found")


def _ds_brief(db: Session, ds: Dataset) -> dict:
    return svc.dataset_brief(db, ds)


@router.post("")
def create_dataset(body: DatasetCreate, db: Session = Depends(get_db)):
    if err := check_name(body.name):
        raise HTTPException(422, err)
    if err := check_scene(body.scene):
        raise HTTPException(422, err)
    if db.query(Dataset).filter(Dataset.name == body.name).first():
        raise HTTPException(409, f"dataset name '{body.name}' already exists")
    ds = svc.create_dataset(db, body.name, body.scene, body.description)
    return ok(_ds_brief(db, ds))


@router.get("")
def list_datasets(scene: str | None = None, db: Session = Depends(get_db)):
    q = db.query(Dataset).order_by(Dataset.created_at.desc())
    if scene:
        q = q.filter(Dataset.scene == scene)
    return ok([_ds_brief(db, ds) for ds in q.all()])


@router.get("/{dataset_id}")
def get_dataset(dataset_id: str, db: Session = Depends(get_db)):
    return ok(_ds_brief(db, _ds_or_404(db, dataset_id)))


@router.delete("/{dataset_id}")
def delete_dataset(dataset_id: str, db: Session = Depends(get_db)):
    ds = _ds_or_404(db, dataset_id)
    n = db.query(DatasetItem).filter(DatasetItem.dataset_id == ds.id).delete()
    db.query(Dataset).filter(Dataset.id == ds.id).delete()
    db.commit()
    return ok({"deleted": ds.id, "items_removed": n})


@router.post("/{dataset_id}/items")
def add_items(dataset_id: str, body: AddItemsRequest, db: Session = Depends(get_db)):
    ds = _ds_or_404(db, dataset_id)
    try:
        result = svc.add_draft_items(db, ds, body.items, skip_invalid=body.skip_invalid)
    except svc.InvalidItems as e:
        raise HTTPException(422, "; ".join(e.errors[:5]))
    return ok(result)


@router.post("/{dataset_id}/items/from-assets")
def add_items_from_assets(dataset_id: str, body: FromAssetsRequest, db: Session = Depends(get_db)):
    ds = _ds_or_404(db, dataset_id)
    if not body.asset_ids and not body.filters:
        raise HTTPException(422, "asset_ids 与 filters 至少提供一个")
    return ok(svc.add_from_assets(db, ds, body))


@router.get("/{dataset_id}/items")
def list_items(
    dataset_id: str,
    draft: bool = False,
    version: int | None = None,
    offset: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
):
    ds = _ds_or_404(db, dataset_id)
    total, rows = svc.list_items(db, ds, draft=draft, version=version, offset=offset, limit=limit)
    out = ItemListOut(total=total, items=[DatasetItemOut.model_validate(r) for r in rows])
    return ok(out.model_dump(mode="json"))


@router.delete("/{dataset_id}/items/{item_id}")
def delete_draft_item(dataset_id: str, item_id: str, db: Session = Depends(get_db)):
    ds = _ds_or_404(db, dataset_id)
    try:
        svc.delete_draft_item(db, ds, item_id)
    except svc.DatasetNotFound:
        raise HTTPException(404, f"item {item_id} not found in dataset")
    except ValueError as e:
        raise HTTPException(409, str(e))
    return ok({"deleted": item_id})


@router.post("/{dataset_id}/versions")
def publish_version(dataset_id: str, body: PublishRequest, db: Session = Depends(get_db)):
    ds = _ds_or_404(db, dataset_id)
    try:
        ver = svc.publish(db, ds, body.changelog, body.skip_invalid)
    except svc.NoDraftItems as e:
        raise HTTPException(422, str(e))
    except svc.InvalidItems as e:
        raise HTTPException(422, "; ".join(e.errors[:5]))
    return ok(DatasetVersionOut.model_validate(ver).model_dump(mode="json"))


@router.get("/{dataset_id}/versions")
def list_versions(dataset_id: str, db: Session = Depends(get_db)):
    ds = _ds_or_404(db, dataset_id)
    rows = svc.list_versions(db, ds)
    out = VersionListOut(total=len(rows), items=[DatasetVersionOut.model_validate(v) for v in rows])
    return ok(out.model_dump(mode="json"))


@router.get("/{name}/versions/{version}/export")
def export_version(name: str, version: int, format: str = "jsonl", db: Session = Depends(get_db)):
    from fastapi import Response

    from agenthub.services.supply_service import EXPORT_FORMATS, read_snapshot_items, render_export

    if format not in EXPORT_FORMATS:
        raise HTTPException(422, f"format must be one of {sorted(EXPORT_FORMATS)}")
    ds = db.query(Dataset).filter(Dataset.name == name).first()
    if not ds:
        raise HTTPException(404, f"dataset '{name}' not found")
    ver = db.query(DatasetVersion).filter_by(dataset_id=ds.id, version=version).first()
    if not ver:
        raise HTTPException(404, f"version {version} not found for dataset '{name}'")
    try:
        items = read_snapshot_items(ver.snapshot_path)
    except FileNotFoundError:
        raise HTTPException(500, f"snapshot file missing: {ver.snapshot_path}")
    content, media_type, filename = render_export(ds, ver, items, format)
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
