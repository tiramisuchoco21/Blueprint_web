# -*- coding: utf-8 -*-
"""AI 설명 출력 — FACT / CALCULATION / AI ADVICE 3층 분리 (Trust Architecture)."""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class ExplainPacket(BaseModel):
    """UI는 이 세 필드를 각각 다른 배경색 카드로 렌더한다."""

    fact: list[str] = Field(
        default_factory=list, description="정책 DB 원문 기반 조건. 창작 금지"
    )
    calculation: list[str] = Field(
        default_factory=list, description="계산 결과 서술. 새 숫자 생성 금지"
    )
    advice: str = Field("", description="목표 관점 해석 1~3문장")
    caveat: str = Field("", description="고정 고지 문구")

    # 아래는 LLM이 채우지 않는다 (서버가 주입)
    source: Literal["llm", "template"] = "llm"
    guard_violations: list[str] = Field(default_factory=list)


class ToolCallLog(BaseModel):
    """에이전트가 어떤 엔진을 호출했는지 — 화면에 노출해 '계산 안 함'을 증명한다."""

    name: str
    input: dict
    output_digest: str


class AgentAnswer(BaseModel):
    text: str
    tool_calls: list[ToolCallLog] = Field(default_factory=list)
    source: Literal["llm", "template"] = "llm"
    guard_violations: list[str] = Field(default_factory=list)


class NudgeMessage(BaseModel):
    text: str
    source: Literal["llm", "template"] = "llm"
    cta_label: Optional[str] = None
    cta_amount: Optional[int] = None
