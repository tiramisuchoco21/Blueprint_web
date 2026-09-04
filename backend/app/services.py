# -*- coding: utf-8 -*-
"""오케스트레이션 — 화면 하나가 필요로 하는 것을 한 번에 조립한다.

렌더 순서 원칙:
  계산 결과(숫자·배지·게이지)를 먼저 확정하고, AI 텍스트는 나중에 채운다.
  이러면 LLM이 느리거나 실패해도 화면은 완성된다.
"""
from __future__ import annotations

import json
from datetime import datetime
from functools import lru_cache

from app.ai import explainer, nudge as nudge_ai, resolver, signal_extractor
from app.config import FIXTURE_DIR
from app.engine import (
    calculator, debt as debt_engine, impulse, policy_db, rules,
    session as session_engine, signals,
)
from app.schemas.consumption import Transaction
from app.schemas.profile import UserProfile, profile_with


# ─────────────────────────────────────────────────────────────
# fixture 로딩
# ─────────────────────────────────────────────────────────────
@lru_cache(maxsize=1)
def load_personas() -> dict[str, UserProfile]:
    raw = json.loads((FIXTURE_DIR / "personas.json").read_text(encoding="utf-8"))
    return {k: UserProfile(**v) for k, v in raw.items()}


@lru_cache(maxsize=1)
def load_transactions() -> tuple[Transaction, ...]:
    # 로컬에 실제 명세로 만든 파일이 있으면 그것을, 없으면 저장소에 포함된
    # 합성본을 쓴다. tx_dummy.json 은 .gitignore 대상이다.
    path = FIXTURE_DIR / "tx_dummy.json"
    if not path.exists():
        path = FIXTURE_DIR / "tx_demo.json"
    if not path.exists():
        return ()
    rows = json.loads(path.read_text(encoding="utf-8"))
    return tuple(
        Transaction(
            id=r["id"], at=datetime.fromisoformat(r["at"]), amount=r["amount"],
            merchant_raw=r["merchant_raw"], brand=r["brand"],
            category=r.get("category", "unknown"), pg=r.get("pg"),
            opaque=r.get("opaque", False), is_recurring=r.get("is_recurring", False),
        )
        for r in rows
    )


# ─────────────────────────────────────────────────────────────
# Blueprint (SCREEN 03)
# ─────────────────────────────────────────────────────────────
def analyze(profile: UserProfile, with_ai: bool = True) -> dict:
    """정책 워터폴 + 목표 가능성 + 설명. 이 순서가 곧 신뢰 구조다."""
    waterfall = rules.waterfall(profile)               # ❌ 룰
    primary = rules.select_primary_loan(waterfall)     # ❌ 룰
    capacity = primary.estimated_amount or 0 if primary else 0
    feas = calculator.feasibility(profile, capacity)   # ❌ 계산
    debt = calculator.debt_decision(profile)           # ❌ 룰

    out = {
        "profile": profile.model_dump(exclude_none=True),
        "policies": [p.model_dump() for p in waterfall],
        "primary_policy": primary.model_dump() if primary else None,
        "feasibility": feas.model_dump(),
        "debt_decision": debt.model_dump() if debt else None,
        "policy_wallet": _policy_wallet(feas),
        "unverified_policies": [p.policy_id for p in waterfall
                                if not _is_verified(p.policy_id)],
    }
    # AI 텍스트는 마지막에. 실패해도 위 내용은 이미 완성돼 있다.
    out["debt"] = debt_summary(profile, primary)

    out["explain"] = (explainer.explain(feas, waterfall) if with_ai
                      else None)
    if out["explain"] is not None:
        out["explain"] = out["explain"].model_dump()
    return out


def debt_summary(profile: UserProfile, primary=None) -> dict | None:
    """부채 — '갚는 것'과 '끼고 사는 것'을 한 묶음으로 돌려준다.

    · strategy  : 상환 vs 저축 배분 3시나리오 + 추천 (갚는 쪽)
    · dsr       : 신규 정책대출 실행 후 월 상환 부담 (끼고 사는 쪽)
    · 두 축은 capacity_gain_if_cleared 로 이어진다.
    """
    debts = profile.debt_list()
    monthly_available = profile.monthly_saving or 0

    # 신규 정책대출을 실행했을 때의 월 상환액
    new_payment = 0
    if primary and primary.estimated_amount:
        pol = policy_db.get_policy(primary.policy_id) or {}
        months = pol.get("loan_months")
        rate = primary.rate_max or (pol.get("rate", {}) or {}).get("max")
        if months and rate:
            new_payment = calculator.monthly_payment(
                primary.estimated_amount, rate, months
            )
    dsr = debt_engine.dsr_check(profile, new_payment)

    if not debts:
        return {"has_debt": False, "strategy": None, "dsr": dsr.model_dump(),
                "new_loan_monthly_payment": new_payment}

    strategy = debt_engine.build_strategy(
        profile,
        lambda dm: rules.capacity_with_debt_payment(profile, dm),
        monthly_available,
    )
    return {
        "has_debt": True,
        "strategy": strategy.model_dump(),
        "dsr": dsr.model_dump(),
        "new_loan_monthly_payment": new_payment,
        "decision": (calculator.debt_decision(profile).model_dump()
                     if calculator.debt_decision(profile) else None),
    }


def _is_verified(policy_id: str) -> bool:
    p = policy_db.get_policy(policy_id)
    return bool(p and p.get("verified"))


