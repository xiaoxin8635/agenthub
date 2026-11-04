"""规则类指标：零成本、确定性，全部可离线跑。

公共 spec 参数：
    actual        从 output 取值的点路径（默认 "answer"）
    expected_path 从 item 取值的点路径（与 value 二选一）
    value         直接给定的期望值
    threshold     通过阈值（默认规则类 1.0 即完全通过）
"""
import json
import re

from jsonschema import ValidationError as JsonSchemaValidationError
from jsonschema import validate as jsonschema_validate

from agenthub.metrics.base import MetricError, MetricScore, get_by_path, register


def _resolve_actual(output: dict, spec: dict):
    return get_by_path(output, spec.get("actual", "answer"))


def _resolve_expected(item: dict, spec: dict):
    if "expected_path" in spec:
        return get_by_path(item, spec["expected_path"])
    if "value" in spec:
        return spec["value"]
    raise MetricError("spec 需要 expected_path 或 value 之一")


def _score(spec: dict, ok_value: float) -> MetricScore:
    threshold = float(spec.get("threshold", 1.0))
    return MetricScore(score=ok_value, detail=spec.get("detail", ""), passed=ok_value >= threshold)


@register
class ExactMetric:
    """rule:exact —— 实际值与期望值精确相等（可忽略大小写）。"""
    name = "rule:exact"

    def evaluate(self, item, output, spec):
        actual, expected = _resolve_actual(output, spec), _resolve_expected(item, spec)
        a = str(actual).strip() if actual is not None else ""
        e = str(expected).strip() if expected is not None else ""
        if spec.get("case_insensitive"):
            a, e = a.lower(), e.lower()
        return _score(spec, 1.0 if a == e else 0.0)


@register
class ContainsMetric:
    """rule:contains —— 实际值包含期望关键词。"""
    name = "rule:contains"

    def evaluate(self, item, output, spec):
        actual, expected = _resolve_actual(output, spec), _resolve_expected(item, spec)
        a, e = str(actual or ""), str(expected)
        if spec.get("case_insensitive"):
            a, e = a.lower(), e.lower()
        return _score(spec, 1.0 if e in a else 0.0)


@register
class NotContainsMetric:
    """rule:not_contains —— 实际值不包含指定关键词（如违禁词）。"""
    name = "rule:not_contains"

    def evaluate(self, item, output, spec):
        actual, expected = _resolve_actual(output, spec), _resolve_expected(item, spec)
        a, e = str(actual or ""), str(expected)
        if spec.get("case_insensitive"):
            a, e = a.lower(), e.lower()
        return _score(spec, 1.0 if e not in a else 0.0)


@register
class RegexMetric:
    """rule:regex —— 实际值匹配正则表达式。"""
    name = "rule:regex"

    def evaluate(self, item, output, spec):
        actual = _resolve_actual(output, spec)
        pattern = spec.get("pattern") or _resolve_expected(item, spec)
        try:
            matched = re.search(str(pattern), str(actual or "")) is not None
        except re.error as e:
            raise MetricError(f"invalid regex: {e}") from e
        return _score(spec, 1.0 if matched else 0.0)


@register
class JsonSchemaMetric:
    """rule:json_schema —— 输出（或其字段）通过 JSON Schema 校验。"""
    name = "rule:json_schema"

    def evaluate(self, item, output, spec):
        actual = _resolve_actual(output, spec)
        schema = spec.get("schema") or _resolve_expected(item, spec)
        if not isinstance(schema, dict):
            raise MetricError("json_schema 需要字典 schema（spec.schema 或 expected_path）")
        if isinstance(actual, str):
            try:
                actual = json.loads(actual)
            except json.JSONDecodeError as e:
                return MetricScore(score=0.0, detail=f"输出不是合法 JSON: {e}", passed=False)
        try:
            jsonschema_validate(actual, schema)
        except JsonSchemaValidationError as e:
            return MetricScore(score=0.0, detail=f"schema 校验失败: {e.message}", passed=False)
        return _score(spec, 1.0)


