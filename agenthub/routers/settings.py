"""服务端配置只读视图（GET /api/v1/settings，UI-501/502）。

LLM 密钥永远打码；API Key 明文返回供控制台「打码显示 + 一键复制」——
端点本身受同一 API Key 鉴权保护，语义等同「持有 Key 者可见 Key」。
"""
from fastapi import APIRouter, Depends

from agenthub.config import Settings, get_settings
from agenthub.schemas.common import ok

router = APIRouter(prefix="/api/v1/settings", tags=["settings"])


def _mask(secret: str) -> str:
    if not secret:
        return ""
    if len(secret) <= 8:
        return "****"
    return f"{secret[:4]}****{secret[-4:]}"


@router.get("")
def show(settings: Settings = Depends(get_settings)):
    return ok({
        "auth_enabled": bool(settings.api_key),
        "api_key": settings.api_key,
        "llm_judge": {
            "configured": bool(settings.llm_base_url and settings.llm_model),
            "base_url": settings.llm_base_url,
            "model": settings.llm_model,
            "api_key_masked": _mask(settings.llm_api_key),
        },
        "data_dir": settings.data_dir,
        "db": settings.db,
        "cors_origins": settings.cors_origins,
        "run_concurrency": settings.run_concurrency,
    })
