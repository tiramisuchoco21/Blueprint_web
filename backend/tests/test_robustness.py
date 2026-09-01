# -*- coding: utf-8 -*-
"""견고성 테스트 — 페르소나 밖의 값이 들어와도 깨지지 않는지 검증한다.

골든 테스트가 '정해진 값에서 맞는가'를 본다면, 이 파일은
'아무 값이나 들어와도 터지지 않고 말이 되는가'를 본다.
"""
from __future__ import annotations

import random
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import services  # noqa: E402
from app.ai import guard  # noqa: E402
from app.engine import calculator, impulse, rules, session as session_engine, signals  # noqa: E402
from app.schemas.consumption import Transaction  # noqa: E402
from app.schemas.profile import UserProfile  # noqa: E402


# ─────────────────────────────────────────────────────────────
# 1. 빈 프로필 / 결측값
# ─────────────────────────────────────────────────────────────
def test_empty_profile_does_not_crash():
    """아무 정보도 없는 프로필로도 워터폴이 돌아야 한다."""
    p = UserProfile()
    results = rules.waterfall(p)
    assert results
    # 값이 없으면 NOT_ELIGIBLE 이 아니라 CONDITIONAL(판정 보류)이어야 한다
    active = [r for r in results if r.status != "ENDED"]
    assert all(r.status != "NOT_ELIGIBLE" for r in active)


def test_partial_profile_is_conditional_not_rejected():
    """나이만 아는 상태에서 '지원 어려움'으로 단정하면 안 된다."""
    p = UserProfile(goal_type="jeonse", age=26)
    for r in rules.waterfall(p):
        if r.status == "NOT_ELIGIBLE":
            # 미충족이 확인된 조건이 실제로 있어야만 거절할 수 있다
            assert any(c.passed is False and not c.soft for c in r.checks)


@pytest.mark.parametrize("field", [
    "target_amount", "horizon_months", "current_cash", "monthly_saving",
    "age", "annual_income", "is_homeowner",
])
def test_single_missing_field_survives(field):
    base = services.load_personas()["persona1"]
    p = base.model_copy(update={field: None})
    out = services.analyze(p, with_ai=False)
    assert "feasibility" in out and "policies" in out


# ─────────────────────────────────────────────────────────────
# 2. 극단값
# ─────────────────────────────────────────────────────────────
@pytest.mark.parametrize("field,bad", [
    ("target_amount", -100_000_000), ("horizon_months", -24),
    ("current_cash", -5_000_000), ("monthly_saving", -100_000),
    ("age", -5), ("age", 300), ("annual_income", -1),
    ("existing_debt_rate", -0.1), ("existing_debt_rate", 1.5),
    ("horizon_months", 99_999),
])
def test_negative_and_absurd_inputs_are_rejected(field, bad):
    """음수 기간이 들어와 '월 저축액 -208,333원'이 화면까지 흘러가면 안 된다.

    조용히 계산하는 대신 스키마 단계에서 거부한다.
    """
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        UserProfile(**{field: bad})


def test_zero_gap_reports_delta_not_none():
    """이미 목표를 넘겨 보유한 경우 delta_months가 None이 되면 안 된다.

    (0은 falsy라서 `if months_needed` 로 쓰면 조용히 None이 된다)
    """
    base = services.load_personas()["persona1"]
    r = services.simulate(base.model_copy(update={"current_cash": 90_000_000}),
                          monthly_saving=550_000)
    assert r["months_to_goal"] == 0
    assert r["delta_months"] == -24


def test_no_saving_capacity_is_flagged_not_sentinel():
    """저축 여력이 없을 때 999개월 센티널이 화면 숫자로 새면 안 된다."""
    base = services.load_personas()["persona1"]
    feas = calculator.feasibility(base, 80_000_000)
    gi = calculator.goal_impact(0, 100_000, 500_000, 30, feas)
    assert gi.unreachable is True
    assert gi.new_horizon_months == 0
    assert gi.d_day_shift_days == 0


def test_debt_decision_when_cash_is_insufficient():
    """상환할 현금이 없으면 음수 잔액을 내보내지 말고 별도 상태로 알린다."""
    base = services.load_personas()["persona1"]
    d = calculator.debt_decision(base.model_copy(update={
        "existing_debt": 25_000_000, "existing_debt_rate": 0.052,
    }))
    assert d.recommend == "CANNOT_REPAY"
    assert d.cash_after_repay == 0
    assert d.note


