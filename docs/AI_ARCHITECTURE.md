# 청사진(CheongSaJin) — AI 레이어 설계서

## 문서 구성

| 문서 | 다루는 것 |
|---|---|
| **AI_ARCHITECTURE.md** (이 문서) | AI 컴포넌트 전체 목록, 데이터 계약, 프롬프트, Numeric Guard |
| [CALC_ENGINE.md](CALC_ENGINE.md) | 계산·판정 엔진 명세 (비-AI). **문서 3세대 충돌 정리 포함** |
| [AI_FINTOX.md](AI_FINTOX.md) | 문자 기반 소비분석 상세 |

## 입력 자료의 우선순위

| 세대 | 문서 | 취급 |
|---|---|---|
| 2세대 | `청사진_MVP_설계서_최종본.pdf`, `청사진_페르소나1_2_최종수정본.pdf` | ✅ **단일 진실원천** |
| 1세대 | `초안.pdf`, `시나리오 1탄.pdf`, `시나리오 페르소나 2.pdf` | ⚠️ 배경 이해용. **일부는 의도적으로 폐기됨** |

> 1세대의 **"LLM이 감정 소비를 판별하고 확률 85%를 제시"**는 2세대에서 명시적으로 금지됐다. 1세대 HTML 프로토타입에 해당 UI가 남아 있으니 재사용 시 반드시 교체할 것. 상세는 [CALC_ENGINE.md §0](CALC_ENGINE.md).

## 구현 전제

- **웹 데이터는 더미로 간다** (MVP 범위 결정). 실제 문자 수집·마이데이터 연동 없음.
  → 파싱 폴백(A6-④)과 카테고리 추론(A6-⑥) LLM이 **사실상 불필요해진다.** 상세는 [AI_FINTOX.md §0](AI_FINTOX.md).
- 스택: Next.js + FastAPI + Pydantic (MVP 설계서 p.12)

---

## 0. 결론부터: AI는 "4개"만 필요하다

설계서의 핵심 원칙이 **"LLM은 이해·설명을 담당하고, 자격판정과 금융계산은 Rule Engine / Calculator가 담당한다"**(p.4, p.12)이다.
이 원칙을 지키면 AI가 담당할 영역은 아래 4가지로 줄어든다.

| # | AI 컴포넌트 | 하는 일 | 우선순위 |
|---|---|---|---|
| **A1** | **Goal Parser** | 자연어 목표 → `UserProfile` JSON | **P0 (필수)** |
| **A2** | **Slot Filler** | 부족한 필드 1개를 골라 질문 생성 | **P0 (필수)** |
| **A3** | **Explainer** | 판정/계산 결과 JSON → 자연어 설명 (FACT/CALC/ADVICE) | **P0 (필수)** |
| **A4** | **Numeric Guard** | LLM 출력에 계산 안 된 숫자가 섞였는지 검증 | **P0 (필수, 비-LLM)** |
| A5 | Alternative Writer | Plan A / Plan B 서술 (후보 생성은 Solver) | P1 |
| A6 | Tx Parser + Prescription | 결제문자 파싱 / 넛지 문구 (FinTox) | P1 |
| A7 | Policy RAG | 정책 원문 근거 인용 | P1 (MVP는 벡터DB 불필요) |
| A8 | Credit Build Writer | 비금융 신용 제출 안내문 (페르소나1 Step4) | **P2 권고** |

> **더미데이터 전제에서 A6는 ⑪ 넛지 문구만 남는다.** 파싱·카테고리 추론 LLM은 더미가 커버하므로 인터페이스만 비워두고 "확장 시 붙는 지점"으로 발표한다. → 실질 AI 컴포넌트는 **A1·A2·A3·A5 + 넛지 = 5개**, 검증은 A4.

### ❌ AI가 담당하면 안 되는 것 (심사에서 무너지는 지점)

