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


class DebtDecision(BaseModel):
    """신용대출 상환 시나리오 비교 (페르소나 2)."""

    recommend: Literal["REPAY", "KEEP"]
    loan_amount: int
    loan_rate: float
    annual_interest_saved: int
    cash_after_repay: int
    cash_if_keep: int
    rationale_key: str


class LoanTerms(BaseModel):
    """금리 빌드업 + 월 상환액."""

    principal: int
    base_rate: float
    applied_discounts: list[dict] = []
    excluded_discounts: list[dict] = []
    final_rate: float
    months: int
    monthly_payment: int
