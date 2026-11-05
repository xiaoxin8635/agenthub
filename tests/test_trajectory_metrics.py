"""轨迹类指标单元测试：traj_parse 归一化 + traj:* 规则指标 + judge:trajectory（mock chat_json）。"""
import pytest

from agenthub.metrics import MetricError, get_metric
from agenthub.metrics import llm_judge
from agenthub.metrics.traj_parse import extract_tool_calls, format_tool_calls

ITEM_TRAJ = {
    "id": "t1",
    "input": {"task": "查询订单 A1002 状态"},
    "expected": {
        "outcome": "告知已发货",
        "must_call_tools": ["query_order"],
        "must_not_call_tools": ["cancel_order"],
    },
    "context": {"available_tools": ["query_order", "cancel_order"], "max_steps": 3},
    "tags": [],
}


def ev(name, item, output, **spec):
    return get_metric(name).evaluate(item, output, {"type": name, **spec})


def out_steps(*tools, wrap="steps"):
    """构造带轨迹的 output；wrap="raw" 时 trajectory 直接是列表。"""
    steps = [{"tool": t, "args": {"order_id": "A1002"}} for t in tools]
    traj = {wrap: steps} if wrap == "steps" else steps
    return {"answer": "已发货", "trajectory": traj}


class TestExtract:
    def test_steps_wrapper(self):
        calls = extract_tool_calls(out_steps("query_order"))
        assert calls == [{"tool": "query_order", "args": {"order_id": "A1002"}}]

    def test_raw_list(self):
        calls = extract_tool_calls(out_steps("query_order", "search_log", wrap="raw"))
        assert [c["tool"] for c in calls] == ["query_order", "search_log"]

    def test_tool_calls_wrapper_key(self):
        out = {"trajectory": {"tool_calls": [{"tool": "a", "args": {}}]}}
        assert extract_tool_calls(out)[0]["tool"] == "a"

    def test_key_aliases(self):
        out = {"trajectory": [{"tool_name": "a", "arguments": {"x": 1}}, {"action": "b", "parameters": {}}]}
        assert [c["tool"] for c in extract_tool_calls(out)] == ["a", "b"]
        assert extract_tool_calls(out)[0]["args"] == {"x": 1}

    def test_missing_or_invalid_shapes(self):
        assert extract_tool_calls({}) == []  # 无轨迹
        assert extract_tool_calls({"trajectory": None}) == []
        assert extract_tool_calls({"trajectory": "文本轨迹"}) == []  # 非列表
        assert extract_tool_calls({"trajectory": ["纯文本步骤", {"args": {}}]}) == []  # 非 dict / 无工具名跳过
        assert extract_tool_calls({"answer": {"steps": []}}) == []  # 路径取不到

    def test_custom_path(self):
        out = {"answer": "x", "trace": {"steps": [{"tool": "t", "args": {}}]}}
        assert extract_tool_calls(out, "trace")[0]["tool"] == "t"

    def test_format(self):
        text = format_tool_calls([{"tool": "query_order", "args": {"order_id": "A1002"}}])
        assert text == "[步骤1] query_order({\"order_id\": \"A1002\"})"


class TestToolsCalled:
    def test_full_match_pass(self):
        r = ev("traj:tools_called", ITEM_TRAJ, out_steps("query_order"))
        assert r.score == 1.0 and r.passed is True

    def test_missing_call_fails(self):
        r = ev("traj:tools_called", ITEM_TRAJ, out_steps("search_log"))
        assert r.score == 0.0 and r.passed is False and "query_order" in r.detail

    def test_must_not_violation_zero(self):
        # 调用了禁用工具：即使 must_call 全命中也直接 0 分
        r = ev("traj:tools_called", ITEM_TRAJ, out_steps("query_order", "cancel_order"))
        assert r.score == 0.0 and r.passed is False and "cancel_order" in r.detail

    def test_partial_ratio(self):
        item = {**ITEM_TRAJ, "expected": {**ITEM_TRAJ["expected"], "must_call_tools": ["a", "b"]}}
        r = ev("traj:tools_called", item, out_steps("a"), partial=True)
        assert r.score == 0.5 and r.passed is False  # 命中 1/2，threshold 默认 1.0
        r = ev("traj:tools_called", item, out_steps("a"), partial=True, threshold=0.5)
        assert r.passed is True

    def test_only_must_not(self):
        # 只有禁用约束：未违禁即通过
        item = {**ITEM_TRAJ, "expected": {"outcome": "x", "must_call_tools": [], "must_not_call_tools": ["cancel_order"]}}
        assert ev("traj:tools_called", item, out_steps("query_order")).passed is True

    def test_no_trajectory_na(self):
        r = ev("traj:tools_called", ITEM_TRAJ, {"answer": "无轨迹"})
        assert r.score is None and r.passed is None

    def test_spec_overrides_expected(self):
        r = ev("traj:tools_called", ITEM_TRAJ, out_steps("x"), must_call=["x"], must_not_call=[])
        assert r.passed is True


