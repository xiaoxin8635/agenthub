"""指标插件体系：统一接口 + 注册表。

指标规格（MetricSpec）存储在 MetricConfig.metrics 中，形如：
    {"type": "rule:exact", "actual": "answer", "expected_path": "expected.answer", "weight": 1}
type 前缀决定类别：rule:* 纯函数 / judge:* LLM 评分 / rag:* RAG / traj:* 轨迹。
"""
from dataclasses import dataclass, field
from typing import Any, Protocol

# item   = 快照 item：{"id","input","expected","context","tags"}
# output = Agent 输出（任意 JSON dict，通常含 answer/trajectory）
# spec   = 该指标的配置（含 type 及参数）


class MetricError(Exception):
    pass


@dataclass
class MetricScore:
    score: float | None  # 0.0~1.0；None = 无法评估（N/A）
    detail: str = ""
    passed: bool | None = None

    def as_dict(self) -> dict:
        return {"score": self.score, "detail": self.detail, "passed": self.passed}


class Metric(Protocol):
    name: str

    def evaluate(self, item: dict, output: dict, spec: dict) -> MetricScore: ...


_REGISTRY: dict[str, Metric] = {}


def register(cls: type) -> type:
    instance = cls()
    _REGISTRY[instance.name] = instance
    return cls


def get_metric(type_name: str) -> Metric:
    if type_name not in _REGISTRY:
        raise MetricError(f"unknown metric type: {type_name} (registered: {sorted(_REGISTRY)})")
    return _REGISTRY[type_name]


def all_metrics() -> dict[str, Metric]:
    return dict(_REGISTRY)


def get_by_path(obj: dict[str, Any], path: str, default: Any = None) -> Any:
    """点路径取值：get_by_path(output, "answer") / get_by_path(item, "expected.answer")。"""
    cur: Any = obj
    for part in path.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return default
    return cur
