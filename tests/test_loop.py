"""M5 闭环测试：badcase 回灌、Run 对比、/metrics 端点、CLI 全链路（经 live server）。"""
import json
import threading
import time

import pytest
import uvicorn

from agenthub.cli import main as cli_main

QA_ITEMS = [
    {"input": {"question": "退货怎么算运费"}, "expected": {"answer": "质量问题商家承担"}, "tags": ["退款"]},
    {"input": {"question": "发货多久"}, "expected": {"answer": "48小时"}, "tags": ["物流"]},
]
METRICS = [
    {"type": "rule:exact", "actual": "answer", "expected_path": "expected.answer", "weight": 2},
    {"type": "rule:contains", "actual": "answer", "expected_path": "expected.answer", "weight": 1},
]


@pytest.fixture
def eval_env(client):
    """已发布的数据集版本 + external target + metric config（回传模式手工控制结果）。"""
    ds = client.post("/api/v1/datasets", json={"name": "loop-ds", "scene": "qa"}).json()["data"]
    client.post(f"/api/v1/datasets/{ds['id']}/items", json={"items": QA_ITEMS})
    ver = client.post(f"/api/v1/datasets/{ds['id']}/versions", json={"changelog": "v1"}).json()["data"]
    target = client.post("/api/v1/targets", json={"name": "ext-agent", "kind": "external"}).json()["data"]
    mc = client.post("/api/v1/metric-configs", json={"name": "qa-basic", "scene": "qa", "metrics": METRICS}).json()["data"]
    items = client.get(f"/api/v1/datasets/{ds['id']}/items", params={"version": 1}).json()["data"]["items"]
    return {"ds": ds, "ver": ver, "target": target, "mc": mc, "item_ids": [it["id"] for it in items]}


def _make_run(client, env, answers: list[str], agent_version: str = "") -> str:
    """回传模式创建并收齐一个 run，answers 与 item 顺序对应。返回 run_id。"""
    run = client.post("/api/v1/runs", json={
        "dataset_version_id": env["ver"]["id"], "target_id": env["target"]["id"],
        "metric_config_id": env["mc"]["id"], "agent_version": agent_version,
    }).json()["data"]
    r = client.post(f"/api/v1/runs/{run['id']}/results", json={"results": [
        {"item_id": iid, "output": {"answer": ans}}
        for iid, ans in zip(env["item_ids"], answers)
    ]})
    assert r.json()["data"]["done"] is True
    return run["id"]


class TestMetricsEndpoint:
    def test_list_metrics(self, client):
        data = client.get("/api/v1/metrics").json()["data"]
        types = {m["type"] for m in data}
        assert "rule:exact" in types and "judge:correctness" in types
        by_type = {m["type"]: m for m in data}
        assert by_type["rule:exact"]["kind"] == "rule"
        assert by_type["rule:exact"]["description"]


class TestFeedback:
    def test_feedback_flow(self, client, eval_env):
        env = eval_env
        run_id = _make_run(client, env, answers=["质量问题商家承担", "大概48小时"])  # 1 过 1 败

        # 回灌（不指定数据集）
        r = client.post(f"/api/v1/runs/{run_id}/feedback", json={"tags": ["regression", "客服agent"]})
        assert r.status_code == 200
        body = r.json()["data"]
        assert body == {"failed_cases": 1, "created_assets": 1, "skipped_dup": 0, "added_items": 0}

        # 资产内容为结构化直通格式
        assets = client.get("/api/v1/assets", params={"source": "badcase_feedback"}).json()["data"]
        assert assets["total"] == 1
        content = assets["items"][0]["content"]
        assert content["input"]["question"] == "发货多久"
        assert content["agent_output"] == {"answer": "大概48小时"}
        assert content["run_id"] == run_id
        assert "run:" + run_id in assets["items"][0]["tags"]
        assert assets["items"][0]["meta"]["source_item_id"] == env["item_ids"][1]

        # 重复回灌 → 内容级去重
        body = client.post(f"/api/v1/runs/{run_id}/feedback", json={}).json()["data"]
        assert body["skipped_dup"] == 1 and body["created_assets"] == 0

        # 回灌到数据集 → 转入草稿
        body = client.post(f"/api/v1/runs/{run_id}/feedback", json={"dataset": "loop-ds"}).json()["data"]
        assert body["added_items"] == 1
        drafts = client.get(f"/api/v1/datasets/{env['ds']['id']}/items", params={"draft": True}).json()["data"]
        assert drafts["total"] == 1
        assert drafts["items"][0]["tags"] and "badcase" in drafts["items"][0]["tags"]

    def test_feedback_unknown_dataset_404(self, client, eval_env):
        env = eval_env
        run_id = _make_run(client, env, answers=["错", "也错"])
        r = client.post(f"/api/v1/runs/{run_id}/feedback", json={"dataset": "ghost"})
        assert r.status_code == 404

    def test_feedback_no_failures(self, client, eval_env):
        env = eval_env
        run_id = _make_run(client, env, answers=["质量问题商家承担", "48小时"])
        body = client.post(f"/api/v1/runs/{run_id}/feedback", json={}).json()["data"]
        assert body["failed_cases"] == 0 and body["created_assets"] == 0


