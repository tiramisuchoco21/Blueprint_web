# -*- coding: utf-8 -*-
"""금융 계산기 — LLM이 절대 개입하지 않는다.

화면에 뜨는 모든 숫자는 이 모듈(또는 rules.py)에서 나온다.
여기서 나온 값들의 집합이 곧 Numeric Guard의 화이트리스트다.
"""
from __future__ import annotations

import math

from app.schemas.finance import (
    DebtDecision, FeasibilityResult, GoalImpact, LoanTerms,
)
from app.schemas.profile import UserProfile

# ─────────────────────────────────────────────────────────────
# 기본 금융 함수
# ─────────────────────────────────────────────────────────────


def monthly_payment(principal: int, annual_rate: float, months: int) -> int:
    """원리금균등상환 월 납입액.

    >>> monthly_payment(320_000_000, 0.0355, 360)
    1445838
    """
    if months <= 0:
        return 0
    r = annual_rate / 12
    if r == 0:
        return principal // months
    factor = (1 + r) ** months
    return round(principal * r * factor / (factor - 1))


def principal_from_payment(payment: int, annual_rate: float, months: int) -> int:
    """월 상환 여력 → 감당 가능한 원금 (DTI 한도 환산)."""
    if months <= 0:
        return 0
    r = annual_rate / 12
    if r == 0:
        return payment * months
    factor = (1 + r) ** months
    return int(payment * (factor - 1) / (r * factor))


def dti_capped_principal(annual_income: int, dti_max: float,
                         annual_rate: float, months: int) -> int:
    """DTI 제약이 허용하는 최대 원금."""
    monthly_capacity = int(annual_income * dti_max / 12)
    return principal_from_payment(monthly_capacity, annual_rate, months)


def build_rate(rate_build: dict, profile: UserProfile) -> LoanTerms | None:
    """금리 빌드업. 종료된 우대(status != ACTIVE)는 자동 반영하지 않는다."""
    if not rate_build:
        return None
    rate = rate_build["base"]
    applied, excluded = [], []
    for d in rate_build.get("discounts", []):
        if d.get("status") != "ACTIVE" or d.get("auto_apply") is False:
            excluded.append({"label": d["label"], "value": d["value"],
                             "reason": "종료된 우대 — 자동 반영하지 않음"})
            continue
        req = d.get("requires", {})
        ok = all((getattr(profile, k, None) or 0) >= v for k, v in req.items())
        (applied if ok else excluded).append(
            {"label": d["label"], "value": d["value"],
             **({} if ok else {"reason": "요건 미충족"})}
        )
        if ok:
            rate += d["value"]
    return LoanTerms(
        principal=0, base_rate=rate_build["base"], applied_discounts=applied,
        excluded_discounts=excluded, final_rate=round(rate, 6), months=0, monthly_payment=0,
    )


# ─────────────────────────────────────────────────────────────
# 목표 달성 가능성
# ─────────────────────────────────────────────────────────────


def feasibility(profile: UserProfile, policy_capacity: int,
                side_costs: int | None = None) -> FeasibilityResult:
    """목표 → 필요 자기자본 → 부족액 → 월 저축액 역산."""
    target = profile.target_amount or 0
    months = profile.horizon_months or 0
    cash = profile.current_cash or 0
    saving = profile.monthly_saving or 0

    required_equity = max(target - policy_capacity, 0)
    projected_cash = cash + saving * months
    gap = max(required_equity - cash, 0)
    required_monthly = math.ceil(gap / months) if months else 0
    # 목표시점 기준 부족액 — 저축까지 다 한 뒤에도 모자라는 금액
    shortfall = max(target - (projected_cash + policy_capacity), 0)

    total_need = required_equity + (side_costs or 0)
    # TIGHT_MARGIN: 필요 월저축액이 현재 저축여력의 이 배수 이내면 '조정 필요'(🟡),
    # 넘으면 '달성 어려움'(🔴). MVP 설계서 p.8 표에 맞춰 보정한 값이다.
    #   월 50만(필요 583,334 ÷ 500,000 = 1.17) → 🟡 조정 필요
    #   월 40만(필요 583,334 ÷ 400,000 = 1.46) → 🔴 달성 어려움
    TIGHT_MARGIN = 1.2
    if projected_cash >= total_need:
        verdict = "ACHIEVABLE"
    elif saving and projected_cash >= required_equity:
        verdict = "TIGHT"
    elif saving and required_monthly <= saving * TIGHT_MARGIN:
        verdict = "TIGHT"
    else:
        verdict = "NOT_ACHIEVABLE"

    return FeasibilityResult(
        goal_type=profile.goal_type or "unknown",
        target_amount=target, policy_capacity=policy_capacity,
        required_equity=required_equity, current_cash=cash,
        projected_cash=projected_cash, gap=gap,
        shortfall_at_horizon=shortfall, horizon_months=months,
        required_monthly=required_monthly, verdict=verdict,
        d_day=months * 30, side_costs=side_costs,
    )


