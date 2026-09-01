# -*- coding: utf-8 -*-
"""A9 Tool-Use Agent — 자유질의 대응.

고정 파이프라인(파싱→룰→계산→설명)은 예상 밖 질문을 못 받는다.
LLM에게 엔진을 **도구로** 주면 자연어 질문에 답할 수 있고,
그러면서도 숫자는 여전히 코드가 만든다.

  "학자금 먼저 갚는 게 나아요?"       → simulate_what_if 2회 호출 후 비교
  "월 70만 원 모으면 언제 돼요?"      → calculate_feasibility
  "버팀목 원문 조건 보여줘"           → lookup_policy_document

도구 호출 로그를 UI에 노출하면 'AI가 계산하지 않는다'는 증거가 화면에 남는다.
"""
from __future__ import annotations

import contextvars
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from app.ai import client as ai_client
from app.ai import fallback, guard, prompts
from app.config import MODEL
from app.engine import calculator, policy_db, rules
from app.schemas.consumption import Transaction
from app.schemas.explain import AgentAnswer, ToolCallLog
from app.schemas.profile import UserProfile

log = logging.getLogger("csj.agent")

MAX_TURNS = 12


@dataclass
class AgentContext:
    profile: UserProfile
    transactions: list[Transaction] = field(default_factory=list)
    #: 도구가 반환한 모든 값 — Numeric Guard 화이트리스트의 원천
    tool_outputs: list[Any] = field(default_factory=list)
    tool_log: list[ToolCallLog] = field(default_factory=list)


_ctx: contextvars.ContextVar[AgentContext] = contextvars.ContextVar("csj_agent_ctx")


def _record(name: str, payload: dict, result: Any) -> str:
    ctx = _ctx.get()
    ctx.tool_outputs.append(result)
    text = json.dumps(result, ensure_ascii=False, default=str)
    ctx.tool_log.append(ToolCallLog(
        name=name, input=payload,
        output_digest=text[:200] + ("…" if len(text) > 200 else ""),
    ))
    return text