class TestCompare:
    def test_compare_regressions_and_fixed(self, client, eval_env):
        env = eval_env
        run_a = _make_run(client, env, answers=["质量问题商家承担", "大概48小时"], agent_version="v1")  # 1过1败
        run_b = _make_run(client, env, answers=["质量问题商家承担", "48小时"], agent_version="v2")  # 全过

        data = client.get(f"/api/v1/runs/{run_a}/compare/{run_b}").json()["data"]
        assert data["base_run"] == run_a and data["compare_run"] == run_b
        assert data["common_items"] == 2
        # exact: 0.5 -> 1.0，delta +0.5；weighted: 2/3 -> 1.0
        assert data["metric_diff"]["rule:exact"]["delta"] == 0.5
        assert abs(data["weighted_total"]["delta"] - 1 / 3) < 1e-3
        assert data["regressions"] == []
        assert [f["item_id"] for f in data["fixed"]] == [env["item_ids"][1]]
        assert data["both_passed"] == 1 and data["both_failed"] == 0

        # 反向对比：v2 vs v1 → 回归
        data = client.get(f"/api/v1/runs/{run_b}/compare/{run_a}").json()["data"]
        assert [r["item_id"] for r in data["regressions"]] == [env["item_ids"][1]]
        assert data["regressions"][0]["compare_output"] == {"answer": "大概48小时"}
        assert data["fixed"] == []

    def test_compare_both_failed_and_passed(self, client, eval_env):
        env = eval_env
        run_a = _make_run(client, env, answers=["质量问题商家承担", "错答案"])  # 1过1败
        run_c = _make_run(client, env, answers=["胡说", "48小时"])  # 1败1过，交叉
        data = client.get(f"/api/v1/runs/{run_a}/compare/{run_c}").json()["data"]
        assert len(data["regressions"]) == 1 and len(data["fixed"]) == 1
        assert data["both_passed"] == 0 and data["both_failed"] == 0

    def test_compare_404(self, client, eval_env):
        env = eval_env
        run_id = _make_run(client, env, answers=["a", "b"])
        assert client.get(f"/api/v1/runs/{run_id}/compare/ghost").status_code == 404


# ---------- CLI（live server + in-process main） ----------

@pytest.fixture(scope="module")
def live_server():
    """CLI 用同步 httpx，起真实服务线程（依赖 conftest 的内存库覆盖，端口避开 test_supply 的 8399）。"""
    from agenthub.main import app

    config = uvicorn.Config(app, host="127.0.0.1", port=8398, log_level="warning")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(50):
        if server.started:
            break
        time.sleep(0.1)
    yield "http://127.0.0.1:8398"
    server.should_exit = True
    t.join(timeout=5)


def _cli(argv: list[str], capsys, expect_rc: int = 0) -> dict:
    rc = cli_main(argv)
    captured = capsys.readouterr()
    assert rc == expect_rc, f"rc={rc}, stderr={captured.err}"
    return json.loads(captured.out)


