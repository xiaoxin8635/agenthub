"""AI 评测集生成服务：文档切片 → LLM 出题 → 代码去重 → 落资产。

流程（POST /assets/generate 触发，后台线程执行）：
  1. split_doc：Markdown/纯文本切片（按标题分章，段落聚合到约 800 字）
  2. LLM 逐片段出题（OpenAI 兼容接口，复用 AGENTHUB_LLM_* 配置）：
     每片段生成 N 条 {question, answer, keyword}，答案必须完全依据片段原文
  3. dedup_items 代码去重：
     - L1 精确：问题归一化（去空白/标点、小写）后 MD5 指纹
     - L2 模糊：问题 3-gram Jaccard 相似度 ≥ 0.6 视为重复
  4. 通过去重的条目写入 assets（type=custom, source=ai_generated, tags=[文件名]），
     content 与手工导入的 rag item 形状一致（input/expected/context），可直接圈选建集。
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import traceback
import uuid
from typing import Any

import httpx
from sqlalchemy.orm import Session

from agenthub.config import get_settings
from agenthub.db.base import SessionLocal
from agenthub.db.models import Asset

# ---------- 文档切片 ----------

_HEADING_RE = re.compile(r"^#{1,6}\s", re.M)


def split_doc(text: str, target_chars: int = 800) -> list[str]:
    """按 Markdown 标题分章、段落聚合到 target_chars；无标题文本按段落聚合。"""
    text = text.strip()
    if not text:
        return []
    # 以标题行为界切块；没有标题则整体作为一块
    parts: list[str] = []
    if _HEADING_RE.search(text):
        buf: list[str] = []
        for line in text.splitlines():
            if _HEADING_RE.match(line) and buf:
                parts.append("\n".join(buf).strip())
                buf = [line]
            else:
                buf.append(line)
        parts.append("\n".join(buf).strip())
    else:
        parts = [text]

    # 每块内部按段落聚合到目标长度
    chunks: list[str] = []
    for part in parts:
        paras = [p.strip() for p in re.split(r"\n\s*\n", part) if p.strip()]
        cur = ""
        for p in paras:
            # 超长单段落硬切
            while len(p) > target_chars * 2:
                chunks.append(p[:target_chars])
                p = p[target_chars:]
            if cur and len(cur) + len(p) > target_chars:
                chunks.append(cur)
                cur = p
            else:
                cur = f"{cur}\n\n{p}" if cur else p
        if cur.strip():
            chunks.append(cur.strip())
    return [c for c in chunks if len(c) >= 50]  # 过短片段无法出题


# ---------- LLM 出题 ----------

_SYSTEM = (
    "你是评测数据生成专家。根据给定资料片段生成中文问答评测数据。要求：\n"
    "1. 问题必须具体、可回答，答案完全依据片段原文，不得编造片段外的信息\n"
    "2. answer 是完整准确的参考答案（50字以内，只依据片段）\n"
    "3. keyword 是 answer 中必须出现的关键词（1个，2~8个字）\n"
    "4. 问题之间角度不同、不重复、不泛化（禁止笼统的\"它是什么\"）\n"
    '严格输出 JSON：{"items":[{"question":"...","answer":"...","keyword":"..."}]}'
)


def _chat(system: str, user: str, temperature: float) -> str:
    """调用 OpenAI 兼容接口返回原始文本。测试可 monkeypatch。"""
    s = get_settings()
    if not (s.llm_base_url and s.llm_model):
        raise RuntimeError("LLM 未配置（需要 AGENTHUB_LLM_BASE_URL / AGENTHUB_LLM_MODEL）")
    url = s.llm_base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": s.llm_model,
        "temperature": temperature,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    headers = {"Authorization": f"Bearer {s.llm_api_key}"} if s.llm_api_key else {}
    r = httpx.post(url, json=payload, headers=headers, timeout=90)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def parse_items(raw: str) -> list[dict]:
    """解析 LLM 输出 JSON，容错：抓第一个 {...} 块；缺字段/类型不对的条目丢弃。"""
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.S)
        if not m:
            return []
        try:
            obj = json.loads(m.group())
        except json.JSONDecodeError:
            return []
    items = obj.get("items") if isinstance(obj, dict) else None
    if not isinstance(items, list):
        return []
    out = []
    for it in items:
        if not isinstance(it, dict):
            continue
        q, a, k = it.get("question"), it.get("answer"), it.get("keyword")
        if all(isinstance(x, str) and x.strip() for x in (q, a, k)):
            out.append({"question": q.strip(), "answer": a.strip(), "keyword": k.strip()})
    return out


# ---------- 代码去重 ----------

_PUNCT_RE = re.compile(r"[\s，。？！、：；,.?!;:（）()\[\]{}\"'“”‘’·…\-—~]")


def _norm(q: str) -> str:
    return _PUNCT_RE.sub("", q).lower()


def _grams(s: str, n: int = 3) -> set[str]:
    return {s[i : i + n] for i in range(max(0, len(s) - n + 1))}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def dedup_items(items: list[dict], fuzzy_threshold: float = 0.6) -> tuple[list[dict], dict]:
    """两级去重：精确指纹 + 3-gram Jaccard 模糊。返回 (保留列表, 统计)。"""
    kept: list[dict] = []
    seen_hashes: set[str] = set()
    seen_grams: list[set[str]] = []
    exact_dup = fuzzy_dup = 0
    for it in items:
        nq = _norm(it["question"])
        h = hashlib.md5(nq.encode()).hexdigest()
        if h in seen_hashes:
            exact_dup += 1
            continue
        g = _grams(nq)
        if any(_jaccard(g, sg) >= fuzzy_threshold for sg in seen_grams):
            fuzzy_dup += 1
            continue
        seen_hashes.add(h)
        seen_grams.append(g)
        kept.append(it)
    return kept, {"generated": len(items), "kept": len(kept), "dropped_exact": exact_dup, "dropped_fuzzy": fuzzy_dup}


# ---------- 后台任务 ----------

JOBS: dict[str, dict] = {}  # 内存态 job；进程重启即失效（生成结果已落库，可接受）


def _best_passage(question: str, chunks: list[str]) -> str:
    """取与问题 3-gram 相似度最高的片段作为来源（供 faithfulness 引用）。"""
    gq = _grams(_norm(question))
    best, best_s = "", -1.0
    for c in chunks:
        s = _jaccard(gq, _grams(_norm(c[:1000])))
        if s > best_s:
            best, best_s = c, s
    return best[:600]


def _run_job(job_id: str, filename: str, text: str, per_chunk: int) -> None:
    job = JOBS[job_id]
    try:
        chunks = split_doc(text)
        if not chunks:
            raise RuntimeError("文档太短或为空，无法切片")
        job["total"] = len(chunks)
        raw_items: list[dict] = []
        for i, chunk in enumerate(chunks):
            raw = _chat(_SYSTEM, f"资料片段（{i + 1}/{len(chunks)}）：\n{chunk}\n生成 {per_chunk} 条。", 0.7)
            raw_items.extend(parse_items(raw))
            job["done"] = i + 1
            job["generated"] = len(raw_items)

        kept, stats = dedup_items(raw_items)
        # 逐条落库（每条独立指纹，撞已有资产时跳过）
        db = SessionLocal()
        try:
            inserted = 0
            for it in kept:
                passage = _best_passage(it["question"], chunks)
                content = {
                    "input": {"question": it["question"]},
                    "expected": {"answer": it["answer"], "keyword": it["keyword"]},
                    "context": {"passages": [passage] if passage else []},
                }
                h = hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                if db.query(Asset).filter(Asset.content_hash == h).first():
                    stats["skipped_exists"] = stats.get("skipped_exists", 0) + 1
                    continue
                db.add(
                    Asset(
                        type="custom",
                        source="ai_generated",
                        content=content,
                        content_hash=h,
                        tags=[filename],
                        meta={"generator": "llm", "question": it["question"]},
                    )
                )
                inserted += 1
            db.commit()
        finally:
            db.close()

        job.update(status="done", inserted=inserted, stats=stats)
    except Exception as e:  # noqa: BLE001
        job.update(status="error", error=str(e), trace=traceback.format_exc()[-800:])


def start_job(filename: str, text: str, per_chunk: int) -> str:
    job_id = uuid.uuid4().hex[:16]
    JOBS[job_id] = {"id": job_id, "filename": filename, "status": "running", "done": 0, "total": 0, "generated": 0}
    threading.Thread(target=_run_job, args=(job_id, filename, text, per_chunk), daemon=True).start()
    return job_id
