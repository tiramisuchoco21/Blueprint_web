# -*- coding: utf-8 -*-
"""A10 Merchant Resolver — 가맹점명 해석.

실측 근거 (실제 카드 명세 96건):
  · PG·간편결제 경유 31% — 실제 가맹점이 결제대행사 이름 뒤에 숨는다
  · 가맹점 정보 자체가 없음 7건 ("네이버페이")
  · 같은 브랜드가 6가지 표기로 분산 (올리브영)
  · 카테고리 미상 26% — 룰 사전으로 덮이지 않는다

카테고리를 모르면 충동성 점수에서 discretionary(20) + deviation(25),
**총 45점이 죽는다.** 즉 이 모듈은 '있으면 좋은 것'이 아니라 전제조건이다.

비용 관리: 배치 1회 호출 + DB 영구 캐싱. 한 번 본 가맹점은 다시 묻지 않는다.
"""
from __future__ import annotations

import json
import logging

from app.ai import client, prompts
from app.schemas.consumption import ResolvedBatch, ResolvedMerchant, Transaction

log = logging.getLogger("csj.resolver")

#: 가맹점명 → 해석 결과. 실제 서비스에서는 merchant_category 테이블로 대체한다.
_CACHE: dict[str, ResolvedMerchant] = {}

MIN_CONFIDENCE = 0.6


def cache_stats() -> dict:
    return {"cached_merchants": len(_CACHE)}


def prime_cache(items: list[ResolvedMerchant]) -> None:
    for m in items:
        _CACHE[m.merchant_raw] = m


def resolve(txs: list[Transaction]) -> tuple[list[Transaction], list[ResolvedMerchant]]:
    """category == 'unknown' 인 거래만 LLM에 배치로 물어본다.

    Returns: (카테고리가 채워진 거래 목록, 이번에 해석한 가맹점 목록)
    """
    pending = sorted({t.merchant_raw for t in txs
                      if t.category == "unknown" and t.merchant_raw not in _CACHE})
    resolved_now: list[ResolvedMerchant] = []

    if pending:
        payload = json.dumps({"merchants": pending}, ensure_ascii=False)
        batch = client.parse_structured(
            ResolvedBatch, prompts.MERCHANT_RESOLVER, payload,
            effort="low", max_tokens=4000,
        )
        if batch:
            for m in batch.merchants:
                if m.confidence < MIN_CONFIDENCE or m.needs_user_input:
                    # 확신이 낮으면 캐싱하지 않는다. 사용자에게 물어야 한다.
                    log.info("해석 보류: %s (conf=%.2f)", m.merchant_raw, m.confidence)
                    _CACHE[m.merchant_raw] = m      # needs_user_input 상태로 기억
                    resolved_now.append(m)
                    continue
                _CACHE[m.merchant_raw] = m
                resolved_now.append(m)

    for t in txs:
        hit = _CACHE.get(t.merchant_raw)
        if not hit or hit.needs_user_input or hit.confidence < MIN_CONFIDENCE:
            continue
        if t.category == "unknown":
            t.category = hit.category
            t.brand = hit.brand or t.brand
            t.is_recurring = t.is_recurring or hit.is_recurring_likely
            t.resolved_by = "llm"
            t.resolve_confidence = hit.confidence

    return txs, resolved_now


def unresolved(txs: list[Transaction]) -> list[dict]:
    """사용자에게 되물어야 하는 목록. '모를 때 모른다고 하는' UX의 재료."""
    out: dict[str, dict] = {}
    for t in txs:
        if t.category != "unknown":
            continue
        hit = _CACHE.get(t.merchant_raw)
        row = out.setdefault(t.merchant_raw, {
            "merchant_raw": t.merchant_raw, "count": 0, "total": 0,
            "reason": (hit.reason if hit else "") or "가맹점 정보가 부족합니다",
        })
        row["count"] += 1
        row["total"] += t.amount
    return sorted(out.values(), key=lambda r: -r["total"])