class TestCLI:
    """全链路：import → dataset-create → select → publish → pull → eval ×2 → run-show → feedback → compare → metrics。"""

    @pytest.fixture
    def setup_env(self, client, live_server):
        """client 先清表；再经 API 建 http target 与 metric config（CLI 不负责低频配置）。"""
        target = client.post("/api/v1/targets", json={
            "name": "fake-agent", "kind": "http", "endpoint_config": {"url": "http://127.0.0.1:1/agent"},
        }).json()["data"]
        mc = client.post("/api/v1/metric-configs", json={"name": "qa-mc", "scene": "qa", "metrics": METRICS}).json()["data"]
        return {"base": live_server, "api_key": "test-key", "target": target, "mc": mc}

    def _args(self, env, *rest):
        return ["--base-url", env["base"], "--api-key", env["api_key"], *rest]

    def test_full_chain(self, client, setup_env, capsys, tmp_path, monkeypatch, session_factory):
        env = setup_env
        ds_name = f"cli-{__import__('uuid').uuid4().hex[:6]}"  # 随机名：避免与磁盘残留快照同名冲突

        # 1. import 资产（JSONL）
        import_file = tmp_path / "traces.jsonl"
        rows = [
            {"type": "dialog", "content": {"question": "退货怎么算运费", "answer": "质量问题商家承担"}, "tags": ["退款"]},
            {"type": "dialog", "content": {"question": "发货多久", "answer": "48小时"}, "tags": ["物流"]},
        ]
        import_file.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
        out = _cli(self._args(env, "import", str(import_file), "--source", "trace_import", "--tags", "批次1"), capsys)
        assert out["created"] == 2 and out["skipped"] == 0

        # 2. dataset-create + select + publish
        _cli(self._args(env, "dataset-create", ds_name, "qa", "--description", "CLI 冒烟"), capsys)
        out = _cli(self._args(env, "dataset-select", ds_name, "--filters", "source=trace_import"), capsys)
        assert out["added"] == 2
        out = _cli(self._args(env, "dataset-publish", ds_name, "--changelog", "v1 首批"), capsys)
        assert out["version"] == 1

        # 3. pull（SDK，写文件；用独立缓存目录避免命中真实用户缓存）
        out_file = tmp_path / "ds.json"
        out = _cli(self._args(env, "pull", f"{ds_name}@1", "-o", str(out_file), "--cache-dir", str(tmp_path / "cache")), capsys)
        assert out["items"] == 2 and out["from_cache"] is False
        assert len(json.loads(out_file.read_text(encoding="utf-8"))) == 2

        # 4. eval 托管模式 ×2（monkeypatch call_agent，第一次 1 过 1 败，第二次全过）
        from agenthub.runners import http_runner

        # live server 的 Runner 后台线程不走 get_db 覆盖，须把其 SessionLocal 指到测试内存库
        monkeypatch.setattr(http_runner, "SessionLocal", session_factory)

        canned = {"mode": "mixed"}

        def fake_call(endpoint_config, item, timeout=120.0):
            if canned["mode"] == "mixed" and item["input"]["question"] == "发货多久":
                return {"answer": "大概48小时能发货"}  # contains 过，exact 败
            return {"answer": "质量问题商家承担" if item["input"]["question"] == "退货怎么算运费" else "48小时"}

        monkeypatch.setattr(http_runner, "call_agent", fake_call)
        run_a = _cli(self._args(env, "eval", f"{ds_name}@1", "--target", "fake-agent", "--metrics", "qa-mc",
                                "--agent-version", "v1", "--wait", "--timeout", "20"), capsys)
        assert run_a["status"] == "done"
        assert run_a["summary"]["passed"] == 1 and run_a["summary"]["total"] == 2, json.dumps(run_a, ensure_ascii=False)

        canned["mode"] = "all-pass"
        run_b = _cli(self._args(env, "eval", ds_name, "--target", "fake-agent", "--metrics", "qa-mc",
                                "--agent-version", "v2"), capsys)  # 不带 @N 走最新版
        assert run_b["status"] == "done" and run_b["summary"]["passed"] == 2

        # 5. run-show（含失败明细）
        out = _cli(self._args(env, "run-show", run_a["run_id"], "--failures"), capsys)
        assert out["status"] == "done"
        assert len(out["failed_results"]) == 1
        assert out["failed_results"][0]["item_id"]

        # 6. feedback 回灌到数据集
        out = _cli(self._args(env, "feedback", run_a["run_id"], "--dataset", ds_name, "--tags", "regression"), capsys)
        assert out["failed_cases"] == 1 and out["added_items"] == 1
        all_ds = client.get("/api/v1/datasets").json()["data"]
        ds_id = next(d["id"] for d in all_ds if d["name"] == ds_name)
        drafts = client.get(f"/api/v1/datasets/{ds_id}/items", params={"draft": True}).json()["data"]
        assert drafts["total"] == 1

        # 7. compare
        out = _cli(self._args(env, "compare", run_a["run_id"], run_b["run_id"]), capsys)
        assert out["common_items"] == 2
        assert out["metric_diff"]["rule:exact"]["delta"] == 0.5
        assert len(out["fixed"]) == 1 and out["regressions"] == []

        # 8. metrics list
        out = _cli(self._args(env, "metrics", "list"), capsys)
        assert "rule:exact" in {m["type"] for m in out}

    def test_error_returns_nonzero(self, setup_env, capsys):
        env = setup_env
        argv = self._args(env, "eval", "ghost-ds", "--target", "fake-agent", "--metrics", "qa-mc")
        rc = cli_main(argv)
        captured = capsys.readouterr()
        assert rc == 1 and "ghost-ds" in captured.err

    def test_unknown_target_fails(self, setup_env, capsys):
        env = setup_env
        # dataset 没有版本 → 先报无版本
        _cli(self._args(env, "dataset-create", "empty-ds", "qa"), capsys)
        rc = cli_main(self._args(env, "eval", "empty-ds", "--target", "fake-agent", "--metrics", "qa-mc"))
        captured = capsys.readouterr()
        assert rc == 1 and "no versions" in captured.err
