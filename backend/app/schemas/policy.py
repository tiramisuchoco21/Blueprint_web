# -*- coding: utf-8 -*-
"""정책 판정 결과 — Rule Engine의 출력. LLM은 이 값을 만들지 않는다."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

PolicyStatus = Literal["ELIGIBLE", "CONDITIONAL", "NOT_ELIGIBLE", "ENDED"]

STATUS_LABEL: dict[str, str] = {
    "ELIGIBLE": "검토 가능",
    "CONDITIONAL": "조건부",
    "NOT_ELIGIBLE": "지원 어려움",
    "ENDED": "종료",
}
STATUS_BADGE: dict[str, str] = {
    "ELIGIBLE": "🟢",
    "CONDITIONAL": "🟡",
    "NOT_ELIGIBLE": "🔴",
    "ENDED": "⚫",
}


class RuleCheck(BaseModel):
    """'왜 가능한가요?'를 펼쳤을 때 보이는 조건 한 줄."""

    field: str
    label: str
    required: str
    actual: str
    passed: Optional[bool] = Field(None, description="None = 입력값이 없어 판정 보류")
    soft: bool = Field(False, description="미충족 시 NOT_ELIGIBLE이 아니라 CONDITIONAL")
    note: Optional[str] = None


class EligibilityResult(BaseModel):
    policy_id: str
    policy_name: str
    category: str
    status: PolicyStatus
    status_label: str = ""
    badge: str = ""
    checks: list[RuleCheck] = []
    missing_fields: list[str] = []
    estimated_amount: Optional[int] = Field(None, description="정책금융 활용 가능 예상액(원)")
    amount_basis: Optional[str] = Field(None, description="금액 산출 근거 문장")
    binding_constraint: Optional[str] = Field(
        None,
        description="한도를 잡고 있는 제약. LTV / PRODUCT_CAP / DTI / RATIO. "
                    "DTI가 아니면 기존 부채를 갚아도 한도는 늘어나지 않는다.",
    )
    rate_min: Optional[float] = None
    rate_max: Optional[float] = None
    source_name: str = ""
    source_url: str = ""
    updated_at: str = ""
    reason: Optional[str] = Field(None, description="ENDED / CONDITIONAL 사유")

    def model_post_init(self, __context) -> None:  # noqa: D105
        if not self.status_label:
            self.status_label = STATUS_LABEL[self.status]
        if not self.badge:
            self.badge = STATUS_BADGE[self.status]
