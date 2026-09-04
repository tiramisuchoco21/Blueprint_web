# -*- coding: utf-8 -*-
"""금융 계산 결과 — Calculator의 출력. Numeric Guard 화이트리스트의 원천."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Verdict = Literal["ACHIEVABLE", "TIGHT", "NOT_ACHIEVABLE"]

VERDICT_LABEL: dict[str, str] = {
    "ACHIEVABLE": "달성 가능권",
    "TIGHT": "조정 필요",
    "NOT_ACHIEVABLE": "달성 어려움",
}


class FeasibilityResult(BaseModel):
    """목표 달성 가능성 판정."""

    goal_type: str
    target_amount: int
    policy_capacity: int = Field(0, description="정책금융 활용 가능 예상액 합계")
    required_equity: int = Field(0, description="필요 자기자본 = 목표 − 정책금융")
    current_cash: int = 0
    projected_cash: int = Field(0, description="목표시점 예상 현금 (현재 + 저축)")
    gap: int = Field(0, description="지금 기준 추가 필요자금 = 필요 자기자본 − 현재 보유")
    shortfall_at_horizon: int = Field(
        0,
        description="목표시점 기준 부족액 = 목표금액 − (목표시점 예상현금 + 정책금융). "
                    "페르소나 2의 '약 8,100만 원 부족'이 이 값이다.",
    )
    horizon_months: int = 0
    required_monthly: int = Field(0, description="목표 달성에 필요한 월 저축액")
    verdict: Verdict = "TIGHT"
    verdict_label: str = ""
    d_day: int = 0
    side_costs: Optional[int] = Field(None, description="취득부대비용 (매수 목표에만)")

    def model_post_init(self, __context) -> None:  # noqa: D105
        if not self.verdict_label:
            self.verdict_label = VERDICT_LABEL[self.verdict]


class GoalImpact(BaseModel):
    """소비 패턴이 목표에 미치는 영향 — FinTox와 목표를 잇는 다리."""

    status: Literal["ON_TRACK", "AT_RISK"]
    projected_monthly_saving: int
    required_monthly: int
    shortfall: int = 0
    buffer: int = 0
    original_horizon_months: int = 0
    new_horizon_months: int = 0
    d_day_shift_days: int = 0
    unreachable: bool = Field(
        False,
        description="현재 패턴으로는 저축 여력이 없어 도달 시점을 계산할 수 없음. "
                    "이때 new_horizon_months / d_day_shift_days 는 0이며 "
                    "UI는 숫자 대신 '현재 패턴으로는 계산 불가'를 표시해야 한다.",
    )


class DebtDecision(BaseModel):
    """신용대출 상환 시나리오 비교 (페르소나 2)."""

    recommend: Literal["REPAY", "KEEP", "CANNOT_REPAY"]
    loan_amount: int
    loan_rate: float
    annual_interest_saved: int
    cash_after_repay: int
    cash_if_keep: int
    rationale_key: str
    note: Optional[str] = None


DebtKind = Literal["student", "credit", "card", "mortgage", "jeonse", "other"]

DEBT_LABEL: dict[str, str] = {
    "student": "학자금대출", "credit": "신용대출", "card": "카드론·현금서비스",
    "mortgage": "주택담보대출", "jeonse": "전세자금대출", "other": "기타 대출",
}


class DebtItem(BaseModel):
    """보유 부채 1건."""

    kind: DebtKind = "other"
    name: str = ""
    balance: int = Field(ge=0, description="잔액(원)")
    rate: float = Field(ge=0.0, le=1.0, description="연 금리. 5.2%→0.052")
    remaining_months: Optional[int] = Field(
        None, ge=0, le=600, description="남은 상환 개월수. 없으면 이자만 내는 것으로 본다"
    )
    monthly_payment: Optional[int] = Field(
        None, ge=0, description="실제 월 상환액. 없으면 계산한다"
    )
    prepayable: bool = Field(True, description="중도상환 가능 여부")

    def model_post_init(self, __context) -> None:  # noqa: D105
        if not self.name:
            self.name = DEBT_LABEL.get(self.kind, "대출")


class RepaymentPlan(BaseModel):
    """부채 1건의 상환 계획."""

    kind: DebtKind
    name: str
    balance: int
    rate: float
    monthly_payment: int
    months_to_clear: Optional[int] = Field(None, description="완제까지 개월수")
    total_interest: int = Field(0, description="완제까지 총이자")
    interest_only: bool = Field(False, description="원금이 줄지 않는 상태(이자만 상환)")


class DsrCheck(BaseModel):
    """신규 대출 실행 후 상환 부담. '대출 끼고 사는' 쪽의 안전장치."""

    monthly_income: int
    existing_debt_payment: int
    new_loan_payment: int
    total_payment: int
    ratio: float = Field(description="총 원리금 ÷ 월 소득")
    limit: float = Field(0.40, description="경고 기준선")
    over_limit: bool = False
    remaining_after_payment: int = Field(0, description="상환 후 월 가처분")


class AllocationScenario(BaseModel):
    """월 여유자금을 상환과 저축에 어떻게 나눌지 — 시나리오 1건."""

    key: Literal["SAVE_FIRST", "REPAY_FIRST", "BALANCED"]
    label: str
    monthly_to_repay: int
    monthly_to_save: int
    debt_cleared_month: Optional[int] = None
    total_interest_paid: int = 0
    equity_at_horizon: int = Field(0, description="목표시점 자기자본")
    policy_capacity_at_horizon: int = Field(0, description="목표시점 정책대출 한도")
    reachable: bool = False
    shortfall: int = 0
    note: str = ""


class DebtStrategy(BaseModel):
    """상환 전략 종합. 추천은 룰이 정하고 LLM은 서술만 한다."""

    total_balance: int
    total_monthly_payment: int
    weighted_rate: float = 0.0
    plans: list[RepaymentPlan] = []
    scenarios: list[AllocationScenario] = []
    recommended: Optional[str] = None
    rationale_key: str = ""
    capacity_gain_if_cleared: int = Field(
        0, description="부채를 다 갚았을 때 늘어나는 정책대출 한도(원)"
    )


class LoanTerms(BaseModel):
    """금리 빌드업 + 월 상환액."""

    principal: int
    base_rate: float
    applied_discounts: list[dict] = []
    excluded_discounts: list[dict] = []
    final_rate: float
    months: int
    monthly_payment: int
