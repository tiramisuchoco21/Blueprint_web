# -*- coding: utf-8 -*-
"""결정론적 템플릿 폴백.

세 경우에 쓰인다:
  1. API 키가 없거나 DEMO_MODE
  2. LLM 호출 실패 (네트워크·타임아웃)
  3. Numeric Guard 위반

즉 **LLM 없이도 모든 화면이 완성된다.** 시연 중 장애 대비이자,
"AI가 틀리면?"에 대한 구조적 답이다.
"""
from __future__ import annotations

from app.config import CAVEAT
from app.schemas.consumption import ScoreBreakdown, SpendSession
from app.schemas.explain import ExplainPacket, NudgeMessage
from app.schemas.finance import FeasibilityResult, GoalImpact
from app.schemas.policy import EligibilityResult


def won(n: int | None) -> str:
    return f"{int(n):,}원" if n is not None else "-"


ADVICE_BY_VERDICT: dict[str, str] = {
    "ACHIEVABLE": "현재 저축 여력으로 목표 시점 내 달성이 가능한 범위입니다. "
                  "정책 신청 시점과 필요 서류를 미리 준비하면 됩니다.",
    "TIGHT": "목표 달성이 빠듯한 구간입니다. 월 저축액을 올리거나 목표 시점을 "
             "조정하는 두 가지 선택지를 비교해 보세요.",
    "NOT_ACHIEVABLE": "현재 조건으로는 목표 시점 내 달성이 어렵습니다. "
                      "목표 금액을 조정할지, 기간을 늘릴지 선택이 필요합니다.",
}


def explain_packet(feas: FeasibilityResult,
                   policies: list[EligibilityResult]) -> ExplainPacket:
    fact: list[str] = []
    for p in policies:
        if p.status == "ELIGIBLE" and p.amount_basis:
            fact.append(f"{p.policy_name}: {p.amount_basis}")
        elif p.status == "ENDED":
            fact.append(f"{p.policy_name}: {p.reason} — 추천 목록에서 제외됩니다.")
        elif p.status == "CONDITIONAL" and p.reason:
            fact.append(f"{p.policy_name}: {p.reason}")

    calc: list[str] = []
    if feas.policy_capacity:
        calc.append(
            f"목표 {won(feas.target_amount)} − 정책금융 검토 가능액 "
            f"{won(feas.policy_capacity)} = 필요 자기자본 {won(feas.required_equity)}"
        )
    if feas.gap:
        calc.append(
            f"필요 자기자본 {won(feas.required_equity)} − 현재 보유 "
            f"{won(feas.current_cash)} = 추가 필요 {won(feas.gap)}"
        )
        if feas.horizon_months:
            calc.append(
                f"추가 필요 {won(feas.gap)} ÷ {feas.horizon_months}개월 "
                f"= 월 {won(feas.required_monthly)}"
            )

    return ExplainPacket(
        fact=fact, calculation=calc,
        advice=ADVICE_BY_VERDICT.get(feas.verdict, ""),
        caveat=CAVEAT, source="template",
    )


def nudge(score: ScoreBreakdown, impact: GoalImpact | None = None,
          benefit: dict | None = None) -> NudgeMessage:
    """밴드별 고정 문구. 심리 단정 없이 관측 사실만 서술한다."""
    obs = " · ".join(score.evidence[:2]) if score.evidence else "관측된 특이 지표 없음"

    if score.band in ("계획", "일반"):
        text = f"{obs}. 현재 목표 계획에 큰 영향은 없습니다."
    elif score.band == "주의":
        text = f"{obs}. 계획한 지출이었다면 알려주세요."
    else:
        text = f"{obs}. 이 패턴이 반복되는지 함께 지켜보겠습니다."

    if impact and impact.status == "AT_RISK" and impact.d_day_shift_days:
        text += (f" 현재 소비 패턴이 유지되면 목표 도달이 약 "
                 f"{impact.d_day_shift_days}일 늦어집니다.")
    if benefit and benefit.get("estimated_saving"):
        text += (f" {benefit['name']} 적용 시 월 {won(benefit['estimated_saving'])} "
                 f"절감이 예상됩니다.")
    return NudgeMessage(text=text, source="template")


def session_note(s: SpendSession) -> str:
    return (f"{s.started_at:%m월 %d일 %H:%M}부터 {s.duration_minutes}분 동안 "
            f"{len(s.tx_ids)}건, 합계 {s.total_amount:,}원의 연속 결제가 있었습니다.")


def agent_answer(reason: str = "") -> str:
    return (
        "지금은 답변을 생성할 수 없습니다. "
        "대시보드의 계산 결과와 정책 카드는 정상적으로 표시됩니다."
        + (f" ({reason})" if reason else "")
    )