| 기능 | 잘못된 구현 | 올바른 구현 |
|---|---|---|
| 정책 자격 판정 | LLM에게 "이 사람 버팀목 되나요?" 질문 | `rules.py` 순수 함수, 조건별 pass/fail 배열 반환 |
| 자기자본·부족액·월저축 계산 | LLM이 "1억 × 80% = 8천만" 생성 | `calculator.py`, Decimal 연산 |
| 슬라이더 재계산 | LLM 호출 | 프론트 순수 함수 (0ms) |
| FinTox 점수 | LLM에게 "위험도 점수 매겨줘" | 명시적 가중치 룰 (p.10). **HABIT/BUDGET 2개 모드** |
| 정책 종료 여부 | LLM 기억에 의존 | DB `status` + `updated_at` 컬럼 |
| 신용대출 상환 판단 | LLM에게 "갚는 게 나을까?" | `scenarios.py` — DTI·필요현금 계산 후 룰이 결정 |
| 상품 만기 vs 목표시점 | LLM 판단 | `maturity_fit()` 룰 (청년미래적금 케이스) |
| 감정·심리 상태 | **1세대 문서의 "스트레스성 소비 85%"** | ❌ **금지.** 관측 가능한 행동 지표만 |

> **한 줄 원칙:** 화면에 뜨는 숫자 중 LLM이 만든 숫자는 **0개**여야 한다.

---

## 1. 전체 파이프라인

```
[사용자 자연어]
      │
      ▼
┌─────────────────────┐
│ A1 Goal Parser      │  LLM + structured output(JSON Schema)
│ A2 Slot Filler      │  → UserProfile JSON
└─────────┬───────────┘
          │  (필수 슬롯 미충족 시 A2가 질문 1개 반환 → 루프)
          ▼
┌─────────────────────┐
│ Rule Engine         │  ❌ LLM 아님. 순수 Python
│  policy_db(10~15건) │  → EligibilityResult[]  (Eligible/Conditional/NotEligible/Ended)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ Financial Calculator│  ❌ LLM 아님. Decimal
│                     │  → FeasibilityResult (자기자본/부족액/월저축/D-Day)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ A3 Explainer        │  LLM. 숫자는 "이미 계산된 값"만 인용
│ A5 Alternative      │  → ExplainPacket (fact/calc/advice 분리)
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ A4 Numeric Guard    │  ❌ LLM 아님. 정규식 + 화이트리스트
│                     │  위반 시 재시도 1회 → 실패 시 템플릿 폴백
└─────────┬───────────┘
          ▼
      [UI 렌더링]
```

**중요:** Rule Engine과 Calculator는 LLM 파이프라인의 *가운데*에 있다. LLM → 계산 → LLM 순서(sandwich). LLM이 계산 결과를 만드는 게 아니라 **받아서 해석**한다.

---

## 2. 데이터 계약 (모든 AI 호출의 입출력 스키마)

AI 레이어 전체가 이 4개 타입만 주고받는다. Pydantic으로 정의하면 그대로 structured output 스키마가 된다.

### 2.1 `UserProfile` — A1의 출력 = Rule Engine의 입력

```python
# app/schemas/profile.py
from pydantic import BaseModel, Field
from typing import Literal, Optional

class UserProfile(BaseModel):
    # --- 목표 (Goal Chat에서 추출) ---
    goal_type: Optional[Literal["jeonse", "purchase", "marriage", "lumpsum"]] = None
    target_amount: Optional[int] = Field(None, description="목표금액(원). '1억'→100000000")
    horizon_months: Optional[int] = Field(None, description="목표까지 개월수. '2년 뒤'→24")
    region: Optional[str] = Field(None, description="시군구 단위. '마포'→'서울 마포구'")

    # --- 현재 재무 ---
    current_cash: Optional[int] = None          # 현금·예적금
    monthly_saving: Optional[int] = None
    existing_debt: Optional[int] = None

    # --- 정책 판정용 (Rule Engine이 요구하는 필드) ---
    age: Optional[int] = None
    annual_income: Optional[int] = Field(None, description="세전 연소득(원)")
    job_type: Optional[Literal["regular", "contract", "freelance", "student", "unemployed"]] = None
    is_homeowner: Optional[bool] = None
    household_size: Optional[int] = None
    marital_status: Optional[Literal["single", "engaged", "married"]] = None
    household_income: Optional[int] = Field(None, description="부부합산 연소득")
```

