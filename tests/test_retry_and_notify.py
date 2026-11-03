# -*- coding: utf-8 -*-
"""case 级重试（http_runner._evaluate_one）与 Webhook 通知（services.notify）单元测试。

纯单元隔离：call_agent / evaluate_item / get_settings / httpx.post 全部注入，
不发真实网络请求。
"""
import time
from types import SimpleNamespace

import httpx
import pytest

from agenthub.runners import http_runner
from agenthub.services import notify


# ---------- 重试逻辑 ----------

@pytest.fixture
def runner_env(monkeypatch):
    """注入隔离环境：统计 call_agent 调用次数，可控前 N 次失败。"""
    env = SimpleNamespace(calls=0, fail_times=0, settings=SimpleNamespace(run_retry=1))
    monkeypatch.setattr(http_runner, "get_settings", lambda: env.settings)
    monkeypatch.setattr(
        http_runner, "eval_service", SimpleNamespace(evaluate_item=lambda specs, item, out: ({}, True, ""))
    )

    def fake_call(cfg, item, timeout):
        env.calls += 1
        if env.calls <= env.fail_times:
            raise http_runner.AgentCallError("boom")
        return {"answer": "ok"}

    monkeypatch.setattr(http_runner, "call_agent", fake_call)
    return env


def test_retry_success_on_second_attempt(runner_env):
    """第 1 次网络失败、重试成功：error 为空，输出正常，共调用 2 次"""
    runner_env.fail_times = 1
    r = http_runner._evaluate_one([], {"id": "i1"}, {}, 1.0)
    assert r["error"] == ""
    assert r["output"] == {"answer": "ok"}
    assert runner_env.calls == 2


def test_retry_exhausted_marks_error(runner_env):
    """重试次数耗尽仍失败：error 记录最后一次异常，调用次数 = 1 + run_retry"""
    runner_env.settings.run_retry = 2
    runner_env.fail_times = 99
    r = http_runner._evaluate_one([], {"id": "i1"}, {}, 1.0)
    assert "boom" in r["error"]
    assert runner_env.calls == 3


def test_no_retry_when_disabled(runner_env):
    """run_retry=0：失败不重试，只调用 1 次"""
    runner_env.settings.run_retry = 0
    runner_env.fail_times = 1
    r = http_runner._evaluate_one([], {"id": "i1"}, {}, 1.0)
    assert "boom" in r["error"]
    assert runner_env.calls == 1


# ---------- Webhook 通知 ----------

def _wait(predicate, timeout_s=2.0):
    """轮询等待异步线程生效（通知走 daemon 线程）。"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_notify_disabled_when_no_url(monkeypatch):
    """webhook_url 为空（默认）：完全不发请求"""
    monkeypatch.setattr(notify, "get_settings", lambda: SimpleNamespace(webhook_url=""))
    calls = []
    monkeypatch.setattr(httpx, "post", lambda *a, **k: calls.append(a))
    notify.notify_run_finished("r1", "done", {"total": 1})
    time.sleep(0.05)  # 给假想的线程时间，若误发必被记录
    assert calls == []


def test_notify_posts_payload(monkeypatch):
    """配置 url 后：POST 到该地址，payload 含 event/run_id/status/summary"""
    monkeypatch.setattr(notify, "get_settings", lambda: SimpleNamespace(webhook_url="http://hook.test"))
    calls = []
    monkeypatch.setattr(httpx, "post", lambda url, json=None, timeout=None: calls.append((url, json)))
    notify.notify_run_finished("r1", "done", {"total": 3})
    assert _wait(lambda: len(calls) == 1)
    url, payload = calls[0]
    assert url == "http://hook.test"
    assert payload == {"event": "run.finished", "run_id": "r1", "status": "done", "summary": {"total": 3}}


def test_notify_silent_on_network_error(monkeypatch):
    """推送失败（网络异常）：静默吞掉，不影响调用方"""
    monkeypatch.setattr(notify, "get_settings", lambda: SimpleNamespace(webhook_url="http://hook.test"))

    def boom(url, json=None, timeout=None):
        raise RuntimeError("net down")

    monkeypatch.setattr(httpx, "post", boom)
    notify.notify_run_finished("r1", "failed", {})  # 不应向调用方抛出
    time.sleep(0.1)  # 等后台线程消化异常
