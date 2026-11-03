"""M1 资产模块接口测试。"""
import io
import json


def _asset_body(i: int = 0, **kw):
    body = {
        "type": "dialog",
        "content": {"user": f"订单A10{i}怎么了", "assistant": "已为您查询"},
        "tags": ["订单", "smoke"],
        "meta": {"model": "gpt-x"},
    }
    body.update(kw)
    return body


class TestHealth:
    def test_health_no_auth(self, client):
        r = client.get("/api/v1/health", headers={})
        assert r.status_code == 200
        assert r.json() == {"code": 0, "data": {"status": "up"}}


class TestAuth:
    def test_wrong_key_rejected(self, client):
        r = client.get("/api/v1/assets", headers={"X-API-Key": "wrong"})
        assert r.status_code == 401
        assert r.json()["code"] == 401

    def test_missing_key_rejected(self, client):
        bare = type(client)(client.app)  # 不带默认 X-API-Key 的裸 client
        assert bare.get("/api/v1/assets").status_code == 401


class TestCreateAsset:
    def test_create_ok(self, client):
        r = client.post("/api/v1/assets", json=_asset_body())
        assert r.status_code == 200
        data = r.json()["data"]
        assert data["id"] and data["type"] == "dialog" and data["source"] == "manual"
        assert data["tags"] == ["订单", "smoke"]

    def test_create_duplicate_409(self, client):
        client.post("/api/v1/assets", json=_asset_body())
        r = client.post("/api/v1/assets", json=_asset_body())
        assert r.status_code == 409

    def test_invalid_type_422(self, client):
        r = client.post("/api/v1/assets", json=_asset_body(type="nope"))
        assert r.status_code == 422
        assert "type" in r.json()["error"]["message"]


class TestListAsset:
    def test_list_filter_tag_and_q(self, client):
        client.post("/api/v1/assets", json=_asset_body(1, tags=["退款"]))
        client.post("/api/v1/assets", json=_asset_body(2))
        client.post("/api/v1/assets", json=_asset_body(3, type="trace"))

        r = client.get("/api/v1/assets", params={"type": "dialog"})
        body = r.json()["data"]
        assert body["total"] == 2

        r = client.get("/api/v1/assets", params={"tag": "退款"})
        assert r.json()["data"]["total"] == 1

        r = client.get("/api/v1/assets", params={"q": "A102"})
        assert r.json()["data"]["total"] == 1

    def test_pagination(self, client):
        for i in range(5):
            client.post("/api/v1/assets", json=_asset_body(i))
        r = client.get("/api/v1/assets", params={"offset": 2, "limit": 2})
        body = r.json()["data"]
        assert body["total"] == 5 and len(body["items"]) == 2


class TestImport:
    def test_import_jsonl_dedup(self, client):
        lines = [
            json.dumps({"type": "trace", "content": {"steps": [1]}, "tags": ["线上"]}),
            json.dumps({"type": "trace", "content": {"steps": [2]}}),
            json.dumps({"type": "trace", "content": {"steps": [1]}}),  # 与第1条重复
            "not-json",  # 坏行
        ]
        f = io.BytesIO("\n".join(lines).encode("utf-8"))
        r = client.post(
            "/api/v1/assets/import",
            files={"file": ("traces.jsonl", f, "application/octet-stream")},
            data={"source": "trace_import", "tags": "batch-1"},
        )
        assert r.status_code == 200
        body = r.json()["data"]
        assert body["created"] == 2 and body["skipped"] == 1
        assert len(body["errors"]) == 1

        # 幂等：重复导入全部跳过
        f.seek(0)
        r = client.post(
            "/api/v1/assets/import",
            files={"file": ("traces.jsonl", f, "application/octet-stream")},
            data={"source": "trace_import"},
        )
        assert r.json()["data"]["created"] == 0 and r.json()["data"]["skipped"] == 3

        # 导入的资产带上了 source、行内 tag 与 extra tag（Form 参数）
        r = client.get("/api/v1/assets", params={"source": "trace_import", "tag": "线上"})
        assert r.json()["data"]["total"] == 1
        r = client.get("/api/v1/assets", params={"source": "trace_import", "tag": "batch-1"})
        assert r.json()["data"]["total"] == 2


class TestPatchDelete:
    def test_patch_and_delete(self, client):
        aid = client.post("/api/v1/assets", json=_asset_body()).json()["data"]["id"]

        r = client.patch(f"/api/v1/assets/{aid}", json={"tags": ["新标签"], "meta": {"reviewed": True}})
        data = r.json()["data"]
        assert data["tags"] == ["新标签"] and data["meta"] == {"reviewed": True}

        r = client.delete(f"/api/v1/assets/{aid}")
        assert r.status_code == 200
        assert client.get(f"/api/v1/assets/{aid}").status_code == 404

    def test_get_missing_404(self, client):
        assert client.get("/api/v1/assets/01NOPE").status_code == 404