> `Optional` + `None` 기본값이 **슬롯 필링의 근거**다. Rule Engine이 "이 필드 없으면 판정 불가"라고 선언한 목록과 대조해서 A2가 질문을 만든다. → **정책이 슬롯을 결정한다(policy-driven slot filling)**. LLM이 "뭘 더 물어볼까?" 자유 판단하지 않는다.

### 2.2 `EligibilityResult` — Rule Engine 출력

```python
class RuleCheck(BaseModel):
    field: str            # "age"
    label: str            # "만 19~34세"
    required: str         # "<= 34"
    actual: str           # "26"
    passed: bool

class EligibilityResult(BaseModel):
    policy_id: str
    policy_name: str
    status: Literal["ELIGIBLE", "CONDITIONAL", "NOT_ELIGIBLE", "ENDED"]
    checks: list[RuleCheck]            # "왜 가능한가요?" 펼침 내용
    estimated_amount: Optional[int]    # 정책금융 활용가능 예상액
    amount_basis: Optional[str]        # "보증금 1억 × 80% vs 상품한도 1.5억 중 min"
    source_name: str                   # "주택도시기금"
    source_url: str
    updated_at: str                    # "2026-09-01"
    missing_fields: list[str] = []     # CONDITIONAL 사유
```

### 2.3 `FeasibilityResult` — Calculator 출력 (= 숫자 화이트리스트의 원천)

```python
class FeasibilityResult(BaseModel):
    target_amount: int          # 100_000_000
    policy_capacity: int        #  80_000_000
    required_equity: int        #  20_000_000
    current_cash: int           #   6_000_000
    gap: int                    #  14_000_000
    horizon_months: int         #  24
    required_monthly: int       #     583_000
    verdict: Literal["ACHIEVABLE", "TIGHT", "NOT_ACHIEVABLE"]
    d_day: int
```

### 2.4 `ExplainPacket` — A3의 출력 (= 화면 렌더 단위)

```python
class ExplainPacket(BaseModel):
    fact: list[str]      # 정책 원문 근거 (DB 인용, LLM 창작 금지)
    calculation: list[str]  # 계산식 서술 (숫자는 FeasibilityResult 값만)
    advice: str          # 목표 관점 해석 1~3문장
    caveat: str          # 고정 문구
```

UI는 이 3개 필드를 **각각 다른 배경색 카드**로 렌더한다 → 설계서 p.6 Trust Architecture가 자동으로 화면에 구현된다.

---

## 3. AI 컴포넌트 상세

### A1 + A2 — Goal Parser & Slot Filler (한 번의 호출로 통합)

**왜 통합하나:** 파싱과 "다음 질문"은 같은 컨텍스트를 본다. 두 번 호출하면 지연 2배 + 비용 2배.

```python
# app/ai/goal_parser.py
import anthropic
from app.schemas.profile import UserProfile
from pydantic import BaseModel
from typing import Optional

client = anthropic.Anthropic()

class GoalParseResult(BaseModel):
    profile: UserProfile
    next_question: Optional[str]   # 부족 필드 있으면 질문 1개, 없으면 None
    asking_field: Optional[str]    # 이번에 묻는 필드명 (UI 칩 하이라이트용)
    ready_for_analysis: bool

SYSTEM = """당신은 한국 정책금융 상담 AI PB '청사진'의 정보 수집 담당이다.

역할:
1. 사용자 발화에서 재무목표와 프로필 정보를 추출해 구조화한다.
2. 정책 판정에 필요한데 아직 없는 정보가 있으면, 딱 한 개만 자연스럽게 되묻는다.

절대 하지 않는 일:
- 정책 자격 여부를 판단하거나 언급하지 않는다.
- 대출 한도, 금리, 지원금액을 추정하거나 말하지 않는다.
- 어떤 금액도 계산하지 않는다. (예: "그러면 8천만 원 정도 나올 것 같네요" 금지)
- 확인되지 않은 값을 추측해서 채우지 않는다. 모르면 null로 둔다.

추출 규칙:
- "1억" → 100000000, "3200만" → 32000000 (원 단위 정수)
- "2년 뒤" → horizon_months=24, "내년 봄" → 12
- "마포" → "서울 마포구" (시군구 단위로 정규화)
- 나이는 만 나이. 언급이 없으면 null.

질문 규칙:
- 한 번에 한 개 필드만 묻는다. 목록으로 나열하지 않는다.
- 왜 필요한지 짧게 붙인다. ("정책 나이 기준을 확인해야 해서요")
- 이미 답한 것을 다시 묻지 않는다.
"""

def parse_goal(history: list[dict], missing_required: list[str]) -> GoalParseResult:
    resp = client.messages.parse(
        model="claude-opus-5",
        max_tokens=2000,
        system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        output_config={"effort": "low"},   # 추출 작업 — 깊은 추론 불필요
        messages=history + [{
            "role": "user",
            "content": f"[시스템 참고] 정책 판정에 아직 부족한 필드: {missing_required}",
        }],
        output_format=GoalParseResult,
    )
    return resp.parsed_output
```

