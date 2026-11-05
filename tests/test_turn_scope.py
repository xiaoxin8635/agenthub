"""multi_turn 逐轮评估单元测试：turn_eval 归一化 / turn_scope 分派 / eval_service 集成。"""
import pytest

from agenthub.metrics import get_metric
from agenthub.metrics import llm_judge
from agenthub.metrics.turn_eval import (
    evaluate_per_turn,
    evaluate_with_turn_scope,
    extract_turn_answers,
    last_user_question,
    user_questions,
    wrap_last_turn,
)
from agenthub.services import eval_service

ITEM_MULTI = {
    "id": "m1",
    "input": {
        "turns": [
            {"role": "user", "content": "第一问：退款政策？"},
            {"role": "assistant", "content": "7 天无理由"},
            {"role": "user", "content": "第二问：运费谁承担？"},
        ]
    },
    "expected": {"final_answer": "商家承担"},
    "context": {},
    "tags": [],
}

OUT_PER_TURN = {"answer": "商家承担", "turn_answers": ["7 天无理由退款", "商家承担运费"]}


def run(metric_name, item, output, **spec):
    return evaluate_with_turn_scope(get_metric(metric_name), item, output, {"type": metric_name, **spec})


def ev_item(metric_specs, item, output):
    return eval_service.evaluate_item(metric_specs, item, output)


class TestNormalize:
    def test_last_user_question(self):
        assert last_user_question(ITEM_MULTI) == "第二问：运费谁承担？"
        assert last_user_question({"input": {"turns": [{"role": "assistant", "content": "x"}]}}) == ""
        assert last_user_question({}) == ""

    def test_user_questions(self):
        assert user_questions(ITEM_MULTI) == ["第一问：退款政策？", "第二问：运费谁承担？"]

    def test_extract_turn_answers_shapes(self):
        assert extract_turn_answers(OUT_PER_TURN) == ["7 天无理由退款", "商家承担运费"]
        assert extract_turn_answers({"answers": ["a", "b"]}) == ["a", "b"]
        assert extract_turn_answers({"turns": [{"role": "assistant", "content": "r1"}, "文本轮"]}) == ["r1", "文本轮"]
        assert extract_turn_answers({"history": [{"content": "h"}]}) == ["h"]
        assert extract_turn_answers({"answer": "仅最终回答"}) == []  # 无逐轮结构
        assert extract_turn_answers({}) == []
        assert extract_turn_answers("非 dict") == []

    def test_wrap_last_turn(self):
        sub = wrap_last_turn(ITEM_MULTI)
        assert sub["input"] == {"question": "第二问：运费谁承担？"}
        assert sub["expected"] == {"answer": "商家承担"}
        assert sub["id"] == "m1"  # 其余字段保留


class TestTurnScopeLast:
    def test_rule_exact_with_expected_path(self):
        # rule 类指标无默认路径，需显式 expected_path；last 包装后命中提升的 final_answer→answer
        ms = run("rule:exact", ITEM_MULTI, {"answer": "商家承担"}, expected_path="expected.answer", turn_scope="last")
        assert ms.score == 1.0 and ms.passed is True

    def test_rule_exact_mismatch(self):
        ms = run("rule:exact", ITEM_MULTI, {"answer": "买家承担"}, expected_path="expected.answer", turn_scope="last")
        assert ms.score == 0.0 and ms.passed is False

    def test_judge_correctness_zero_config(self, monkeypatch):
        # judge 类指标有默认路径（input.question / expected.answer），last 包装后零配置可用
        captured = {}

        def fake_chat(system, user):
            captured["user"] = user
            return {"score": 0.9, "reason": "ok"}

        monkeypatch.setattr(llm_judge, "chat_json", fake_chat)
        ms = run("judge:correctness", ITEM_MULTI, {"answer": "商家承担运费"}, turn_scope="last")
        assert ms.score == 0.9
        assert "第二问：运费谁承担？" in captured["user"]  # question_path 默认 input.question 命中最后一轮
        assert "商家承担" in captured["user"]  # expected_path 默认 expected.answer 命中 final_answer

    def test_default_scope_unchanged(self):
        # 无 turn_scope：现状行为——rule 类无 expected_path/value 直接 MetricError
        from agenthub.metrics import MetricError

        with pytest.raises(MetricError):
            run("rule:exact", ITEM_MULTI, {"answer": "商家承担"})


