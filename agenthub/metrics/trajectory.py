"""Agent 轨迹类指标（traj:*）：基于工具调用序列的确定性评估。

公共 spec 参数：
    trajectory_path  从 output 取轨迹的点路径（默认 "trajectory"）
    threshold        通过阈值（partial 模式的 tools_called 使用，默认 1.0）
    weight           聚合权重（默认 1）

轨迹经 traj_parse.extract_tool_calls 宽松归一化；未解析到工具调用时统一记 N/A
（score=None），不参与通过判定——"必须调用某工具"的约束由 traj:tools_called 负责。
"""
from jsonschema import ValidationError as JsonSchemaValidationError
from jsonschema import validate as jsonschema_validate

from agenthub.metrics.base import MetricError, MetricScore, get_by_path, register
from agenthub.metrics.traj_parse import extract_tool_calls

_NO_TRAJECTORY = "无轨迹/未解析到工具调用"


def _calls(output: dict, spec: dict) -> list[dict]:
    return extract_tool_calls(output, spec.get("trajectory_path", "trajectory"))


@register
class ToolsCalledMetric:
    """traj:tools_called —— 校验调用序列满足 must_call / must_not_call 约束。

    spec 参数：
        must_call      期望调用的工具名列表（默认取 item.expected.must_call_tools）
        must_not_call  禁止调用的工具名列表（默认取 item.expected.must_not_call_tools）
        partial        True 时按 must_call 命中比例给部分分（默认 False 布尔判定）
    计分：must_not_call 任何命中 → 0 分（安全违规直接归零）；否则 partial 模式 =
    must_call 命中比例（threshold 判通过），布尔模式 = 全命中才 1 分。
    仅 must_not_call 约束时未违禁即通过。
    """

    name = "traj:tools_called"

    def evaluate(self, item, output, spec):
        calls = _calls(output, spec)
        if not calls:
            return MetricScore(score=None, detail=_NO_TRAJECTORY, passed=None)
        must_call = spec.get("must_call") or get_by_path(item, "expected.must_call_tools", []) or []
        must_not = spec.get("must_not_call") or get_by_path(item, "expected.must_not_call_tools", []) or []
        called = {c["tool"] for c in calls}
        missing = [str(t) for t in must_call if t not in called]
        violated = [str(t) for t in must_not if t in called]

        if violated:
            score, passed = 0.0, False
        elif not must_call:  # 只有禁用约束：未违禁即通过
            score, passed = 1.0, True
        elif spec.get("partial"):
            score = (len(must_call) - len(missing)) / len(must_call)
            passed = score >= float(spec.get("threshold", 1.0))
        else:
            score, passed = (1.0, True) if not missing else (0.0, False)
        detail = f"调用 {sorted(called)}; 缺失 {missing or '无'}; 违禁 {violated or '无'}"
        return MetricScore(score=score, detail=detail, passed=passed)


@register
class MaxStepsMetric:
    """traj:max_steps —— 步数上限（效率约束）：工具调用次数不得超过上限。

    spec 参数：
        max_steps  步数上限（默认取 item.context.max_steps，均缺省时 10）
    超限记 0 分；上限内记 1 分（不奖励更少步数，效率下限交给业务侧数据）。
    """

    name = "traj:max_steps"

    def evaluate(self, item, output, spec):
        calls = _calls(output, spec)
        if not calls:
            return MetricScore(score=None, detail=_NO_TRAJECTORY, passed=None)
        limit = int(spec.get("max_steps") or get_by_path(item, "context.max_steps", 10) or 10)
        n = len(calls)
        ok = n <= limit
        return MetricScore(score=1.0 if ok else 0.0, detail=f"步数 {n}，上限 {limit}", passed=ok)


@register
class ToolArgsMetric:
    """traj:tool_args —— 指定工具的调用参数做 JSON Schema 校验。

    spec 参数：
        tool    工具名（必需）
        schema  JSON Schema 对象（必需）
    该工具的全部调用逐一校验，任一失败即 0 分；未调用该工具记 N/A
    （是否必须调用由 traj:tools_called 判定，两者组合使用）。
    """

    name = "traj:tool_args"

    def evaluate(self, item, output, spec):
        tool = spec.get("tool")
        schema = spec.get("schema")
        if not tool or not isinstance(schema, dict):
            raise MetricError("traj:tool_args 需要 spec.tool 与 spec.schema（对象）")
        calls = _calls(output, spec)
        matched = [c for c in calls if c["tool"] == tool]
        if not matched:
            return MetricScore(score=None, detail=f"未调用工具 {tool}", passed=None)
        for c in matched:
            try:
                jsonschema_validate(c["args"], schema)
            except JsonSchemaValidationError as e:
                return MetricScore(score=0.0, detail=f"{tool} 参数校验失败: {e.message}", passed=False)
        return MetricScore(score=1.0, detail=f"{tool} 参数校验通过（{len(matched)} 次调用）", passed=True)
