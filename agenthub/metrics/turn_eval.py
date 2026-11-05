"""multi_turn 逐轮评估：turn_scope 切片归一化与指标包装。

指标 spec 的可选字段 turn_scope（经 eval_service.evaluate_item 统一分派，托管/回传两模式自动生效）：
    未设置   现状行为，整 output 评估（完全向后兼容）
    "last"   构造 qa 形状子 item（input.question=最后一轮 user 消息、expected.answer=final_answer）
             后评估——让 rule:exact / judge:correctness 等按 qa 形状取数的指标零配置用于 multi_turn
    "each"   output 逐轮回答切片（宽松解析 turn_answers/answers/turns 等键），每轮独立评估；
             score=可评轮均值，passed=全部可判轮通过；输出无逐轮回答结构时记 N/A（不静默回退）。
             expected 不做映射——multi_turn 只有 final_answer，拿它当前几轮的标准答案是错误行为，
             需要期望值的指标在 each 模式下仅对最后一轮有意义。
"""
import statistics

from agenthub.metrics.base import Metric, MetricScore, get_by_path

_USER_ROLES = ("user", "human")
# output 中逐轮回答的常见键（按序取第一个 list 命中）
_TURN_KEYS = ("turn_answers", "answers", "turns", "messages", "history")


def last_user_question(item: dict) -> str:
    """取 item.input.turns 中最后一轮 user 消息内容；无则空串。"""
    turns = get_by_path(item, "input.turns", [])
    if not isinstance(turns, list):
        return ""
    for t in reversed(turns):
        if isinstance(t, dict) and str(t.get("role", "")).lower() in _USER_ROLES and isinstance(t.get("content"), str):
            return t["content"]
    return ""


def user_questions(item: dict) -> list[str]:
    """按序取全部 user 轮问题（与逐轮回答按索引配对）。"""
    turns = get_by_path(item, "input.turns", [])
    if not isinstance(turns, list):
        return []
    return [
        t["content"]
        for t in turns
        if isinstance(t, dict) and str(t.get("role", "")).lower() in _USER_ROLES and isinstance(t.get("content"), str)
    ]


def extract_turn_answers(output: dict) -> list[str]:
    """从 output 提取逐轮回答文本；无逐轮结构返回 []。

    兼容元素形状：字符串直接取；{"content": str}（Agent 回放对话轮）取 content；其余跳过。
    """
    if not isinstance(output, dict):
        return []
    raw = next((output[k] for k in _TURN_KEYS if isinstance(output.get(k), list)), None)
    if raw is None:
        return []
    out: list[str] = []
    for t in raw:
        if isinstance(t, str) and t.strip():
            out.append(t)
        elif isinstance(t, dict) and isinstance(t.get("content"), str) and t["content"].strip():
            out.append(t["content"])
    return out


def wrap_last_turn(item: dict) -> dict:
    """turn_scope=last 的子 item：input={question: 最后一轮 user 消息}，expected.final_answer 提升为 expected.answer。"""
    sub = dict(item)
    sub["input"] = {"question": last_user_question(item)}
    expected = dict(item.get("expected") or {})
    final = expected.pop("final_answer", None)
    if final is not None:
        expected.setdefault("answer", final)
    sub["expected"] = expected
    return sub


def evaluate_per_turn(metric: Metric, item: dict, output: dict, spec: dict) -> MetricScore:
    """turn_scope=each：逐轮切片评估并聚合（均值 / 全通过）。

    每轮构造 sub_item（原 input 保留并注入该轮 question）与 sub_output={"answer": 该轮回答}，
    使指标默认取数路径（actual="answer"、question_path="input.question"）逐轮命中。
    """
    answers = extract_turn_answers(output)
    if not answers:
        return MetricScore(score=None, detail="输出无逐轮回答结构，无法逐轮评估", passed=None)
    questions = user_questions(item)
    scores: list[float] = []
    passed_flags: list[bool] = []
    details: list[str] = []
    for i, ans in enumerate(answers):
        sub_input = dict(item.get("input") or {})
        if i < len(questions):
            sub_input["question"] = questions[i]
        sub_item = {**item, "input": sub_input}
        ms = metric.evaluate(sub_item, {"answer": ans}, spec)
        if ms.score is not None:
            scores.append(ms.score)
        if ms.passed is not None:
            passed_flags.append(ms.passed)
        details.append(f"轮{i + 1}={ms.score if ms.score is not None else 'N/A'}")
    score = round(statistics.fmean(scores), 4) if scores else None
    passed = all(passed_flags) if passed_flags else None
    return MetricScore(score=score, detail="; ".join(details), passed=passed)


def evaluate_with_turn_scope(metric: Metric, item: dict, output: dict, spec: dict) -> MetricScore:
    """按 spec.turn_scope 分派：默认原样 / last 包装 / each 逐轮。"""
    scope = str(spec.get("turn_scope", "")).lower()
    if scope == "each":
        return evaluate_per_turn(metric, item, output, spec)
    if scope == "last":
        return metric.evaluate(wrap_last_turn(item), output, spec)
    return metric.evaluate(item, output, spec)
