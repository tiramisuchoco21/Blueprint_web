# -*- coding: utf-8 -*-
"""부채 엔진 테스트 — '갚는 것'과 '끼고 사는 것'.

팀 논의: "대출금이 갚는 거야, 대출 끼고 산다는 거야?" → "둘 다".
두 축을 잇는 고리는 DTI다: 부채를 갚으면 여력이 생겨 대출 한도가 올라간다.
단, 한도가 DTI가 아닌 다른 제약에 걸려 있으면 갚아도 늘지 않는다.
그 구분이 정확히 되는지 검증한다.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import services  # noqa: E402
from app.engine import calculator, debt, rules  # noqa: E402
from app.schemas.finance import DebtItem  # noqa: E402
from app.schemas.profile import UserProfile  # noqa: E402


@pytest.fixture(scope="module")
def personas():
    return services.load_personas()


# ─────────────────────────────────────────────────────────────
# 1. 상환 계획
# ─────────────────────────────────────────────────────────────
def test_student_loan_repayment_plan():
    """학자금 400만 @1.7% / 48개월."""
    d = DebtItem(kind="student", balance=4_000_000, rate=0.017, remaining_months=48)
    assert debt.monthly_due(d) == calculator.monthly_payment(4_000_000, 0.017, 48)
    plan = debt.repayment_plan(d)
    assert plan.months_to_clear == 48
    assert plan.total_interest > 0
    assert plan.interest_only is False


def test_interest_only_debt_never_clears():
    """만기일시 신용대출은 이자만 내면 원금이 영원히 안 줄어든다."""
    d = DebtItem(kind="credit", balance=25_000_000, rate=0.052)
    plan = debt.repayment_plan(d)
    assert plan.interest_only is True
    assert plan.months_to_clear is None
    assert plan.monthly_payment == int(25_000_000 * 0.052 / 12)


def test_extra_payment_shortens_and_saves_interest():
    d = DebtItem(kind="student", balance=4_000_000, rate=0.05, remaining_months=48)
    base = debt.repayment_plan(d)
    fast = debt.repayment_plan(d, extra_monthly=200_000)
    assert fast.months_to_clear < base.months_to_clear
    assert fast.total_interest < base.total_interest


def test_zero_rate_debt():
    d = DebtItem(kind="other", balance=1_200_000, rate=0.0, monthly_payment=100_000)
    plan = debt.repayment_plan(d)
    assert plan.months_to_clear == 12
    assert plan.total_interest == 0


# ─────────────────────────────────────────────────────────────
# 2. 갚기 ↔ 끼고 사기를 잇는 고리 (DTI)
# ─────────────────────────────────────────────────────────────
def test_dti_now_accounts_for_existing_debt():
    """기존 부채 상환액이 DTI 여력을 깎아야 한다.

    이걸 빼먹으면 '빚을 갚아도 한도가 그대로'가 된다.
    """
    no_debt = calculator.dti_capped_principal(50_000_000, 0.6, 0.04, 360, 0)
    with_debt = calculator.dti_capped_principal(50_000_000, 0.6, 0.04, 360, 1_000_000)
    assert with_debt < no_debt


def test_dti_capacity_zero_when_debt_eats_all():
    assert calculator.dti_capped_principal(30_000_000, 0.4, 0.04, 360, 5_000_000) == 0


def test_clearing_debt_raises_capacity_when_dti_is_binding():
    """DTI가 병목이면 빚을 갚았을 때 한도가 실제로 늘어야 한다."""
    p = UserProfile(
        goal_type="purchase", target_amount=600_000_000, horizon_months=12,
        region="경기", current_cash=100_000_000, monthly_saving=500_000,
        monthly_income_net=2_500_000,
        household_income=40_000_000,          # 소득이 낮아 DTI가 병목이 되도록
        annual_income=40_000_000, age=33, spouse_age=35,
        is_homeowner=False, is_householder=True, first_home_buyer=True,
        marital_status="engaged", months_to_marriage=2,
        debts=[DebtItem(kind="credit", balance=60_000_000, rate=0.06,
                        remaining_months=60)],
    )
    primary = rules.select_primary_loan(rules.waterfall(p))
    assert primary.binding_constraint == "DTI", "이 케이스는 DTI가 병목이어야 한다"

    with_debt = rules.capacity_with_debt_payment(p, debt.total_monthly_due(p))
    cleared = rules.capacity_with_debt_payment(p, 0)
    assert cleared > with_debt

    strategy = debt.build_strategy(
        p, lambda dm: rules.capacity_with_debt_payment(p, dm), 500_000
    )
    assert strategy.capacity_gain_if_cleared > 0


def test_no_capacity_gain_when_product_cap_is_binding(personas):
    """페르소나 2: 한도가 상품한도에 걸려 있으므로 갚아도 한도는 안 늘어난다.

    이건 버그가 아니라 정답이다. '갚으면 무조건 좋아진다'고 말하지 않는 것이 핵심.
    """
    p = personas["persona2"]
    primary = rules.select_primary_loan(rules.waterfall(p))
    assert primary.binding_constraint == "PRODUCT_CAP"
    strategy = debt.build_strategy(
        p, lambda dm: rules.capacity_with_debt_payment(p, dm), p.monthly_saving or 0
    )
    assert strategy.capacity_gain_if_cleared == 0


def test_jeonse_capacity_is_ratio_bound_not_dti(personas):
    """전세대출 한도는 보증금 비율로 정해진다 — 부채를 갚아도 늘지 않는다."""
    primary = rules.select_primary_loan(rules.waterfall(personas["persona1"]))
    assert primary.binding_constraint == "RATIO"


# ─────────────────────────────────────────────────────────────
# 3. 배분 시나리오
# ─────────────────────────────────────────────────────────────
def test_scenarios_respect_minimum_payment(personas):
    """어느 시나리오에서도 최소 상환액은 면제되지 않는다."""
    p = personas["persona1"]
    min_due = debt.total_monthly_due(p)
    available = (p.monthly_saving or 0) + min_due
    for s in debt.allocation_scenarios(
        p, lambda dm: rules.capacity_with_debt_payment(p, dm), available
    ):
        assert s.monthly_to_repay >= min_due


def test_repay_first_pays_least_interest(personas):
    """상환 우선이 총이자가 가장 적어야 한다."""
    p = personas["persona1"]
    available = (p.monthly_saving or 0) + debt.total_monthly_due(p)
    scs = {s.key: s for s in debt.allocation_scenarios(
        p, lambda dm: rules.capacity_with_debt_payment(p, dm), available)}
    assert scs["REPAY_FIRST"].total_interest_paid <= scs["BALANCED"].total_interest_paid
    assert scs["BALANCED"].total_interest_paid <= scs["SAVE_FIRST"].total_interest_paid


def test_save_first_builds_most_equity(personas):
    """저축 우선이 목표시점 자기자본이 가장 커야 한다."""
    p = personas["persona1"]
    available = (p.monthly_saving or 0) + debt.total_monthly_due(p)
    scs = {s.key: s for s in debt.allocation_scenarios(
        p, lambda dm: rules.capacity_with_debt_payment(p, dm), available)}
    assert scs["SAVE_FIRST"].equity_at_horizon >= scs["REPAY_FIRST"].equity_at_horizon


def test_allocation_totals_are_consistent(personas):
    p = personas["persona1"]
    available = (p.monthly_saving or 0) + debt.total_monthly_due(p)
    for s in debt.allocation_scenarios(
        p, lambda dm: rules.capacity_with_debt_payment(p, dm), available
    ):
        assert s.monthly_to_repay + s.monthly_to_save == available
        assert s.equity_at_horizon >= 0
        assert s.shortfall >= 0


# ─────────────────────────────────────────────────────────────
# 4. DSR — 대출 끼고 사는 쪽의 안전장치
# ─────────────────────────────────────────────────────────────
def test_dsr_includes_existing_and_new(personas):
    p = personas["persona2"]
    new_payment = calculator.monthly_payment(320_000_000, 0.0355, 360)
    d = debt.dsr_check(p, new_payment)
    assert d.existing_debt_payment == debt.total_monthly_due(p)
    assert d.total_payment == d.existing_debt_payment + new_payment
    assert d.remaining_after_payment == d.monthly_income - d.total_payment


def test_dsr_flags_over_limit():
    p = UserProfile(monthly_income_net=2_000_000,
                    debts=[DebtItem(kind="credit", balance=30_000_000, rate=0.06,
                                    remaining_months=36)])
    d = debt.dsr_check(p, 800_000)
    assert d.over_limit is True
    assert d.ratio > d.limit


def test_dsr_without_income_does_not_crash():
    d = debt.dsr_check(UserProfile(), 1_000_000)
    assert d.ratio == 0.0
    assert d.over_limit is False


# ─────────────────────────────────────────────────────────────
# 5. 견고성 + 하위호환
# ─────────────────────────────────────────────────────────────
def test_no_debt_profile():
    p = UserProfile(goal_type="jeonse", target_amount=10**8, horizon_months=24,
                    current_cash=0, monthly_saving=500_000)
    s = debt.build_strategy(p, lambda dm: 0, 500_000)
    assert s.total_balance == 0 and s.plans == [] and s.scenarios == []
    assert services.debt_summary(p)["has_debt"] is False


def test_legacy_single_debt_field_still_works():
    """debts 없이 existing_debt만 있어도 동작해야 한다 (하위호환)."""
    p = UserProfile(existing_debt=5_000_000, existing_debt_rate=0.04)
    assert p.total_debt() == 5_000_000
    assert len(p.debt_list()) == 1
    assert debt.total_monthly_due(p) > 0


def test_debts_take_precedence_over_legacy_field():
    p = UserProfile(existing_debt=5_000_000, existing_debt_rate=0.04,
                    debts=[DebtItem(kind="student", balance=1_000_000, rate=0.02)])
    assert p.total_debt() == 1_000_000


@pytest.mark.parametrize("balance,rate,months,payment", [
    (0, 0.05, 12, None), (1, 0.0, None, None), (10**9, 0.99, 600, None),
    (5_000_000, 0.05, None, 1), (5_000_000, 0.05, None, 10**7),
])
def test_repayment_plan_extremes(balance, rate, months, payment):
    d = DebtItem(kind="other", balance=balance, rate=rate,
                 remaining_months=months, monthly_payment=payment)
    plan = debt.repayment_plan(d)
    assert plan.total_interest >= 0
    assert plan.months_to_clear is None or plan.months_to_clear >= 0


def test_debt_endpoint_shape(personas):
    from fastapi.testclient import TestClient

    from app.api.main import app

    c = TestClient(app)
    for name in ("persona1", "persona2", "persona2_repaid"):
        r = c.post("/api/debt", json={"persona": name})
        assert r.status_code == 200
        body = r.json()
        assert "dsr" in body and "has_debt" in body