**`missing_required`는 코드가 계산한다:**

```python
# app/engine/slots.py
REQUIRED_BY_GOAL = {
    "jeonse":   ["target_amount", "horizon_months", "region",
                 "current_cash", "age", "annual_income", "job_type", "is_homeowner"],
    "purchase": ["target_amount", "horizon_months", "region", "current_cash",
                 "household_income", "is_homeowner", "marital_status"],
}

def missing_fields(p: UserProfile) -> list[str]:
    if not p.goal_type:
        return ["goal_type"]
    return [f for f in REQUIRED_BY_GOAL[p.goal_type] if getattr(p, f) is None]
```

→ **슬롯 목록이 Rule Engine에서 나오므로**, 정책을 추가해도 질문 로직을 손댈 필요가 없다.

---

### A3 — Explainer (가장 중요한 프롬프트)

입력은 **이미 확정된 JSON**. LLM은 서술만 한다.

```python
# app/ai/explainer.py
EXPLAINER_SYSTEM = """당신은 '청사진'의 설명 담당 AI PB다.
계산과 자격 판정은 이미 끝났다. 당신은 결과를 사용자 목표 관점에서 해석만 한다.

## 절대 규칙
1. 입력 JSON에 없는 숫자를 절대 쓰지 마라. 어림수(약 6천만, 대략 1억)도 금지다.
   금액을 언급하려면 반드시 입력 JSON에 그대로 있는 값이어야 한다.
2. 직접 계산하지 마라. 덧셈·뺄셈·비율 계산 결과를 새로 쓰지 마라.
3. 다음 표현을 쓰지 마라:
   "승인", "확정", "보장", "100%", "무조건", "반드시 됩니다",
   "신용점수가 오릅니다", "이자를 아낄 수 있습니다(확정형)"
4. 대출은 항상 "상품상 최대한도 / 1차 자격검토 / 예상 가능범위"로 표현한다.
5. 확정적 미래 예측 대신 조건부로 쓴다. ("현재 입력 기준으로는")

## 출력 구조
- fact: 정책 DB에서 온 조건 원문. 입력의 policy.checks / amount_basis 문구를 인용한다. 창작 금지.
- calculation: 입력 숫자들을 잇는 서술. (예: "목표 1억에서 정책금융 검토 가능액 8,000만 원을 빼면
  자기자본 2,000만 원이 필요합니다") 새 숫자 생성 금지.
- advice: 목표 관점 해석 1~3문장. 사용자가 다음에 무엇을 봐야 하는지.
- caveat: 아래 문구를 그대로 출력.
  "실제 금액은 신청 당시 은행·보증기관·정책 기준에 따라 달라질 수 있습니다."

## 톤
20~30대 사용자 대상. 존댓말, 담백하게. 과장·감탄사 없이.
"""

def explain(feasibility: FeasibilityResult, policies: list[EligibilityResult]) -> ExplainPacket:
    payload = {
        "feasibility": feasibility.model_dump(),
        "policies": [p.model_dump() for p in policies],
    }
    resp = client.messages.parse(
        model="claude-opus-5",
        max_tokens=2000,
        system=[{"type": "text", "text": EXPLAINER_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
        output_format=ExplainPacket,
    )
    return numeric_guard(resp.parsed_output, payload)   # ← A4
```

