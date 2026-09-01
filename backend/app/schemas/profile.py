# -*- coding: utf-8 -*-
"""사용자 프로필 — A1 Goal Parser의 출력이자 Rule Engine의 입력."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

GoalType = Literal["jeonse", "purchase", "marriage", "lumpsum"]
JobType = Literal["regular", "contract", "freelance", "student", "unemployed"]
MaritalStatus = Literal["single", "engaged", "married"]


class UserProfile(BaseModel):
    """모든 필드가 Optional이다. None인 필드가 곧 슬롯 필링의 대상이 된다."""

    # ── 목표 ────────────────────────────────────────────────
    goal_type: Optional[GoalType] = Field(None, description="목표 유형")
    target_amount: Optional[int] = Field(None, description="목표금액(원). '1억'→100000000")
    horizon_months: Optional[int] = Field(None, description="목표까지 개월수. '2년 뒤'→24")
    region: Optional[str] = Field(None, description="시군구 단위. '마포'→'서울 마포구'")

    # ── 현재 재무 ───────────────────────────────────────────
    current_cash: Optional[int] = Field(None, description="현금·예적금 합계(원)")
    monthly_saving: Optional[int] = Field(None, description="월 순저축 가능액(원)")
    existing_debt: Optional[int] = Field(None, description="기존 대출 잔액(원)")
    existing_debt_rate: Optional[float] = Field(None, description="기존 대출 금리. 5.2%→0.052")

    # ── 정책 판정용 ─────────────────────────────────────────
    age: Optional[int] = Field(None, description="만 나이")
    spouse_age: Optional[int] = None
    annual_income: Optional[int] = Field(None, description="세전 연소득(원)")
    household_income: Optional[int] = Field(None, description="부부합산 세전 연소득(원)")
    job_type: Optional[JobType] = None
    is_homeowner: Optional[bool] = Field(None, description="주택 보유 여부")
    is_householder: Optional[bool] = Field(None, description="세대주 또는 예비세대주")
    marital_status: Optional[MaritalStatus] = None
    months_to_marriage: Optional[int] = Field(None, description="결혼까지 남은 개월수")
    first_home_buyer: Optional[bool] = None
    housing_subscription_years: Optional[int] = Field(None, description="청약통장 가입연수")
    housing_subscription_count: Optional[int] = Field(None, description="청약통장 납입횟수")

    def income_for_policy(self) -> Optional[int]:
        """정책 소득기준은 기혼·예비신혼이면 부부합산을 본다."""
        if self.marital_status in ("engaged", "married") and self.household_income:
            return self.household_income
        return self.annual_income or self.household_income


class GoalParseResult(BaseModel):
    """A1+A2 통합 호출의 출력."""

    profile: UserProfile
    next_question: Optional[str] = Field(
        None, description="아직 부족한 정보가 있으면 물어볼 질문 1개. 없으면 null"
    )
    asking_field: Optional[str] = Field(None, description="이번에 묻는 필드명")
    ready_for_analysis: bool = Field(False, description="정책 판정에 필요한 정보가 모두 모였는가")
