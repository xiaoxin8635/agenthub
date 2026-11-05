"""轨迹归一化：从被测 Agent 输出中提取标准化的工具调用序列。

被测系统的轨迹形状各异（{"steps": [...]} / 直接列表 / 键别名不同），
各 traj:* 指标与 judge:trajectory 统一经由 extract_tool_calls 取数。
宽松解析策略：形状不符或缺键的步骤跳过，整体无轨迹返回空列表（调用方记 N/A），
不强求被测端适配统一协议，接入成本最低。
"""
import json

from agenthub.metrics.base import get_by_path

# 步骤对象中工具名的常见键别名（按序取第一个字符串命中）
_TOOL_KEYS = ("tool", "tool_name", "name", "action", "function")
# 步骤对象中参数的常见键别名（按序取第一个 dict 命中）
_ARG_KEYS = ("args", "arguments", "input", "parameters", "params")


def extract_tool_calls(output: dict, path: str = "trajectory") -> list[dict]:
    """从 output 提取工具调用序列，返回标准形式 [{"tool": str, "args": dict}, ...]。

    兼容形状：
        output.trajectory = {"steps": [{tool, args, ...}, ...]}（tool_calls 键亦可）
        output.trajectory = [{tool, args, ...}, ...]（直接列表）
        键别名：tool/tool_name/name/action/function；args/arguments/input/parameters/params
    无轨迹 / 形状不符 / path 取不到值时返回 []。
    """
    if not isinstance(output, dict):
        return []
    raw = get_by_path(output, path, [])
    if isinstance(raw, dict):  # {"steps": [...]} / {"tool_calls": [...]} 包装
        raw = raw.get("steps") or raw.get("tool_calls") or []
    if not isinstance(raw, list):
        return []
    calls: list[dict] = []
    for step in raw:
        if not isinstance(step, dict):
            continue
        tool = next((step[k] for k in _TOOL_KEYS if isinstance(step.get(k), str) and step[k].strip()), None)
        if tool is None:
            continue
        args = next((step[k] for k in _ARG_KEYS if isinstance(step.get(k), dict)), {})
        calls.append({"tool": tool.strip(), "args": args})
    return calls


def format_tool_calls(calls: list[dict]) -> str:
    """工具调用序列编号文本化（judge:trajectory 组 prompt 用）。"""
    return "\n".join(
        f"[步骤{i + 1}] {c['tool']}({json.dumps(c['args'], ensure_ascii=False)})" for i, c in enumerate(calls)
    )
