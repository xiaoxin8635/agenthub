"""托管模式 Runner：后台线程逐条调用被测 Agent HTTP 端点并算分落库。"""
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

import httpx
from sqlalchemy.orm import Session, sessionmaker

from agenthub.config import get_settings
from agenthub.db.base import SessionLocal, make_engine, make_session_factory
from agenthub.db.models import EvalResult, EvalRun
from agenthub.services import eval_service
from agenthub.services.notify import notify_run_finished


class AgentCallError(Exception):
    pass


# Run 级共享连接池：并发调用复用 keep-alive 连接，避免每条 case 重新握手
_HTTP = httpx.Client(
    limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
    timeout=None,  # 超时按次传入
)


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
        r = _HTTP.post(url, json=body, headers=headers, timeout=timeout)
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


def _evaluate_one(metric_specs: list, item: dict, endpoint_config: dict, timeout: float) -> dict:
    """单 case 处理（线程内执行，不触碰 Session）：调 Agent（网络失败自动重试）+ 算分（含 LLM Judge）。"""
    retries = max(0, get_settings().run_retry)
    error = ""
    output: dict = {}
    for attempt in range(retries + 1):
        try:
            output = call_agent(endpoint_config, item, timeout=timeout)
            error = ""
            break
        except AgentCallError as e:
            error = str(e)
    scores, passed, metric_err = eval_service.evaluate_item(metric_specs, item, output)
    return {
        "item_id": item["id"],
        "output": output,
        "trajectory": output.get("trajectory") or {},
        "scores": scores,
        "passed": passed,
        "error": error or metric_err,
    }


def execute_run(run_id: str, session_factory: sessionmaker | None = None) -> None:
    """在线程中执行整个 Run：并发调用 + 算分 + 落库 + 聚合。

    并发仅覆盖网络 IO（Agent 调用 / LLM Judge），DB 写入仍在主线程单事务完成。
    并发度由 AGENTHUB_RUN_CONCURRENCY 控制（默认 4）。
    """
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
        endpoint_config = target.endpoint_config or {}
        timeout = float(endpoint_config.get("timeout", 120))
        metric_specs = mc.metrics

        # 初始化进度（UI 轮询实时读取 run.progress）
        run.progress = {"done": 0, "total": len(item_dicts)}
        db.commit()

        # 并发执行：executor.map 保序返回，Session 只在主线程操作；
        # 每完成一条即 commit（WAL 读写并行，进度实时可见）
        workers = max(1, get_settings().run_concurrency)
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="eval") as pool:
            futures = [
                pool.submit(_evaluate_one, metric_specs, item, endpoint_config, timeout)
                for item in item_dicts
            ]
            done_count = 0
            for fut in futures:
                r = fut.result()
                db.add(EvalResult(
                    run_id=run.id, item_id=r["item_id"], output=r["output"],
                    trajectory=r["trajectory"],
                    scores=r["scores"], passed=r["passed"], error=r["error"],
                ))
                done_count += 1
                run.progress = {"done": done_count, "total": len(item_dicts)}
                db.commit()

        # 收尾：全部结果已在事务中，finalize 聚合一次落库
        eval_service.finalize_run(db, run)
        run.progress = None
        db.commit()
        notify_run_finished(run.id, "done", run.summary or {})
    except Exception:  # noqa: BLE001 — Run 级失败落库，不抛出线程
        db.rollback()
        run = db.get(EvalRun, run_id)
        if run:
            run.status = "failed"
            run.error = traceback.format_exc()[-2000:]
            run.progress = None
            db.commit()
            notify_run_finished(run.id, "failed", {"error": run.error[-300:]})
    finally:
        db.close()


def start_run_async(run_id: str, session_factory: sessionmaker | None = None) -> threading.Thread:
    t = threading.Thread(target=execute_run, args=(run_id, session_factory), daemon=True)
    t.start()
    return t
