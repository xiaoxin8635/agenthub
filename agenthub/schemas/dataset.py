import re
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from agenthub.schemas.scenes import SCENES

DATASET_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,62}$")


class DatasetCreate(BaseModel):
    name: str = Field(description="小写字母/数字/中划线，如 order-agent-regression")
    scene: str
    description: str = ""


class DatasetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    scene: str
    description: str
    draft_count: int = 0
    total_items: int = 0
    latest_version: int | None = None
    created_at: datetime


class DatasetItemCreate(BaseModel):
    input: dict[str, Any]
    expected: dict[str, Any] = {}
    context: dict[str, Any] = {}
    tags: list[str] = []
    source_asset_id: str | None = None


class AddItemsRequest(BaseModel):
    items: list[DatasetItemCreate]
    skip_invalid: bool = False  # True 时跳过非法项并上报，False 时整批拒绝


class AddItemsResult(BaseModel):
    added: int
    skipped_invalid: int
    skipped_dup: int
    errors: list[str] = []


class FromAssetsRequest(BaseModel):
    asset_ids: list[str] = []  # 二选一：直接圈定资产
    filters: dict[str, Any] = {}  # 或过滤条件 {type, source, tag, q, limit}
    tags: list[str] = []  # 附加到生成 items 的标签
    skip_invalid: bool = True  # 圈选默认跳过无法映射/非法的资产


class DatasetItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    input: dict[str, Any]
    expected: dict[str, Any]
    context: dict[str, Any]
    tags: list[str]
    source_asset_id: str | None
    version_id: str | None
    created_at: datetime


class ItemListOut(BaseModel):
    total: int
    items: list[DatasetItemOut]


class PublishRequest(BaseModel):
    changelog: str = ""
    skip_invalid: bool = False


class DatasetVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    dataset_id: str
    version: int
    item_count: int
    stats: dict[str, Any]
    changelog: str
    snapshot_path: str
    created_at: datetime


class VersionListOut(BaseModel):
    total: int
    items: list[DatasetVersionOut]


def check_scene(scene: str) -> str | None:
    return None if scene in SCENES else f"scene must be one of {sorted(SCENES)}"


def check_name(name: str) -> str | None:
    return None if DATASET_NAME_RE.match(name) else "name must match ^[a-z0-9][a-z0-9_-]{1,62}$"