---

### A4 — Numeric Guard (설계서 원칙을 **강제**하는 장치)

프롬프트로 "계산하지 마"라고 쓰는 건 요청이지 보장이 아니다. **코드로 막아야** 심사위원 질문에 답이 된다.

```python
# app/ai/guard.py
import re

FORBIDDEN = ["승인", "확정", "보장", "100%", "무조건", "반드시 됩니다", "점수가 오릅니다"]

def _allowed_number_strings(payload: dict) -> set[str]:
    """계산 결과에 실제로 존재하는 숫자의 모든 한국식 표기 변형"""
    allowed = set()
    for n in _walk_numbers(payload):
        allowed |= {
            str(n),                      # 100000000
            f"{n:,}",                    # 100,000,000
            *_korean_forms(n),           # "1억", "8,000만", "583,000"
        }
    allowed |= {str(i) for i in range(0, 101)}   # 퍼센트·개월수 등 소수 정수 허용
    return allowed

NUM_RE = re.compile(r"[\d][\d,]*\s*(?:억|만|원|%|개월|년)?")

def numeric_guard(packet: ExplainPacket, payload: dict) -> ExplainPacket:
    allowed = _allowed_number_strings(payload)
    text = " ".join(packet.fact + packet.calculation + [packet.advice])

    violations = [m.group() for m in NUM_RE.finditer(text)
                  if _normalize(m.group()) not in allowed]
    banned = [w for w in FORBIDDEN if w in text]

    if violations or banned:
        log.warning("guard_violation", extra={"nums": violations, "words": banned})
        return template_fallback(payload)      # ← 결정론적 템플릿으로 대체
    return packet
```

**폴백 템플릿** (LLM 없이도 화면이 완성되는 안전망 — 시연 중 네트워크 장애 대비도 겸함):

```python
def template_fallback(p: dict) -> ExplainPacket:
    f = p["feasibility"]
    return ExplainPacket(
        fact=[f"{pol['policy_name']}: {pol['amount_basis']}" for pol in p["policies"]
              if pol["status"] == "ELIGIBLE"],
        calculation=[
            f"목표 {won(f['target_amount'])} − 정책금융 검토 가능액 {won(f['policy_capacity'])}"
            f" = 자기자본 {won(f['required_equity'])}",
            f"자기자본 {won(f['required_equity'])} − 현재 보유 {won(f['current_cash'])}"
            f" = 추가 필요 {won(f['gap'])}",
            f"추가 필요 {won(f['gap'])} ÷ {f['horizon_months']}개월"
            f" = 월 {won(f['required_monthly'])}",
        ],
        advice=ADVICE_BY_VERDICT[f["verdict"]],
        caveat=CAVEAT,
    )
```

> 이 Guard 하나가 **USP 05 (Trust Architecture)의 실물 증거**다. 발표에서 "프롬프트로 부탁한 게 아니라 코드로 차단합니다"라고 말할 수 있는 지점.

---

### A5 — Alternative Writer (Plan A / Plan B, 페르소나 2)

설계서 p.9의 "불가능 판정이 차별점". **대안 후보는 Solver가 역산하고, LLM은 서술만 한다.**

```python
# app/engine/solver.py  ← ❌ LLM 아님
def plan_a(profile, target_months) -> dict:
    """기간 고정 → 감당 가능한 목표금액 역산 (6억 → 4.8~5.0억)"""
    affordable = profile.expected_cash + policy_capacity(profile)
    return {"kind": "KEEP_HORIZON", "adjusted_target": floor_to(affordable, 10_000_000)}

def plan_b(profile, target_amount) -> dict:
    """금액 고정 → 필요한 추가기간/추가자본 역산"""
    gap = target_amount - (profile.expected_cash + policy_capacity(profile))
    return {"kind": "KEEP_TARGET",
            "extra_capital": gap,
            "extra_months": ceil(gap / profile.monthly_saving)}
```

