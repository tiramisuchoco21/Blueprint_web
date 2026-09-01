# -*- coding: utf-8 -*-
"""A1 + A2 — Goal Parser & Slot Filler (한 번의 호출로 통합).

파싱과 '다음 질문'은 같은 컨텍스트를 본다. 두 번 호출하면 지연도 비용도 2배다.

핵심: 무엇을 더 물을지는 Rule Engine이 요구하는 필드가 결정한다.
LLM이 자유 판단하지 않는다 (policy-driven slot filling).
"""
from __future__ import annotations

import json

from app.ai import client, prompts
from app.engine import slots
from app.schemas.profile import GoalParseResult, UserProfile


def _rule_question(missing: list[str]) -> tuple[str | None, str | None]:
    """LLM 없이도 다음 질문을 만든다 (폴백 겸 데모 모드)."""
    if not missing:
        return None, None
    field = missing[0]
    label = slots.FIELD_LABEL.get(field, field)
    reason = slots.FIELD_REASON.get(field)
    q = f"{label}을(를) 알려주시겠어요?"
    if reason:
        q += f" {reason}."
    return q, field


def parse_goal(user_message: str, current: UserProfile | None = None,
               history: list[dict] | None = None) -> GoalParseResult:
    """자연어 → UserProfile + 다음 질문 1개."""
    current = current or UserProfile()
    missing_before = slots.missing_fields(current)

    payload = json.dumps({
        "현재까지_수집된_프로필": current.model_dump(exclude_none=True),
        "정책_판정에_아직_부족한_필드": missing_before,
        "사용자_발화": user_message,
    }, ensure_ascii=False)

    result = client.parse_structured(
        GoalParseResult, prompts.GOAL_PARSER, payload,
        effort="low", max_tokens=2000, history=history,
    )

    if result is None:                      # 폴백: 기존 프로필 유지 + 룰 질문
        q, field = _rule_question(missing_before)
        return GoalParseResult(
            profile=current, next_question=q, asking_field=field,
            ready_for_analysis=not missing_before,
        )

    # LLM이 기존 값을 null로 되돌린 경우 복구 (지시했지만 코드로도 막는다)
    merged = current.model_dump()
    for k, v in result.profile.model_dump().items():
        if v is not None:
            merged[k] = v
    result.profile = UserProfile(**merged)

    # ready 판정은 LLM 말이 아니라 슬롯 룰이 정한다
    missing_after = slots.missing_fields(result.profile)
    result.ready_for_analysis = not missing_after
    if missing_after and not result.next_question:
        result.next_question, result.asking_field = _rule_question(missing_after)
    if not missing_after:
        result.next_question, result.asking_field = None, None
    return result