def acquisition_costs(price: int, cfg: dict | None = None) -> dict:
    """취득부대비용.

    ⚠️ 요율을 코드에 박지 않는다. cfg(정책 DB/설정)에서 받고, 없으면 계산하지 않는다.
       생애최초 취득세 감면은 요건·한도가 자주 바뀌므로 반드시 조회값으로 관리할 것.
    """
    if not cfg:
        return {"available": False,
                "note": "취득부대비용 요율이 설정되지 않았습니다. 정책 DB에서 조회 후 표시합니다."}
    out = {
        "acquisition_tax": int(price * cfg["acq_tax_rate"]),
        "brokerage": int(price * cfg["brokerage_rate"]),
        "registration": int(price * cfg["registration_rate"]),
        "moving": int(cfg.get("moving_flat", 0)),
    }
    out["total"] = sum(v for k, v in out.items() if isinstance(v, int))
    out["available"] = True
    return out


# ─────────────────────────────────────────────────────────────
# 신용대출 상환 의사결정 (페르소나 2)
# ─────────────────────────────────────────────────────────────


def debt_decision(profile: UserProfile) -> DebtDecision | None:
    """상환 vs 유지. 판단은 룰이 한다 — LLM에게 묻지 않는다."""
    loan = profile.existing_debt or 0
    rate = profile.existing_debt_rate or 0.0
    if not loan or not rate:
        return None
    assets = profile.current_cash or 0
    interest = int(loan * rate)

    # 보유 현금이 대출액보다 적으면 애초에 '상환 vs 유지'를 비교할 상황이 아니다.
    # 음수 잔액(-19,000,000 같은 값)을 화면에 내보내지 않는다.
    if assets < loan:
        return DebtDecision(
            recommend="CANNOT_REPAY", loan_amount=loan, loan_rate=rate,
            annual_interest_saved=interest, cash_after_repay=0, cash_if_keep=assets,
            rationale_key="INSUFFICIENT_CASH",
            note="보유 현금이 대출 잔액보다 적어 전액 상환 시나리오를 비교할 수 없습니다.",
        )

    # 기준: 신용대출 금리가 정책대출 예상금리보다 높고, 상환 후에도
    #       계약금 여력이 남으면 상환이 유리하다고 본다.
    recommend = "REPAY" if rate >= 0.045 else "KEEP"
    return DebtDecision(
        recommend=recommend, loan_amount=loan, loan_rate=rate,
        annual_interest_saved=interest, cash_after_repay=assets - loan,
        cash_if_keep=assets, rationale_key="DTI_AND_CAPACITY",
    )


# ─────────────────────────────────────────────────────────────
# 소비 → 목표 영향 (FinTox와 목표를 잇는 다리)
# ─────────────────────────────────────────────────────────────


def goal_impact(monthly_income: int, fixed_cost: int, variable_spent: int,
                observed_days: int, feas: FeasibilityResult) -> GoalImpact:
    """현재 소비 패턴이 유지되면 목표 시점이 어떻게 바뀌는가."""
    if observed_days <= 0:
        observed_days = 1
    projected_variable = int(variable_spent / observed_days * 30)
    capacity = monthly_income - fixed_cost - projected_variable

    if capacity >= feas.required_monthly:
        return GoalImpact(
            status="ON_TRACK", projected_monthly_saving=capacity,
            required_monthly=feas.required_monthly,
            buffer=capacity - feas.required_monthly,
            original_horizon_months=feas.horizon_months,
            new_horizon_months=feas.horizon_months,
        )

    # 저축 여력이 0 이하면 도달 시점을 계산할 수 없다.
    # 예전에는 999개월 센티널을 넣었는데, 그 값이 그대로 화면(과 Guard 화이트리스트)까지
    # 흘러가 'D-Day 29,250일 지연' 같은 무의미한 숫자가 나왔다. 플래그로 바꾼다.
    if capacity <= 0:
        return GoalImpact(
            status="AT_RISK", projected_monthly_saving=0,
            required_monthly=feas.required_monthly, shortfall=feas.required_monthly,
            original_horizon_months=feas.horizon_months,
            new_horizon_months=0, d_day_shift_days=0, unreachable=True,
        )

    new_months = math.ceil(feas.gap / capacity)
    return GoalImpact(
        status="AT_RISK", projected_monthly_saving=capacity,
        required_monthly=feas.required_monthly,
        shortfall=feas.required_monthly - capacity,
        original_horizon_months=feas.horizon_months,
        new_horizon_months=new_months,
        d_day_shift_days=(new_months - feas.horizon_months) * 30,
    )
