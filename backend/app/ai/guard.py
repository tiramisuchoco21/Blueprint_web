# -*- coding: utf-8 -*-
"""Numeric Guard — 설계 원칙을 **코드로 강제**하는 장치.

프롬프트에 "계산하지 마"라고 쓰는 건 요청이지 보장이 아니다.
LLM 출력에서 숫자를 뽑아, 엔진이 실제로 계산한 값에 존재하는지 대조한다.
위반이면 결정론적 템플릿으로 대체한다.

이 모듈에는 LLM이 없다. 순수 검증기다.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Iterable

log = logging.getLogger("csj.guard")

#: 금지 표현 — 프롬프트와 이 목록을 동일하게 유지한다
FORBIDDEN_PHRASES: list[str] = [
    "승인됩니다", "승인 됩니다", "승인 확정", "확정됩니다", "보장합니다", "보장됩니다",
    "100% ", "100%가", "100%로", "무조건", "반드시 됩니다", "틀림없이",
    "신용점수가 오릅니다", "점수 상승", "당첨", "최적의 상품", "추천 1위",
    "절약됩니다", "환급받습니다", "안전권",
]

#: 심리 단정 금지 (FinTox 전용) — 2세대 문서가 명시적으로 금지한 표현
FORBIDDEN_PSYCH: list[str] = [
    "스트레스", "충동적으로", "보상심리", "외로", "우울", "감정 소비", "감정소비",
    "홧김", "기분 때문", "심리적",
]

#: 숫자 + 단위 토큰
_NUM_RE = re.compile(
    r"(?<![\w.])"
    r"(?:약\s*)?"
    r"(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)"
    r"\s*(억\s*\d{1,3}(?:,\d{3})*\s*만|억|만|원|%|개월|년|일|건|회|배|점)?"
)

#: 이 이하의 정수는 항상 허용한다 (개월수·나이·퍼센트·회차·점수 등)
SMALL_INT_MAX = 1000
#: 큰 숫자는 화이트리스트와 이 오차 이내면 통과 (58만 ≈ 583,333 같은 반올림 표기)
TOLERANCE = 0.02


def walk_numbers(obj: Any) -> Iterable[float]:
    """dict/list를 재귀 순회하며 모든 수치를 뽑는다."""
    if isinstance(obj, bool):
        return
    if isinstance(obj, (int, float)):
        yield float(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from walk_numbers(v)
    elif isinstance(obj, (list, tuple)):
        for v in obj:
            yield from walk_numbers(v)


def whitelist_values(payload: Any) -> set[float]:
    """엔진이 계산한 값 + 파생 표기 허용값."""
    vals: set[float] = set()
    for n in walk_numbers(payload):
        vals.add(abs(n))
        if 0 < abs(n) < 1:          # 비율 0.80 → 80(%) 표기 허용
            vals.add(round(abs(n) * 100, 4))
    return vals


def token_to_value(num: str, unit: str | None) -> float | None:
    """'1억 9,900만' / '3.2억' / '583,000원' → 정수 값."""
    try:
        base = float(num.replace(",", ""))
    except ValueError:
        return None
    if not unit:
        return base
    unit = unit.replace(" ", "")
    if unit.startswith("억") and len(unit) > 1:          # "억 9,900만"
        man = re.sub(r"[^\d]", "", unit)
        return base * 100_000_000 + (float(man) * 10_000 if man else 0)
    return {
        "억": base * 100_000_000,
        "만": base * 10_000,
        "원": base,
        "%": base,
        "개월": base, "년": base, "일": base, "건": base, "회": base,
        "배": base, "점": base,
    }.get(unit, base)


def _allowed(value: float, allowed: set[float]) -> bool:
    if value <= SMALL_INT_MAX and float(value).is_integer():
        return True
    for a in allowed:
        if a == 0:
            continue
        if abs(value - a) / max(abs(a), 1) <= TOLERANCE:
            return True
    return value in allowed


def check_text(text: str, payload: Any, *, forbid_psych: bool = False) -> list[str]:
    """위반 목록을 돌려준다. 빈 리스트면 통과."""
    allowed = whitelist_values(payload)
    violations: list[str] = []

    for m in _NUM_RE.finditer(text):
        val = token_to_value(m.group(1), m.group(2))
        if val is None:
            continue
        if not _allowed(val, allowed):
            violations.append(f"근거 없는 숫자: '{m.group(0).strip()}'")

    for w in FORBIDDEN_PHRASES:
        if w in text:
            violations.append(f"금지 표현: '{w.strip()}'")

    if forbid_psych:
        for w in FORBIDDEN_PSYCH:
            if w in text:
                violations.append(f"심리 단정 표현: '{w}'")

    return violations


def guard(texts: list[str], payload: Any, *, forbid_psych: bool = False) -> list[str]:
    """여러 문자열을 한 번에 검사."""
    joined = "\n".join(t for t in texts if t)
    v = check_text(joined, payload, forbid_psych=forbid_psych)
    if v:
        log.warning("guard 위반 %d건: %s", len(v), v[:5])
    return v
