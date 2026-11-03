from fastapi import Header, HTTPException

from agenthub.config import get_settings


def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """单 API Key 鉴权；未配置 AGENTHUB_API_KEY 时为开发模式，放行。"""
    expected = get_settings().api_key
    if expected and x_api_key != expected:
        raise HTTPException(401, "invalid or missing X-API-Key")
