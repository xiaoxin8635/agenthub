import json
from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from agenthub.config import get_settings


def _json_serializer(obj) -> str:
    # 中文原样存储，保证 LIKE 检索可用
    return json.dumps(obj, ensure_ascii=False)


def make_engine(db_url: str | None = None):
    url = db_url or get_settings().db
    if url.startswith("sqlite"):
        return create_engine(
            url,
            connect_args={"check_same_thread": False},
            json_serializer=_json_serializer,
        )
    return create_engine(url, json_serializer=_json_serializer)


def make_session_factory(engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


engine = None
SessionLocal: sessionmaker[Session] | None = None


def init_db() -> None:
    """按配置初始化全局 engine 并建表。"""
    global engine, SessionLocal
    url = get_settings().db
    if url.startswith("sqlite:///") and not url.endswith(":memory:"):
        # 确保数据库文件所在目录存在
        from pathlib import Path

        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
    engine = make_engine(url)
    SessionLocal = make_session_factory(engine)
    from agenthub.db.models import Base

    Base.metadata.create_all(engine)


def get_db() -> Generator[Session, None, None]:
    assert SessionLocal is not None, "init_db() not called"
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
