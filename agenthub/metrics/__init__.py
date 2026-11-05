"""指标插件注册入口：import 本包即完成全部内置指标注册。"""
from agenthub.metrics import rule_based, llm_judge, trajectory  # noqa: F401 注册副作用
from agenthub.metrics.base import Metric, MetricError, MetricScore, all_metrics, get_by_path, get_metric
from agenthub.metrics.traj_parse import extract_tool_calls, format_tool_calls

__all__ = [
    "Metric", "MetricError", "MetricScore", "all_metrics", "get_metric", "get_by_path",
    "rule_based", "llm_judge", "trajectory", "extract_tool_calls", "format_tool_calls",
]