class TestMaxSteps:
    def test_within_limit(self):
        r = ev("traj:max_steps", ITEM_TRAJ, out_steps("query_order", "search_log", "query_logistics"))
        assert r.score == 1.0 and "3" in r.detail  # context.max_steps=3

    def test_over_limit(self):
        r = ev("traj:max_steps", ITEM_TRAJ, out_steps("a", "b", "c", "d"))
        assert r.score == 0.0 and r.passed is False

    def test_spec_override(self):
        r = ev("traj:max_steps", ITEM_TRAJ, out_steps("a", "b"), max_steps=1)
        assert r.passed is False
        assert ev("traj:max_steps", ITEM_TRAJ, out_steps("a"), max_steps=5).passed is True

    def test_default_limit_without_context(self):
        item = {**ITEM_TRAJ, "context": {}}
        steps = [{"tool": f"t{i}", "args": {}} for i in range(10)]
        assert ev("traj:max_steps", item, {"trajectory": {"steps": steps}}).passed is True  # 默认 10
        steps.append({"tool": "extra", "args": {}})
        assert ev("traj:max_steps", item, {"trajectory": {"steps": steps}}).passed is False

    def test_no_trajectory_na(self):
        assert ev("traj:max_steps", ITEM_TRAJ, {"answer": "x"}).score is None


class TestToolArgs:
    SCHEMA = {"type": "object", "required": ["order_id"], "properties": {"order_id": {"type": "string"}}}

    def test_valid_args(self):
        r = ev("traj:tool_args", ITEM_TRAJ, out_steps("query_order"), tool="query_order", schema=self.SCHEMA)
        assert r.score == 1.0 and r.passed is True

    def test_invalid_args(self):
        out = {"trajectory": {"steps": [{"tool": "query_order", "args": {"wrong": 123}}]}}
        r = ev("traj:tool_args", ITEM_TRAJ, out, tool="query_order", schema=self.SCHEMA)
        assert r.score == 0.0 and r.passed is False and "order_id" in r.detail

    def test_all_calls_checked(self):
        steps = [{"tool": "query_order", "args": {"order_id": "A"}}, {"tool": "query_order", "args": {"bad": 1}}]
        r = ev("traj:tool_args", ITEM_TRAJ, {"trajectory": {"steps": steps}}, tool="query_order", schema=self.SCHEMA)
        assert r.passed is False  # 第二次调用违规

    def test_tool_not_called_na(self):
        r = ev("traj:tool_args", ITEM_TRAJ, out_steps("other"), tool="query_order", schema=self.SCHEMA)
        assert r.score is None and r.passed is None

    def test_missing_spec_raises(self):
        with pytest.raises(MetricError, match="spec.tool"):
            ev("traj:tool_args", ITEM_TRAJ, out_steps("query_order"), schema=self.SCHEMA)


class TestJudgeTrajectory:
    @pytest.fixture(autouse=True)
    def _mock_llm(self, monkeypatch):
        self.last_user = {}

        def fake_chat(system, user):
            self.last_user = user
            return {"score": 0.7, "reason": "路径可行"}

        monkeypatch.setattr(llm_judge, "chat_json", fake_chat)

    def test_prompt_contains_task_outcome_steps(self):
        ms = ev("judge:trajectory", ITEM_TRAJ, out_steps("query_order"))
        assert ms.score == 0.7 and ms.passed is True  # threshold 默认 0.7
        assert "查询订单 A1002 状态" in self.last_user
        assert "告知已发货" in self.last_user
        assert "[步骤1] query_order" in self.last_user
        assert "query_order, cancel_order" in self.last_user  # 可用工具清单

    def test_no_trajectory_na(self):
        ms = ev("judge:trajectory", ITEM_TRAJ, {"answer": "无轨迹"})
        assert ms.score is None and ms.passed is None
        assert self.last_user == {}  # 未调用 LLM

    def test_custom_rubric(self):
        ms = ev("judge:trajectory", ITEM_TRAJ, out_steps("query_order"), rubric="自定义细则")
        assert "自定义细则" in self.last_user

    def test_threshold(self):
        ms = ev("judge:trajectory", ITEM_TRAJ, out_steps("query_order"), threshold=0.9)
        assert ms.passed is False  # 0.7 < 0.9
