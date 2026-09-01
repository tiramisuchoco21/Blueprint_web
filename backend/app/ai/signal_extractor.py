# -*- coding: utf-8 -*-
"""A11 Policy Signal Extractor — 소비에서 정책 신호를 역추적한다.

기존 흐름은 Goal → Policy(정방향) 하나뿐이다.
여기에 Consumption → Policy(역방향)를 더하면, 사용자가 존재조차 모르는
정책을 소비 흔적만으로 발굴할 수 있다.

  기존 가계부 : "식비 30만 원 쓰셨어요"
  청사진      : "소비내역을 보니 자격증 준비 중이시네요. 응시료 지원 조례가 있습니다."

안전장치: evidence_tx_ids 가 비면 그 신호는 버린다.
         '왜 그렇게 판단했는지'가 클릭 한 번으로 원본 거래까지 내려가야 한다.
"""
from __future__ import annotations

import json

from app.ai import client, prompts
from app.engine import signals as signal_rules
from app.schemas.consumption import ConsumptionSignal, SignalBatch, Transaction

MIN_CONFIDENCE = 0.5


def extract(txs: list[Transaction]) -> list[ConsumptionSignal]:
    """룰 신호 + LLM 신호를 합친다. 룰이 우선한다."""
    rule_based = signal_rules.rule_signals(txs)

    payload = json.dumps({
        "transactions": [
            {"id": t.id, "date": t.at.strftime("%Y-%m-%d"),
             "merchant": t.merchant_raw, "brand": t.brand,
             "category": t.category, "amount": t.amount}
            for t in txs
        ],
        "이미_규칙으로_확인된_신호": [s.signal for s in rule_based],
    }, ensure_ascii=False)

    batch = client.parse_structured(
        SignalBatch, prompts.SIGNAL_EXTRACTOR, payload,
        effort="medium", max_tokens=3000,
    )
    llm_based = [] if batch is None else [
        s for s in batch.signals
        if s.evidence_tx_ids and s.confidence >= MIN_CONFIDENCE
    ]

    # 존재하지 않는 거래 ID를 지어낸 경우 제거
    valid_ids = {t.id for t in txs}
    for s in llm_based:
        s.evidence_tx_ids = [i for i in s.evidence_tx_ids if i in valid_ids]
    llm_based = [s for s in llm_based if s.evidence_tx_ids]

    return signal_rules.merge_signals(rule_based, llm_based)


def discover_benefits(txs: list[Transaction]) -> dict:
    """신호 추출 → 혜택 매칭 → 절감액 계산. 금액 계산은 전부 룰이 한다."""
    sigs = extract(txs)
    matched = signal_rules.match_benefits(sigs, txs)
    return {
        "signals": [s.model_dump() for s in sigs],
        "benefits": matched,
        "unverified_count": sum(1 for b in matched if not b.get("verified")),
    }
