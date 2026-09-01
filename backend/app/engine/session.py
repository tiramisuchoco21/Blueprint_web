# -*- coding: utf-8 -*-
"""소비 세션(연쇄 결제) 탐지 — 룰. LLM 개입 없음.

건별 채점은 실제 충동을 과소평가한다. 실측 예:

    22:27  분99      24,000원
    23:14  올리브영    3,000원  (47분 후)
    23:29  다이소      1,000원  (15분 후)

개별로는 대수롭지 않지만, 묶으면 '야간 62분간 3개 가맹점 연쇄 28,000원'이다.
사람이 '충동소비'라고 부르는 것은 후자에 훨씬 가깝다.
"""
from __future__ import annotations

from datetime import timedelta

from app.schemas.consumption import AUTO_DEBIT, DISCRETIONARY, SpendSession, Transaction

SESSION_GAP = timedelta(minutes=60)
MIN_SESSION_SIZE = 2

SESSION_WEIGHTS = {
    "night": 25,        # 세션이 야간에 시작
    "chain_len": 30,    # 연쇄 길이
    "density": 20,      # 시간당 결제 건수
    "discretionary": 25,  # 재량지출 비중
}
SESSION_BANDS = [(0, 24, "계획"), (25, 44, "일반"), (45, 64, "주의"), (65, 100, "충동 패턴")]


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def detect(txs: list[Transaction]) -> list[SpendSession]:
    """60분 이내로 이어지는 결제를 하나의 세션으로 묶는다."""
    active = sorted(
        (t for t in txs if not t.is_recurring and t.category not in AUTO_DEBIT),
        key=lambda t: t.at,
    )
    groups: list[list[Transaction]] = []
    for t in active:
        if groups and t.at - groups[-1][-1].at <= SESSION_GAP:
            groups[-1].append(t)
        else:
            groups.append([t])

    sessions: list[SpendSession] = []
    for i, g in enumerate(g for g in groups if len(g) >= MIN_SESSION_SIZE):
        minutes = max(int((g[-1].at - g[0].at).total_seconds() // 60), 1)
        s = SpendSession(
            session_id=i + 1, tx_ids=[t.id for t in g],
            started_at=g[0].at, ended_at=g[-1].at, duration_minutes=minutes,
            total_amount=sum(t.amount for t in g),
            brands=list(dict.fromkeys(t.brand for t in g)),
            is_night=(g[0].at.hour >= 22 or g[0].at.hour < 4),
        )
        sessions.append(_score(s, g))
    return sessions


def _score(s: SpendSession, txs: list[Transaction]) -> SpendSession:
    n = len(txs)
    disc = sum(1 for t in txs if t.category in DISCRETIONARY) / n

    f = {
        "night": 1.0 if s.is_night else 0.0,
        "chain_len": _clamp((n - 1) / 3),          # 2건=0.33, 4건=1.0
        "density": _clamp(n / (s.duration_minutes / 60) / 4),  # 시간당 4건이면 만점
        "discretionary": disc,
    }
    s.score = round(sum(SESSION_WEIGHTS[k] * v for k, v in f.items()))
    s.band = next(b for lo, hi, b in SESSION_BANDS if lo <= s.score <= hi)

    ev = [f"{s.duration_minutes}분 동안 {n}건 · {len(s.brands)}개 가맹점 "
          f"· 합계 {s.total_amount:,}원"]
    if s.is_night:
        ev.append(f"야간 시작 ({s.started_at:%H:%M})")
    if disc >= 0.5:
        ev.append(f"재량지출 비중 {disc:.0%}")
    ev.append(" → ".join(s.brands))
    s.evidence = ev
    return s
