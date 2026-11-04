from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

ASSET_TYPES = {"dialog", "trace", "tool_log", "doc", "custom"}
ASSET_SOURCES = {"manual", "trace_import", "badcase_feedback", "ai_generated"}


class AssetCreate(BaseModel):
    type: str = Field(description="dialog/trace/tool_log/doc/custom")
    content: dict[str, Any]
    tags: list[str] = []
    meta: dict[str, Any] = {}
    source: str = "manual"


class AssetPatch(BaseModel):
    tags: list[str] | None = None
    meta: dict[str, Any] | None = None


class AssetOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    type: str
    source: str
    content: dict[str, Any]
    tags: list[str]
    meta: dict[str, Any]
    created_at: datetime


class AssetListOut(BaseModel):
    total: int
    items: list[AssetOut]


class AssetImportItem(BaseModel):
    type: str
    content: dict[str, Any]
    tags: list[str] = []
    meta: dict[str, Any] = {}


class AssetImportResult(BaseModel):
    total: int
    created: int
    skipped: int
