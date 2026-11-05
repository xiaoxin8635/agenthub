import json
import os
import sys
import tempfile
from pathlib import Path

os.environ.setdefault("AGENTHUB_API_KEY", "test-key")

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk"))  # agenthub_sdk 可导入

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from agenthub.db.base import get_db
from agenthub.db.models import Base
from agenthub.main import app

# 临时文件库（而非内存+StaticPool）：Runner 后台线程与 HTTP 请求需要各自独立连接，
# 单连接 StaticPool 上任何 session close/rollback 都会连带回滚其他线程未提交的事务。
_test_db = Path(tempfile.mkdtemp(prefix="agenthub-test-")) / "test.db"
engine = create_engine(
    f"sqlite:///{_test_db}",
    connect_args={"check_same_thread": False},
    json_serializer=lambda o: json.dumps(o, ensure_ascii=False),
)
TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
Base.metadata.create_all(engine)


def override_get_db():
    db = TestingSession()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db

HEADERS = {"X-API-Key": "test-key"}


@pytest.fixture(autouse=True)
def _isolated_llm_judge(monkeypatch):
    """隔离 .env 的 LLM Judge 配置：单测不依赖外网 LLM（judge 指标应记 N/A）。"""
    from agenthub.config import get_settings

    monkeypatch.setattr(get_settings(), "llm_base_url", "", raising=False)
    monkeypatch.setattr(get_settings(), "llm_api_key", "", raising=False)
    monkeypatch.setattr(get_settings(), "llm_model", "", raising=False)


@pytest.fixture
def client():
    # 每个测试前清空所有表
    with TestingSession() as db:
        for table in reversed(Base.metadata.sorted_tables):
            db.execute(table.delete())
        db.commit()
    return TestClient(app, headers=HEADERS)


@pytest.fixture
def session_factory():
    """与 app 覆盖的 get_db 同源的会话工厂（供 Runner 等直接使用）。

    注意：测试里不要 `from tests.conftest import ...` —— tests/ 无 __init__.py 时
    会创建第二个 conftest 模块实例，得到另一个空内存库。
    """
    return TestingSession
