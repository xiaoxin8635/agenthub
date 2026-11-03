"""UI 依赖端点测试：Run 列表（FR-B1）、仪表盘统计（FR-B2）、失败 tag 分布（FR-B3）、CORS（FR-B4）。"""
import pytest

QA_ITEMS = [
    {"input": {"question": "退货怎么算运费"}, "expected": {"answer": "质量问题商家承担"}, "tags": ["退款"]},
    {"input": {"question": "发货多久"}, "expected": {"answer": "48小时"}, "tags": ["物流"]},
]
METRICS = [
    {"type": "rule:exact", "actual": "answer", "expected_path": "expected.answer", "weight": 2},
    {"type": "rule:contains", "actual": "answer", "expected_path": "expected.answer", "weight": 1},
]


@pytest.fixture
def env(client):
    """数据集@v1 + external target + metric config + 两个 done run（run_a 1过1败，run_b 全过）。"""
    ds = client.post("/api/v1/datasets", json={"name": "ui-ds", "scene": "qa"}).json()["data"]
    client.post(f"/api/v1/datasets/{ds['id']}/items", json={"items": QA_ITEMS})
    ver = client.post(f"/api/v1/datasets/{ds['id']}/versions", json={"changelog": "v1"}).json()["data"]
    target = client.post("/api/v1/targets", json={"name": "ui-agent", "kind": "external"}).json()["data"]
    mc = client.post("/api/v1/metric-configs", json={"name": "ui-mc", "scene": "qa", "metrics": METRICS}).json()["data"]
    items = client.get(f"/api/v1/datasets/{ds['id']}/items", params={"version": 1}).json()["data"]["items"]

    item_ids = [it["id"] for it in items]

    def make_run(answers: list[str]) -> str:
        run = client.post("/api/v1/runs", json={
            "dataset_version_id": ver["id"], "target_id": target["id"],
            "metric_config_id": mc["id"], "agent_version": "v1",
        }).json()["data"]
        r = client.post(f"/api/v1/runs/{run['id']}/results", json={"results": [
            {"item_id": iid, "output": {"answer": ans}} for iid, ans in zip(item_ids, answers)
        ]})
        assert r.json()["data"]["done"] is True
        return run["id"]

    run_a = make_run(["质量问题商家承担", "大概48小时"])  # 1 过 1 败（失败项 tag=物流）
    run_b = make_run(["质量问题商家承担", "48小时"])  # 全过
    return {"ds": ds, "target": target, "mc": mc, "run_a": run_a, "run_b": run_b}


class TestRunList:
    def test_list_and_filters(self, client, env):
        data = client.get("/api/v1/runs").json()["data"]
        assert data["total"] == 2 and len(data["items"]) == 2
        row = data["items"][0]
        assert row["dataset"] == "ui-ds@1"
        assert row["target"] == "ui-agent" and row["metric_config"] == "ui-mc"
        assert row["agent_version"] == "v1"
        assert {"id", "status", "pass_rate", "weighted_total", "created_at"} <= set(row)
        # 全过 run 的 pass_rate=1.0
        assert max(r["pass_rate"] for r in data["items"]) == 1.0

        assert client.get("/api/v1/runs", params={"status": "done"}).json()["data"]["total"] == 2
        assert client.get("/api/v1/runs", params={"dataset": "ui-ds"}).json()["data"]["total"] == 2
        assert client.get("/api/v1/runs", params={"dataset": "ghost"}).json()["data"]["total"] == 0
        assert client.get("/api/v1/runs", params={"target": "ui-agent"}).json()["data"]["total"] == 2
        assert client.get("/api/v1/runs", params={"limit": 1}).json()["data"]["items"].__len__() == 1


class TestStats:
    def test_dashboard_counts_and_trend(self, client, env):
        client.post("/api/v1/assets", json={"type": "dialog", "content": {"q": "x"}})
        client.post("/api/v1/assets", json={"type": "doc", "content": {"q": "y"}})
        # 一个有草稿未发布的数据集
        ds2 = client.post("/api/v1/datasets", json={"name": "ui-ds2", "scene": "qa"}).json()["data"]
        client.post(f"/api/v1/datasets/{ds2['id']}/items", json={"items": [QA_ITEMS[0]]})

        data = client.get("/api/v1/stats").json()["data"]
        assert data["counts"] == {"assets": 2, "datasets": 2, "dataset_versions": 1, "runs": 2}
        assert len(data["trend_30d"]) == 1
        assert data["trend_30d"][0]["runs"] == 2
        assert data["trend_30d"][0]["pass_rate"] == 0.75  # (0.5 + 1.0) / 2
        assert data["draft_datasets"] == 1
        assert data["unfeedback_runs"] == 1  # run_a 有失败且未回灌

    def test_unfeedback_after_feedback(self, client, env):
        r = client.post(f"/api/v1/runs/{env['run_a']}/feedback", json={})
        assert r.status_code == 200
        assert client.get("/api/v1/stats").json()["data"]["unfeedback_runs"] == 0


class TestFailedTags:
    def test_summary_contains_failed_tags(self, client, env):
        run = client.get(f"/api/v1/runs/{env['run_a']}").json()["data"]
        assert run["summary"]["failed_tags"] == {"物流": 1}
        full = client.get(f"/api/v1/runs/{env['run_b']}").json()["data"]
        assert "failed_tags" not in full["summary"]


class TestCors:
    def test_allow_origin(self, client):
        r = client.get("/api/v1/health", headers={"Origin": "http://localhost:5173"})
        assert r.status_code == 200
        assert r.headers.get("access-control-allow-origin") == "*"

    def test_preflight(self, client):
        r = client.options(
            "/api/v1/runs",
            headers={
                "Origin": "http://localhost:5173",
                "Access-Control-Request-Method": "GET",
            },
        )
        assert r.status_code == 200
        assert r.headers.get("access-control-allow-origin") == "*"