class TestTurnScopeEach:
    def test_mean_aggregation(self):
        # rule:custom length_range 不需要期望值，逐轮可评
        item = {**ITEM_MULTI, "expected": {}}
        ms = run("rule:custom", item, OUT_PER_TURN, kind="length_range", min_len=2, max_len=10, turn_scope="each")
        assert ms.score == 1.0 and ms.passed is True
        assert "轮1=" in ms.detail and "轮2=" in ms.detail

    def test_partial_scores(self):
        item = {**ITEM_MULTI, "expected": {}}
        out = {"turn_answers": ["合格回答内容", "太短"]}  # 第二轮长度 2 < min_len 3
        ms = run("rule:custom", item, out, kind="length_range", min_len=3, max_len=10, turn_scope="each")
        assert ms.score == 0.5 and ms.passed is False

    def test_each_without_turn_structure_na(self):
        item = {**ITEM_MULTI, "expected": {}}
        ms = run("rule:custom", item, {"answer": "整体回答"}, kind="length_range", min_len=1, turn_scope="each")
        assert ms.score is None and ms.passed is None
        assert "逐轮" in ms.detail

    def test_each_fewer_answers_than_questions(self):
        item = {**ITEM_MULTI, "expected": {}}
        out = {"turn_answers": ["只有一轮回答"]}  # 2 问 1 答：只评有回答的轮，配对第 1 问
        from agenthub.metrics.turn_eval import evaluate_per_turn

        captured = {}
        orig = get_metric("rule:custom")

        class Spy:
            name = orig.name

            def evaluate(self, item_, output_, spec_):
                captured["q"] = item_["input"].get("question")
                return orig.evaluate(item_, output_, spec_)

        ms = evaluate_per_turn(Spy(), item, out, {"type": "rule:custom", "kind": "length_range", "min_len": 1})
        assert ms.score == 1.0
        assert captured["q"] == "第一问：退款政策？"

    def test_each_na_turns_excluded_from_aggregation(self):
        # 指标对某轮 N/A（如 judge 未配置）时该轮不计入均值与 passed
        from agenthub.metrics.base import MetricScore

        class FakeMetric:
            name = "fake"

            def evaluate(self, item_, output_, spec_):
                if output_["answer"] == "轮1" :
                    return MetricScore(score=1.0, passed=True)
                return MetricScore(score=None, passed=None)  # N/A

        ms = evaluate_per_turn(FakeMetric(), {**ITEM_MULTI, "expected": {}},
                               {"turn_answers": ["轮1", "轮2"]}, {"type": "fake"})
        assert ms.score == 1.0 and ms.passed is True
        assert "N/A" in ms.detail


class TestEvalServiceIntegration:
    def test_item_level_scores_with_each(self):
        item = {**ITEM_MULTI, "expected": {}}
        scores, passed, err = ev_item(
            [{"type": "rule:custom", "kind": "length_range", "min_len": 2, "max_len": 20, "turn_scope": "each"}],
            item,
            OUT_PER_TURN,
        )
        assert err == ""
        assert scores["rule:custom"]["score"] == 1.0
        assert passed is True

    def test_item_level_last(self):
        scores, passed, err = ev_item(
            [{"type": "rule:exact", "expected_path": "expected.answer", "turn_scope": "last"}],
            ITEM_MULTI,
            {"answer": "商家承担"},
        )
        assert err == "" and scores["rule:exact"]["passed"] is True and passed is True

    def test_item_level_default_compat(self):
        # 默认（无 turn_scope）与旧行为一致：expected.answer 缺失 → metric error 字段记录
        scores, passed, err = ev_item([{"type": "rule:exact"}], ITEM_MULTI, {"answer": "商家承担"})
        assert "rule:exact" in err
        assert scores["rule:exact"]["score"] is None and passed is None
