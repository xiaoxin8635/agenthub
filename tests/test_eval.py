"""M4 评测流程测试：targets/metric-configs、回传模式全流程、托管 Runner、聚合。"""
import pytest

from agenthub.services import eval_service

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
    """已发布的数据集版本 + target + metric config，返回 dict。"""
    ds = client.post("/api/v1/datasets", json={"name": "eval-ds", "scene": "qa"}).json()["data"]
    r = client.post(f"/api/v1/datasets/{ds['id']}/items", json={"items": QA_ITEMS})
    assert r.json()["data"]["added"] == 2
    ver = client.post(f"/api/v1/datasets/{ds['id']}/versions", json={"changelog": "v1"}).json()["data"]
    target = client.post("/api/v1/targets", json={
        "name": "my-agent", "kind": "external",
        "endpoint_config": {"owner": "qa-team"},
    }).json()["data"]
    mc = client.post("/api/v1/metric-configs", json={
        "name": "qa-basic", "scene": "qa", "metrics": METRICS,
    }).json()["data"]
    return {"ds": ds, "ver": ver, "target": target, "mc": mc}


class TestTargetsAndConfigs:
    def test_create_target_validations(self, client):
        assert client.post("/api/v1/targets", json={"name": "t1", "kind": "bad"}).status_code == 422
        assert client.post("/api/v1/targets", json={"name": "t1", "kind": "http"}).status_code == 422  # 无 url
        r = client.post("/api/v1/targets", json={"name": "t1", "kind": "http", "endpoint_config": {"url": "http://x/agent"}})
        assert r.status_code == 200
        assert client.post("/api/v1/targets", json={"name": "t1", "kind": "http", "endpoint_config": {"url": "u"}}).status_code == 409

    def test_metric_config_unknown_type_422(self, client):
        r = client.post("/api/v1/metric-configs", json={
            "name": "bad", "scene": "qa", "metrics": [{"type": "rule:nope"}],
        })
        assert r.status_code == 422


class TestCallbackMode:
    def test_full_flow_and_summary(self, client, eval_env):
        env = eval_env
        run = client.post("/api/v1/runs", json={
            "dataset_version_id": env["ver"]["id"], "target_id": env["target"]["id"],
            "metric_config_id": env["mc"]["id"], "agent_version": "v1.0",
        }).json()["data"]

        item_ids = [r["id"] for r in client.get(
            f"/api/v1/datasets/{env['ds']['id']}/items", params={"version": 1}).json()["data"]["items"]]

        # 第一条：完全正确（exact 1.0 权重2 + contains 1.0 权重1）→ passed
        r = client.post(f"/api/v1/runs/{run['id']}/results", json={"results": [
            {"item_id": item_ids[0], "output": {"answer": "质量问题商家承担"}},
        ]})
        body = r.json()["data"]
        assert body == {"received": 1, "expected": 2, "done": False}

        # 第二条：含关键词但非精确（exact 0 + contains 1）→ passed False；重复回传第一条应幂等跳过
        r = client.post(f"/api/v1/runs/{run['id']}/results", json={"results": [
            {"item_id": item_ids[1], "output": {"answer": "大概48小时能发货"}},
            {"item_id": item_ids[0], "output": {"answer": "重复的应该被忽略"}},
        ]})
        assert r.json()["data"]["done"] is True

        run_data = client.get(f"/api/v1/runs/{run['id']}").json()["data"]
        assert run_data["status"] == "done"
        s = run_data["summary"]
        assert s["total"] == 2 and s["passed"] == 1 and s["pass_rate"] == 0.5
        assert s["metrics"]["rule:exact"]["avg"] == 0.5
        assert s["metrics"]["rule:contains"]["avg"] == 1.0
        # 加权总分 = (0.5*2 + 1.0*1) / 3 = 0.6667
        assert abs(s["weighted_total"] - 0.6667) < 1e-3

        # 失败项过滤
        fails = client.get(f"/api/v1/runs/{run['id']}/results", params={"passed": False}).json()["data"]
        assert fails["total"] == 1 and fails["items"][0]["item_id"] == item_ids[1]

    def test_unknown_item_422(self, client, eval_env):
        env = eval_env
        run = client.post("/api/v1/runs", json={
            "dataset_version_id": env["ver"]["id"], "target_id": env["target"]["id"],
            "metric_config_id": env["mc"]["id"],
        }).json()["data"]
        r = client.post(f"/api/v1/runs/{run['id']}/results", json={"results": [{"item_id": "ghost"}]})
        assert r.status_code == 422

    def test_done_run_rejects_409(self, client, eval_env):
        env = eval_env
        run = client.post("/api/v1/runs", json={
            "dataset_version_id": env["ver"]["id"], "target_id": env["target"]["id"],
            "metric_config_id": env["mc"]["id"],
        }).json()["data"]
        item_ids = [r["id"] for r in client.get(
            f"/api/v1/datasets/{env['ds']['id']}/items", params={"version": 1}).json()["data"]["items"]]
        client.post(f"/api/v1/runs/{run['id']}/results", json={"results": [
            {"item_id": i, "output": {"answer": "x"}} for i in item_ids]})
        r = client.post(f"/api/v1/runs/{run['id']}/results", json={"results": [{"item_id": item_ids[0]}]})
        assert r.status_code == 409