def _policy_wallet(feas) -> list[dict]:
    """'목표 대응 가능 자원' — 성격이 다른 돈을 섞지 않고 라벨을 분리한다."""
    future = max(feas.projected_cash - feas.current_cash, 0)
    return [
        {"kind": "현재 현금·예적금", "amount": feas.current_cash,
         "ui_label": "보유 금융자산", "confirmed": True},
        {"kind": "정책대출 검토 가능액", "amount": feas.policy_capacity,
         "ui_label": "정책금융 활용가능 예상액", "confirmed": False},
        {"kind": f"향후 {feas.horizon_months}개월 저축", "amount": future,
         "ui_label": "미래 예상자금", "confirmed": False},
        {"kind": "합계", "amount": feas.current_cash + feas.policy_capacity + future,
         "ui_label": "목표 대응 가능 자원", "confirmed": False},
    ]


# ─────────────────────────────────────────────────────────────
# Simulator (SCREEN 04)
# ─────────────────────────────────────────────────────────────
def simulate(profile: UserProfile, monthly_saving: int | None = None,
             target_amount: int | None = None,
             horizon_months: int | None = None) -> dict:
    """슬라이더 재계산. LLM을 부르지 않는다 — 0ms여야 한다."""
    # model_copy 가 아니라 profile_with 를 쓴다 — 음수 등 잘못된 값이
    # 검증을 건너뛰고 들어오는 것을 막기 위해서다.
    prof = profile_with(profile, monthly_saving=monthly_saving,
                        target_amount=target_amount, horizon_months=horizon_months)

    capacity = rules.total_policy_capacity(rules.waterfall(prof))
    feas = calculator.feasibility(prof, capacity)

    months_needed = (
        -(-feas.gap // prof.monthly_saving) if prof.monthly_saving else None
    )
    return {
        "feasibility": feas.model_dump(),
        "months_to_goal": months_needed,
        # `if months_needed` 로 쓰면 0개월(이미 목표 달성)이 falsy라 None이 된다.
        "delta_months": (months_needed - feas.horizon_months)
                        if months_needed is not None else None,
    }


# ─────────────────────────────────────────────────────────────
# FinTox (SCREEN 05)
# ─────────────────────────────────────────────────────────────
def fintox(profile: UserProfile, txs: list[Transaction] | None = None,
           with_ai: bool = True, monthly_income: int = 0) -> dict:
    txs = list(txs if txs is not None else load_transactions())

    resolved_now = []
    if with_ai:
        txs, resolved_now = resolver.resolve(txs)      # ✅ AI — 여기가 전제조건

    scores = impulse.score_all(txs)                     # ❌ 룰
    sessions = session_engine.detect(txs)               # ❌ 룰

    capacity = rules.total_policy_capacity(rules.waterfall(profile))
    feas = calculator.feasibility(profile, capacity)

    fixed = sum(t.amount for t in txs if t.category in ("telecom", "insurance"))
    variable = sum(t.amount for t in txs
                   if t.category not in ("telecom", "insurance", "health", "admin"))
    days = max((max(t.at for t in txs) - min(t.at for t in txs)).days, 1) if txs else 1
    impact = calculator.goal_impact(monthly_income, fixed, variable, days, feas)

    discovered = (signal_extractor.discover_benefits(txs) if with_ai
                  else {"signals": [s.model_dump() for s in signals.rule_signals(txs)],
                        "benefits": signals.match_benefits(signals.rule_signals(txs), txs)})

    return {
        "transactions": [t.model_dump(mode="json") for t in txs],
        "scores": [s.model_dump() for s in scores],
        "sessions": [s.model_dump(mode="json") for s in sessions],
        "goal_impact": impact.model_dump(),
        "discovery": discovered,
        "resolver": {
            "resolved_now": [m.model_dump() for m in resolved_now],
            "unresolved": resolver.unresolved(txs),
            "unknown_count": sum(1 for t in txs if t.category == "unknown"),
            "llm_resolved_count": sum(1 for t in txs if t.resolved_by == "llm"),
            **resolver.cache_stats(),
        },
        "coverage_note": "카드 승인 내역 기준입니다. 현금·계좌이체는 포함되지 않습니다.",
    }


def nudge_for(tx_id: int, profile: UserProfile, monthly_income: int = 0) -> dict:
    """넛지는 별도 엔드포인트다. 느리거나 실패해도 FinTox 렌더를 막지 않는다."""
    txs = list(load_transactions())
    tx = next((t for t in txs if t.id == tx_id), None)
    if tx is None:
        return {"error": f"거래를 찾을 수 없습니다: {tx_id}"}

    scores = {s.tx_id: s for s in impulse.score_all(txs)}
    score = scores[tx_id]
    sess = next((s for s in session_engine.detect(txs) if tx_id in s.tx_ids), None)

    capacity = rules.total_policy_capacity(rules.waterfall(profile))
    feas = calculator.feasibility(profile, capacity)
    fixed = sum(t.amount for t in txs if t.category in ("telecom", "insurance"))
    variable = sum(t.amount for t in txs
                   if t.category not in ("telecom", "insurance", "health", "admin"))
    days = max((max(t.at for t in txs) - min(t.at for t in txs)).days, 1)
    impact = calculator.goal_impact(monthly_income, fixed, variable, days, feas)

    msg = nudge_ai.make_nudge(tx, score, impact, None, sess)
    return {"transaction": tx.model_dump(mode="json"), "score": score.model_dump(),
            "session": sess.model_dump(mode="json") if sess else None,
            "nudge": msg.model_dump()}
