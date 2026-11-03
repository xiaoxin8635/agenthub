"""被测 Agent（EvalTarget）与指标组合（MetricConfig）管理。"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from agenthub.db.base import get_db
from agenthub.db.models import EvalTarget, MetricConfig
from agenthub.metrics import all_metrics, get_metric
from agenthub.schemas.common import ok

router = APIRouter(prefix="/api/v1", tags=["targets"])


class TargetCreate(BaseModel):
    name: str
    kind: str = Field(description="http(托管调用) / external(仅回传)")
    endpoint_config: dict = {}


class TargetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    kind: str
    endpoint_config: dict
    created_at: datetime


class MetricSpecIn(BaseModel):
    type: str
    weight: float = 1.0
    threshold: float | None = None
    model_config = ConfigDict(extra="allow")  # 各指标自有参数透传


class MetricConfigCreate(BaseModel):
    name: str
    scene: str
    metrics: list[MetricSpecIn]


class MetricConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    scene: str
    metrics: list[dict]
    created_at: datetime


@router.get("/metrics")
def list_metrics():
    """列出所有注册指标（rule:*/judge:*/rag:*/traj:*），供前端与 CLI 展示。"""
    rows = []
    for name, m in sorted(all_metrics().items()):
        doc = (getattr(m, "__doc__", "") or "").strip().splitlines()
        rows.append({"type": name, "kind": name.split(":")[0], "description": doc[0] if doc else ""})
    return ok(rows)


@router.post("/targets")
def create_target(body: TargetCreate, db: Session = Depends(get_db)):
    if body.kind not in {"http", "external"}:
        raise HTTPException(422, "kind must be http or external")
    if db.query(EvalTarget).filter(EvalTarget.name == body.name).first():
        raise HTTPException(409, f"target '{body.name}' already exists")
    if body.kind == "http" and not body.endpoint_config.get("url"):
        raise HTTPException(422, "http target 需要 endpoint_config.url")
    t = EvalTarget(name=body.name, kind=body.kind, endpoint_config=body.endpoint_config)
    db.add(t)
    db.commit()
    db.refresh(t)
    return ok(TargetOut.model_validate(t).model_dump(mode="json"))


@router.get("/targets")
def list_targets(db: Session = Depends(get_db)):
    rows = db.query(EvalTarget).order_by(EvalTarget.created_at.desc()).all()
    return ok([TargetOut.model_validate(t).model_dump(mode="json") for t in rows])


@router.post("/metric-configs")
def create_metric_config(body: MetricConfigCreate, db: Session = Depends(get_db)):
    if db.query(MetricConfig).filter(MetricConfig.name == body.name).first():
        raise HTTPException(409, f"metric config '{body.name}' already exists")
    for spec in body.metrics:
        try:
            get_metric(spec.type)
        except Exception as e:
            raise HTTPException(422, str(e))
        if spec.threshold is not None:
            spec = spec.model_copy(update={"threshold": spec.threshold})
    mc = MetricConfig(name=body.name, scene=body.scene, metrics=[m.model_dump(exclude_none=True) for m in body.metrics])
    db.add(mc)
    db.commit()
    db.refresh(mc)
    return ok(MetricConfigOut.model_validate(mc).model_dump(mode="json"))


@router.get("/metric-configs")
def list_metric_configs(db: Session = Depends(get_db)):
    rows = db.query(MetricConfig).order_by(MetricConfig.created_at.desc()).all()
    return ok([MetricConfigOut.model_validate(m).model_dump(mode="json") for m in rows])