LLM은 이 dict를 받아 한 문단씩 쓴다. A3와 같은 프롬프트/Guard를 재사용.

---

### A6 — FinTox Transaction Parser (P1)

```
[신한체크승인] 09/01 23:40 배달의민족 34,000원
```

**LLM 먼저 쓰지 마라. 3단계 폴백:**

1. **정규식** — 카드사 문자 포맷은 정형적이다. 6개 카드사 패턴이면 90%+ 커버. 0ms, 0원.
2. **가맹점명 → 카테고리 사전** — 로컬 dict + 부분일치.
3. **LLM 폴백** — 1·2가 실패한 것만. `effort: "low"`, structured output.

```python
class Transaction(BaseModel):
    merchant: str
    amount: int
    at: datetime
    category: Literal["food_delivery","cafe","transport","shopping","entertainment","other"]
    channel: Literal["card","transfer","auto_debit"]
```

**FinTox 점수는 100% 룰이다** (설계서 p.10이 명시적으로 요구):

```python
# app/engine/fintox.py  ← ❌ LLM 아님
WEIGHTS = {
    "late_night":       15,   # 22:00~04:00 결제
    "above_avg":        25,   # 최근 4주 동일 카테고리 평균 대비 초과율
    "budget_burn":      30,   # 이번 달 예산 소진율
    "repeat_count":     15,   # 동일 가맹점 7일 내 반복
    "goal_ratio":       15,   # 월 목표저축액 대비 비중
}
```

> "스트레스성 소비 확률 85%" 같은 심리 단정은 금지(p.10). 점수의 **각 항목 기여도를 UI에 그대로 노출**하면 설명가능성이 확보된다.

LLM은 **넛지 문구 1줄**만 쓴다. 혜택 매칭(K-패스·지역화폐)은 `region` + `category` 기준 룰 조회.

---

### A7 — Policy RAG: **MVP에서는 벡터 DB를 만들지 마라**

설계서는 정책 10~15개만 정확히 구현하라고 한다(p.13). 이 규모면:

| 방식 | 정확도 | 구축비용 | MVP 적합 |
|---|---|---|---|
| 벡터DB(pgvector) + 임베딩 검색 | 검색 누락 리스크 | 높음 | ❌ |
| **정책 원문 전체를 캐시된 시스템 블록에 삽입** | **100% (누락 불가)** | **거의 0** | ✅ |

15개 정책 원문 ≈ 8,000~15,000 토큰. Claude Opus 5의 컨텍스트는 1M이므로 **전량 삽입이 가능하고, 프롬프트 캐싱을 걸면 반복 호출 비용이 급감한다.**

```python
POLICY_CORPUS = load_policy_texts()   # 정렬된 순서로 직렬화 — 바이트 안정성 필수

system = [
    {"type": "text", "text": EXPLAINER_SYSTEM},
    {"type": "text", "text": POLICY_CORPUS, "cache_control": {"type": "ephemeral"}},
]
```

⚠️ 캐시는 **prefix 완전일치**다. 정책 corpus 직렬화에 `datetime.now()`, `dict` 순회 순서, 랜덤 ID가 섞이면 매번 캐시 미스가 난다. `json.dumps(..., sort_keys=True)` 고정. 검증은 응답의 `usage.cache_read_input_tokens`가 0이 아닌지 확인.

> 벡터 검색은 P2(전국 정책 확장) 시점에 도입.

---

## 4. Policy DB — Rule DSL 설계

설계서 p.13의 Policy Record를 **Rule Engine이 자동 순회할 수 있는 형태**로 확장한다. 정책 추가 시 코드를 안 고치는 게 목표.

