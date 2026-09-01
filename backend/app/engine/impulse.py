# -*- coding: utf-8 -*-
"""충동성(Impulsivity) 스코어러 — 규칙 기반. LLM 개입 없음.

설계 원칙 (청사진_페르소나1_2_최종수정본.pdf):
  "스트레스성 소비일 확률 85%처럼 사용자의 심리상태를 단정하지 않는다.
   대신 검증 가능한 소비 행동 데이터를 사용해 규칙 기반으로 계산한다."

따라서 이 모듈은 '충동적이었는지'(심리)를 추론하지 않는다.
'충동 소비의 관측 가능한 특징을 얼마나 갖고 있는지'(행동)만 계산한다.

  ❌ "스트레스 받아서 사셨네요"
  ✅ "야간 + 직전 결제 15분 후 + 재량지출 → 특징 3개 중 3개 해당"
"""
from __future__ import annotations

from datetime import timedelta
from statistics import median

from app.schemas.consumption import (
    AUTO_DEBIT, DISCRETIONARY, PLANNED, ImpulseResult, Transaction,
)

WEIGHTS = {
    "night": 20,          # 22:00~04:00 결제
    "burst": 20,          # 직전 능동 결제로부터 60분 이내 (다른 가맹점)
    "deviation": 25,      # 동일 카테고리 중앙값 대비 초과 배수
    "rapid_repeat": 15,   # 24시간 내 동일 브랜드 재결제
    "discretionary": 20,  # 재량지출 카테고리
}  # 합계 100

# 밴드는 실제 데이터 96건 분포에 맞춰 보정한 값이다.
# 데이터가 바뀌면 반드시 재보정할 것 (고정 상수로 취급 금지).
BANDS = [(0, 19, "계획"), (20, 39, "일반"), (40, 59, "주의"), (60, 100, "충동 패턴")]

PLANNED_CAP = 20
BURST_WINDOW = timedelta(minutes=60)
REPEAT_WINDOW = timedelta(hours=24)


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def band_of(score: int) -> str:
    return next(b for lo, hi, b in BANDS if lo <= score <= hi)


def category_medians(txs: list[Transaction]) -> dict[str, float]:
    buckets: dict[str, list[int]] = {}
    for t in txs:
        buckets.setdefault(t.category, []).append(t.amount)
    return {k: median(v) for k, v in buckets.items()}


def score_impulse(tx: Transaction, history: list[Transaction],
                  cat_median: dict[str, float]) -> ImpulseResult:
    """history 는 tx 이전 거래만 담겨야 한다 (미래 정보 누수 방지)."""
    ev: list[str] = []

    # ── 1. 야간 ────────────────────────────────────────────
    hour = tx.at.hour
    f_night = 1.0 if (hour >= 22 or hour < 4) else 0.0
    if f_night:
        ev.append(f"야간 결제 ({tx.at:%H:%M})")

    # ── 2. 버스트 — 직전 '능동' 결제와의 간격 ───────────────
    # 자동이체·보험료·통신비는 그 시각에 사용자가 행동한 게 아니므로 기준선에서 뺀다.
    active = [h for h in history if not h.is_recurring and h.category not in AUTO_DEBIT]
    prev = active[-1] if active else None
    f_burst = 0.0
    if prev and prev.brand != tx.brand:
        gap = tx.at - prev.at
        if timedelta(0) <= gap <= BURST_WINDOW:
            f_burst = _clamp(1.0 - gap / BURST_WINDOW)
            ev.append(f"직전 결제({prev.brand}) {int(gap.total_seconds() // 60)}분 후 연속 결제")

    # ── 3. 카테고리 중앙값 대비 편차 ────────────────────────
    # 카테고리를 모르면 비교 기준이 없다. unknown끼리의 중앙값을 쓰면
    # 성격이 다른 거래가 섞여 편차가 허위로 커진다.
    med = 0 if tx.category == "unknown" else (cat_median.get(tx.category, 0) or 0)
    f_dev = _clamp((tx.amount / med - 1.0) / 2.0) if med else 0.0
    if f_dev > 0.3:
        ev.append(f"{tx.category} 중앙값({int(med):,}원) 대비 {tx.amount / med:.1f}배")
    elif tx.category == "unknown":
        ev.append("카테고리 미상 — 편차 판정 보류 (AI 카테고라이저 필요)")

    # ── 4. 24시간 내 동일 브랜드 재결제 ─────────────────────
    same = [h for h in history if h.brand == tx.brand and tx.at - h.at <= REPEAT_WINDOW]
    f_rep = _clamp(len(same) / 2.0)
    if same:
        ev.append(f"24시간 내 {tx.brand} {len(same) + 1}회차")

    # ── 5. 재량지출 여부 ───────────────────────────────────
    f_disc = 1.0 if tx.category in DISCRETIONARY else 0.0

    factors = {"night": f_night, "burst": f_burst, "deviation": f_dev,
               "rapid_repeat": f_rep, "discretionary": f_disc}
    parts = {k: round(WEIGHTS[k] * v, 1) for k, v in factors.items()}
    score = round(sum(parts.values()))

    # ── Planned Gate ───────────────────────────────────────
    # 고액이라고 충동이 아니다. 계획 지출로 확인되면 상한을 건다.
    capped = False
    if tx.is_recurring or tx.category in PLANNED:
        if score > PLANNED_CAP:
            score, capped = PLANNED_CAP, True
        reason = "정기 결제" if tx.is_recurring else f"계획성 지출({tx.category})"
        ev.append(f"→ {reason}으로 확인되어 충동 점수 상한 적용")

    return ImpulseResult(
        tx_id=tx.id, total=score, band=band_of(score),
        parts=parts, factors=factors, evidence=ev, planned_capped=capped,
    )


def score_all(txs: list[Transaction]) -> list[ImpulseResult]:
    txs = sorted(txs, key=lambda t: t.at)
    med = category_medians(txs)
    return [score_impulse(t, txs[:i], med) for i, t in enumerate(txs)]
