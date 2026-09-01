# -*- coding: utf-8 -*-
"""전역 설정. 정책 수치는 여기에 넣지 않는다 (정책 DB 담당)."""
from __future__ import annotations

import os
from datetime import date
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except ImportError:  # dotenv 없이도 동작
    pass

BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parents[1]
POLICY_DIR = BASE_DIR / "data" / "policies"
FIXTURE_DIR = ROOT_DIR / "fixtures"

MODEL = os.getenv("CSJ_MODEL", "claude-opus-5")
POLICY_BASE_DATE = date.fromisoformat(os.getenv("CSJ_POLICY_BASE_DATE", "2026-09-01"))
DEMO_MODE = os.getenv("CSJ_DEMO_MODE", "0") == "1"
HAS_API_KEY = bool(os.getenv("ANTHROPIC_API_KEY"))

#: LLM을 실제로 호출할지. 둘 중 하나라도 막히면 전부 템플릿 폴백으로 동작한다.
LLM_ENABLED = HAS_API_KEY and not DEMO_MODE

CAVEAT = "실제 금액은 신청 당시 은행·보증기관·정책 기준에 따라 달라질 수 있습니다."