@pytest.mark.parametrize("target,horizon,cash,saving", [
    (0, 24, 6_000_000, 550_000),            # 목표 0원
    (100_000_000, 0, 6_000_000, 550_000),   # 기간 0개월
    (100_000_000, 24, 0, 0),                # 저축 0
    (100_000_000, 1, 0, 0),                 # 1개월 + 무저축
    (1, 1, 0, 0),                           # 최소값
    (50_000_000, 24, 90_000_000, 550_000),  # 이미 목표 초과 보유
    (10_000_000_000, 600, 1000, 1000),      # 100억 / 50년
    (100_000_000, 24, 6_000_000, 99_999_999),  # 비현실적 고액 저축
])
def test_extreme_feasibility_inputs(target, horizon, cash, saving):
    p = UserProfile(goal_type="jeonse", target_amount=target, horizon_months=horizon,
                    current_cash=cash, monthly_saving=saving, age=26,
                    annual_income=32_000_000, job_type="regular",
                    is_homeowner=False, is_householder=True, region="서울 마포구")
    cap = rules.total_policy_capacity(rules.waterfall(p))
    f = calculator.feasibility(p, cap)
    assert f.required_equity >= 0
    assert f.gap >= 0
    assert f.shortfall_at_horizon >= 0
    assert f.required_monthly >= 0
    assert f.verdict in ("ACHIEVABLE", "TIGHT", "NOT_ACHIEVABLE")


@pytest.mark.parametrize("saving", [0, 1, 10_000, 583_334, 5_000_000, 10**9])
def test_simulate_never_crashes(saving):
    p = services.load_personas()["persona1"]
    r = services.simulate(p, monthly_saving=saving)
    assert r["feasibility"]["verdict"]
    if saving == 0:
        assert r["months_to_goal"] is None      # 0으로 나누지 않는다


def test_simulate_is_monotonic():
    """저축을 늘리면 도달 기간이 늘어나면 안 된다."""
    p = services.load_personas()["persona1"]
    months = [services.simulate(p, monthly_saving=s)["months_to_goal"]
              for s in (300_000, 400_000, 500_000, 600_000, 800_000, 1_200_000)]
    months = [m for m in months if m is not None]
    assert months == sorted(months, reverse=True)


@pytest.mark.parametrize("rate,months", [
    (0.0, 360), (0.001, 12), (0.35, 360), (0.0355, 1), (0.0355, 600),
])
def test_monthly_payment_edge_rates(rate, months):
    m = calculator.monthly_payment(320_000_000, rate, months)
    assert m > 0
    assert m * months >= 320_000_000 * 0.99   # 원금은 갚아진다


def test_monthly_payment_zero_months():
    assert calculator.monthly_payment(100_000_000, 0.03, 0) == 0


# ─────────────────────────────────────────────────────────────
# 3. 랜덤 프로필 대량 투입
# ─────────────────────────────────────────────────────────────
def test_random_profiles_survive():
    rnd = random.Random(42)
    for _ in range(300):
        p = UserProfile(
            goal_type=rnd.choice(["jeonse", "purchase", "marriage", "lumpsum", None]),
            target_amount=rnd.choice([None, 0, 1, 10**7, 6 * 10**8, 10**10]),
            horizon_months=rnd.choice([None, 0, 1, 12, 24, 600]),
            current_cash=rnd.choice([None, 0, 10**6, 2 * 10**8]),
            monthly_saving=rnd.choice([None, 0, 5 * 10**5, 10**7]),
            existing_debt=rnd.choice([None, 0, 25_000_000]),
            existing_debt_rate=rnd.choice([None, 0.0, 0.052, 0.2, 0.99]),
            age=rnd.choice([None, 0, 18, 26, 34, 35, 120]),
            annual_income=rnd.choice([None, 0, 32_000_000, 10**9]),
            household_income=rnd.choice([None, 0, 84_000_000]),
            job_type=rnd.choice([None, "regular", "freelance", "unemployed"]),
            is_homeowner=rnd.choice([None, True, False]),
            is_householder=rnd.choice([None, True, False]),
            marital_status=rnd.choice([None, "single", "engaged", "married"]),
            months_to_marriage=rnd.choice([None, 0, 3, 12]),
            first_home_buyer=rnd.choice([None, True, False]),
            region=rnd.choice([None, "", "서울 마포구", "경기", "제주"]),
            housing_subscription_years=rnd.choice([None, 0, 6]),
            housing_subscription_count=rnd.choice([None, 0, 60]),
        )
        out = services.analyze(p, with_ai=False)
        f = out["feasibility"]
        assert f["gap"] >= 0 and f["required_equity"] >= 0
        services.simulate(p, monthly_saving=p.monthly_saving)
        calculator.debt_decision(p)


