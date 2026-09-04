# -*- coding: utf-8 -*-
"""FastAPI 엔트리포인트.

원칙:
  · 계산·판정 엔드포인트는 LLM 없이도 200을 반환한다.
  · AI 텍스트(넛지·에이전트)는 별도 엔드포인트로 분리해 렌더를 막지 않는다.

실행:  cd backend && uvicorn app.api.main:app --reload
"""
from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app import services
from app.ai import agent, goal_parser
from app.config import DEMO_MODE, HAS_API_KEY, LLM_ENABLED, MODEL, POLICY_BASE_DATE
from app.engine import policy_db
from app.schemas.profile import UserProfile

app = FastAPI(title="청사진 (CheongSaJin) API", version="0.1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)


def _profile(persona: Optional[str], profile: Optional[UserProfile]) -> UserProfile:
    if profile is not None:
        return profile
    personas = services.load_personas()
    if persona not in personas:
        raise HTTPException(400, f"알 수 없는 페르소나: {persona}. "
                                 f"가능: {list(personas)}")
    return personas[persona]


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": MODEL,
        "llm_enabled": LLM_ENABLED,
        "has_api_key": HAS_API_KEY,
        "demo_mode": DEMO_MODE,
        "policy_base_date": str(POLICY_BASE_DATE),
        "policies": len(policy_db.all_policies()),
        "transactions": len(services.load_transactions()),
        "note": "llm_enabled=false 여도 모든 계산·판정 엔드포인트는 정상 동작합니다.",
    }


# ── SCREEN 01: Goal Chat ────────────────────────────────────
class ChatRequest(BaseModel):
    message: str
    profile: Optional[UserProfile] = None


@app.post("/api/goal/chat")
def goal_chat(req: ChatRequest) -> dict:
    """자연어 → 프로필 추출 + 다음 질문 1개. (A1+A2)"""
    return goal_parser.parse_goal(req.message, req.profile).model_dump()


# ── SCREEN 02·03: Policy Waterfall + Blueprint ──────────────
class AnalyzeRequest(BaseModel):
    persona: Optional[str] = "persona1"
    profile: Optional[UserProfile] = None
    with_ai: bool = True


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest) -> dict:
    """정책 워터폴 + 목표 가능성 + FACT/CALC/ADVICE 설명. (룰·계산 → A3 → A4)"""
    return services.analyze(_profile(req.persona, req.profile), with_ai=req.with_ai)


# ── SCREEN 04: What-if Simulator ────────────────────────────
class SimulateRequest(BaseModel):
    persona: Optional[str] = "persona1"
    profile: Optional[UserProfile] = None
    monthly_saving: Optional[int] = Field(None, ge=0)
    target_amount: Optional[int] = Field(None, ge=0)
    horizon_months: Optional[int] = Field(None, ge=0, le=1200)


@app.post("/api/simulate")
def simulate(req: SimulateRequest) -> dict:
    """슬라이더 재계산. **LLM을 호출하지 않는다** — 즉시 응답해야 한다."""
    return services.simulate(
        _profile(req.persona, req.profile),
        monthly_saving=req.monthly_saving, target_amount=req.target_amount,
        horizon_months=req.horizon_months,
    )


# ── SCREEN 05: FinTox ───────────────────────────────────────
class FinToxRequest(BaseModel):
    persona: Optional[str] = "persona1"
    profile: Optional[UserProfile] = None
    monthly_income: int = Field(2350000, ge=0)
    with_ai: bool = True


@app.post("/api/fintox")
def fintox(req: FinToxRequest) -> dict:
    """소비 분석 + 충동성 + 세션 + 목표 영향 + 정책 역추적. (A10·A11)"""
    return services.fintox(
        _profile(req.persona, req.profile),
        with_ai=req.with_ai, monthly_income=req.monthly_income,
    )


class NudgeRequest(BaseModel):
    tx_id: int = Field(..., ge=1)
    persona: Optional[str] = "persona1"
    profile: Optional[UserProfile] = None
    monthly_income: int = Field(2350000, ge=0)


@app.post("/api/fintox/nudge")
def nudge(req: NudgeRequest) -> dict:
    """넛지 문구. 느리거나 실패해도 /api/fintox 렌더를 막지 않는다."""
    return services.nudge_for(
        req.tx_id, _profile(req.persona, req.profile), req.monthly_income
    )


# ── Tool-Use Agent: 자유질의 ─────────────────────────────────
class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    persona: Optional[str] = "persona1"
    profile: Optional[UserProfile] = None
    include_transactions: bool = True


@app.post("/api/ask")
def ask(req: AskRequest) -> dict:
    """LLM이 Rule Engine·Calculator를 **도구로 호출**해 자연어 질문에 답한다. (A9)

    응답의 tool_calls 를 UI에 노출하면 'AI가 계산하지 않는다'는 증거가 화면에 남는다.
    """
    txs = list(services.load_transactions()) if req.include_transactions else []
    return agent.ask(
        req.question, _profile(req.persona, req.profile), transactions=txs
    ).model_dump()


# ── 부채: 갚기 + 끼고 사기 ───────────────────────────────────
class DebtRequest(BaseModel):
    persona: Optional[str] = "persona1"
    profile: Optional[UserProfile] = None


@app.post("/api/debt")
def debt(req: DebtRequest) -> dict:
    """부채 전략 — 상환 배분 시나리오 + 신규 대출 후 DSR.

    '대출금을 갚는 것'과 '대출을 끼고 사는 것'을 한 응답으로 돌려준다.
    두 축은 strategy.capacity_gain_if_cleared 로 이어진다:
    부채를 갚으면 DTI 여력이 생겨 정책대출 한도가 얼마나 늘어나는가.
    """
    p = _profile(req.persona, req.profile)
    primary = None
    from app.engine import rules as _rules

    primary = _rules.select_primary_loan(_rules.waterfall(p))
    return services.debt_summary(p, primary) or {"has_debt": False}


@app.get("/api/policies")
def policies() -> dict:
    return {"base_date": str(POLICY_BASE_DATE),
            "policies": policy_db.all_policies(),
            "benefits": policy_db.all_benefits()}
