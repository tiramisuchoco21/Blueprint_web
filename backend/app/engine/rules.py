# -*- coding: utf-8 -*-
"""Rule Engine — 정책 자격 판정.

LLM은 이 모듈을 호출할 수만 있고, 판정 결과를 만들 수는 없다.
정책이 바뀌면 policies.json 레코드만 교체하면 화면 전체 판정이 갱신된다.
"""
from __future__ import annotations

from datetime import date
from typing import Any, Optional

from app.config import POLICY_BASE_DATE
from app.engine import calculator, policy_db
from app.schemas.policy import EligibilityResult, RuleCheck
from app.schemas.profile import UserProfile


def _won(n: int | float | None) -> str:
    return f"{int(n):,}원" if n is not None else "-"


def _resolve(profile: UserProfile, field: str) -> Any:
    if field == "income_for_policy":
        return profile.income_for_policy()
    return getattr(profile, field, None)


def _apply_op(op: str, actual: Any, value: Any) -> Optional[bool]:
    """값이 없으면 None(판정 보류)을 돌려준다. False가 아니다 — 이 구분이 중요하다."""
    if actual is None:
        return None
    try:
        if op == "between":
            return value[0] <= actual <= value[1]
        if op == "lte":
            return actual <= value
        if op == "gte":
            return actual >= value
        if op == "eq":
            return actual == value
        if op == "in":
            return actual in value
        if op == "contains":
            return str(value) in str(actual)
    except TypeError:
        return None
    return None


def _required_text(op: str, value: Any) -> str:
    return {
        "between": lambda: f"{value[0]} ~ {value[1]}",
        "lte": lambda: f"{_won(value) if isinstance(value, int) and value > 1000 else value} 이하",
        "gte": lambda: f"{value} 이상",
        "eq": lambda: {True: "예", False: "아니오"}.get(value, str(value)),
        "in": lambda: " 또는 ".join(map(str, value)),
        "contains": lambda: f"'{value}' 포함",
    }.get(op, lambda: str(value))()


def _actual_text(actual: Any) -> str:
    if actual is None:
        return "미입력"
    if isinstance(actual, bool):
        return "예" if actual else "아니오"
    if isinstance(actual, int) and actual > 1000:
        return _won(actual)
    return str(actual)


def check_rule(rule: dict, profile: UserProfile) -> RuleCheck:
    actual = _resolve(profile, rule["field"])
    passed = _apply_op(rule["op"], actual, rule["value"])
    return RuleCheck(
        field=rule["field"], label=rule["label"],
        required=_required_text(rule["op"], rule["value"]),
        actual=_actual_text(actual), passed=passed, soft=rule.get("soft", False),
    )


def maturity_fit(policy: dict, profile: UserProfile) -> Optional[RuleCheck]:
    """상품 만기 ↔ 목표시점 적합성.

    '자격은 되는데 목표에 못 쓴다'를 잡아내는 축. 일반 자격 룰로는 절대 안 나온다.
    (예: 3년 만기 적금 ↔ 24개월 전세 목표)
    """
    m = policy.get("maturity_months")
    if m is None or profile.horizon_months is None:
        return None
    ok = m <= profile.horizon_months
    return RuleCheck(
        field="maturity_months",
        label=f"상품 만기 {m}개월 ≤ 목표 {profile.horizon_months}개월",
        required=f"{profile.horizon_months}개월 이하", actual=f"{m}개월",
        passed=ok, soft=True,
        note=None if ok else (
            "목표 시점에 현금화되지 않습니다. 목표자금 수단에서 제외하고 "
            "장기 자산형성용으로 별도 검토합니다."
        ),
    )


def estimate_amount(policy: dict, profile: UserProfile,
                    rate: float | None) -> tuple[Optional[int], Optional[str]]:
    """정책금융 활용 가능 예상액. '승인액'이 아니라 '상품상 최대 검토가능액'이다."""
    spec = policy.get("amount", {})
    kind = spec.get("type", "none")
    if kind == "none":
        return None, policy.get("benefit_note")

    base = _resolve(profile, spec["base_field"]) or 0
    if not base:
        return None, None

    if kind == "ratio_capped":
        ratio_amount = int(base * spec["ratio"])
        cap = spec["cap"]
        amount = min(ratio_amount, cap)
        basis = spec["basis_template"].format(
            base=_won(base), ratio_pct=f"{spec['ratio']:.0%}",
            ratio_amount=_won(ratio_amount), cap=_won(cap),
        )
        return amount, basis

    if kind == "ltv_dti_capped":
        ltv_amount = int(base * spec["ltv_max"])
        cap = spec["cap"]
        income = profile.income_for_policy() or 0
        months = policy.get("loan_months", 360)
        dti_amount = (
            calculator.dti_capped_principal(income, spec["dti_max"], rate or 0.04, months)
            if income else cap
        )
        amount = min(ltv_amount, cap, dti_amount)
        basis = spec["basis_template"].format(
            base=_won(base), ltv_pct=f"{spec['ltv_max']:.0%}", ltv_amount=_won(ltv_amount),
            dti_pct=f"{spec['dti_max']:.0%}", cap=_won(cap),
        )
        return amount, basis

    return None, None


