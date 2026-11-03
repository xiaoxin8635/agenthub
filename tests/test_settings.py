"""UI-501/502：GET /api/v1/settings 服务端配置只读视图（密钥打码 + 鉴权保护）。"""
import pytest
from fastapi.testclient import TestClient

from agenthub.config import get_settings
from agenthub.main import app
from agenthub.routers.settings import _mask


class TestMask:
    def test_mask_rules(self):
        assert _mask("") == ""
        assert _mask("short") == "****"
        masked = _mask("sk-1234567890abcdef")
        assert masked.startswith("sk-1") and masked.endswith("cdef") and "****" in masked


@pytest.fixture
def llm_env(monkeypatch):
    """注入 LLM 配置并重置 get_settings 缓存（结束后再清一次防污染其他测试）。"""
    monkeypatch.setenv("AGENTHUB_LLM_BASE_URL", "https://api.example.com/v1")
    monkeypatch.setenv("AGENTHUB_LLM_API_KEY", "sk-super-secret-key")
    monkeypatch.setenv("AGENTHUB_LLM_MODEL", "gpt-4o-mini")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class TestSettingsEndpoint:
    def test_shape_and_dev_values(self, client):
        data = client.get("/api/v1/settings").json()["data"]
        # conftest 设置了 AGENTHUB_API_KEY=test-key，LLM 未配置
        assert data["auth_enabled"] is True
        assert data["api_key"] == "test-key"
        assert data["llm_judge"] == {
            "configured": False,
            "base_url": "",
            "model": "",
            "api_key_masked": "",
        }
        assert data["data_dir"]
        assert "cors_origins" in data and "db" in data

    def test_llm_masked_when_configured(self, client, llm_env):
        judge = client.get("/api/v1/settings").json()["data"]["llm_judge"]
        assert judge["configured"] is True
        assert judge["base_url"] == "https://api.example.com/v1"
        assert judge["model"] == "gpt-4o-mini"
        assert judge["api_key_masked"] == "sk-s****-key"
        assert "super-secret" not in judge["api_key_masked"]

    def test_requires_api_key(self):
        assert TestClient(app).get("/api/v1/settings").status_code == 401
