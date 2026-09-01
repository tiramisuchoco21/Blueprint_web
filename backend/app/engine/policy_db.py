# -*- coding: utf-8 -*-
"""정책 DB 로더. 정책이 바뀌면 JSON 레코드만 교체하면 된다."""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from app.config import POLICY_DIR


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    path = POLICY_DIR / "policies.json"
    return json.loads(path.read_text(encoding="utf-8"))


def all_policies() -> list[dict]:
    return _load()["policies"]


def policies_for_goal(goal_type: str | None) -> list[dict]:
    if not goal_type:
        return all_policies()
    return [p for p in all_policies() if goal_type in p.get("goal_types", [])]


def get_policy(policy_id: str) -> dict | None:
    return next((p for p in all_policies() if p["policy_id"] == policy_id), None)


def all_benefits() -> list[dict]:
    return _load().get("benefits", [])


def get_benefit(benefit_id: str) -> dict | None:
    return next((b for b in all_benefits() if b["benefit_id"] == benefit_id), None)


def policy_corpus() -> str:
    """프롬프트 캐싱용 정책 원문 직렬화.

    ⚠️ 캐시는 prefix 완전일치다. sort_keys=True 로 바이트 안정성을 보장한다.
    타임스탬프·랜덤값이 섞이면 매 호출 캐시 미스가 난다.
    """
    return json.dumps(_load(), ensure_ascii=False, sort_keys=True, indent=1)
