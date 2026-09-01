# -*- coding: utf-8 -*-
"""소비 신호 → 정책/혜택 매핑 — 룰. LLM 개입 없음.

A11 Policy Signal Extractor 의 후반부.
LLM은 '신호를 뽑는 것'까지만 하고, 신호를 정책에 연결하는 건 이 모듈이 한다.

  Goal → Policy   (정방향, 기존)
  Consumption → Policy  (역방향, 신규 USP)  ← 여기
"""
from __future__ import annotations

from collections import defaultdict

from app.engine import policy_db
from app.schemas.consumption import ConsumptionSignal, Transaction

#: 신호 → 혜택/정책 후보
SIGNAL_TO_BENEFIT: dict[str, list[str]] = {
    "studying_certificate": ["cert_exam_support"],
    "telecom_autopay": ["nonfinancial_credit"],
    "transit_heavy": ["k_pass"],
    "no_car_owner": ["k_pass"],
    "frequent_delivery": ["local_gift_card"],
    "living_alone": ["local_gift_card"],
}

#: LLM 없이도 잡히는 신호 (규칙 기반 1차 추출)
RULE_SIGNALS = {
    "telecom_autopay": lambda by_cat: len(by_cat.get("telecom", [])) > 0,
    "transit_heavy": lambda by_cat: sum(
        t.amount for t in by_cat.get("transport", []) + by_cat.get("transit_pass", [])
    ) >= 70000,
    "studying_certificate": lambda by_cat: len(by_cat.get("education", [])) >= 2,
    "frequent_delivery": lambda by_cat: len(by_cat.get("food_delivery", [])) >= 4,
}


def rule_signals(txs: list[Transaction]) -> list[ConsumptionSignal]:
    """규칙만으로 확실한 신호. LLM 결과와 합쳐 쓴다."""
    by_cat: dict[str, list[Transaction]] = defaultdict(list)
    for t in txs:
        by_cat[t.category].append(t)

    cat_for_signal = {
        "telecom_autopay": ["telecom"],
        "transit_heavy": ["transport", "transit_pass"],
        "studying_certificate": ["education"],
        "frequent_delivery": ["food_delivery"],
    }
    out: list[ConsumptionSignal] = []
    for name, fn in RULE_SIGNALS.items():
        if not fn(by_cat):
            continue
        ev = [t for c in cat_for_signal[name] for t in by_cat.get(c, [])]
        out.append(ConsumptionSignal(
            signal=name, evidence_tx_ids=[t.id for t in ev],
            rationale=f"{'/'.join(cat_for_signal[name])} 결제 {len(ev)}건 "
                      f"· 합계 {sum(t.amount for t in ev):,}원",
            confidence=1.0,
        ))
    return out


def merge_signals(rule: list[ConsumptionSignal],
                  llm: list[ConsumptionSignal]) -> list[ConsumptionSignal]:
    """룰 신호를 우선한다. LLM 신호는 근거 거래가 있는 것만 채택한다."""
    seen = {s.signal for s in rule}
    out = list(rule)
    for s in llm:
        if s.signal in seen:
            continue
        if not s.evidence_tx_ids:      # 근거 없는 신호는 버린다
            continue
        out.append(s)
        seen.add(s.signal)
    return out


def match_benefits(signals: list[ConsumptionSignal],
                   txs: list[Transaction]) -> list[dict]:
    """신호에 걸린 혜택 후보 + 예상 절감액. 금액 계산은 여기서(코드가) 한다."""
    by_id = {t.id: t for t in txs}
    days = max((max(t.at for t in txs) - min(t.at for t in txs)).days, 1) if txs else 1
    out: list[dict] = []

    for sig in signals:
        for bid in SIGNAL_TO_BENEFIT.get(sig.signal, []):
            b = policy_db.get_benefit(bid)
            if not b:
                continue
            ev_txs = [by_id[i] for i in sig.evidence_tx_ids if i in by_id]
            monthly = int(sum(t.amount for t in ev_txs) / days * 30) if ev_txs else 0

            trig = b.get("trigger", {})
            if monthly < trig.get("monthly_amount_gte", 0):
                continue

            saving, basis = _estimate_saving(b, monthly)
            out.append({
                "benefit_id": bid, "name": b["name"], "verified": b.get("verified", False),
                "signal": sig.signal, "rationale": sig.rationale,
                "evidence_tx_ids": sig.evidence_tx_ids,
                "monthly_base": monthly, "estimated_saving": saving,
                "saving_basis": basis, "note": b.get("note"),
                "source": b.get("source", {}),
            })
    return out


def _estimate_saving(benefit: dict, monthly: int) -> tuple[int | None, str | None]:
    spec = benefit.get("benefit", {})
    kind = spec.get("type")
    if kind == "refund_rate":
        rate = spec.get("rate_youth") or spec.get("rate") or 0
        cap = spec.get("annual_cap")
        amount = int(monthly * rate)
        if cap:
            amount = min(amount, cap // 12)
        return amount, f"월 {monthly:,}원 × 환급률 {rate:.0%}"
    if kind == "discount_rate":
        rate = spec["rate"]
        base = min(monthly, spec.get("monthly_cap", monthly))
        return int(base * rate), f"월 {base:,}원 × 할인율 {rate:.0%}"
    return None, None
