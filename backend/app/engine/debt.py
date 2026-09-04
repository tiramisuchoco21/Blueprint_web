# -*- coding: utf-8 -*-
"""부채 엔진 — '갚는 것'과 '끼고 사는 것'을 하나로 잇는다. LLM 개입 없음.

팀 논의: "대출금이 갚는 거야, 대출 끼고 산다는 거야?" → "둘 다".

두 축은 사실 하나로 연결된다:

    부채를 갚는다  →  DTI 여력이 생긴다  →  정책대출 한도가 올라간다
                                          →  목표 달성 가능성이 바뀐다

지금까지는 이 고리가 끊겨 있었다. DTI 계산에 기존 부채 상환액이 들어가지 않아
빚을 갚아도 한도가 그대로였다. 이 모듈이 그 다리를 놓는다.
"""
from __future__ import annotations

import math

from app.engine.calculator import monthly_payment
from app.schemas.finance import (
    AllocationScenario, DebtItem, DebtStrategy, DsrCheck, RepaymentPlan,
)
from app.schemas.profile import UserProfile

#: DSR 경고 기준선. 정책·기관마다 다르므로 설정값으로 다룬다.
DSR_LIMIT = 0.40

#: 저축의 기회비용(연). 부채 금리와 비교해 상환 우선순위를 정하는 기준.
#: 예금 금리 수준으로 보수적으로 잡는다. 투자 수익률을 가정하지 않는다.
SAVING_RATE = 0.03


def monthly_due(d: DebtItem) -> int:
    """부채 1건의 월 상환액.

    · monthly_payment 가 주어지면 그대로.
    · 남은 개월수를 알면 원리금균등.
    · 둘 다 없으면 **이자만 내는 것**으로 본다 (원금이 줄지 않는 상태).
    """
    if d.monthly_payment is not None:
        return d.monthly_payment
    if d.remaining_months:
        return monthly_payment(d.balance, d.rate, d.remaining_months)
    return int(d.balance * d.rate / 12)


def total_monthly_due(profile: UserProfile) -> int:
    return sum(monthly_due(d) for d in profile.debt_list())


def repayment_plan(d: DebtItem, extra_monthly: int = 0) -> RepaymentPlan:
    """상환 계획. extra_monthly 를 얹으면 완제 시점과 총이자가 줄어든다."""
    base = monthly_due(d)
    pay = base + max(extra_monthly, 0)
    r = d.rate / 12

    # 월 상환액이 이자에도 못 미치면 원금이 영원히 줄지 않는다.
    if pay <= d.balance * r:
        return RepaymentPlan(
            kind=d.kind, name=d.name, balance=d.balance, rate=d.rate,
            monthly_payment=pay, months_to_clear=None,
            total_interest=0, interest_only=True,
        )

    if r == 0:
        months = math.ceil(d.balance / pay)
        return RepaymentPlan(kind=d.kind, name=d.name, balance=d.balance, rate=d.rate,
                             monthly_payment=pay, months_to_clear=months,
                             total_interest=0)

    # n = -ln(1 - r·B/P) / ln(1+r)
    months = math.ceil(-math.log(1 - r * d.balance / pay) / math.log(1 + r))
    total_interest = max(pay * months - d.balance, 0)
    return RepaymentPlan(
        kind=d.kind, name=d.name, balance=d.balance, rate=d.rate,
        monthly_payment=pay, months_to_clear=months, total_interest=int(total_interest),
    )


def dsr_check(profile: UserProfile, new_loan_payment: int,
              limit: float = DSR_LIMIT) -> DsrCheck:
    """신규 대출을 실행하면 월 상환 부담이 얼마가 되는가.

    '대출 끼고 산다'는 쪽의 안전장치다. 한도만 보여주고 갚을 수 있는지를
    안 보여주면 그건 반쪽짜리다.
    """
    income = profile.monthly_income_net or 0
    existing = total_monthly_due(profile)
    total = existing + max(new_loan_payment, 0)
    ratio = (total / income) if income else 0.0
    return DsrCheck(
        monthly_income=income, existing_debt_payment=existing,
        new_loan_payment=max(new_loan_payment, 0), total_payment=total,
        ratio=round(ratio, 4), limit=limit,
        over_limit=bool(income and ratio > limit),
        remaining_after_payment=max(income - total, 0),
    )


