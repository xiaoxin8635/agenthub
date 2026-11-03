"""M2 数据集模块测试：建集/草稿校验/圈选/发布快照/导出。"""
import json

import pytest

from agenthub.schemas.scenes import asset_to_item_payload, validate_item

QA_ITEM = {"input": {"question": "退货运费谁承担？"}, "expected": {"answer": "质量问题由商家承担"}}
QA_ITEM_2 = {"input": {"question": "发货时间？"}, "expected": {"answer": "48小时内"}}


@pytest.fixture(autouse=True)
def _tmp_data_dir(tmp_path, monkeypatch):
    from agenthub.config import get_settings

    monkeypatch.setattr(get_settings(), "data_dir", str(tmp_path / "snapshots"))


def _mk_dataset(client, name="qa-core", scene="qa"):
    r = client.post("/api/v1/datasets", json={"name": name, "scene": scene, "description": "test"})
    assert r.status_code == 200, r.text
    return r.json()["data"]


def _mk_asset(client, user, assistant, tags=None):
    r = client.post("/api/v1/assets", json={
        "type": "dialog",
        "content": {"user": user, "assistant": assistant},
        "tags": tags or [],
    })
    assert r.status_code == 200
    return r.json()["data"]


class TestScenes:
    def test_validate_qa_ok_and_bad(self):
        assert validate_item("qa", QA_ITEM) == []
        errs = validate_item("qa", {"input": {"question": 1}, "expected": {}})
        assert any("input" in e for e in errs)

    def test_validate_trajectory(self):
        item = {
            "input": {"task": "取消订单A1002"},
            "context": {"available_tools": ["cancel_order"], "max_steps": 5},
            "expected": {"outcome": "已取消", "must_call_tools": ["cancel_order"]},
        }
        assert validate_item("trajectory", item) == []

    def test_extract_from_asset_structured_passthrough(self):
        payload = asset_to_item_payload("qa", {"input": {"question": "x"}, "expected": {"answer": "y"}})
        assert payload["input"] == {"question": "x"}

    def test_extract_scenes(self):
        assert asset_to_item_payload("qa", {"user": "q1", "assistant": "a1"}) == {
            "input": {"question": "q1"}, "expected": {"answer": "a1"}, "context": {},
        }
        assert asset_to_item_payload("rag", {"question": "q", "answer": "a", "context": "段落"}) == {
            "input": {"question": "q"}, "expected": {"answer": "a"}, "context": {"passages": ["段落"]},
        }
        assert asset_to_item_payload("tool_call", {"user": "查A1002", "tool": "query_order", "args": {"oid": "A1002"}})["expected"]["tool"] == "query_order"
        assert asset_to_item_payload("trajectory", {"task": "t", "outcome": "o"})["expected"]["outcome"] == "o"
        mt = asset_to_item_payload("multi_turn", {"turns": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]})
        assert mt["expected"]["final_answer"] == "hello"
        assert asset_to_item_payload("qa", {"foo": "bar"}) is None  # 无法映射


class TestDatasetCrud:
    def test_create_and_get(self, client):
        data = _mk_dataset(client)
        assert data["name"] == "qa-core" and data["scene"] == "qa" and data["latest_version"] is None
        r = client.get(f"/api/v1/datasets/{data['id']}")
        assert r.json()["data"]["name"] == "qa-core"

    def test_invalid_scene_and_name(self, client):
        assert client.post("/api/v1/datasets", json={"name": "x1", "scene": "bad"}).status_code == 422
        assert client.post("/api/v1/datasets", json={"name": "Bad Name!", "scene": "qa"}).status_code == 422

    def test_dup_name_409(self, client):
        _mk_dataset(client)
        assert client.post("/api/v1/datasets", json={"name": "qa-core", "scene": "qa"}).status_code == 409

    def test_list_filter_scene(self, client):
        _mk_dataset(client, "qa-core", "qa")
        _mk_dataset(client, "traj-core", "trajectory")
        r = client.get("/api/v1/datasets", params={"scene": "qa"})
        assert len(r.json()["data"]) == 1


