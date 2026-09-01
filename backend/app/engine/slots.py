# -*- coding: utf-8 -*-
"""필수 슬롯 정의.

핵심: 무엇을 더 물어볼지는 **Rule Engine이 요구하는 필드**가 결정한다.
LLM이 "뭘 더 물어볼까?"를 자유 판단하지 않는다 (policy-driven slot filling).
"""
from __future__ import annotations

from app.schemas.profile import UserProfile

REQUIRED_BY_GOAL: dict[str, list[str]] = {
    "jeonse": [
        "target_amount", "horizon_months", "region", "current_cash",
        "age", "annual_income", "job_type", "is_homeowner", "is_householder",
    ],
    "purchase": [
        "target_amount", "horizon_months", "region", "current_cash",
        "household_income", "is_homeowner", "first_home_buyer", "marital_status",
    ],
    "marriage": [
        "target_amount", "horizon_months", "current_cash",
        "household_income", "months_to_marriage",
    ],
    "lumpsum": ["target_amount", "horizon_months", "current_cash", "age", "annual_income"],
}

#: 사용자에게 물을 때 쓰는 한국어 이름
FIELD_LABEL: dict[str, str] = {
    "goal_type": "목표 유형", "target_amount": "목표 금액", "horizon_months": "목표 시점",
    "region": "희망 지역", "current_cash": "현재 보유 자금", "monthly_saving": "월 저축 가능액",
    "age": "만 나이", "annual_income": "세전 연소득", "household_income": "부부합산 연소득",
    "job_type": "직업 형태", "is_homeowner": "주택 보유 여부",
    "is_householder": "세대주 여부", "marital_status": "결혼 상태",
    "months_to_marriage": "결혼까지 남은 기간", "first_home_buyer": "생애최초 주택구입 여부",
}

#: 왜 필요한지 — 질문에 붙여 신뢰를 만든다
FIELD_REASON: dict[str, str] = {
    "age": "정책 나이 기준을 확인해야 해서요",
    "annual_income": "정책 소득 기준을 확인해야 해서요",
    "household_income": "부부합산 소득 기준을 확인해야 해서요",
    "job_type": "일부 정책은 재직 형태에 따라 자격이 갈려서요",
    "is_homeowner": "무주택 요건이 있는 정책이 많아서요",
    "is_householder": "세대주·예비세대주 요건을 확인해야 해서요",
    "region": "지자체 정책은 거주지 기준이라서요",
    "months_to_marriage": "신혼부부 정책은 신청 가능 시점이 정해져 있어서요",
    "first_home_buyer": "생애최초 요건을 확인해야 해서요",
}


def missing_fields(p: UserProfile) -> list[str]:
    if not p.goal_type:
        return ["goal_type"]
    required = REQUIRED_BY_GOAL.get(p.goal_type, [])
    return [f for f in required if getattr(p, f, None) is None]


def is_ready(p: UserProfile) -> bool:
    return not missing_fields(p)
