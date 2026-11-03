"""LLM Judge 指标：OpenAI 兼容接口 + G-Eval 风格评分细则。

公共 spec 参数：
    actual    从 output 取值的点路径（默认 "answer"）
    threshold 通过阈值（默认 0.7）
    weight    聚合权重（默认 1）

LLM 返回 JSON：{"score": 0~1, "reason": "..."}；失败重试 2 次后抛 MetricError。
"""
import json

import httpx

from agenthub.config import get_settings
from agenthub.metrics.base import MetricError, MetricScore, get_by_path, register


def chat_json(system: str, user: str) -> dict:
    """调用 OpenAI 兼容 chat/completions，返回解析后的 JSON 对象。测试可 monkeypatch 此函数。"""
    s = get_settings()
    if not (s.llm_base_url and s.llm_model):
        raise MetricError("LLM 未配置（需要 AGENTHUB_LLM_BASE_URL / AGENTHUB_LLM_MODEL）")
    url = s.llm_base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": s.llm_model,
        "temperature": 0,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
    }
    headers = {"Authorization": f"Bearer {s.llm_api_key}"} if s.llm_api_key else {}
    last_err: Exception | None = None
    for _ in range(3):  # 1 次原始 + 2 次重试
        try:
            r = httpx.post(url, json=payload, headers=headers, timeout=60)
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            obj = json.loads(content)
            if "score" not in obj:
                raise ValueError("LLM 输出缺少 score 字段")
            return obj
        except Exception as e:  # noqa: BLE001 — 统一重试
            last_err = e
    raise MetricError(f"LLM Judge 调用失败: {last_err}")


_JUDGE_SYSTEM = (
    "你是严格的评测裁判。只输出 JSON 对象：{\"score\": <0到1的数字>, \"reason\": \"<一句话理由>\"}。"
    "score 必须是 0、0.1~0.9 的一位小数、或 1。"
)


def _normalize_score(obj: dict) -> float:
    try:
        s = float(obj["score"])
    except (TypeError, ValueError) as e:
        raise MetricError(f"score 不可解析: {obj.get('score')!r}") from e
    return max(0.0, min(1.0, s))


def _evaluate(actual: str, rubric_user: str, threshold: float) -> MetricScore:
    obj = chat_json(_JUDGE_SYSTEM, rubric_user)
    score = _normalize_score(obj)
    return MetricScore(score=score, detail=str(obj.get("reason", "")), passed=score >= threshold)


@register
class JudgeCorrectness:
    """judge:correctness —— 回答与标准答案的事实一致性。"""

    name = "judge:correctness"

    def evaluate(self, item, output, spec):
        question = get_by_path(item, spec.get("question_path", "input.question"), "")
        expected = get_by_path(item, spec.get("expected_path", "expected.answer"), "")
        actual = get_by_path(output, spec.get("actual", "answer"), "")
        user = (
            f"[问题]\n{question}\n\n[标准答案]\n{expected}\n\n[被评回答]\n{actual}\n\n"
            "评分标准：完全正确=1.0；主体正确有次要遗漏=0.7；部分正确=0.4；错误/幻觉=0.0。"
        )
        return _evaluate(str(actual), user, float(spec.get("threshold", 0.7)))


@register
class JudgeFaithfulness:
    """judge:faithfulness —— 回答是否忠于给定 context（防幻觉），不给标准答案。"""

    name = "judge:faithfulness"

    def evaluate(self, item, output, spec):
        passages = get_by_path(item, spec.get("context_path", "context.passages"), [])
        if isinstance(passages, str):
            passages = [passages]
        context = "\n---\n".join(str(p) for p in passages or [])
        actual = get_by_path(output, spec.get("actual", "answer"), "")
        user = (
            f"[参考资料]\n{context or '(空)'}\n\n[被评回答]\n{actual}\n\n"
            "评分标准：回答中所有事实性陈述均可由资料支撑=1.0；个别表述超出资料但无硬伤=0.7；"
            "有明显资料外主张=0.4；编造事实/与资料矛盾=0.0。"
        )
        return _evaluate(str(actual), user, float(spec.get("threshold", 0.7)))


@register
class JudgeCustom:
    """judge:custom —— 用户自定义评分细则（spec.rubric）。"""

    name = "judge:custom"

    def evaluate(self, item, output, spec):
        rubric = spec.get("rubric")
        if not rubric:
            raise MetricError("judge:custom 需要 spec.rubric")
        user = (
            f"[输入]\n{json.dumps(item.get('input'), ensure_ascii=False)}\n\n"
            f"[被评输出]\n{json.dumps(get_by_path(output, spec.get('actual', ''), output), ensure_ascii=False)}\n\n"
            f"[评分细则]\n{rubric}\n\n请按细则评分。"
        )
        return _evaluate("", user, float(spec.get("threshold", 0.7)))
