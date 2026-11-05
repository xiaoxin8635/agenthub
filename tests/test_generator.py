"""AI 评测集生成：切片 / 出题解析 / 代码去重 / API 全流程（mock LLM）。"""
from __future__ import annotations

import json
import time

import pytest

from agenthub.services import generator


# ---------- 切片 ----------


class TestSplitDoc:
    def test_split_by_heading(self):
        md = (
            "# 第一章\n" + "内容一。" * 100 + "\n\n# 第二章\n" + "内容二。" * 100 + "\n"
        )
        chunks = generator.split_doc(md, target_chars=200)
        assert len(chunks) >= 2
        assert all("#" not in c[:2] or c.startswith("#") for c in chunks)

    def test_split_plain_text(self):
        text = "\n\n".join("段落内容。" * 30 for _ in range(5))
        chunks = generator.split_doc(text, target_chars=300)
        assert len(chunks) >= 2
        assert all(len(c) <= 700 for c in chunks)

    def test_too_short_doc(self):
        assert generator.split_doc("太短了") == []

    def test_long_paragraph_hard_split(self):
        chunks = generator.split_doc("超" * 3000, target_chars=500)
        assert len(chunks) >= 2


# ---------- LLM 输出解析 ----------


class TestParseItems:
    def test_normal(self):
        raw = json.dumps({"items": [
            {"question": "Q1?", "answer": "A1", "keyword": "k1"},
            {"question": "Q2?", "answer": "A2", "keyword": "k2"},
        ]}, ensure_ascii=False)
        items = generator.parse_items(raw)
        assert len(items) == 2 and items[0]["question"] == "Q1?"

    def test_dirty_wrapper(self):
        raw = '好的，以下是生成结果：\n{"items":[{"question":"Q","answer":"A","keyword":"K"}]}\n请查收'
        assert len(generator.parse_items(raw)) == 1

    def test_invalid_entries_dropped(self):
        raw = json.dumps({"items": [
            {"question": "", "answer": "A", "keyword": "K"},  # 空问题
            {"question": "Q"},  # 缺字段
            "not a dict",
        ]}, ensure_ascii=False)
        assert generator.parse_items(raw) == []


# ---------- 代码去重 ----------


class TestDedup:
    def test_exact_dup(self):
        items = [
            {"question": "云帆工作台支持哪些渠道？", "answer": "A", "keyword": "k"},
            {"question": "云帆工作台支持哪些渠道", "answer": "A2", "keyword": "k"},  # 仅标点差异
        ]
        kept, stats = generator.dedup_items(items)
        assert len(kept) == 1 and stats["dropped_exact"] == 1

    def test_fuzzy_dup(self):
        base = "云帆客服工作台的企业微信接入配置步骤是什么"
        items = [
            {"question": base, "answer": "A", "keyword": "k"},
            {"question": base + "呢？谢谢", "answer": "A2", "keyword": "k"},  # 高相似
        ]
        kept, stats = generator.dedup_items(items)
        assert len(kept) == 1 and stats["dropped_fuzzy"] == 1

    def test_distinct_kept(self):
        items = [
            {"question": "如何配置企业微信接入？", "answer": "A", "keyword": "k"},
            {"question": "工单超时的默认时限是多久？", "answer": "A2", "keyword": "k2"},
            {"question": "知识库支持批量导入吗？", "answer": "A3", "keyword": "k3"},
        ]
        kept, stats = generator.dedup_items(items)
        assert len(kept) == 3 and stats["kept"] == 3

    def test_stats_shape(self):
        _, stats = generator.dedup_items([])
        assert stats == {"generated": 0, "kept": 0, "dropped_exact": 0, "dropped_fuzzy": 0}


# ---------- API 全流程（mock LLM） ----------


@pytest.fixture()
def mock_chat(monkeypatch):
    """固定 LLM 输出：同一片段总是产出两条不同问题。"""
    def fake_chat(system: str, user: str, temperature: float) -> str:
        return json.dumps({"items": [
            {"question": "测试问题一：功能A如何开启？", "answer": "在设置里开启", "keyword": "设置"},
            {"question": "测试问题二：功能B的上限是多少？", "answer": "上限一百", "keyword": "一百"},
        ]}, ensure_ascii=False)

    monkeypatch.setattr(generator, "_chat", fake_chat)


