"""场景模板：Item Schema 定义、校验与资产内容映射。

每个场景规定 input/expected/context 的结构；数据集发布与草稿录入时强校验。
"""
from typing import Any

from pydantic import BaseModel, ValidationError


# ---------- 各场景 Schema ----------


class QAInput(BaseModel):
    question: str


class QAExpected(BaseModel):
    answer: str


class RAGInput(BaseModel):
    question: str


class RAGContext(BaseModel):
    passages: list[str] = []


class RAGExpected(BaseModel):
    answer: str


class ToolCallInput(BaseModel):
    utterance: str


class ToolCallContext(BaseModel):
    available_tools: list[str] = []


class ToolCallExpected(BaseModel):
    tool: str
    args: dict[str, Any] = {}


class Turn(BaseModel):
    role: str
    content: str


class MultiTurnInput(BaseModel):
    turns: list[Turn]


class MultiTurnExpected(BaseModel):
    final_answer: str


class TrajectoryInput(BaseModel):
    task: str


class TrajectoryContext(BaseModel):
    available_tools: list[str] = []
    max_steps: int = 10


class TrajectoryExpected(BaseModel):
    outcome: str
    must_call_tools: list[str] = []
    must_not_call_tools: list[str] = []


# scene -> (input, expected, context|None)
SCENES: dict[str, tuple[type[BaseModel], type[BaseModel], type[BaseModel] | None]] = {
    "qa": (QAInput, QAExpected, None),
    "rag": (RAGInput, RAGExpected, RAGContext),
    "tool_call": (ToolCallInput, ToolCallExpected, ToolCallContext),
    "multi_turn": (MultiTurnInput, MultiTurnExpected, None),
    "trajectory": (TrajectoryInput, TrajectoryExpected, TrajectoryContext),
}


def validate_item(scene: str, payload: dict) -> list[str]:
    """校验 item payload 是否符合场景 Schema，返回错误列表（空 = 通过）。"""
    if scene not in SCENES:
        return [f"unknown scene: {scene}"]
    input_m, expected_m, context_m = SCENES[scene]
    errors: list[str] = []
    for name, model, data in (
        ("input", input_m, payload.get("input")),
        ("expected", expected_m, payload.get("expected")),
        ("context", context_m, payload.get("context", {})),
    ):
        if model is None:
            continue
        if not isinstance(data, dict):
            errors.append(f"{name}: expected object, got {type(data).__name__}")
            continue
        try:
            model.model_validate(data)
        except ValidationError as e:
            errors.append(f"{name}: " + "; ".join(f"{'.'.join(str(l) for l in x['loc'])}: {x['msg']}" for x in e.errors()))
    return errors


# ---------- 资产内容 → item payload 映射 ----------


def _first(content: dict, *keys: str) -> Any:
    for k in keys:
        v = content.get(k)
        if v:
            return v
    return None


def asset_to_item_payload(scene: str, content: dict) -> dict | None:
    """把资产 content 映射为场景 item payload；无法映射时返回 None。

    若 content 已带 input/expected 结构则直接采用，否则按场景字段名启发式提取。
    """
    if not isinstance(content, dict):
        return None
    if isinstance(content.get("input"), dict):
        return {
            "input": content["input"],
            "expected": content.get("expected") or {},
            "context": content.get("context") or {},
        }

    if scene == "qa":
        q, a = _first(content, "question", "user", "query"), _first(content, "answer", "assistant")
        if not (isinstance(q, str) and isinstance(a, str)):
            return None
        return {"input": {"question": q}, "expected": {"answer": a}, "context": {}}

    if scene == "rag":
        q, a = _first(content, "question", "user", "query"), _first(content, "answer", "assistant")
        if not (isinstance(q, str) and isinstance(a, str)):
            return None
        passages = content.get("passages") or content.get("contexts") or []
        if not passages and content.get("context"):
            passages = [content["context"]] if isinstance(content["context"], str) else content["context"]
        return {"input": {"question": q}, "expected": {"answer": a}, "context": {"passages": passages}}

    if scene == "tool_call":
        u = _first(content, "utterance", "user", "query", "question")
        nested = content.get("expected") if isinstance(content.get("expected"), dict) else {}
        tool = _first(content, "tool") or nested.get("tool")
        if not (isinstance(u, str) and isinstance(tool, str)):
            return None
        args = content.get("args") or nested.get("args") or {}
        return {
            "input": {"utterance": u},
            "expected": {"tool": tool, "args": args},
            "context": {"available_tools": content.get("available_tools", [])},
        }

    if scene == "multi_turn":
        turns = content.get("turns")
        if not isinstance(turns, list) or not turns:
            return None
        final = _first(content, "final_answer")
        if not final:
            for t in reversed(turns):
                if isinstance(t, dict) and t.get("role") == "assistant":
                    final = t.get("content")
                    break
        if not isinstance(final, str):
            return None
        return {"input": {"turns": turns}, "expected": {"final_answer": final}, "context": {}}

    if scene == "trajectory":
        task = _first(content, "task", "user", "question")
        nested = content.get("expected") if isinstance(content.get("expected"), dict) else {}
        outcome = _first(content, "outcome", "expected_outcome") or nested.get("outcome")
        if not (isinstance(task, str) and isinstance(outcome, str)):
            return None
        return {
            "input": {"task": task},
            "expected": {
                "outcome": outcome,
                "must_call_tools": content.get("must_call_tools", nested.get("must_call_tools", [])),
                "must_not_call_tools": content.get("must_not_call_tools", nested.get("must_not_call_tools", [])),
            },
            "context": {
                "available_tools": content.get("available_tools", []),
                "max_steps": content.get("max_steps", 10),
            },
        }

    return None
