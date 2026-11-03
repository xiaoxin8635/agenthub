import json
from collections.abc import Generator

from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session, sessionmaker

from agenthub.config import get_settings


def _json_serializer(obj) -> str:
    # 中文原样存储，保证 LIKE 检索可用
    return json.dumps(obj, ensure_ascii=False)


def make_engine(db_url: str | None = None):
    url = db_url or get_settings().db
    if url.startswith("sqlite"):
        engine = create_engine(
            url,
            connect_args={"check_same_thread": False},
            json_serializer=_json_serializer,
        )

        @event.listens_for(engine, "connect")
        def _sqlite_pragma(dbapi_conn, _record):  # noqa: ANN001
            """WAL：读写并行（执行器写结果时 UI 轮询不阻塞）；busy_timeout 缓解锁竞争。"""
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA journal_mode=WAL")
            cur.execute("PRAGMA busy_timeout=5000")
            cur.execute("PRAGMA synchronous=NORMAL")
            cur.close()

        return engine
    return create_engine(url, json_serializer=_json_serializer)


def make_session_factory(engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


engine = None
SessionLocal: sessionmaker[Session] | None = None

# 旧库补列清单：init 时逐个 ALTER TABLE（列已存在则忽略）
_SQLITE_NEW_COLUMNS = [
    ("eval_runs", "progress", "JSON"),
]


def _migrate_sqlite(db_path: str) -> None:
    import sqlite3

    con = sqlite3.connect(db_path)
    try:
        for table, col, col_type in _SQLITE_NEW_COLUMNS:
            cols = {r[1] for r in con.execute(f"PRAGMA table_info({table})")}
            if cols and col not in cols:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_type}")
        con.commit()
    finally:
        con.close()


def init_db() -> None:
    """按配置初始化全局 engine 并建表；旧库轻量补列（无 alembic，create_all 不改已有表）。"""
    global engine, SessionLocal
    url = get_settings().db
    if url.startswith("sqlite:///") and not url.endswith(":memory:"):
        # 确保数据库文件所在目录存在
        from pathlib import Path

        Path(url.removeprefix("sqlite:///")).parent.mkdir(parents=True, exist_ok=True)
        _migrate_sqlite(url.removeprefix("sqlite:///"))
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