def test_generate_api_full_flow(client, mock_chat, monkeypatch, session_factory):
    # 单测环境：LLM 配置被隔离 + 库为临时文件库 → 打桩配置检查与 SessionLocal（_chat 已 mock）
    class _S:
        llm_base_url, llm_model = "http://mock", "mock-model"

    monkeypatch.setattr("agenthub.routers.assets.get_settings", lambda: _S())
    monkeypatch.setattr(generator, "SessionLocal", session_factory)
    doc = ("# 测试手册\n" + "这是一段足够长的测试文档内容，" * 30) * 2
    files = {"file": ("测试手册.md", doc.encode(), "text/markdown")}
    r = client.post("/api/v1/assets/generate", files=files, data={"per_chunk": "2"})
    assert r.status_code == 200
    job_id = r.json()["data"]["job_id"]

    # 轮询至完成（后台线程，最多 5s）
    deadline = time.time() + 5
    job = None
    while time.time() < deadline:
        jr = client.get(f"/api/v1/assets/generate/{job_id}")
        assert jr.status_code == 200
        job = jr.json()["data"]
        if job["status"] != "running":
            break
        time.sleep(0.1)
    assert job["status"] == "done", json.dumps(job, ensure_ascii=False)[:1200]
    assert job["stats"]["generated"] == job["stats"]["kept"]  # mock 输出无重复

    # 资产已入库且可按 source 筛选
    ar = client.get("/api/v1/assets", params={"source": "ai_generated"})
    items = ar.json()["data"]["items"]
    assert len(items) >= job["inserted"] > 0
    sample = next(i for i in items if i["content"]["input"]["question"] == "测试问题一：功能A如何开启？")
    assert sample["content"]["expected"]["keyword"] == "设置"
    assert sample["content"]["context"]["passages"], "来源片段应非空"
    # passages 直接取自出题片段（逐片段出题出处已知，不再回猜）
    assert sample["content"]["context"]["passages"][0] in generator.split_doc(doc)
    assert "测试手册.md" in sample["tags"]
    # 默认来源名 = 文件名去扩展名（写入 meta.source_name + tags）
    assert sample["meta"]["source_name"] == "测试手册"
    assert "测试手册" in sample["tags"]
    # 按 source_name 筛选
    fr = client.get("/api/v1/assets", params={"source": "ai_generated", "source_name": "测试手册"})
    assert fr.json()["data"]["total"] >= job["inserted"]
    assert client.get(
        "/api/v1/assets", params={"source": "ai_generated", "source_name": "不存在的来源"}
    ).json()["data"]["total"] == 0


def test_generate_custom_source_name(client, mock_chat, monkeypatch, session_factory):
    """自定义来源名：写入 meta.source_name 与 tags，并可按其筛选。"""

    class _S:
        llm_base_url, llm_model = "http://mock", "mock-model"

    monkeypatch.setattr("agenthub.routers.assets.get_settings", lambda: _S())
    monkeypatch.setattr(generator, "SessionLocal", session_factory)
    doc = "# 手册\n" + "足够长的正文内容用于切片，" * 30
    files = {"file": ("doc.md", doc.encode(), "text/markdown")}
    r = client.post("/api/v1/assets/generate", files=files, data={"per_chunk": "2", "source_name": "产品手册A"})
    assert r.status_code == 200
    job_id = r.json()["data"]["job_id"]

    deadline = time.time() + 5
    job = None
    while time.time() < deadline:
        jr = client.get(f"/api/v1/assets/generate/{job_id}")
        job = jr.json()["data"]
        if job["status"] != "running":
            break
        time.sleep(0.1)
    assert job["status"] == "done", json.dumps(job, ensure_ascii=False)[:1200]
    assert job["inserted"] > 0

    ar = client.get("/api/v1/assets", params={"source": "ai_generated"})
    sample = ar.json()["data"]["items"][0]
    assert sample["meta"]["source_name"] == "产品手册A"
    assert "产品手册A" in sample["tags"] and "doc.md" in sample["tags"]
    fr = client.get("/api/v1/assets", params={"source": "ai_generated", "source_name": "产品手册A"})
    assert fr.json()["data"]["total"] == job["inserted"]
    # 模糊匹配：source 片段与 source_name 子串均可命中
    assert client.get("/api/v1/assets", params={"source": "ai_gen"}).json()["data"]["total"] == job["inserted"]
    assert client.get(
        "/api/v1/assets", params={"source": "ai_generated", "source_name": "手册"}
    ).json()["data"]["total"] == job["inserted"]


def test_generate_rejects_short_doc(client, mock_chat):
    r = client.post("/api/v1/assets/generate", files={"file": ("a.md", "太短".encode(), "text/markdown")})
    assert r.status_code == 422


def test_generate_job_404(client):
    assert client.get("/api/v1/assets/generate/nope").status_code == 404
