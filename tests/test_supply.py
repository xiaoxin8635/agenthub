"""M3 数据供给测试：resolve/latest 端点、yaml/hf 导出、SDK pull 与缓存。"""
import json
import threading
import time

import httpx
import pytest
import uvicorn
import yaml

from agenthub_sdk import AgentHub, AgentHubError


@pytest.fixture(scope="module")
def live_server():
    """SDK 用同步 httpx.Client，ASGITransport 只支持异步 —— 起真实服务线程。"""
    from agenthub.main import app

    config = uvicorn.Config(app, host="127.0.0.1", port=8399, log_level="warning")
    server = uvicorn.Server(config)
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    for _ in range(50):
        if server.started:
            break
        time.sleep(0.1)
    yield "http://127.0.0.1:8399"
    server.should_exit = True
    t.join(timeout=5)


@pytest.fixture
def published_ds(client):
    """发布一个 v2（含 carried）的 qa 数据集，返回 (name, v1_item, v2_item)。"""
    ds = client.post("/api/v1/datasets", json={"name": "supply-ds", "scene": "qa"}).json()["data"]
    items = [
        {"input": {"question": "退货怎么算运费"}, "expected": {"answer": "质量问题商家承担"}, "tags": ["退款"]},
        {"input": {"question": "可以开发票吗"}, "expected": {"answer": "可以"}},
    ]
    client.post(f"/api/v1/datasets/{ds['id']}/items", json={"items": items[:1]})
    client.post(f"/api/v1/datasets/{ds['id']}/versions", json={"changelog": "v1"})
    client.post(f"/api/v1/datasets/{ds['id']}/items", json={"items": items[1:]})
    client.post(f"/api/v1/datasets/{ds['id']}/versions", json={"changelog": "v2"})
    return ds["name"], items[0], items[1]


class TestResolveAndLatest:
    def test_resolve(self, client, published_ds):
        name, *_ = published_ds
        data = client.get(f"/api/v1/supply/datasets/{name}/resolve").json()["data"]
        assert data["latest_version"] == 2 and data["scene"] == "qa" and data["item_count"] == 2

    def test_resolve_unknown_404(self, client):
        assert client.get("/api/v1/supply/datasets/nope/resolve").status_code == 404

    def test_resolve_unpublished_404(self, client):
        ds = client.post("/api/v1/datasets", json={"name": "no-ver", "scene": "qa"}).json()["data"]
        assert client.get(f"/api/v1/supply/datasets/{ds['name']}/resolve").status_code == 404

    def test_latest_302_follows_to_jsonl(self, client, published_ds):
        name, i1, _ = published_ds
        r = client.get(f"/api/v1/supply/datasets/{name}/latest", follow_redirects=False)
        assert r.status_code == 302
        r2 = client.get(f"/api/v1/supply/datasets/{name}/latest", follow_redirects=True)
        lines = [json.loads(l) for l in r2.text.strip().splitlines()]
        assert len(lines) == 2 and lines[0]["input"]["question"] == i1["input"]["question"]


class TestExportFormats:
    def test_yaml_promptfoo_compatible(self, client, published_ds):
        name, i1, _ = published_ds
        r = client.get(f"/api/v1/datasets/{name}/versions/1/export", params={"format": "yaml"})
        assert r.status_code == 200
        doc = yaml.safe_load(r.text)
        assert doc["tests"][0]["vars"]["question"] == i1["input"]["question"]
        assert doc["tests"][0]["assert"] == [{"type": "equals", "value": i1["expected"]["answer"]}]
        # metadata 无损保留
        assert doc["tests"][0]["metadata"]["agenthub_id"]
        assert doc["tests"][0]["metadata"]["expected"] == i1["expected"]

    def test_yaml_non_scalar_vars_json_encoded(self, client, published_ds):
        """context.passages（列表）应 JSON 序列化为字符串进 vars。"""
        name, _, _ = published_ds
        r = client.get(f"/api/v1/datasets/{name}/versions/2/export", params={"format": "yaml"})
        doc = yaml.safe_load(r.text)
        for t in doc["tests"]:
            for v in t["vars"].values():
                assert isinstance(v, (str, int, float, bool))

    def test_hf_format(self, client, published_ds):
        name, _, _ = published_ds
        r = client.get(f"/api/v1/datasets/{name}/versions/2/export", params={"format": "hf"})
        doc = r.json()
        assert doc["version"] == 2 and len(doc["splits"]["train"]) == 2
        assert doc["splits"]["train"][0]["expected"]["answer"]

    def test_invalid_format_422(self, client, published_ds):
        name, *_ = published_ds
        assert client.get(f"/api/v1/datasets/{name}/versions/1/export", params={"format": "csv"}).status_code == 422


class TestSDK:
    def test_pull_explicit_version_and_cache_hit(self, client, published_ds, tmp_path, live_server):
        name, i1, i2 = published_ds
        hub = AgentHub(base_url=live_server, api_key="test-key", cache_dir=tmp_path / "cache")
        ds = hub.pull(f"{name}@2")
        assert ds.version == 2 and len(ds) == 2 and ds.scene == "qa" and not ds.from_cache
        assert ds.items[0].input["question"] == i1["input"]["question"]
        assert (tmp_path / "cache" / f"{name}-v2.jsonl").exists()

        # 缓存命中：换一个指向无效端口的 client，仍能拉到（显式版本不发请求）
        dead = AgentHub(base_url="http://127.0.0.1:1", api_key="test-key",
                        cache_dir=tmp_path / "cache", timeout=1.0)
        ds2 = dead.pull(f"{name}@2")
        assert ds2.from_cache and len(ds2) == 2

    def test_pull_latest_resolves_version(self, client, published_ds, tmp_path, live_server):
        name, _, _ = published_ds
        hub = AgentHub(base_url=live_server, api_key="test-key", cache_dir=tmp_path / "cache2")
        ds = hub.pull(name)
        assert ds.version == 2 and len(ds) == 2

    def test_pull_use_cache_false_refetches(self, client, published_ds, tmp_path, live_server):
        name, _, _ = published_ds
        hub = AgentHub(base_url=live_server, api_key="test-key", cache_dir=tmp_path / "cache3")
        hub.pull(f"{name}@1")
        ds = hub.pull(f"{name}@1", use_cache=False)
        assert not ds.from_cache and len(ds) == 1

    def test_invalid_ref_raises(self, tmp_path):
        hub = AgentHub(base_url="http://127.0.0.1:1", cache_dir=tmp_path / "c")
        with pytest.raises(AgentHubError):
            hub.pull("name@abc")
        with pytest.raises(AgentHubError):
            hub._parse_ref("@novalue")

    def test_pull_unknown_404_message(self, tmp_path, live_server):
        hub = AgentHub(base_url=live_server, api_key="test-key", cache_dir=tmp_path / "c")
        with pytest.raises(AgentHubError, match="404"):
            hub.pull("ghost-ds@1")

    def test_to_list_roundtrip(self, client, published_ds, tmp_path, live_server):
        name, _, _ = published_ds
        hub = AgentHub(base_url=live_server, api_key="test-key", cache_dir=tmp_path / "c4")
        ds = hub.pull(f"{name}@2")
        rows = ds.to_list()
        assert rows[0]["input"]["question"] and isinstance(rows, list)