```jsonc
{
  "policy_id": "youth_butimok",
  "name": "청년전용 버팀목전세자금",
  "category": "housing_loan",
  "status": "ACTIVE",                       // ACTIVE | ENDED
  "apply_window": { "start": null, "end": null },   // 상시
  "source": { "name": "주택도시기금", "url": "https://nhuf.molit.go.kr/...",
              "updated_at": "2026-09-01" },

  "rules": [
    { "field": "age",          "op": "between", "value": [19, 34],
      "label": "만 19~34세" },
    { "field": "annual_income","op": "lte",     "value": 50000000,
      "label": "연소득 5,000만 원 이하" },
    { "field": "is_homeowner", "op": "eq",      "value": false,
      "label": "무주택 세대주" },
    { "field": "target_amount","op": "lte",     "value": 300000000,
      "label": "보증금 3억 원 이하", "soft": true }   // soft=true → 미충족 시 CONDITIONAL
  ],

  "amount": {
    "formula": "min(target_amount * deposit_ratio_limit, max_loan)",
    "deposit_ratio_limit": 0.80,
    "max_loan": 150000000,
    "basis_template": "보증금 {target_amount} × {deposit_ratio_limit} vs 상품한도 {max_loan} 중 작은 값"
  }
}
```

**Rule Engine 판정 로직 (전부 코드, ~60줄):**

```python
def evaluate(policy: dict, p: UserProfile) -> EligibilityResult:
    if policy["status"] == "ENDED":                     return _ended(policy)
    if _outside_window(policy, today()):                return _ended(policy)

    checks = [_check(r, p) for r in policy["rules"]]
    if any(c is None for c in checks):                  # 값이 없어 판정 불가
        return _conditional(policy, checks, reason="MISSING_INPUT")
    if all(c.passed for c in checks):                   status = "ELIGIBLE"
    elif all(c.passed for c in checks if not c.soft):   status = "CONDITIONAL"
    else:                                               status = "NOT_ELIGIBLE"
    ...
```

→ 정책이 바뀌면 **JSON 레코드만 교체**하면 화면 전체 판정이 갱신된다(설계서 p.6 요구사항 그대로).

---

## 5. 모델 선택 · 비용 · 지연

### 모델

전 컴포넌트 **`claude-opus-5`** 하나로 통일하고, 컴포넌트별 튜닝은 `effort`로 한다. 모델을 나누면 프롬프트 캐시가 모델 단위로 쪼개져서 오히려 비싸진다.

| 컴포넌트 | effort | max_tokens | 목표 지연 |
|---|---|---|---|
| A1/A2 Goal Parser | `low` | 2,000 | < 2s |
| A3 Explainer | `low` | 2,000 | < 3s (스트리밍) |
| A5 Alternative | `medium` | 3,000 | < 4s |
| A6 Tx Parser | `low` | 500 | < 1s |

> Opus 5는 thinking이 기본 on이다. `thinking`을 끄지 말고 `effort`를 낮춰라 — 끄면 tool call이 본문 텍스트로 새는 실패 모드가 있다.

### 비용 (실측 기준 대략치, Opus 5 = 입력 $5 / 출력 $25 per MTok)

- 시연 1회 풀코스(페르소나 2명, LLM 호출 ~10회): 입력 ~80K + 출력 ~6K → **약 $0.5** (캐시 적용 시 그보다 크게 낮음)
- 개발 중 반복 테스트 500회 → **$50~250 수준**

공모전 MVP 규모에서 모델 비용은 병목이 아니다. **캐시 히트만 확인**하면 된다.

### 지연 — What-if Simulator는 LLM을 부르면 안 된다

설계서 p.8의 핵심 시연은 "슬라이더를 58만 → 70만으로 움직이는 순간" D-Day가 바뀌는 장면이다. 여기서 LLM 호출은 치명적이다.

```
슬라이더 onChange
   ├─ 즉시(0ms): 프론트 순수 함수로 D-Day / 부족액 / 상태배지 재계산  ← 필수
   └─ debounce 600ms 후: A3 Explainer 호출로 "AI 인사이트" 한 줄만 갱신  ← 선택
```

발표 안정성을 위해 **페르소나 2명의 슬라이더 구간별 인사이트 문구를 사전 생성해 JSON으로 캐싱**해 두는 것을 권장한다. 시연 중 네트워크 문제와 무관해진다.

---

## 6. 시연 안전장치 (공모전 150초)