# ─────────────────────────────────────────────────────────────
# 4. 소비 데이터 변형
# ─────────────────────────────────────────────────────────────
def _tx(i, at, amount, brand="테스트", cat="food_dining", **kw):
    return Transaction(id=i, at=at, amount=amount, merchant_raw=brand,
                       brand=brand, category=cat, **kw)


def test_empty_transactions():
    assert impulse.score_all([]) == []
    assert session_engine.detect([]) == []
    assert signals.rule_signals([]) == []
    assert signals.match_benefits([], []) == []


def test_single_transaction():
    t = _tx(1, datetime(2026, 1, 1, 23, 30), 30_000)
    scores = impulse.score_all([t])
    assert len(scores) == 1
    assert scores[0].factors["burst"] == 0.0        # 직전 결제가 없다
    assert scores[0].factors["rapid_repeat"] == 0.0


def test_identical_timestamps():
    """같은 시각 결제가 여러 건이어도 터지지 않아야 한다."""
    at = datetime(2026, 1, 1, 12, 0)
    txs = [_tx(i, at, 10_000, brand=f"가맹점{i}") for i in range(1, 6)]
    scores = impulse.score_all(txs)
    assert len(scores) == 5
    sessions = session_engine.detect(txs)
    assert all(s.duration_minutes >= 1 for s in sessions)   # 0분 나누기 방지


def test_zero_and_huge_amounts():
    base = datetime(2026, 1, 1, 12, 0)
    txs = [_tx(1, base, 0), _tx(2, base + timedelta(hours=5), 10**9),
           _tx(3, base + timedelta(days=1), 1)]
    scores = impulse.score_all(txs)
    assert all(0 <= s.total <= 100 for s in scores)


def test_all_unknown_categories():
    """전부 카테고리 미상이어도 점수가 계산돼야 한다 (다만 축 2개는 죽는다)."""
    base = datetime(2026, 1, 1, 22, 0)
    txs = [_tx(i, base + timedelta(minutes=20 * i), 10_000 * i,
               brand=f"미상{i}", cat="unknown") for i in range(1, 6)]
    scores = impulse.score_all(txs)
    assert all(s.factors["deviation"] == 0.0 for s in scores)
    assert all(s.factors["discretionary"] == 0.0 for s in scores)
    assert all(0 <= s.total <= 100 for s in scores)


def test_score_bounds_on_random_transactions():
    rnd = random.Random(7)
    base = datetime(2026, 1, 1)
    cats = ["food_dining", "cafe", "unknown", "education", "telecom",
            "shopping", "transport", "health", "insurance"]
    txs = [
        _tx(i, base + timedelta(minutes=rnd.randint(0, 60 * 24 * 40)),
            rnd.choice([0, 500, 12_000, 340_000, 5_000_000]),
            brand=f"B{rnd.randint(1, 12)}", cat=rnd.choice(cats),
            is_recurring=rnd.random() < 0.1)
        for i in range(1, 201)
    ]
    for s in impulse.score_all(txs):
        assert 0 <= s.total <= 100
        assert s.band in {b for _, _, b in impulse.BANDS}
    for s in session_engine.detect(txs):
        assert 0 <= s.score <= 100
        assert s.duration_minutes >= 1


def test_fintox_endpoint_with_random_income():
    p = services.load_personas()["persona1"]
    for income in (0, 1, 2_350_000, 10**9):
        out = services.fintox(p, with_ai=False, monthly_income=income)
        gi = out["goal_impact"]
        assert gi["status"] in ("ON_TRACK", "AT_RISK")
        assert gi["projected_monthly_saving"] >= 0
        assert gi["new_horizon_months"] >= 0


