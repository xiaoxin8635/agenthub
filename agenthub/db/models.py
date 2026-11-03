import ulid
from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def new_id() -> str:
    return str(ulid.ULID())  # 26 位可排序 ULID


class Base(DeclarativeBase):
    pass


# ---------- 资产层 ----------


class Asset(Base):
    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    type: Mapped[str] = mapped_column(String(20), index=True)  # dialog/trace/tool_log/doc/custom
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual/trace_import/badcase_feedback
    content: Mapped[dict] = mapped_column(JSON)
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(DateTime, server_default=func.now())


# ---------- 数据集层 ----------


class Dataset(Base):
    __tablename__ = "datasets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    scene: Mapped[str] = mapped_column(String(20))  # qa/rag/tool_call/multi_turn/trajectory
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(DateTime, server_default=func.now())


class DatasetVersion(Base):
    __tablename__ = "dataset_versions"
    __table_args__ = (UniqueConstraint("dataset_id", "version", name="uq_dataset_version"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    snapshot_path: Mapped[str] = mapped_column(Text, default="")
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    changelog: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(20), default="published")
    created_at: Mapped[str] = mapped_column(DateTime, server_default=func.now())


class DatasetItem(Base):
    __tablename__ = "dataset_items"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    dataset_id: Mapped[str] = mapped_column(ForeignKey("datasets.id"), index=True)  # 归属数据集（草稿也归属）
    version_id: Mapped[str | None] = mapped_column(ForeignKey("dataset_versions.id"), index=True, nullable=True)  # NULL = 草稿；否则=首次引入的版本
    source_asset_id: Mapped[str | None] = mapped_column(ForeignKey("assets.id"), nullable=True)
    input: Mapped[dict] = mapped_column(JSON)
    expected: Mapped[dict] = mapped_column(JSON, default=dict)
    context: Mapped[dict] = mapped_column(JSON, default=dict)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[str] = mapped_column(DateTime, server_default=func.now())


# ---------- 评测层 ----------


class EvalTarget(Base):
    __tablename__ = "eval_targets"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(20))  # http/external
    endpoint_config: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(DateTime, server_default=func.now())


class MetricConfig(Base):
    __tablename__ = "metric_configs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    scene: Mapped[str] = mapped_column(String(20))
    metrics: Mapped[list] = mapped_column(JSON)  # [{"type": "rule:exact", ...}, ...]
    created_at: Mapped[str] = mapped_column(DateTime, server_default=func.now())


class EvalRun(Base):
    __tablename__ = "eval_runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    dataset_version_id: Mapped[str] = mapped_column(ForeignKey("dataset_versions.id"), index=True)
    target_id: Mapped[str] = mapped_column(ForeignKey("eval_targets.id"), index=True)
    metric_config_id: Mapped[str] = mapped_column(ForeignKey("metric_configs.id"), index=True)
    agent_version: Mapped[str] = mapped_column(String(100), default="")
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)  # pending/running/done/failed
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[str | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[str | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[str] = mapped_column(DateTime, server_default=func.now())

    dataset_version = relationship("DatasetVersion")
    target = relationship("EvalTarget")
    metric_config = relationship("MetricConfig")


class EvalResult(Base):
    __tablename__ = "eval_results"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("eval_runs.id"), index=True)
    item_id: Mapped[str] = mapped_column(String(32), index=True)
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    trajectory: Mapped[dict] = mapped_column(JSON, default=dict)
    scores: Mapped[dict] = mapped_column(JSON, default=dict)  # {"rule:exact": 1.0, ...}
    passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(DateTime, server_default=func.now())
