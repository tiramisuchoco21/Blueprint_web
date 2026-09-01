# -*- coding: utf-8 -*-
"""골든 테스트 — 페르소나 문서의 숫자가 코드로 재현되는지 검증한다.

이 테스트가 통과해야 Numeric Guard의 화이트리스트가 성립한다.
AI보다 먼저 통과시켜야 하는 이유가 여기 있다.

실행:  cd backend && python -m pytest tests -q
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import calculator, impulse, rules, session as session_engine  # noqa: E402
from app.services import load_personas, load_transactions  # noqa: E402


@pytest.fixture(scope="module")
def personas():
    return load_personas()


# ─────────────────────────────────────────────────────────────
# 순수 금융 계산
# ─────────────────────────────────────────────────────────────
def test_monthly_payment_matches_persona_doc():
    """3.2억 / 연 3.55% / 30년 → 문서의 '월 원리금 약 145만 원'."""
    assert calculator.monthly_payment(320_000_000, 0.0355, 360) == 1_445_889


def test_rate_build_excludes_ended_discount(personas):
    """종료된 전자계약 우대(-0.1%p)는 자동 반영하지 않는다."""
    from app.engine import policy_db

    policy = policy_db.get_policy("newlywed_purchase")
    terms = calculator.build_rate(policy["rate"]["build"], personas["persona2"])
    assert terms.final_rate == pytest.approx(0.0355)          # 3.85% − 0.30%p
    assert any(d["label"].startswith("청약저축") for d in terms.applied_discounts)
    assert any(d["label"].startswith("전자계약") for d in terms.excluded_discounts)


# ─────────────────────────────────────────────────────────────
# 페르소나 1 — 전세 독립
# ─────────────────────────────────────────────────────────────
def test_persona1_waterfall_shows_all_four_states(personas):
    """Eligible / Conditional / Not Eligible / Ended 가 한 화면에 다 나와야 한다."""
    results = rules.waterfall(personas["persona1"])
    states = {r.status for r in results}
    assert {"ELIGIBLE", "CONDITIONAL", "NOT_ELIGIBLE", "ENDED"} <= states


def test_persona1_ended_policies(personas):
    """1세대 문서가 주력으로 밀던 두 정책이 종료 상태로 잡혀야 한다."""
    by_id = {r.policy_id: r for r in rules.waterfall(personas["persona1"])}
    assert by_id["sme_youth_jeonse"].status == "ENDED"
    assert by_id["youth_leap_account"].status == "ENDED"


def test_persona1_butimok_eligible_and_capped(personas):
    by_id = {r.policy_id: r for r in rules.waterfall(personas["persona1"])}
    b = by_id["youth_butimok"]
    assert b.status == "ELIGIBLE"
    assert b.estimated_amount == 80_000_000        # 1억 × 80% vs 한도 1.5억
    assert "80%" in b.amount_basis


def test_persona1_maturity_mismatch_is_conditional(personas):
    """자격은 되지만 3년 만기 ↔ 24개월 목표가 안 맞아 조건부여야 한다."""
    by_id = {r.policy_id: r for r in rules.waterfall(personas["persona1"])}
    savings = by_id["youth_future_savings"]
    assert savings.status == "CONDITIONAL"
    mf = next(c for c in savings.checks if c.field == "maturity_months")
    assert mf.passed is False
    assert "현금화" in (mf.note or "")


@pytest.mark.parametrize("saving,months,delta,verdict", [
    (400_000, 35, +11, "NOT_ACHIEVABLE"),   # 문서: "약 35개월 / 약 11개월 늦음" 🔴
    (500_000, 28, +4, "TIGHT"),             # 문서: "약 28개월 / 약 4개월 추가 필요" 🟡
    (583_334, 24, 0, "ACHIEVABLE"),         # 문서: "약 24개월 / 기본 추천값" 🟢
    (700_000, 20, -4, "ACHIEVABLE"),        # 문서: "약 20개월 / 약 4개월 단축" 🟢
])
def test_persona1_slider_matches_design_doc(personas, saving, months, delta, verdict):
    """MVP 설계서 p.8 What-if Simulator 표 4행을 그대로 재현한다.

    이 시연이 공모전의 핵심 인터랙션이므로 숫자를 테스트로 고정한다.
    """
    from app.services import simulate

    r = simulate(personas["persona1"], monthly_saving=saving)
    assert r["months_to_goal"] == months
    assert r["delta_months"] == delta
    assert r["feasibility"]["verdict"] == verdict


def test_persona1_feasibility_numbers(personas):
    """문서: 자기자본 2,000만 / 추가 1,400만 / 월 약 58.3만."""
    p = personas["persona1"]
    cap = rules.total_policy_capacity(rules.waterfall(p))
    feas = calculator.feasibility(p, cap)
    assert cap == 80_000_000
    assert feas.required_equity == 20_000_000
    assert feas.gap == 14_000_000
    assert feas.required_monthly == 583_334        # ceil(14,000,000 / 24)


# ─────────────────────────────────────────────────────────────
# 페르소나 2 — 내집마련
# ─────────────────────────────────────────────────────────────
def test_persona2_newlywed_is_conditional_not_eligible(personas):
    """결혼까지 12개월 남았으므로 '신청 가능'으로 표시하면 안 된다."""
    by_id = {r.policy_id: r for r in rules.waterfall(personas["persona2"])}
    n = by_id["newlywed_purchase"]
    assert n.status == "CONDITIONAL"
    assert n.estimated_amount == 320_000_000       # 4억이 아니라 3.2억


def test_primary_loan_prefers_verified_over_bigger(personas):
    """미검증 정책(보금자리론 3.6억)이 검증된 정책(신혼부부 3.2억)을 밀어내면 안 된다."""
    results = rules.waterfall(personas["persona2"])
    primary = rules.select_primary_loan(results)
    assert primary.policy_id == "newlywed_purchase"


def test_persona2_shortfall_is_81m(personas):
    """문서: 6억 − (1.99억 + 3.2억) = 약 8,100만 원 부족."""
    p = personas["persona2_repaid"]
    cap = rules.total_policy_capacity(rules.waterfall(p))
    feas = calculator.feasibility(p, cap)
    assert feas.projected_cash == 199_000_000      # 1.75억 + 200만×12
    assert cap == 320_000_000
    assert feas.shortfall_at_horizon == 81_000_000
    assert feas.verdict == "NOT_ACHIEVABLE"


def test_persona2_five_hundred_million_is_achievable(personas):
    """문서: 5억이면 자기자본 1.8억, 예상현금 1.99억 → 버퍼 1,900만."""
    p = personas["persona2_repaid"].model_copy(update={"target_amount": 500_000_000})
    cap = rules.total_policy_capacity(rules.waterfall(p))
    feas = calculator.feasibility(p, cap)
    assert feas.required_equity == 180_000_000
    assert feas.projected_cash - feas.required_equity == 19_000_000
    assert feas.shortfall_at_horizon == 0


def test_persona2_debt_decision_recommends_repay(personas):
    d = calculator.debt_decision(personas["persona2"])
    assert d.recommend == "REPAY"
    assert d.annual_interest_saved == 1_300_000    # 2,500만 × 5.2%
    assert d.cash_after_repay == 175_000_000


# ─────────────────────────────────────────────────────────────
# 충동성 — 실데이터
# ─────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def txs():
    data = load_transactions()
    if not data:
        pytest.skip("fixtures/tx_dummy.json 없음 — tools/build_fixture.py 먼저 실행")
    return list(data)


def test_planned_gate_beats_amount(txs):
    """고액이라고 충동이 아니다: 교육비 118,000원 < 다이소 1,000원."""
    scores = {s.tx_id: s for s in impulse.score_all(txs)}
    by_id = {t.id: t for t in txs}

    edu = [s for i, s in scores.items() if by_id[i].category == "education"]
    assert edu, "education 카테고리 거래가 있어야 한다"
    assert all(s.total <= impulse.PLANNED_CAP for s in edu)

    daiso = [s for i, s in scores.items()
             if by_id[i].brand == "다이소" and by_id[i].at.hour >= 22]
    assert daiso and max(s.total for s in daiso) > impulse.PLANNED_CAP


def test_unknown_category_disables_two_axes(txs):
    """카테고리 미상이면 deviation·discretionary 축이 죽는다 → AI가 전제조건."""
    scores = {s.tx_id: s for s in impulse.score_all(txs)}
    by_id = {t.id: t for t in txs}
    unknown = [s for i, s in scores.items() if by_id[i].category == "unknown"]
    assert unknown, "unknown 거래가 있어야 이 테스트가 의미 있다"
    assert all(s.factors["deviation"] == 0.0 for s in unknown)
    assert all(s.factors["discretionary"] == 0.0 for s in unknown)


def test_night_chain_detected_as_session(txs):
    """22:27 분99 → 23:14 올리브영 → 23:29 다이소 가 한 세션으로 묶여야 한다."""
    sessions = session_engine.detect(txs)
    night = [s for s in sessions if s.is_night and len(s.tx_ids) >= 3]
    assert night, "야간 3건 연쇄 세션이 잡혀야 한다"
    s = max(night, key=lambda x: len(x.tx_ids))
    assert s.duration_minutes <= 90
    assert s.score > 0


def test_no_future_leak_in_scoring(txs):
    """채점에 미래 거래가 새어들면 안 된다 — 첫 거래는 burst/repeat가 0이어야."""
    first = min(txs, key=lambda t: t.at)
    scores = {s.tx_id: s for s in impulse.score_all(txs)}
    s = scores[first.id]
    assert s.factors["burst"] == 0.0
    assert s.factors["rapid_repeat"] == 0.0