class TestDraftItems:
    def test_add_valid_and_invalid(self, client):
        ds = _mk_dataset(client)
        r = client.post(f"/api/v1/datasets/{ds['id']}/items", json={"items": [QA_ITEM, {"input": {"wrong": 1}}]})
        assert r.status_code == 422  # 默认整批拒绝
        r = client.post(f"/api/v1/datasets/{ds['id']}/items", json={"items": [QA_ITEM, {"input": {"wrong": 1}}], "skip_invalid": True})
        body = r.json()["data"]
        assert body["added"] == 1 and body["skipped_invalid"] == 1
        r = client.get(f"/api/v1/datasets/{ds['id']}/items", params={"draft": True})
        assert r.json()["data"]["total"] == 1

    def test_from_assets_and_dup(self, client):
        a1 = _mk_asset(client, "退货怎么算运费", "质量问题商家承担")
        a2 = _mk_asset(client, "发货要多久", "48小时内")
        _mk_asset(client, None, None)  # 无法映射的资产
        ds = _mk_dataset(client)

        r = client.post(f"/api/v1/datasets/{ds['id']}/items/from-assets", json={"filters": {"type": "dialog", "limit": 10}})
        body = r.json()["data"]
        assert body["selected"] == 3 and body["added"] == 2 and body["skipped_invalid"] == 1

        # 重复圈选 → skipped_dup
        r = client.post(f"/api/v1/datasets/{ds['id']}/items/from-assets", json={"asset_ids": [a1["id"], a2["id"]]})
        assert r.json()["data"]["skipped_dup"] == 2

        # 单条删除草稿
        items = client.get(f"/api/v1/datasets/{ds['id']}/items", params={"draft": True}).json()["data"]["items"]
        assert client.delete(f"/api/v1/datasets/{ds['id']}/items/{items[0]['id']}").status_code == 200

    def test_no_filters_422(self, client):
        ds = _mk_dataset(client)
        assert client.post(f"/api/v1/datasets/{ds['id']}/items/from-assets", json={}).status_code == 422


class TestPublishAndExport:
    def _publish_ds_with_2_items(self, client):
        a1 = _mk_asset(client, "退货怎么算运费", "质量问题商家承担", tags=["退款"])
        a2 = _mk_asset(client, "发货要多久", "48小时内", tags=["物流"])
        ds = _mk_dataset(client)
        client.post(f"/api/v1/datasets/{ds['id']}/items/from-assets", json={"asset_ids": [a1["id"], a2["id"]]})
        ver = client.post(f"/api/v1/datasets/{ds['id']}/versions", json={"changelog": "init"}).json()["data"]
        return ds, ver

    def test_publish_empty_422(self, client):
        ds = _mk_dataset(client)
        assert client.post(f"/api/v1/datasets/{ds['id']}/versions", json={}).status_code == 422

    def test_publish_v1_and_export(self, client):
        ds, ver = self._publish_ds_with_2_items(client)
        assert ver["version"] == 1 and ver["item_count"] == 2
        assert ver["stats"]["new"] == 2 and set(ver["stats"]["tags"]) == {"退款", "物流"}

        # 发布后草稿清零、items 归属版本
        assert client.get(f"/api/v1/datasets/{ds['id']}/items", params={"draft": True}).json()["data"]["total"] == 0

        # 导出快照文件内容正确
        r = client.get(f"/api/v1/datasets/{ds['name']}/versions/1/export")
        assert r.status_code == 200
        lines = [json.loads(l) for l in r.text.strip().splitlines()]
        assert len(lines) == 2 and lines[0]["input"]["question"] == "退货怎么算运费"

    def test_v2_carries_v1_items(self, client):
        ds, ver1 = self._publish_ds_with_2_items(client)
        a3 = _mk_asset(client, "可以开发票吗", "可以，电子发票")
        client.post(f"/api/v1/datasets/{ds['id']}/items/from-assets", json={"asset_ids": [a3["id"]]})
        ver2 = client.post(f"/api/v1/datasets/{ds['id']}/versions", json={"changelog": "加发票case"}).json()["data"]
        assert ver2["version"] == 2 and ver2["item_count"] == 3
        assert ver2["stats"]["carried"] == 2 and ver2["stats"]["new"] == 1

        # version=1 仍只看到 2 条（不可变），version=2 看到 3 条
        assert client.get(f"/api/v1/datasets/{ds['id']}/items", params={"version": 1}).json()["data"]["total"] == 2
        assert client.get(f"/api/v1/datasets/{ds['id']}/items", params={"version": 2}).json()["data"]["total"] == 3

    def test_published_item_immutable(self, client):
        ds, ver = self._publish_ds_with_2_items(client)
        items = client.get(f"/api/v1/datasets/{ds['id']}/items", params={"version": 1}).json()["data"]["items"]
        r = client.delete(f"/api/v1/datasets/{ds['id']}/items/{items[0]['id']}")
        assert r.status_code == 409

    def test_publish_skip_invalid(self, client):
        ds = _mk_dataset(client)
        client.post(f"/api/v1/datasets/{ds['id']}/items", json={"items": [QA_ITEM, {"input": {"bad": 1}}], "skip_invalid": True})
        ver = client.post(f"/api/v1/datasets/{ds['id']}/versions", json={"skip_invalid": True}).json()["data"]
        assert ver["item_count"] == 1

    def test_export_unknown_404(self, client):
        assert client.get("/api/v1/datasets/nope/versions/1/export").status_code == 404