@register
class OneOfMetric:
    """rule:one_of —— 实际值落在候选集合内。"""
    name = "rule:one_of"

    def evaluate(self, item, output, spec):
        actual = _resolve_actual(output, spec)
        choices = spec.get("choices") or _resolve_expected(item, spec)
        if not isinstance(choices, (list, tuple, set)):
            raise MetricError("one_of 需要 choices 列表")
        a = str(actual).strip().lower() if actual is not None else ""
        normalized = {str(c).strip().lower() for c in choices}
        return _score(spec, 1.0 if a in normalized else 0.0)


@register
class NumericWithinMetric:
    """rule:numeric_within —— 数值比较，支持绝对/相对容差。"""
    name = "rule:numeric_within"

    def evaluate(self, item, output, spec):
        actual, expected = _resolve_actual(output, spec), _resolve_expected(item, spec)
        try:
            a, e = float(actual), float(expected)
        except (TypeError, ValueError) as exc:
            raise MetricError(f"非数值无法比较: actual={actual!r} expected={expected!r}") from exc
        tol_abs = float(spec.get("abs_tolerance", 0.0))
        tol_rel = float(spec.get("rel_tolerance", 0.0))
        ok = abs(a - e) <= tol_abs + tol_rel * abs(e)
        return _score(spec, 1.0 if ok else 0.0)


@register
class CustomMetric:
    """rule:custom —— 自定义规则入口：按 kind 分派（regex/numeric_within/json_schema 复用内置实现）。

    spec 参数：
        kind        contains_any / length_range / regex / numeric_within / json_schema
        keywords    contains_any: 关键词列表；match=any(任一命中)/all(全部命中)
        match       contains_any 的命中模式，默认 any
        min_len / max_len   length_range: 文本长度区间（min_len 默认 0，max_len 默认无穷）
        其余 kind 的参数与对应内置指标一致（pattern / expected+tolerances / schema）
    """

    name = "rule:custom"
    _DELEGATE = {"regex": RegexMetric, "numeric_within": NumericWithinMetric, "json_schema": JsonSchemaMetric}

    def evaluate(self, item, output, spec):
        kind = spec.get("kind")
        if kind == "contains_any":
            return self._contains_any(item, output, spec)
        if kind == "length_range":
            return self._length_range(item, output, spec)
        delegate = self._DELEGATE.get(kind)
        if delegate is None:
            raise MetricError(f"rule:custom 不支持的 kind={kind!r}（可选 contains_any/length_range/regex/numeric_within/json_schema）")
        return delegate().evaluate(item, output, spec)

    def _contains_any(self, item, output, spec):
        actual = _resolve_actual(output, spec)
        keywords = spec.get("keywords")
        if not isinstance(keywords, (list, tuple)) or not keywords:
            raise MetricError("contains_any 需要 keywords 列表")
        a = str(actual or "")
        if spec.get("case_insensitive", True):
            a = a.lower()
            keywords = [str(k).lower() for k in keywords]
        else:
            keywords = [str(k) for k in keywords]
        hits = [k for k in keywords if k in a]
        want_all = spec.get("match", "any") == "all"
        ok = len(hits) == len(keywords) if want_all else bool(hits)
        score = MetricScore(score=1.0 if ok else 0.0, passed=ok)
        score.detail = f"命中 {len(hits)}/{len(keywords)}: {hits or '无'}"
        return score

    def _length_range(self, item, output, spec):
        actual = _resolve_actual(output, spec)
        n = len(str(actual or ""))
        lo = int(spec.get("min_len", 0))
        hi = spec.get("max_len")
        ok = n >= lo and (hi is None or n <= int(hi))
        score = MetricScore(score=1.0 if ok else 0.0, passed=ok)
        score.detail = f"长度 {n}，要求 [{lo}, {hi if hi is not None else '∞'}]"
        return score
