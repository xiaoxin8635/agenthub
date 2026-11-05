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
from agenthub.metrics.traj_parse import extract_tool_calls, format_tool_calls


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


def _context_texts(passages: object) -> list[str]:
    """参照条目归一化为文本；dict 条目（如 citations）抽取常见正文字段。"""
    if passages is None:
        return []
    if isinstance(passages, str):
        passages = [passages]
    out: list[str] = []
    for p in passages:
        if isinstance(p, dict):
            for k in ("content", "text", "snippet", "chunk", "passage"):
                if isinstance(p.get(k), str) and p[k].strip():
                    out.append(p[k])
                    break
        elif isinstance(p, str) and p.strip():
            out.append(p)
    return out


def _gather_chunks(output: dict, item: dict, spec: dict) -> str:
    """按 spec.context_source 取检索切片并编号；检索类指标默认取 output 的真实 citations。"""
    source = str(spec.get("context_source", "output")).lower()
    if source == "output":
        root, default_path = output, "context.citations"
    else:
        root, default_path = item, "context.passages"
    texts = _context_texts(get_by_path(root, spec.get("context_path", default_path), []))
    return "\n".join(f"[切片{i + 1}] {t}" for i, t in enumerate(texts))


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
    """judge:faithfulness —— 回答是否忠于参考资料（防幻觉），不给标准答案。

    spec.context_source 决定参照来源：
      "item"   默认，从评测集 item 取（context_path 默认 context.passages）
      "output" 从被评回答携带的实际检索引用取（context_path 默认 context.citations），
               适用于适配器回填切片正文的 RAG 场景——判定基准是"被评系统真实检索到的资料"，
               可区分检索质量问题（correctness 低）与生成编造（faithfulness 低）
    """

    name = "judge:faithfulness"

    def evaluate(self, item, output, spec):
        source = str(spec.get("context_source", "item")).lower()
        if source == "output":
            root, default_path = output, "context.citations"
        else:
            root, default_path = item, "context.passages"
        context = "\n---\n".join(_context_texts(get_by_path(root, spec.get("context_path", default_path), [])))
        actual = get_by_path(output, spec.get("actual", "answer"), "")
        user = (
            f"[参考资料]\n{context or '(空)'}\n\n[被评回答]\n{actual}\n\n"
            "评分标准：回答中所有事实性陈述均可由资料支撑=1.0；个别表述超出资料但无硬伤=0.7；"
            "有明显资料外主张=0.4；编造事实/与资料矛盾=0.0。"
        )
        return _evaluate(str(actual), user, float(spec.get("threshold", 0.7)))


@register
class JudgeContextRecall:
    """judge:context_recall —— 检索召回：标准答案的信息被检索切片覆盖的程度（RAGAS 风格）。"""

    name = "judge:context_recall"

    def evaluate(self, item, output, spec):
        chunks = _gather_chunks(output, item, spec)
        question = get_by_path(item, spec.get("question_path", "input.question"), "")
        expected = get_by_path(item, spec.get("expected_path", "expected.answer"), "")
        user = (
            f"[问题]\n{question}\n\n[标准答案]\n{expected}\n\n[检索到的切片]\n{chunks or '(空)'}\n\n"
            "评分标准：标准答案中的关键信息几乎全部能在切片中找到=1.0；大部分能找到=0.7；"
            "约一半=0.4；基本找不到=0.0。只评检索素材对标准答案的覆盖程度，不评回答。"
        )
        return _evaluate("", user, float(spec.get("threshold", 0.7)))


@register
class JudgeContextPrecision:
    """judge:context_precision —— 检索精确：检索回的切片与问题的相关占比（precision@k 简化版）。"""

    name = "judge:context_precision"

    def evaluate(self, item, output, spec):
        chunks = _gather_chunks(output, item, spec)
        question = get_by_path(item, spec.get("question_path", "input.question"), "")
        user = (
            f"[问题]\n{question}\n\n[检索到的切片]\n{chunks or '(空)'}\n\n"
            "评分标准：所有切片都与问题相关且切题=1.0；多数相关、少数冗余=0.7；"
            "近半无关=0.4；大多无关或未检索到任何切片=0.0。只评切片本身的质量，不评回答。"
        )
        return _evaluate("", user, float(spec.get("threshold", 0.7)))


@register
class JudgeTrajectory:
    """judge:trajectory —— LLM 评审执行轨迹：工具选择合理性、路径效率与结果达成。

    spec 参数：
        trajectory_path  从 output 取轨迹的点路径（默认 "trajectory"）
        task_path        从 item 取任务的点路径（默认 "input.task"）
        expected_path    从 item 取预期结果的点路径（默认 "expected.outcome"）
        rubric           自定义评分细则（覆盖默认）
        threshold / weight 同其他 judge 指标
    无轨迹/未解析到工具调用时记 N/A（确定性约束请用 traj:* 规则指标）。
    """

    name = "judge:trajectory"

    def evaluate(self, item, output, spec):
        calls = extract_tool_calls(output, spec.get("trajectory_path", "trajectory"))
        if not calls:
            return MetricScore(score=None, detail="无轨迹/未解析到工具调用", passed=None)
        task = get_by_path(item, spec.get("task_path", "input.task"), "")
        expected = get_by_path(item, spec.get("expected_path", "expected.outcome"), "")
        tools = get_by_path(item, "context.available_tools", []) or []
        rubric = spec.get("rubric") or (
            "评分标准：工具选择合理、路径高效无明显绕弯、最终达成预期结果=1.0；"
            "达成结果但路径有冗余=0.7；明显弯路或遗漏关键步骤=0.4；未达成结果/操作不当=0.0。"
        )
        user = (
            f"[任务]\n{task}\n\n[可用工具]\n{', '.join(map(str, tools)) or '(未提供)'}\n\n"
            f"[预期结果]\n{expected}\n\n[执行轨迹]\n{format_tool_calls(calls)}\n\n{rubric}\n\n请评分。"
        )
        return _evaluate("", user, float(spec.get("threshold", 0.7)))


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
