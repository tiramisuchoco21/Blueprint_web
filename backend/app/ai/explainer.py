# -*- coding: utf-8 -*-
"""A3 Explainer — 확정된 계산 결과를 서술한다.

입력은 이미 확정된 JSON이다. LLM은 숫자를 만들지 않고 잇기만 한다.
출력은 반드시 A4 Numeric Guard를 통과해야 화면에 나간다.
"""
from __future__ import annotations

import json

from app.ai import client, fallback, guard, prompts
from app.config import CAVEAT
from app.schemas.explain import ExplainPacket
from app.schemas.finance import FeasibilityResult
from app.schemas.policy import EligibilityResult


def explain(feas: FeasibilityResult,
            policies: list[EligibilityResult]) -> ExplainPacket:
    payload = {
        "feasibility": feas.model_dump(),
        "policies": [p.model_dump() for p in policies],
    }

    packet = client.parse_structured(
        ExplainPacket, prompts.EXPLAINER,
        json.dumps(payload, ensure_ascii=False),
        effort="low", max_tokens=2000,
    )
    if packet is None:
        return fallback.explain_packet(feas, policies)

    # ── Numeric Guard ──────────────────────────────────────
    violations = guard.guard(
        [*packet.fact, *packet.calculation, packet.advice], payload
    )
    if violations:
        fb = fallback.explain_packet(feas, policies)
        fb.guard_violations = violations
        return fb

    packet.caveat = CAVEAT       # 고지 문구는 서버가 강제한다
    packet.source = "llm"
    return packet
