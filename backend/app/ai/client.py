# -*- coding: utf-8 -*-
"""Anthropic 클라이언트 + 공통 호출 래퍼.

- 모델은 claude-opus-5 하나로 통일한다. 컴포넌트별 튜닝은 effort로 한다.
  (모델을 나누면 프롬프트 캐시가 모델 단위로 쪼개져 오히려 비싸진다)
- thinking은 opus-5에서 기본 on이다. 끄지 말고 effort를 낮춘다.
- 시스템 프롬프트 + 정책 corpus에 cache_control을 걸어 반복 호출 비용을 줄인다.
"""
from __future__ import annotations

import logging
from typing import Any, TypeVar

from pydantic import BaseModel

from app.config import LLM_ENABLED, MODEL
from app.engine import policy_db

log = logging.getLogger("csj.ai")
T = TypeVar("T", bound=BaseModel)

_client = None


def get_client():
    """지연 생성. API 키가 없으면 None을 돌려주고 호출부가 폴백한다."""
    global _client
    if not LLM_ENABLED:
        return None
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic()
    return _client


def system_blocks(prompt: str, with_policy_corpus: bool = False) -> list[dict]:
    """캐시 가능한 시스템 블록 구성.

    ⚠️ 캐시는 prefix 완전일치다. 여기에 datetime.now()나 요청별 ID를 넣지 말 것.
       변하는 값은 messages 쪽에 둔다.
    """
    blocks: list[dict[str, Any]] = [
        {"type": "text", "text": prompt, "cache_control": {"type": "ephemeral"}}
    ]
    if with_policy_corpus:
        blocks.append({
            "type": "text",
            "text": "다음은 현재 정책 DB 전문이다. 이 안의 내용만 사실로 취급한다.\n"
                    + policy_db.policy_corpus(),
            "cache_control": {"type": "ephemeral"},
        })
    return blocks


def parse_structured(
    output_model: type[T],
    system: str,
    user_content: str,
    *,
    effort: str = "low",
    max_tokens: int = 2000,
    with_policy_corpus: bool = False,
    history: list[dict] | None = None,
) -> T | None:
    """구조화 출력 호출. 실패하면 None을 돌려주고 호출부가 폴백한다."""
    client = get_client()
    if client is None:
        return None

    messages = list(history or [])
    messages.append({"role": "user", "content": user_content})
    try:
        resp = client.messages.parse(
            model=MODEL,
            max_tokens=max_tokens,
            system=system_blocks(system, with_policy_corpus),
            output_config={"effort": effort},
            messages=messages,
            output_format=output_model,
        )
        _log_cache(resp)
        return resp.parsed_output
    except Exception as e:  # noqa: BLE001 — 어떤 실패든 폴백으로 흘린다
        log.warning("LLM 호출 실패 (%s): %s", output_model.__name__, e)
        return None


def _log_cache(resp) -> None:
    """캐시 히트 확인. 0이 계속 나오면 프롬프트에 변동값이 섞인 것이다."""
    u = getattr(resp, "usage", None)
    if u is not None:
        log.debug(
            "cache_read=%s cache_write=%s in=%s out=%s",
            getattr(u, "cache_read_input_tokens", None),
            getattr(u, "cache_creation_input_tokens", None),
            getattr(u, "input_tokens", None),
            getattr(u, "output_tokens", None),
        )
