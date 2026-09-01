# -*- coding: utf-8 -*-
"""사용자 프로필 — A1 Goal Parser의 출력이자 Rule Engine의 입력."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

GoalType = Literal["jeonse", "purchase", "marriage", "lumpsum"]
JobType = Literal["regular", "contract", "freelance", "student", "unemployed"]
MaritalStatus = Literal["single", "engaged", "married"]


class UserProfile(BaseModel):
    """모든 필드가 Optional이다. None인 필드가 곧 슬롯 필링의 대상이 된다.

    ⚠️ 금액·기간·나이에는 ge=0 제약이 걸려 있다. 음수가 들어오면 조용히 계산되는 대신
       ValidationError로 거부된다. (음수 기간이 들어와 '월 저축액 -208,333원' 같은
       값이 화면까지 흘러가는 것을 막는다)
    """

    # ── 목표 ────────────────────────────────────────────────
    goal_type: Optional[GoalType] = Field(None, description="목표 유형")
    target_amount: Optional[int] = Field(None, ge=0, description="목표금액(원). '1억'→100000000")
    horizon_months: Optional[int] = Field(None, ge=0, le=1200,
                                          description="목표까지 개월수. '2년 뒤'→24")
    region: Optional[str] = Field(None, max_length=100,
                                  description="시군구 단위. '마포'→'서울 마포구'")

    # ── 현재 재무 ───────────────────────────────────────────
    current_cash: Optional[int] = Field(None, ge=0, description="현금·예적금 합계(원)")
    monthly_saving: Optional[int] = Field(None, ge=0, description="월 순저축 가능액(원)")
    existing_debt: Optional[int] = Field(None, ge=0, description="기존 대출 잔액(원)")
    existing_debt_rate: Optional[float] = Field(
        None, ge=0.0, le=1.0, description="기존 대출 금리. 5.2%→0.052"
    )

    # ── 정책 판정용 ─────────────────────────────────────────
    age: Optional[int] = Field(None, ge=0, le=120, description="만 나이")
    spouse_age: Optional[int] = Field(None, ge=0, le=120)
    annual_income: Optional[int] = Field(None, ge=0, description="세전 연소득(원)")
    household_income: Optional[int] = Field(None, ge=0, description="부부합산 세전 연소득(원)")
    job_type: Optional[JobType] = None
    is_homeowner: Optional[bool] = Field(None, description="주택 보유 여부")
    is_householder: Optional[bool] = Field(None, description="세대주 또는 예비세대주")
    marital_status: Optional[MaritalStatus] = None
    months_to_marriage: Optional[int] = Field(None, ge=0, le=1200,
                                              description="결혼까지 남은 개월수")
    first_home_buyer: Optional[bool] = None
    housing_subscription_years: Optional[int] = Field(None, ge=0, le=100,
                                                      description="청약통장 가입연수")
    housing_subscription_count: Optional[int] = Field(None, ge=0,
                                                      description="청약통장 납입횟수")

    def income_for_policy(self) -> Optional[int]:
        """정책 소득기준은 기혼·예비신혼이면 부부합산을 본다."""
        if self.marital_status in ("engaged", "married") and self.household_income:
            return self.household_income
        return self.annual_income or self.household_income


def profile_with(base: UserProfile, **updates) -> UserProfile:
    """검증을 거치는 프로필 복사.

    ⚠️ `base.model_copy(update=...)` 는 **검증을 건너뛴다.** ge=0 제약이 걸려 있어도
       음수가 그대로 들어가서 '목표 도달 -28개월' 같은 값이 화면까지 흘러간다.
       프로필을 변형하는 곳(시뮬레이터·에이전트)에서는 반드시 이 함수를 쓴다.
    """
    data = base.model_dump()
    data.update({k: v for k, v in updates.items() if v is not None})
    return UserProfile.model_validate(data)


class GoalParseResult(BaseModel):
    """A1+A2 통합 호출의 출력."""

    profile: UserProfile
    next_question: Optional[str] = Field(
        None, description="아직 부족한 정보가 있으면 물어볼 질문 1개. 없으면 null"
    )
    asking_field: Optional[str] = Field(None, description="이번에 묻는 필드명")
    ready_for_analysis: bool = Field(False, description="정책 판정에 필요한 정보가 모두 모였는가")