class TestManagedRunner:
    def test_execute_run_with_stub_agent(self, client, eval_env, monkeypatch, session_factory):
        """monkeypatch call_agent 模拟托管执行（避免真实 HTTP）。"""
        from agenthub.runners import http_runner

        env = eval_env
        run = client.post("/api/v1/runs", json={
            "dataset_version_id": env["ver"]["id"], "target_id": env["target"]["id"],
            "metric_config_id": env["mc"]["id"], "agent_version": "v2",
        }).json()["data"]

        canned = {"answer": "质量问题商家承担"}

        def fake_call(endpoint_config, item, timeout=120.0):
            return dict(canned)  # 两题都答第一题的标准答案 → 1 过 1 不过

        monkeypatch.setattr(http_runner, "call_agent", fake_call)
        http_runner.execute_run(run["id"], session_factory=session_factory)

        run_data = client.get(f"/api/v1/runs/{run['id']}").json()["data"]
        assert run_data["status"] == "done" and run_data["summary"]["total"] == 2
        assert run_data["summary"]["passed"] == 1

    def test_start_rejects_external_target(self, client, eval_env):
        env = eval_env
        run = client.post("/api/v1/runs", json={
            "dataset_version_id": env["ver"]["id"], "target_id": env["target"]["id"],
            "metric_config_id": env["mc"]["id"],
        }).json()["data"]
        assert client.post(f"/api/v1/runs/{run['id']}/start").status_code == 422

    def test_runner_records_agent_failure(self, client, eval_env, monkeypatch, session_factory):
        from agenthub.runners import http_runner
        from agenthub.runners.http_runner import AgentCallError

        env = eval_env
        run = client.post("/api/v1/runs", json={
            "dataset_version_id": env["ver"]["id"], "target_id": env["target"]["id"],
            "metric_config_id": env["mc"]["id"],
        }).json()["data"]

        def boom(endpoint_config, item, timeout=120.0):
            raise AgentCallError("connection refused")

        monkeypatch.setattr(http_runner, "call_agent", boom)
        http_runner.execute_run(run["id"], session_factory=session_factory)
        results = client.get(f"/api/v1/runs/{run['id']}/results").json()["data"]
        assert results["total"] == 2 and all("connection refused" in r["error"] for r in results["items"])
        run_data = client.get(f"/api/v1/runs/{run['id']}").json()["data"]
        assert run_data["status"] == "done"  # agent 失败不算 run 失败

    def test_start_only_from_pending(self, client, eval_env):
        """start 原子状态转移：仅 pending 可启动；重复/非 pending 状态一律 409（防重复执行结果翻倍）"""
        env = eval_env
        tg = client.post("/api/v1/targets", json={
            "name": "t-start-guard", "kind": "http",
            "endpoint_config": {"url": "http://127.0.0.1:9/invoke"},  # 不可达，仅触发状态流转
        }).json()["data"]
        run = client.post("/api/v1/runs", json={
            "dataset_version_id": env["ver"]["id"], "target_id": tg["id"],
            "metric_config_id": env["mc"]["id"],
        }).json()["data"]
        assert client.post(f"/api/v1/runs/{run['id']}/start").status_code == 200
        # 第一次 start 已原子置 running（后台线程异步执行）；重复 start 必须 409
        assert client.post(f"/api/v1/runs/{run['id']}/start").status_code == 409


class TestEvalService:
    def test_evaluate_item_na_handling(self):
        specs = [
            {"type": "rule:exact", "actual": "answer", "expected_path": "expected.answer"},
            {"type": "judge:correctness"},  # LLM 未配置 → N/A
        ]
        item = {"id": "x", "input": {"question": "q"}, "expected": {"answer": "a"}, "context": {}}
        scores, passed, err = eval_service.evaluate_item(specs, item, {"answer": "a"})
        assert scores["rule:exact"]["passed"] is True
        assert scores["judge:correctness"]["score"] is None
        assert passed is True and "judge:correctness" in err

    def test_compute_summary_skips_na(self):
        specs = [{"type": "m1", "weight": 1}, {"type": "m2", "weight": 3}]

        class FakeResult:
            def __init__(self, scores, passed):
                self.scores = scores
                self.passed = passed

        results = [
            FakeResult({"m1": {"score": 1.0, "passed": True}, "m2": {"score": 0.6, "passed": False}}, False),
            FakeResult({"m1": {"score": 0.0, "passed": False}, "m2": {"score": None, "passed": None}}, False),
        ]
        s = eval_service.compute_summary(specs, results)
        assert s["metrics"]["m1"]["avg"] == 0.5
        assert s["metrics"]["m2"]["avg"] == 0.6 and s["metrics"]["m2"]["n"] == 1
        # 加权 = (0.5*1 + 0.6*3)/4 = 0.575
        assert abs(s["weighted_total"] - 0.575) < 1e-3