| 리스크 | 대비 |
|---|---|
| 네트워크/API 장애 | `DEMO_MODE=1` → 페르소나 1·2 응답을 `fixtures/*.json`에서 재생 |
| LLM이 이상한 숫자 생성 | A4 Numeric Guard → 템플릿 폴백 (화면은 항상 정상) |
| 응답 지연 | 스트리밍 + 스켈레톤 UI, 계산 결과는 LLM 대기 없이 먼저 렌더 |
| 심사위원 "AI가 틀리면?" | 화면의 FACT/CALC/ADVICE 분리 + Guard 코드 시연 |

**렌더 순서를 지켜라:** 숫자·배지·게이지는 계산이 끝나는 즉시 그린다. LLM 텍스트는 나중에 채워 넣는다. 이러면 LLM이 느리거나 실패해도 시연은 진행된다.

---

## 7. 파일 구조

```
backend/
├── app/
│   ├── ai/                      # ── LLM 담당 영역
│   │   ├── client.py            #    Anthropic 클라이언트 + 캐시 헤더
│   │   ├── goal_parser.py       #    A1 + A2
│   │   ├── explainer.py         #    A3
│   │   ├── alternative.py       #    A5
│   │   ├── tx_parser.py         #    A6
│   │   ├── guard.py             #    A4 Numeric Guard  ★
│   │   ├── fallback.py          #    템플릿 폴백
│   │   └── prompts/             #    시스템 프롬프트 (버전 관리)
│   ├── engine/                  # ── ❌ LLM 절대 금지 영역
│   │   ├── rules.py             #    Rule Engine
│   │   ├── calculator.py        #    금융 계산 (Decimal)
│   │   ├── solver.py            #    Plan A/B 역산
│   │   ├── fintox.py            #    소비위험 점수
│   │   └── slots.py             #    필수 슬롯 정의
│   ├── data/policies/*.json     #    정책 10~15건
│   ├── schemas/                 #    Pydantic 계약
│   └── api/                     #    FastAPI 라우터
└── fixtures/                    #    시연용 고정 응답
```

> `ai/`와 `engine/` 디렉토리 분리 자체가 발표 자료가 된다. "저희는 AI가 계산하는 코드가 물리적으로 존재하지 않습니다."

---

## 8. 구현 순서

| 순서 | 작업 | 산출물 | AI 관여 |
|---|---|---|---|
| 1 | `schemas/` 4개 타입 확정 | Pydantic | — |
| 2 | 정책 JSON 10~15건 수기 작성 | `data/policies/` | — |
| 3 | `engine/rules.py` + `calculator.py` | 판정·계산 | — |
| 4 | 페르소나 1·2 골든 케이스 테스트 | pytest | — |
| 5 | **A1/A2 Goal Parser** | Goal Chat 동작 | ✅ |
| 6 | **A3 Explainer + A4 Guard** | Blueprint 화면 | ✅ |
| 7 | 프론트 슬라이더 (순수 함수) | Simulator | — |
| 8 | A5 Plan A/B | 페르소나 2 | ✅ |
| 9 | fixtures 캐싱 + DEMO_MODE | 시연 안정화 | — |
| 10 | A6 FinTox / Timeline | P1 | ✅ |

**3·4번(엔진 + 골든 테스트)을 5번보다 먼저 하는 게 핵심이다.** 정답 숫자가 확정돼야 A4 Guard의 화이트리스트가 성립하고, LLM 없이도 화면이 완성된 상태에서 AI를 얹게 된다.

---

## 부록: 프롬프트 금지어 전체 목록

Guard와 프롬프트 양쪽에 동일하게 넣는다.

```python
FORBIDDEN_PHRASES = [
    "승인", "승인됩니다", "확정", "보장", "보장합니다", "100%", "무조건",
    "반드시 됩니다", "가능합니다(단정)", "신용점수가 오릅니다", "점수 상승",
    "이자를 아낄 수 있습니다", "최적의 상품", "추천 1위", "당첨",
]

REQUIRED_HEDGES = [
    "상품상 최대한도", "1차 자격검토", "예상 가능범위",
    "현재 입력 기준", "신청 시점 기준",
]
```