# ─────────────────────────────────────────────────────────────
# 도구 정의 — 전부 기존 엔진을 그대로 호출한다. 새 로직을 넣지 않는다.
# ─────────────────────────────────────────────────────────────
def _build_tools():
    from anthropic import beta_tool

    @beta_tool
    def list_policies() -> str:
        """현재 사용자의 목표에 해당하는 정책 목록과 자격 판정 결과를 모두 조회한다.

        어떤 정책이 있는지, 각각 검토 가능/조건부/지원 어려움/종료 중 무엇인지 알려준다.
        """
        ctx = _ctx.get()
        results = rules.waterfall(ctx.profile)
        return _record("list_policies", {},
                       [r.model_dump() for r in results])

    @beta_tool
    def check_policy_eligibility(policy_id: str) -> str:
        """특정 정책 하나의 자격을 판정한다. 조건별 통과/미통과 내역까지 돌려준다.

        Args:
            policy_id: 정책 ID. 예: youth_butimok, newlywed_purchase
        """
        ctx = _ctx.get()
        p = policy_db.get_policy(policy_id)
        if not p:
            return json.dumps({"error": f"정책을 찾을 수 없습니다: {policy_id}"},
                              ensure_ascii=False)
        return _record("check_policy_eligibility", {"policy_id": policy_id},
                       rules.evaluate(p, ctx.profile).model_dump())

    @beta_tool
    def calculate_feasibility(target_amount: int, horizon_months: int,
                              monthly_saving: int) -> str:
        """목표 달성 가능성을 계산한다. 필요 자기자본·부족액·월 저축액·판정을 돌려준다.

        Args:
            target_amount: 목표 금액(원).
            horizon_months: 목표까지 개월수.
            monthly_saving: 월 저축 가능액(원).
        """
        ctx = _ctx.get()
        prof = ctx.profile.model_copy(update={
            "target_amount": target_amount, "horizon_months": horizon_months,
            "monthly_saving": monthly_saving,
        })
        cap = rules.total_policy_capacity(rules.waterfall(prof))
        feas = calculator.feasibility(prof, cap)
        return _record("calculate_feasibility",
                       {"target_amount": target_amount,
                        "horizon_months": horizon_months,
                        "monthly_saving": monthly_saving},
                       feas.model_dump())

    @beta_tool
    def simulate_what_if(target_amount: int = 0, horizon_months: int = 0,
                         monthly_saving: int = 0, repay_debt: bool = False) -> str:
        """조건을 바꿔 목표 달성 가능성을 다시 계산한다. 0을 넘기면 기존 값을 쓴다.

        Args:
            target_amount: 바꿀 목표 금액(원). 0이면 기존 값 유지.
            horizon_months: 바꿀 목표 기간(개월). 0이면 기존 값 유지.
            monthly_saving: 바꿀 월 저축액(원). 0이면 기존 값 유지.
            repay_debt: True면 기존 대출을 전액 상환한 시나리오로 계산한다.
        """
        ctx = _ctx.get()
        base = ctx.profile
        upd: dict[str, Any] = {}
        if target_amount:
            upd["target_amount"] = target_amount
        if horizon_months:
            upd["horizon_months"] = horizon_months
        if monthly_saving:
            upd["monthly_saving"] = monthly_saving
        if repay_debt and base.existing_debt:
            upd["current_cash"] = (base.current_cash or 0) - base.existing_debt
            upd["existing_debt"] = 0
        prof = base.model_copy(update=upd)
        cap = rules.total_policy_capacity(rules.waterfall(prof))
        feas = calculator.feasibility(prof, cap)
        out = {"scenario": upd or "변경 없음", "result": feas.model_dump()}
        if repay_debt:
            d = calculator.debt_decision(base)
            out["debt_decision"] = d.model_dump() if d else None
        return _record("simulate_what_if", upd, out)

    @beta_tool
    def search_consumption(category: str = "", days: int = 30) -> str:
        """소비 내역을 조회·집계한다. 카테고리별 합계와 건수를 돌려준다.

        Args:
            category: 필터할 카테고리. 비우면 전체. 예: food_delivery, transport
            days: 최근 며칠을 볼지.
        """
        ctx = _ctx.get()
        txs = ctx.transactions
        if not txs:
            return json.dumps({"error": "소비 내역이 없습니다"}, ensure_ascii=False)
        latest = max(t.at for t in txs)
        picked = [t for t in txs
                  if (latest - t.at).days <= days
                  and (not category or t.category == category)]
        by_cat: dict[str, dict] = {}
        for t in picked:
            row = by_cat.setdefault(t.category, {"count": 0, "total": 0})
            row["count"] += 1
            row["total"] += t.amount
        return _record("search_consumption", {"category": category, "days": days},
                       {"count": len(picked),
                        "total": sum(t.amount for t in picked),
                        "by_category": by_cat})

    @beta_tool
    def lookup_policy_document(policy_id: str) -> str:
        """정책 원문 레코드(조건·한도·금리·출처·기준일)를 그대로 조회한다.

        Args:
            policy_id: 정책 ID. 예: youth_butimok
        """
        p = policy_db.get_policy(policy_id)
        if not p:
            return json.dumps({"error": f"정책을 찾을 수 없습니다: {policy_id}"},
                              ensure_ascii=False)
        return _record("lookup_policy_document", {"policy_id": policy_id}, p)

    return [list_policies, check_policy_eligibility, calculate_feasibility,
            simulate_what_if, search_consumption, lookup_policy_document]


# ─────────────────────────────────────────────────────────────
def ask(question: str, profile: UserProfile,
        transactions: list[Transaction] | None = None,
        history: list[dict] | None = None) -> AgentAnswer:
    client = ai_client.get_client()
    if client is None:
        return AgentAnswer(text=fallback.agent_answer("AI 비활성화"), source="template")

    ctx = AgentContext(profile=profile, transactions=transactions or [])
    token = _ctx.set(ctx)
    try:
        messages = list(history or [])
        messages.append({"role": "user", "content": question})

        runner = client.beta.messages.tool_runner(
            model=MODEL,
            max_tokens=8000,
            system=ai_client.system_blocks(prompts.AGENT, with_policy_corpus=True),
            output_config={"effort": "medium"},
            tools=_build_tools(),
            messages=messages,
        )

        final = None
        for i, message in enumerate(runner):
            final = message
            if i >= MAX_TURNS:
                log.warning("에이전트 최대 턴 초과")
                break

        text = ""
        if final is not None:
            text = "".join(b.text for b in final.content if b.type == "text").strip()
        if not text:
            return AgentAnswer(text=fallback.agent_answer("빈 응답"),
                               tool_calls=ctx.tool_log, source="template")

        # ── Numeric Guard — 화이트리스트는 '도구가 반환한 모든 값' ──
        violations = guard.guard([text], ctx.tool_outputs)
        if violations:
            return AgentAnswer(
                text=fallback.agent_answer("검증 실패"), tool_calls=ctx.tool_log,
                source="template", guard_violations=violations,
            )
        return AgentAnswer(text=text, tool_calls=ctx.tool_log, source="llm")

    except Exception as e:  # noqa: BLE001
        log.warning("에이전트 실패: %s", e)
        return AgentAnswer(text=fallback.agent_answer(), tool_calls=ctx.tool_log,
                           source="template")
    finally:
        _ctx.reset(token)
