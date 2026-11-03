"""M4 指标单元测试：规则类全量 + LLM Judge（mock chat_json）。"""
import pytest

from agenthub.metrics import MetricError, get_by_path, get_metric
from agenthub.metrics import llm_judge

ITEM_QA = {"id": "it1", "input": {"question": "q"}, "expected": {"answer": "北京"}, "context": {"passages": ["北京是首都"]}, "tags": []}


def ev(name, item, output, **spec):
    if "value" not in spec:  # 显式 value 优先，否则默认取标准答案路径
        spec.setdefault("expected_path", "expected.answer")
    return get_metric(name).evaluate(item, output, {"type": name, **spec})


class TestRules:
    def test_exact(self):
        assert ev("rule:exact", ITEM_QA, {"answer": "北京"}).passed is True
        assert ev("rule:exact", ITEM_QA, {"answer": "上海"}).passed is False
        assert ev("rule:exact", ITEM_QA, {"answer": "北京 "}).passed is True  # strip
        assert ev("rule:exact", ITEM_QA, {"answer": "BEIJING"}, case_insensitive=True,
                  value="beijing").passed is True

    def test_contains_not_contains(self):
        assert ev("rule:contains", ITEM_QA, {"answer": "中国的首都是北京"}, expected_path="expected.answer").passed is True
        assert ev("rule:contains", ITEM_QA, {"answer": "上海"}).passed is False
        assert ev("rule:not_contains", ITEM_QA, {"answer": "没事"}, value="退款").passed is True
        assert ev("rule:not_contains", ITEM_QA, {"answer": "拒绝退款"}, value="退款").passed is False

    def test_regex(self):
        assert ev("rule:regex", ITEM_QA, {"answer": "订单号 A1002 已取消"}, pattern=r"A\d{4,}").passed is True
        assert ev("rule:regex", ITEM_QA, {"answer": "没有单号"}, pattern=r"A\d{4,}").passed is False

    def test_json_schema(self):
        schema = {"type": "object", "required": ["tool", "args"]}
        assert ev("rule:json_schema", ITEM_QA, {"answer": {"tool": "t", "args": {}}}, schema=schema).passed is True
        assert ev("rule:json_schema", ITEM_QA, {"answer": {"tool": "t"}}, schema=schema).passed is False
        assert ev("rule:json_schema", ITEM_QA, {"answer": "not json"}, schema=schema).score == 0.0

    def test_one_of(self):
        assert ev("rule:one_of", ITEM_QA, {"answer": "POSITIVE"}, choices=["positive", "negative"]).passed is True
        assert ev("rule:one_of", ITEM_QA, {"answer": "neutral"}, choices=["positive", "negative"]).passed is False

    def test_numeric_within(self):
        assert ev("rule:numeric_within", ITEM_QA, {"answer": "3.1416"}, value=3.14159, rel_tolerance=1e-3).passed is True
        assert ev("rule:numeric_within", ITEM_QA, {"answer": "10"}, value=8, abs_tolerance=2).passed is True
        # 非数值 → MetricError，经 evaluate_item 变为 N/A
        from agenthub.services import eval_service

        scores, passed, err = eval_service.evaluate_item(
            [{"type": "rule:numeric_within", "value": 8}], ITEM_QA, {"answer": "abc"})
        assert scores["rule:numeric_within"]["score"] is None and "numeric_within" in err

    def test_unknown_metric(self):
        with pytest.raises(MetricError):
            get_metric("rule:nope")

    def test_get_by_path(self):
        assert get_by_path(ITEM_QA, "expected.answer") == "北京"
        assert get_by_path(ITEM_QA, "context.passages.0") is None  # 不支持列表下标，返回默认
        assert get_by_path(ITEM_QA, "nope", "x") == "x"


class TestJudge:
    @pytest.fixture(autouse=True)
    def _mock_llm(self, monkeypatch):
        self.last_user = {}

        def fake_chat(system, user):
            self.last_user = user
            if "回答里没有答案" in user:
                return {"score": 0.0, "reason": "编造"}
            return {"score": 0.9, "reason": "正确"}

        monkeypatch.setattr(llm_judge, "chat_json", fake_chat)

    def test_correctness_pass_and_fail(self):
        ms = ev("judge:correctness", ITEM_QA, {"answer": "北京是中国的首都"})
        assert ms.score == 0.9 and ms.passed is True
        assert "北京" in self.last_user  # prompt 含标准答案

        ms = ev("judge:correctness", ITEM_QA, {"answer": "回答里没有答案"})
        assert ms.score == 0.0 and ms.passed is False

    def test_faithfulness_uses_context_not_answer(self):
        ms = ev("judge:faithfulness", ITEM_QA, {"answer": "北京"})
        assert ms.score == 0.9
        assert "北京是首都" in self.last_user and "标准答案" not in self.last_user

    def test_custom_rubric(self):
        ms = ev("judge:custom", ITEM_QA, {"answer": "x"}, rubric="是否押韵")
        assert ms.score == 0.9 and "押韵" in self.last_user

    def test_threshold_override(self):
        ms = ev("judge:correctness", ITEM_QA, {"answer": "x"}, threshold=0.5, value=None) if False else \
            get_metric("judge:correctness").evaluate(ITEM_QA, {"answer": "回答里没有答案"}, {"type": "judge:correctness", "threshold": 0.0})
        assert ms.passed is True  # 0.0 >= 0.0