# ─────────────────────────────────────────────────────────────
# 5. Numeric Guard — 오탐/미탐
# ─────────────────────────────────────────────────────────────
def test_guard_accepts_korean_number_variants():
    payload = {"a": 583_334, "b": 100_000_000, "c": 80_000_000, "d": 1_445_889}
    ok = ("목표 1억 원에서 8,000만 원을 빼면 됩니다. "
          "월 약 58만 원, 상환액은 약 145만 원입니다. 583,334원을 모으세요.")
    assert guard.check_text(ok, payload) == []


def test_guard_catches_invented_number():
    payload = {"a": 583_334, "b": 100_000_000}
    bad = "목표 1억 원이고 월 720,000원을 모으면 됩니다."
    v = guard.check_text(bad, payload)
    assert any("720,000" in x for x in v)


def test_guard_catches_forbidden_and_psych():
    payload = {"a": 100}
    assert guard.check_text("대출이 승인됩니다.", payload)
    assert guard.check_text("스트레스 때문에 쓰셨네요.", payload, forbid_psych=True)
    # forbid_psych=False 면 심리 표현은 통과해야 한다 (플래그가 실제로 작동하는지)
    assert not any("심리" in x for x in
                   guard.check_text("스트레스 때문에", payload, forbid_psych=False))


def test_guard_allows_small_integers():
    """개월수·나이·퍼센트 같은 작은 정수는 화이트리스트에 없어도 허용한다."""
    assert guard.check_text("24개월 동안 26세 기준으로 80% 적용됩니다.", {"x": 1}) == []


def test_guard_handles_empty_and_garbage():
    assert guard.check_text("", {}) == []
    assert guard.check_text("숫자가 없는 문장입니다.", {}) == []
    guard.check_text("1,,,2..3억 ...만원 %%", {"a": 1})     # 터지지 않으면 통과


# ─────────────────────────────────────────────────────────────
# 6. API 계층 — 잘못된 입력이 500이 되면 안 된다
# ─────────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from app.api.main import app

    return TestClient(app)


@pytest.mark.parametrize("path,body", [
    ("/api/analyze", {"profile": {"goal_type": "jeonse", "target_amount": -1}}),
    ("/api/analyze", {"profile": {"age": 999}}),
    ("/api/analyze", {"profile": {"existing_debt_rate": 1.5}}),
    ("/api/analyze", {"profile": {"goal_type": "우주여행"}}),
    ("/api/analyze", {"profile": {"target_amount": "일억"}}),
    ("/api/analyze", {"persona": "persona99"}),
    ("/api/analyze", {"profile": {}}),
    ("/api/simulate", {}),
    ("/api/simulate", {"persona": "persona1", "monthly_saving": -500_000}),
    ("/api/simulate", {"persona": "persona1", "horizon_months": 99_999}),
    ("/api/fintox", {"persona": "persona1", "monthly_income": -1, "with_ai": False}),
    ("/api/fintox/nudge", {"tx_id": 0}),
    ("/api/fintox/nudge", {"tx_id": 99_999}),
    ("/api/ask", {"question": "", "persona": "persona1"}),
    ("/api/ask", {"question": "가" * 20_000, "persona": "persona1"}),
])
def test_api_never_returns_500(client, path, body):
    assert client.post(path, json=body).status_code < 500


def test_negative_saving_is_rejected_not_silently_computed(client):
    """음수 저축이 통과하면 '목표 도달 -28개월'이 화면에 뜬다."""
    r = client.post("/api/simulate",
                    json={"persona": "persona1", "monthly_saving": -500_000})
    assert r.status_code == 422


def test_simulate_never_returns_negative_months(client):
    for saving in (0, 1, 1_000, 583_334, 10**9):
        r = client.post("/api/simulate",
                        json={"persona": "persona1", "monthly_saving": saving}).json()
        m = r["months_to_goal"]
        assert m is None or m >= 0
        assert r["feasibility"]["projected_cash"] >= 0


def test_profile_with_validates_unlike_model_copy():
    """model_copy 는 검증을 건너뛴다. profile_with 는 건너뛰지 않아야 한다."""
    from pydantic import ValidationError

    from app.schemas.profile import profile_with

    base = services.load_personas()["persona1"]
    assert base.model_copy(update={"monthly_saving": -999}).monthly_saving == -999
    with pytest.raises(ValidationError):
        profile_with(base, monthly_saving=-999)