# ─────────────────────────────────────────────────────────────
# 상환 vs 저축 배분
# ─────────────────────────────────────────────────────────────
def _simulate_allocation(profile: UserProfile, capacity_fn,
                         monthly_available: int, repay_ratio: float) -> tuple:
    """월 가용액을 (상환, 저축)으로 나눠 목표시점까지 굴린다.

    ⚠️ monthly_available 은 '저축 여력 + 이미 부채로 나가는 돈'의 합이다.
       최소 상환액은 어느 시나리오에서도 면제되지 않는다 — 학자금을 안 갚고
       전액 저축하는 선택지는 현실에 없기 때문이다. repay_ratio 는 그 위에
       얹는 추가 상환의 비율이다.

    Returns: (equity, policy_capacity, cleared_month, interest_paid, monthly_repay)
    """
    horizon = profile.horizon_months or 0
    debts = [d.model_copy() for d in profile.debt_list()]
    balances = [float(d.balance) for d in debts]

    min_due = min(total_monthly_due(profile), monthly_available)
    surplus = max(monthly_available - min_due, 0)
    to_repay = min_due + int(surplus * repay_ratio)
    to_save = monthly_available - to_repay

    cash = float(profile.current_cash or 0)
    interest_paid = 0.0
    cleared_month: int | None = None

    for m in range(1, horizon + 1):
        budget = float(to_repay)
        # 금리 높은 것부터 갚는다 (avalanche)
        order = sorted(range(len(debts)), key=lambda i: -debts[i].rate)
        for i in order:
            if balances[i] <= 0:
                continue
            r = debts[i].rate / 12
            interest = balances[i] * r
            interest_paid += interest
            pay = min(budget, balances[i] + interest)
            budget -= pay
            balances[i] = max(balances[i] + interest - pay, 0.0)
            if budget <= 0:
                break
        # 상환에 다 못 쓴 돈은 저축으로 넘긴다
        cash += to_save + max(budget, 0)
        if cleared_month is None and all(b <= 0 for b in balances):
            cleared_month = m

    # 목표시점의 잔여 부채로 정책대출 한도를 다시 계산한다
    remaining_monthly = 0
    for d, b in zip(debts, balances):
        if b > 0:
            d2 = d.model_copy(update={"balance": int(b)})
            remaining_monthly += monthly_due(d2)

    capacity = capacity_fn(remaining_monthly)
    return int(cash), capacity, cleared_month, int(interest_paid), to_repay


def allocation_scenarios(profile: UserProfile, capacity_fn,
                         monthly_available: int) -> list[AllocationScenario]:
    """3가지 배분 시나리오를 같은 기준으로 비교한다.

    capacity_fn(잔여_월상환액) -> 정책대출 한도  를 주입받는다.
    (부채가 줄면 DTI 여력이 늘어 한도가 올라가는 효과를 반영하기 위해서다)
    """
    target = profile.target_amount or 0
    specs = [
        ("SAVE_FIRST", "저축 우선 — 최소 상환만 하고 자기자본을 모은다", 0.0),
        ("BALANCED", "병행 — 최소 상환 + 여유분을 절반씩 나눈다", 0.5),
        ("REPAY_FIRST", "상환 우선 — 빚부터 정리하고 그다음 저축한다", 1.0),
    ]
    out: list[AllocationScenario] = []
    for key, label, ratio in specs:
        equity, capacity, cleared, interest, to_repay = _simulate_allocation(
            profile, capacity_fn, monthly_available, ratio
        )
        reachable = equity + capacity >= target
        out.append(AllocationScenario(
            key=key, label=label,
            monthly_to_repay=to_repay, monthly_to_save=monthly_available - to_repay,
            debt_cleared_month=cleared, total_interest_paid=interest,
            equity_at_horizon=equity, policy_capacity_at_horizon=capacity,
            reachable=reachable,
            shortfall=max(target - (equity + capacity), 0),
            note=("목표 달성 가능" if reachable else "목표시점 기준 부족"),
        ))
    return out


def build_strategy(profile: UserProfile, capacity_fn,
                   monthly_available: int) -> DebtStrategy:
    """부채 전략 종합. 추천은 룰이 정한다 — LLM에게 묻지 않는다."""
    debts = profile.debt_list()
    if not debts:
        return DebtStrategy(total_balance=0, total_monthly_payment=0)

    total_balance = sum(d.balance for d in debts)
    weighted = (sum(d.balance * d.rate for d in debts) / total_balance
                if total_balance else 0.0)
    plans = [repayment_plan(d) for d in debts]

    base_capacity = capacity_fn(total_monthly_due(profile))
    cleared_capacity = capacity_fn(0)

    scenarios = allocation_scenarios(profile, capacity_fn, monthly_available)

    # ── 추천 규칙 ────────────────────────────────────────────
    # 1) 목표에 도달하는 시나리오가 있으면 그중 총이자가 가장 적은 것.
    # 2) 하나도 도달 못 하면 부족액이 가장 작은 것.
    reachable = [s for s in scenarios if s.reachable]
    if reachable:
        best = min(reachable, key=lambda s: s.total_interest_paid)
        rationale = "GOAL_REACHABLE_MIN_INTEREST"
    else:
        best = min(scenarios, key=lambda s: s.shortfall)
        rationale = "GOAL_UNREACHABLE_MIN_SHORTFALL"

    return DebtStrategy(
        total_balance=total_balance,
        total_monthly_payment=total_monthly_due(profile),
        weighted_rate=round(weighted, 6), plans=plans, scenarios=scenarios,
        recommended=best.key, rationale_key=rationale,
        capacity_gain_if_cleared=max(cleared_capacity - base_capacity, 0),
    )
