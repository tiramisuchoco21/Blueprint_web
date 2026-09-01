# -*- coding: utf-8 -*-
"""넛지 문구 생성 — FinTox에서 LLM이 문장을 쓰는 유일한 지점.

심리 단정 금지가 여기서 가장 중요하다. Guard에 forbid_psych=True로 검사한다.
"""
from __future__ import annotations

import json

from app.ai import client, fallback, guard, prompts
from app.schemas.consumption import ScoreBreakdown, SpendSession, Transaction
from app.schemas.explain import NudgeMessage
from app.schemas.finance import GoalImpact

#: 밴드별 셀프저축 제안 비율
SELF_SAVE_RATE = {"계획": 0.0, "일반": 0.0, "주의": 0.10, "충동 패턴": 0.15}


def _cta(tx: Transaction, score: ScoreBreakdown) -> tuple[str | None, int | None]:
    rate = SELF_SAVE_RATE.get(score.band, 0.0)
    if not rate:
        return None, None
    amount = int(tx.amount * rate)
    return f"{amount:,}원 목표 저축에 반영하기", amount


def make_nudge(tx: Transaction, score: ScoreBreakdown,
               impact: GoalImpact | None = None,
               benefit: dict | None = None,
               session: SpendSession | None = None) -> NudgeMessage:
    cta_label, cta_amount = _cta(tx, score)

    payload = {
        "transaction": {"merchant": tx.brand, "amount": tx.amount,
                        "at": tx.at.strftime("%Y-%m-%d %H:%M"), "category": tx.category},
        "score": score.model_dump(),
        "goal_impact": impact.model_dump() if impact else None,
        "benefit": benefit,
        "session": session.model_dump(mode="json") if session else None,
        "self_save_amount": cta_amount,
    }

    msg = client.parse_structured(
        NudgeMessage, prompts.NUDGE, json.dumps(payload, ensure_ascii=False),
        effort="low", max_tokens=500,
    )
    if msg is None:
        fb = fallback.nudge(score, impact, benefit)
        fb.cta_label, fb.cta_amount = cta_label, cta_amount
        return fb

    violations = guard.guard([msg.text], payload, forbid_psych=True)
    if violations:
        fb = fallback.nudge(score, impact, benefit)
        fb.cta_label, fb.cta_amount = cta_label, cta_amount
        return fb

    msg.source = "llm"
    msg.cta_label, msg.cta_amount = cta_label, cta_amount
    return msg