def evaluate(policy: dict, profile: UserProfile,
             today: date | None = None) -> EligibilityResult:
    today = today or POLICY_BASE_DATE
    src = policy.get("source", {})
    common = dict(
        policy_id=policy["policy_id"], policy_name=policy["name"],
        category=policy.get("category", ""),
        source_name=src.get("name", ""), source_url=src.get("url", ""),
        updated_at=src.get("updated_at", ""),
    )

    # ── 1. 종료 여부가 최우선 ──────────────────────────────
    if policy.get("status") == "ENDED":
        return EligibilityResult(
            status="ENDED", reason=policy.get("ended_reason", "신규지원 종료"), **common
        )
    win = policy.get("apply_window") or {}
    if win.get("end") and date.fromisoformat(win["end"]) < today:
        return EligibilityResult(status="ENDED", reason="신청기간 종료", **common)
    if win.get("start") and date.fromisoformat(win["start"]) > today:
        return EligibilityResult(
            status="CONDITIONAL", reason=f"신청 시작 예정 ({win['start']})", **common
        )

    # ── 2. 조건 판정 ──────────────────────────────────────
    checks = [check_rule(r, profile) for r in policy.get("rules", [])]
    mf = maturity_fit(policy, profile)
    if mf:
        checks.append(mf)

    missing = [c.field for c in checks if c.passed is None]
    hard_fail = [c for c in checks if c.passed is False and not c.soft]
    soft_fail = [c for c in checks if c.passed is False and c.soft]

    if hard_fail:
        status = "NOT_ELIGIBLE"
        reason = " · ".join(c.label for c in hard_fail)
    elif missing:
        status, reason = "CONDITIONAL", "추가 정보 확인 필요"
    elif soft_fail:
        status = "CONDITIONAL"
        reason = soft_fail[0].note or " · ".join(c.label for c in soft_fail)
    else:
        status, reason = "ELIGIBLE", None

    # ── 3. 금액·금리 ──────────────────────────────────────
    rate_spec = policy.get("rate", {})
    terms = calculator.build_rate(rate_spec.get("build", {}), profile)
    final_rate = terms.final_rate if terms else rate_spec.get("max")
    amount, basis = (None, None)
    if status in ("ELIGIBLE", "CONDITIONAL"):
        amount, basis = estimate_amount(policy, profile, final_rate)

    return EligibilityResult(
        status=status, checks=checks, missing_fields=missing,
        estimated_amount=amount, amount_basis=basis,
        rate_min=rate_spec.get("min"), rate_max=rate_spec.get("max"),
        reason=reason, **common,
    )


def waterfall(profile: UserProfile, today: date | None = None) -> list[EligibilityResult]:
    """정책 워터폴 — Eligible / Conditional / Not Eligible / Ended 를 한 번에."""
    order = {"ELIGIBLE": 0, "CONDITIONAL": 1, "NOT_ELIGIBLE": 2, "ENDED": 3}
    results = [
        evaluate(p, profile, today) for p in policy_db.policies_for_goal(profile.goal_type)
    ]
    return sorted(results, key=lambda r: (order[r.status], -(r.estimated_amount or 0)))


def select_primary_loan(results: list[EligibilityResult]) -> EligibilityResult | None:
    """목표 자금에 실제로 대응시킬 대출성 정책 1건을 고른다.

    단순히 '한도가 가장 큰 것'을 고르면 안 된다. 우선순위:

      1. **검증된 정책 우선** — 공식 출처로 수치를 확인하지 못한(verified=false)
         정책의 한도를 대표 숫자로 내세우면 신뢰가 깨진다.
      2. ELIGIBLE > CONDITIONAL — 조건부도 포함하는 이유는, 정책금융을
         '확보 완료'가 아니라 '검토 가능 예상'으로 다루기 때문이다.
         (페르소나 2: 지금은 신청 시점이 아니지만 한도는 3.2억)
      3. 그 다음에야 금액이 큰 것.

    중복 수혜 조합 판정은 MVP 범위 밖이므로 1건만 고른다.
    """
    loans = [
        r for r in results
        if r.status in ("ELIGIBLE", "CONDITIONAL")
        and r.category in ("housing_loan", "mortgage") and r.estimated_amount
    ]
    if not loans:
        return None
    verified = {p["policy_id"] for p in policy_db.all_policies() if p.get("verified")}
    status_rank = {"ELIGIBLE": 0, "CONDITIONAL": 1}
    return min(
        loans,
        key=lambda r: (
            0 if r.policy_id in verified else 1,
            status_rank[r.status],
            -(r.estimated_amount or 0),
        ),
    )


def total_policy_capacity(results: list[EligibilityResult]) -> int:
    primary = select_primary_loan(results)
    return primary.estimated_amount or 0 if primary else 0
