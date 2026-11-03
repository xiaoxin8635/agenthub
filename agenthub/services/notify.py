# -*- coding: utf-8 -*-
"""Run 事件通知：完成后向配置的 Webhook URL 推送结果（可选，AGENTHUB_WEBHOOK_URL）。"""
import threading

import httpx

from agenthub.config import get_settings


def notify_run_finished(run_id: str, status: str, summary: dict) -> None:
    """异步推送，失败静默（不影响评测主流程）。"""
    url = get_settings().webhook_url
    if not url:
        return
    payload = {
        "event": "run.finished",
        "run_id": run_id,
        "status": status,  # done / failed
        "summary": summary,
    }

    def _post():
        try:
            httpx.post(url, json=payload, timeout=10)
        except Exception:
            pass

    threading.Thread(target=_post, daemon=True).start()
