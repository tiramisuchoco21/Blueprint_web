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
from pydantic import BaseModel

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
    monthly_saving: Optional[int] = None
    target_amount: Optional[int] = None
    horizon_months: Optional[int] = None


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
    monthly_income: int = 2350000
    with_ai: bool = True


@app.post("/api/fintox")
def fintox(req: FinToxRequest) -> dict:
    """소비 분석 + 충동성 + 세션 + 목표 영향 + 정책 역추적. (A10·A11)"""
    return services.fintox(
        _profile(req.persona, req.profile),
        with_ai=req.with_ai, monthly_income=req.monthly_income,
    )


class NudgeRequest(BaseModel):
    tx_id: int
    persona: Optional[str] = "persona1"
    profile: Optional[UserProfile] = None
    monthly_income: int = 2350000


@app.post("/api/fintox/nudge")
def nudge(req: NudgeRequest) -> dict:
    """넛지 문구. 느리거나 실패해도 /api/fintox 렌더를 막지 않는다."""
    return services.nudge_for(
        req.tx_id, _profile(req.persona, req.profile), req.monthly_income
    )


# ── Tool-Use Agent: 자유질의 ─────────────────────────────────
class AskRequest(BaseModel):
    question: str
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


@app.get("/api/policies")
def policies() -> dict:
    return {"base_date": str(POLICY_BASE_DATE),
            "policies": policy_db.all_policies(),
            "benefits": policy_db.all_benefits()}
