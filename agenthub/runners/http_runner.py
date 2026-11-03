"""托管模式 Runner：后台线程逐条调用被测 Agent HTTP 端点并算分落库。"""
import threading
import traceback
from datetime import datetime

import httpx
from sqlalchemy.orm import Session, sessionmaker

from agenthub.db.base import SessionLocal, make_engine, make_session_factory
from agenthub.db.models import EvalResult, EvalRun
from agenthub.services import eval_service


class AgentCallError(Exception):
    pass


def call_agent(endpoint_config: dict, item: dict, timeout: float = 120.0) -> dict:
    """调用被测 Agent HTTP 端点，返回标准化 output dict：{"answer": ..., "trajectory": {...}}。"""
    url = endpoint_config.get("url")
    if not url:
        raise AgentCallError("target.endpoint_config.url 未配置")
    body = {
        "item_id": item["id"],
        "input": item.get("input"),
        "context": item.get("context") or {},
    }
    headers = endpoint_config.get("headers") or {}
    try:
        r = httpx.post(url, json=body, headers=headers, timeout=timeout)
        r.raise_for_status()
        resp = r.json()
    except httpx.HTTPError as e:
        raise AgentCallError(f"agent endpoint 调用失败: {e}") from e
    except ValueError as e:
        raise AgentCallError(f"agent endpoint 返回非 JSON: {e}") from e

    if isinstance(resp, dict) and "output" in resp:  # 标准协议 {"output":..., "trajectory":...}
        out = resp["output"]
        if isinstance(out, dict):
            out.setdefault("trajectory", resp.get("trajectory") or {})
        return out if isinstance(out, dict) else {"answer": out}
    if isinstance(resp, dict) and "answer" in resp:  # 直接返回 answer 字段
        return resp
    return {"answer": resp if isinstance(resp, str) else resp}  # 其余整体作为 answer


def execute_run(run_id: str, session_factory: sessionmaker | None = None) -> None:
    """在线程中执行整个 Run：逐条调用 + 算分 + 落库 + 聚合。"""
    factory = session_factory or SessionLocal
    if factory is None:
        factory = make_session_factory(make_engine())
    db: Session = factory()
    try:
        run = db.get(EvalRun, run_id)
        if not run:
            return
        run.status = "running"
        run.started_at = datetime.now()
        db.commit()

        target = run.target
        mc = run.metric_config
        items = eval_service.load_snapshot_items(db, run.dataset_version)
        item_dicts = [
            {"id": it.id, "input": it.input, "expected": it.expected,
             "context": it.context, "tags": it.tags}
            for it in items
        ]

        for item in item_dicts:
            error = ""
            output: dict = {}
            try:
                output = call_agent(target.endpoint_config or {}, item,
                                    timeout=float((target.endpoint_config or {}).get("timeout", 120)))
            except AgentCallError as e:
                error = str(e)
            scores, passed, metric_err = eval_service.evaluate_item(mc.metrics, item, output)
            error = error or metric_err
            db.add(EvalResult(
                run_id=run.id, item_id=item["id"], output=output,
                trajectory=output.get("trajectory") or {},
                scores=scores, passed=passed, error=error,
            ))

        # 整个 Run 单事务提交：flush 使本事务内可查询，finalize 聚合后一次落库
        db.flush()
        eval_service.finalize_run(db, run)
        db.commit()
    except Exception:  # noqa: BLE001 — Run 级失败落库，不抛出线程
        db.rollback()
        run = db.get(EvalRun, run_id)
        if run:
            run.status = "failed"
            run.error = traceback.format_exc()[-2000:]
            db.commit()
    finally:
        db.close()


def start_run_async(run_id: str, session_factory: sessionmaker | None = None) -> threading.Thread:
    t = threading.Thread(target=execute_run, args=(run_id, session_factory), daemon=True)
    t.start()
    return t
