# -*- coding: utf-8 -*-
"""소비 데이터 스키마.

※ raw_text 필드는 의도적으로 두지 않는다. 스키마에 없으면 실수로 저장할 수 없다.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field

Category = Literal[
    "food_dining", "cafe", "food_delivery", "convenience", "grocery",
    "transport", "car_sharing", "shopping", "beauty", "health",
    "education", "telecom", "insurance", "transit_pass", "admin",
    "entertainment", "subscription", "unknown",
]

#: 줄일 수 있는 지출 — 충동성 판정 대상
DISCRETIONARY: set[str] = {
    "food_dining", "cafe", "food_delivery", "convenience", "shopping",
    "beauty", "entertainment",
}
#: 계획 지출 — 충동성 판정에서 상한을 건다
PLANNED: set[str] = {
    "education", "telecom", "insurance", "transit_pass", "health",
    "admin", "subscription",
}
#: 자동이체성 — 결제 시각이 사용자 행동 시각이 아니다
AUTO_DEBIT: set[str] = {"telecom", "insurance", "transit_pass", "subscription"}


class Transaction(BaseModel):
    id: int
    at: datetime
    amount: int
    merchant_raw: str = Field(description="명세 원문 (PG 접두 포함)")
    brand: str = Field(description="정규화된 브랜드")
    category: Category = "unknown"
    pg: Optional[str] = Field(None, description="결제대행사. 실제 가맹점을 가리는 문자열")
    opaque: bool = Field(False, description="가맹점 정보가 아예 없음 (예: '네이버페이')")
    is_recurring: bool = False
    resolved_by: Literal["rule", "llm", "user", "none"] = "rule"
    resolve_confidence: float = 1.0


class ResolvedMerchant(BaseModel):
    """A10 Merchant Resolver의 LLM 출력."""

    merchant_raw: str
    brand: str = Field(description="정규화된 브랜드명. 모르면 원문 그대로")
    category: Category
    is_fixed_cost: bool = False
    is_recurring_likely: bool = False
    confidence: float = Field(ge=0.0, le=1.0)
    needs_user_input: bool = Field(
        False, description="문자열만으로는 알 수 없어 사용자에게 물어야 함"
    )
    reason: str = Field("", description="판단 근거 한 줄")


class ResolvedBatch(BaseModel):
    merchants: list[ResolvedMerchant]


class ScoreBreakdown(BaseModel):
    total: int
    band: str
    parts: dict[str, float]
    factors: dict[str, float]
    evidence: list[str] = Field(default_factory=list)
    planned_capped: bool = False


class ImpulseResult(ScoreBreakdown):
    tx_id: int


class SpendSession(BaseModel):
    """60분 이내 연쇄 결제 묶음. 건별 채점이 놓치는 패턴을 잡는다."""

    session_id: int
    tx_ids: list[int]
    started_at: datetime
    ended_at: datetime
    duration_minutes: int
    total_amount: int
    brands: list[str]
    is_night: bool
    score: int = 0
    band: str = ""
    evidence: list[str] = Field(default_factory=list)


SignalName = Literal[
    "studying_certificate", "job_seeking", "no_car_owner", "moving_soon",
    "wedding_prep", "health_expense", "transit_heavy", "telecom_autopay",
    "living_alone", "frequent_delivery",
]


class ConsumptionSignal(BaseModel):
    """A11 Policy Signal Extractor 출력 — 소비에서 정책 신호를 역추적한다."""

    signal: SignalName
    evidence_tx_ids: list[int] = Field(
        description="근거 거래 ID. 비어 있으면 이 신호는 버린다"
    )
    rationale: str = Field(description="근거 요약 한 줄")
    confidence: float = Field(ge=0.0, le=1.0)


class SignalBatch(BaseModel):
    signals: list[ConsumptionSignal]
