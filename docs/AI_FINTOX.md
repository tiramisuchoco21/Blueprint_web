# 청사진 — 문자 기반 소비분석 (FinTox) 상세 설계

`AI_ARCHITECTURE.md`의 **A6** 확장. SCREEN 05 (FinTox + Smart Prescription, 설계서 p.10) 구현 설계.

---

## 0. 수집 경로 — MVP는 더미데이터 + Ctrl+V

### 결론: 문자 수집을 자동화하지 않는다

브라우저에는 SMS를 읽는 API가 없다. 그런데 **초안 문서가 이미 답을 갖고 있었다** — `초안.pdf` §7과 `시나리오 1탄.pdf` Step 3이 처음부터 **"결제 문자 (Ctrl+V) 붙여넣기"**를 UX로 명시했다. 자동 수집은 애초에 기획에 없었다.

| 경로 | MVP 채택 | 비고 |
|---|---|---|
| **더미 문자 세트 (fixtures)** | ✅ **P0 — 기본 동선** | 시연은 이걸로 한다 |
| **Ctrl+V 붙여넣기** (`onPaste`) | ✅ **P0 — 인터랙션 증명** | 초안·시나리오1탄에 명시된 원래 UX |
| PWA Web Share Target | ⬜ P1 (선택) | Android 공유시트 연동. 여유 있으면 |
| 네이티브 `READ_SMS` | ❌ 범위 밖 | Play 정책상 기본 SMS앱만 승인 |
| 마이데이터 / 오픈뱅킹 | ❌ P2 | MVP 설계서 p.14가 이미 P2로 분류 |
| OCR (영수증 이미지) | ❌ 범위 밖 | 초안엔 Tesseract가 있었으나 **MVP 설계서 p.14에서 P2로 강등** |

### 더미데이터가 설계를 줄여준다

더미로 가면 **AI 컴포넌트가 하나 사라진다.**

| 구성요소 | 실데이터 전제 | **더미 전제** |
|---|---|---|
| ③ 정규식 파서 | 카드사 10곳 포맷 대응 필요 | **더미가 통과하는 3~4개 포맷만** |
| ④ LLM 파서 폴백 | 필수 (롱테일 포맷) | **불필요 → 시연용 1건만 남기고 제거 가능** |
| ⑥ LLM 카테고라이저 | 필수 (미지 가맹점 롱테일) | **불필요 → 더미 가맹점 전량 사전 매핑** |
| ⑪ 넛지 문구 | AI | AI (유지) |

→ **더미 기준 FinTox의 AI는 ⑪ 넛지 문구 하나뿐이다.** ④⑥은 "확장 시 이렇게 붙는다"로 발표에서 말만 하고, 코드는 인터페이스만 비워둔다.

> ⚠️ 단, **④ LLM 파서 폴백은 시연용으로 1건만 살려두는 걸 권한다.** 더미 40건 중 2건을 일부러 깨진 포맷으로 넣고 "38건은 규칙, 2건은 AI가 복구"를 보여주면, AI가 **어디에 필요하고 어디에 불필요한지 아는 팀**이라는 신호가 된다. 이건 심사에서 꽤 강한 차별점이다.

### 더미데이터 원칙

1. **파일로 관리한다.** `fixtures/persona1_sms.json` — 코드에 하드코딩하지 않는다.
2. **실제 카드사 문자 포맷을 그대로 쓴다.** 형식을 단순화하면 "파서를 만든 게 아니라 자기가 만든 형식을 읽는 것"이 된다.
3. **결과가 설계서 숫자와 일치하도록 역산해서 만든다.** (§6 검증표 참조 — 72점이 나와야 한다)
4. **더미임을 UI에 숨기지 않는다.** `데모 데이터` 배지를 단다. 심사위원이 물어보기 전에 밝히는 쪽이 신뢰를 얻는다.

### 커버리지 한계는 UI에 표시한다

```
"카드 승인 문자 기준입니다. 현금·계좌이체는 포함되지 않습니다."
```

→ No False Certainty 원칙의 연장. "전체 소비의 100%를 분석했다"고 말하지 않는다.

---

## 1. 파이프라인

```
[문자 원문 n건]
      │
      ▼ ① 클라이언트 마스킹  ← 서버로 보내기 전
   전화번호/카드번호/잔액 제거
      │
      ▼ ② 분할 (Splitter)
   여러 건 붙여넣기 → 개별 문자로 분리
      │
      ▼ ③ 정규식 파서 (1차)        ❌ LLM 아님  ~90% 커버
   금액 / 일시 / 취소 / 할부 / 카드사 / 가맹점 추출
      │
      ├─ 실패 건만 ─────────┐
      │                     ▼ ④ LLM 파서 (2차)   ✅ AI  배치 1회 호출
      │                     구조화 실패분 복구
      ▼                     │
      ◄─────────────────────┘
      ▼ ⑤ 정규화 (Normalizer)      ❌ LLM 아님
   가맹점명 정제 → alias 사전 → 카테고리
      │
      ├─ 미매핑 가맹점만 ───┐
      │                     ▼ ⑥ LLM 카테고라이저   ✅ AI  배치 1회 + 결과 캐싱
      ▼                     │
      ◄─────────────────────┘
      ▼ ⑦ 중복제거 / 취소상계        ❌ LLM 아님
      ▼ ⑧ FinTox 스코어러            ❌ LLM 아님  (명시적 가중치 룰)
      ▼ ⑨ Goal Impact 계산           ❌ LLM 아님  ★ 청사진의 차별점
      ▼ ⑩ Smart Prescription 매칭    ❌ LLM 아님  (혜택 룰 테이블)
      ▼ ⑪ 넛지 문구 생성             ✅ AI  (문장 1~2줄만) + Numeric Guard
      ▼
   [FinTox 화면]
```

**AI가 관여하는 건 ④⑥⑪ 세 군데뿐이고, 셋 다 폴백이 있다.** LLM이 죽어도 화면은 완성된다.

---

## 2. ① 마스킹 — 서버로 보내기 전에 지운다

문자 원문은 민감정보다. **원문을 서버에 저장하지 않는 것**이 이 모듈의 기본 설계다.

```typescript
// web/lib/mask.ts  ← 브라우저에서 실행
const MASKS: [RegExp, string][] = [
  [/\b\d{2,3}-\d{3,4}-\d{4}\b/g,        "[전화번호]"],
  [/\b\d{4}-?\d{4}-?\d{4}-?\d{4}\b/g,   "[카드번호]"],
  [/\(\d{4}\)/g,                         "(****)"],      // 신한카드(1234)
  [/잔액\s*[\d,]+원/g,                   "잔액 [마스킹]"],
  [/https?:\/\/\S+/g,                    "[링크]"],
  [/[가-힣]{2,4}님/g,                    "고객님"],       // 이름
];

export const mask = (s: string) => MASKS.reduce((t, [re, to]) => t.replace(re, to), s);
```

| 데이터 | 저장 여부 |
|---|---|
| 문자 원문 (`raw_text`) | ❌ **저장 안 함.** 파싱 후 메모리에서 폐기 |
| 파싱 실패 원문 | ⚠️ 마스킹본만, 24시간 TTL, 파서 개선 목적 (동의 필요) |
| 구조화 결과 (금액/일시/가맹점/카테고리) | ✅ 저장 |
| LLM 전송 텍스트 | 마스킹본만. 잔액·이름·카드번호는 애초에 없음 |

> `transactions` 테이블에 `raw_text` 컬럼을 **만들지 않는다.** 스키마에 없으면 실수로 저장할 수 없다.

---

## 3. ②③ Splitter + 정규식 파서

### 붙여넣기 분할

여러 건을 한 번에 붙여넣으면 경계를 찾아야 한다. 카드사 문자는 거의 항상 발신 헤더로 시작한다.

```python
SPLIT_RE = re.compile(
    r"(?=\[?(?:Web발신|웹발신)?\]?\s*\[?(?:신한|국민|KB|삼성|현대|롯데|우리|하나|BC|NH|카카오뱅크|토스)"
    r"(?:카드|체크|은행)?)"
)
def split_messages(blob: str) -> list[str]:
    return [m.strip() for m in SPLIT_RE.split(blob) if m.strip()]
```

### 필드별 추출 (카드사별 전체 패턴을 만들지 마라)

카드사마다 문장 구조는 다르지만 **금액·일시·취소·할부 표기는 거의 동일**하다. 카드사별 풀패턴 10개를 유지보수하는 대신, 필드별 정규식 + 가맹점 위치만 카드사 프로파일로 처리한다.

```python
# app/engine/sms/patterns.py   ← ❌ LLM 아님
AMOUNT   = re.compile(r"([\d,]{3,})\s*원")
DATETIME = re.compile(r"(\d{1,2})[/월\.](\d{1,2})[일]?\s*(\d{1,2}):(\d{2})")
CANCEL   = re.compile(r"승인\s*취소|취소")
INSTALL  = re.compile(r"(\d{1,2})\s*개월\s*(?:할부)?")
ISSUER   = re.compile(r"(신한|국민|KB|삼성|현대|롯데|우리|하나|BC|NH|카카오뱅크|토스)")
CHANNEL  = re.compile(r"(체크|신용|은행|간편)")

# 가맹점: 카드사별로 "금액 뒤" 또는 "마지막 줄" 등 위치가 다름
MERCHANT_HINTS = {
    "신한": r"원\s*\n?\s*(.+?)\s*$",
    "국민": r"원\s+(.+?)(?:\s+잔액|$)",
    "_default": r"(?:원|일시불|\d개월)\s*[\n ]\s*(.+?)\s*$",
}
```

**처리해야 하는 예외:**

| 케이스 | 처리 |
|---|---|
| `승인취소` | `is_cancelled=True` → 원 승인 건과 상계 (금액+분+가맹점 매칭) |
| `3개월 할부` | `installment_months=3`, 월 분할액으로 예산 반영 |
| `USD 29.99` | 해외결제 → `currency` 분리, 원화 환산 전까지 `pending` |
| 정기결제 (넷플릭스 등) | 30일 주기 반복 감지 → `is_recurring=True`, 변동지출에서 제외 |
| 연도 없음 (`09/01`) | 오늘 기준 추론. 미래 날짜가 나오면 작년으로 |
| 입금/이체 문자 | 지출 아님 → 스킵 (`입금`, `이체` 키워드) |

```python
class ParsedTx(BaseModel):
    amount: int
    occurred_at: datetime
    merchant_raw: str
    issuer: str
    channel: Literal["card_credit", "card_check", "transfer", "easy_pay"]
    is_cancelled: bool = False
    installment_months: int = 0
    currency: str = "KRW"
    parse_method: Literal["regex", "llm"] = "regex"
    confidence: float = 1.0
```

---

## 4. ④ LLM 파서 폴백 — 실패분만, 배치로

정규식이 못 잡은 건만 모아서 **한 번에** 호출한다. 건별 호출은 비용·지연 낭비다.

```python
# app/ai/tx_parser.py
class ParsedBatch(BaseModel):
    transactions: list[ParsedTx]

TX_PARSER_SYSTEM = """당신은 한국 카드사 결제 알림 문자를 구조화하는 파서다.

규칙:
- 문자에 명시된 값만 추출한다. 추론하거나 채워 넣지 않는다.
- 금액은 원 단위 정수. "34,000원" → 34000
- 연도가 없으면 today 기준으로 판단하되, 미래가 되면 작년으로 한다.
- 입금·이체·잔액안내·광고 문자는 결과에서 제외한다.
- 가맹점명은 문자에 적힌 그대로 둔다. 정제하지 마라. (정제는 후처리 담당)
- 카테고리를 추측하지 마라. 이 단계는 추출만 한다.
- 확신이 없으면 confidence를 낮춰라. 지어내지 마라.
"""

def parse_failed(masked_texts: list[str], today: date) -> list[ParsedTx]:
    resp = client.messages.parse(
        model="claude-opus-5",
        max_tokens=4000,
        system=[{"type": "text", "text": TX_PARSER_SYSTEM,
                 "cache_control": {"type": "ephemeral"}}],
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": json.dumps(
            {"today": str(today), "messages": masked_texts}, ensure_ascii=False)}],
        output_format=ParsedBatch,
    )
    return [t for t in resp.parsed_output.transactions if t.confidence >= 0.6]
```

`confidence < 0.6`은 버리고 **"인식하지 못한 문자 2건"으로 UI에 표시**한다. 잘못 잡은 걸 조용히 섞는 것보다 낫다.

---

## 5. ⑤⑥ 정규화 + 카테고리

### 가맹점명 정제 (룰)

```python
STRIP = [r"^\(주\)", r"^㈜", r"^주식회사\s*", r"\s*\d{2,}$",       # 단말기번호
         r"\s*(강남|홍대|마포|신촌|역삼)점$", r"\s*지점$"]

ALIAS = {
    "배달의민족": ["배민", "우아한형제들", "BAEMIN", "배달의민족"],
    "쿠팡이츠":   ["쿠팡이츠", "COUPANGEATS"],
    "스타벅스":   ["스타벅스", "STARBUCKS", "스타벅스코리아"],
    # ... 시연에 등장할 가맹점 30~50개면 충분
}
```

### 카테고리 매핑 (룰 → LLM 폴백)

```python
CATEGORY_MAP = {
    "배달의민족": "food_delivery", "쿠팡이츠": "food_delivery",
    "스타벅스": "cafe", "이디야": "cafe",
    "GS25": "convenience", "CU": "convenience",
    "카카오T": "transport", "티머니": "transport",
    # ...
}
```

**미매핑 가맹점만 LLM에 배치로 물어보고, 결과는 DB에 영구 캐싱한다.**

```python
# app/ai/categorizer.py
class MerchantCategory(BaseModel):
    merchant: str
    category: Literal["food_delivery","dining","cafe","convenience","grocery",
                      "transport","shopping","entertainment","health",
                      "subscription","utility","other"]
    is_recurring_likely: bool
    confidence: float

# 한 번 물어본 가맹점은 merchant_category 테이블에 저장 → 두 번 다시 LLM을 안 부른다
```

> 여기가 이 모듈에서 **LLM이 진짜로 필요한 유일한 지점**이다. 신규·소상공인 가맹점명은 롱테일이라 사전으로 못 덮는다. 대신 캐싱하면 호출 횟수는 사용자당 수십 건에 수렴한다.

---

## 6. ⑧ FinTox 스코어러 — 100% 룰

설계서 p.10이 **"심리상태를 확률로 단정하지 않는다"**, **"명시적 규칙으로 점수화"**를 요구한다. LLM 금지.

### 점수 정의 두 개를 분리한다

| 지표 | 대상 | 쓰임 |
|---|---|---|
| **TxRisk** | 결제 **1건** | 결제 직후 넛지 (설계서 예시의 72점) |
| **FinToxIndex** | 최근 30일 | 대시보드 게이지 |

### ⚠️ 스코어링 모드가 **두 개** 필요하다 (페르소나별로 성격이 다르다)

페르소나 최종수정본을 읽고 나서 드러난 사실이다. 두 페르소나의 FinTox는 **같은 산식으로 계산되지 않는다.**

| | 페르소나 1 (민재) | 페르소나 2 (지은) |
|---|---|---|
| 입력 | `배달의민족 34,000원 / 23:40` | `OO웨딩스튜디오 추가금 880,000원 / 15:30` |
| 문제의 성격 | **소비 습관** — 야간·반복·평균 대비 | **프로젝트 예산 초과** — 스드메 300만 예산에 누적 420만 |
| 점수 | 72 / 100 | 78 / 100 |
| 판단 축 | 시간대, 평균 편차, 반복 | 예산 집행률(140%), 결제 비중 |

**야간 가중치를 지은 님 케이스에 적용하면 15:30 결제라 0점이 되어 78점이 절대 안 나온다.** 모드를 나눠야 한다.

```python
class ScoringMode(str, Enum):
    HABIT  = "habit"    # 일상 소비 습관 (페르소나 1)
    BUDGET = "budget"   # 프로젝트 예산 관리 (페르소나 2 — 웨딩·이사·가전)
```

모드 결정도 룰이다: 사용자가 **예산이 설정된 프로젝트**(웨딩, 이사 등)를 만들고 그 카테고리에 속하는 결제면 `BUDGET`, 아니면 `HABIT`.

### 모드 A — HABIT 산식 (페르소나 1)

```python
# app/engine/fintox.py   ← ❌ LLM 아님
WEIGHTS = {
    "late_night":  15,   # 22:00~04:00 결제
    "above_avg":   25,   # 동일 카테고리 최근 4주 평균 대비 초과
    "budget_burn": 25,   # 직전 30일 변동지출 예산 소진율
    "repeat":      15,   # 7일 내 동일 가맹점 반복
    "goal_ratio":  20,   # 월 목표저축액 대비 비중
}   # 합계 100

clamp = lambda x: max(0.0, min(1.0, x))

def tx_risk(tx, ctx) -> ScoreBreakdown:
    f = {
        "late_night":  1.0 if tx.occurred_at.hour >= 22 or tx.occurred_at.hour < 4 else 0.0,
        "above_avg":   clamp(tx.amount / max(ctx.category_avg_4w, 1) - 1.0),
        "budget_burn": clamp(ctx.variable_spent_30d / max(ctx.variable_budget, 1)),
        "repeat":      clamp((ctx.same_merchant_7d - 1) / 3),
        "goal_ratio":  clamp(tx.amount / max(ctx.required_monthly, 1) / 0.10),
    }
    parts = {k: round(WEIGHTS[k] * v, 1) for k, v in f.items()}
    return ScoreBreakdown(total=round(sum(parts.values())), parts=parts, factors=f)
```

### 설계서 예시(72점) 재현 검증

입력: `배달의민족 34,000원 / 09-01 23:40`, `required_monthly = 583,000`

| 항목 | 근거값 | f | 가중 | 점수 |
|---|---|---|---|---|
| late_night | 23:40 (야간대) | 1.000 | 15 | **15.0** |
| above_avg | 34,000 ÷ 19,000(4주 배달 평균) = 1.79배 | 0.789 | 25 | **19.7** |
| budget_burn | 직전 30일 변동지출 소진율 62% | 0.620 | 25 | **15.5** |
| repeat | 7일 내 배민 3회 | 0.667 | 15 | **10.0** |
| goal_ratio | 34,000 ÷ 583,000 = 5.83% (임계 10%) | 0.583 | 20 | **11.7** |
| | | | | **= 71.9 → 72** |

→ **설계서의 72점이 실제로 계산으로 재현된다.** 시연에서 이 표를 그대로 펼쳐 보이면 "규칙 기반"이 증명된다.

### 모드 B — BUDGET 산식 (페르소나 2 · 웨딩 FinTox)

```python
BUDGET_WEIGHTS = {
    "budget_overrun":  35,   # 프로젝트 예산 누적 집행률 초과분
    "tx_share":        25,   # 이번 결제 / 최초 예산
    "goal_impact":     20,   # 이번 결제 / 월 저축여력
    "category_creep":  20,   # 같은 프로젝트 '추가금' 결제 반복 횟수
}   # 합계 100

def budget_risk(tx, proj) -> ScoreBreakdown:
    f = {
        "budget_overrun": clamp((proj.spent / proj.budget - 1.0) / 0.5),
        "tx_share":       clamp(tx.amount / proj.budget / 0.30),
        "goal_impact":    clamp(tx.amount / proj.monthly_capacity / 0.50),
        "category_creep": clamp((proj.tx_count - 1) / 5),
    }
    return ScoreBreakdown(total=round(sum(BUDGET_WEIGHTS[k] * v for k, v in f.items())),
                          parts={k: round(BUDGET_WEIGHTS[k]*v, 1) for k, v in f.items()},
                          factors=f)
```

**페르소나 2 예시(78점) 재현 검증** — 입력: 웨딩스튜디오 추가금 880,000원, 스드메 예산 300만, 누적 420만, 월 저축여력 200만

| 항목 | 근거값 | f | 가중 | 점수 |
|---|---|---|---|---|
| budget_overrun | 집행률 140% → 초과 40%p (임계 50%p) | 0.800 | 35 | **28.0** |
| tx_share | 880,000 ÷ 3,000,000 = 29.3% (임계 30%) | 0.978 | 25 | **24.4** |
| goal_impact | 880,000 ÷ 2,000,000 = 44% (임계 50%) | 0.880 | 20 | **17.6** |
| category_creep | 스드메 추가금 3회차 | 0.400 | 20 | **8.0** |
| | | | | **= 78.0** |

→ **설계서의 78점도 정확히 재현된다.** 두 페르소나 모두 산식으로 떨어지므로, "점수를 어떻게 냈냐"는 질문에 두 번 다 답할 수 있다.

### 판정 밴드

```python
BANDS = [(0, 39, "양호"), (40, 59, "관찰"), (60, 79, "주의"), (80, 100, "경고")]
```

> **UI에 각 항목 기여도를 막대로 노출한다.** 정책 카드의 "왜 가능한가요?"와 같은 패턴 — 설명가능성이 화면에 그대로 드러난다.

---

## 7. ⑨ Goal Impact — **이게 가계부와 청사진을 가르는 지점**

설계서 p.10: *"이번 달 소비패턴이 계속되면 목표 저축액과 목표 D-Day가 어떻게 변하는지 연결"*

FinTox의 존재 이유가 여기다. 점수는 거들 뿐이고, **D-Day가 밀리는 숫자**가 본체다.

```python
# app/engine/calculator.py   ← ❌ LLM 아님
def goal_impact(ctx, feasibility) -> GoalImpact:
    # 관측 구간을 30일로 정규화
    projected_variable = ctx.variable_spent / ctx.observed_days * 30
    capacity = ctx.monthly_income - ctx.fixed_cost - projected_variable

    if capacity >= feasibility.required_monthly:
        return GoalImpact(status="ON_TRACK", d_day_shift=0, buffer=capacity - feasibility.required_monthly)

    new_months = ceil(feasibility.gap / max(capacity, 1))
    shift_days = (new_months - feasibility.horizon_months) * 30
    return GoalImpact(
        status="AT_RISK",
        projected_monthly_saving=int(capacity),
        shortfall=feasibility.required_monthly - int(capacity),
        d_day_shift=shift_days,
        new_horizon_months=new_months,
    )
```

**화면 문구 (템플릿, LLM 아님):**

```
현재 소비 패턴이 유지되면
월 저축 583,000원 → 예상 512,000원
목표 도달 24개월 → 28개월   (D-730 → D-850, 약 4개월 지연)
```

> 시연 동선: **FinTox 화면에서 이 숫자를 보여준 뒤 What-if Simulator로 넘어가면**, 소비 → 저축 → 목표가 하나의 흐름으로 닫힌다. 설계서 p.15 동선에서 FinTox가 빠져 있는데, Part A 끝에 15초만 붙이면 "행동관리까지 연결된다"는 USP가 살아난다.

---

## 8. ⑩ Smart Prescription — 혜택 매칭도 룰

설계서 p.10: *"소비를 금지하는 대신 지역화폐·K-패스 등 공공혜택을 제안"*

**금지가 아니라 처방**이라는 게 핵심. 매칭은 룰 테이블, 절감액은 계산.

```jsonc
// app/data/benefits/*.json  — 정책 DB와 동일한 구조로 관리
{
  "benefit_id": "k_pass",
  "name": "K-패스",
  "trigger": {
    "category": ["transport"],
    "monthly_amount_gte": 70000,
    "region_in": ["서울", "경기", "인천", "..."]
  },
  "benefit": { "type": "refund_rate", "rate_by_age": { "youth": 0.30, "general": 0.20 } },
  "saving_formula": "monthly_transport * rate",
  "source": { "name": "국토교통부 K-패스", "url": "https://korea-pass.kr",
              "updated_at": "2026-09-01" }
}
```

| 소비 패턴 | 처방 | 절감 계산 |
|---|---|---|
| 대중교통 월 7만↑ | K-패스 | `월교통비 × 환급률(청년 30%)` |
| 지역 내 식비·소매 | 지역사랑상품권 | `월지출 × 할인율 7~10%` (한도 적용) |
| 배달 반복 + 야간 | 행동 넛지 (혜택 없음) | 결제액 10% 셀프저축 |
| 구독 중복 | 중복 구독 정리 | 중복분 합계 |

**넛지 3,400원 = 34,000 × 10%** — 설계서 예시도 룰로 재현된다 (주의 밴드 → 결제액 10% 셀프저축).

> 혜택 카드도 **정책 카드와 같은 컴포넌트를 재사용**한다. 출처·기준일·"공식 출처 확인" CTA가 자동으로 붙는다. Trust Architecture가 FinTox 화면에도 그대로 적용된다.

---

## 9. ⑪ 넛지 문구 — LLM은 여기서만 문장을 쓴다

```python
NUDGE_SYSTEM = """당신은 '청사진'의 소비 코치다. 점수와 처방은 이미 계산됐다.
사용자에게 보여줄 한두 문장만 쓴다.

절대 규칙:
1. 입력 JSON에 없는 숫자를 쓰지 마라. 계산하지 마라.
2. 심리 상태를 단정하지 마라.
   금지: "스트레스성 소비", "충동구매하셨네요", "~하고 싶으셨군요", "외로우셨나요"
   허용: "야간 시간대 결제였습니다", "최근 4주 평균보다 높습니다"  ← 관측 사실만
3. 비난·훈계하지 마라. 소비를 금지하지 마라.
   금지: "줄이셔야 합니다", "과소비입니다", "아끼세요"
   허용: "이 패턴이 유지되면 목표가 4개월 늦어집니다" ← 결과만 제시
4. 확정 표현 금지: "절약됩니다", "환급받습니다", "보장"
   → "환급 대상일 수 있습니다", "예상 절감액"
5. 두 문장 이내.

톤: 담백한 존댓말. 감탄사·이모지 없음.
"""
```

**출력은 `AI_ARCHITECTURE.md`의 A4 Numeric Guard를 그대로 통과시킨다.** 화이트리스트는 `ScoreBreakdown` + `GoalImpact` + `Prescription`의 숫자.

**폴백 템플릿 (밴드별 고정 문구):**

```python
NUDGE_TEMPLATE = {
  "주의": "야간 시간대 결제이고 최근 4주 평균보다 높습니다. "
          "{nudge_amount}원을 목표 저축에 옮겨두면 이번 달 계획을 유지할 수 있습니다.",
  "경고": "이 패턴이 유지되면 목표 도달이 약 {d_day_shift}일 늦어집니다. "
          "{benefit_name} 적용 시 월 {saving}원 절감이 예상됩니다.",
}
```

---

## 10. 데이터 모델

```sql
CREATE TABLE transactions (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,
  amount             INTEGER NOT NULL,
  merchant_raw       TEXT NOT NULL,
  merchant_norm      TEXT NOT NULL,
  category           TEXT NOT NULL,
  channel            TEXT NOT NULL,
  issuer             TEXT,
  is_cancelled       BOOLEAN DEFAULT FALSE,
  is_recurring       BOOLEAN DEFAULT FALSE,
  installment_months SMALLINT DEFAULT 0,
  parse_method       TEXT NOT NULL,      -- 'regex' | 'llm'
  confidence         REAL DEFAULT 1.0,
  ingest_source      TEXT NOT NULL,      -- 'paste' | 'share_target' | 'demo'
  dedup_key          TEXT UNIQUE,        -- md5(amount|occurred_at분|merchant_norm)
  created_at         TIMESTAMPTZ DEFAULT now()
  -- raw_text 컬럼 없음 (의도적)
);

CREATE TABLE merchant_category (       -- LLM 카테고리 추론 캐시
  merchant_norm TEXT PRIMARY KEY,
  category      TEXT NOT NULL,
  source        TEXT NOT NULL,          -- 'dict' | 'llm' | 'user'
  confidence    REAL,
  updated_at    TIMESTAMPTZ DEFAULT now()
);
```

`dedup_key`가 UNIQUE라 같은 문자를 두 번 붙여넣어도 중복이 안 쌓인다. 시연 중 실수 방지용으로도 중요하다.

---

## 11. API

```
POST /api/fintox/ingest
  body: { texts: string[], source: "paste"|"share_target" }
  resp: { parsed: Transaction[], unrecognized: number, tx_risks: ScoreBreakdown[] }

GET  /api/fintox/summary?days=30
  resp: { index: FinToxIndex, breakdown: {...}, top_categories: [...],
          goal_impact: GoalImpact, prescriptions: Prescription[] }

POST /api/fintox/nudge          # ⑪ LLM 문구 (선택적, 비동기)
  body: { tx_id }
  resp: { text: string, source: "llm"|"template" }
```

`/ingest`는 **LLM 없이도 200을 반환**해야 한다. 넛지 문구는 별도 엔드포인트로 분리해서, 느리거나 실패해도 파싱 결과 렌더를 막지 않는다.

---

## 12. 시연 설계

### 데모 데이터

`fixtures/persona1_sms.txt` — 김민재의 최근 30일 문자 40건을 미리 만들어 둔다.

```
[Web발신]
신한카드(****) 승인
고객님
34,000원 일시불
09/01 23:40
배달의민족
```

- 배달 반복 8건 (야간 3건 포함) ← 72점이 나오도록 설계
- 대중교통 월 84,000원 ← K-패스 처방이 뜨도록
- 구독 중복 2건 ← 정리 처방
- 파싱 실패 유도 2건 ← **LLM 폴백이 동작하는 장면을 보여주기 위해 의도적으로 포함**

### 시연 동선 (Part A 뒤 15초 추가)

```
1. [붙여넣기] 문자 40건 paste → "38건 인식, 2건은 AI가 복구" 배지
2. [FinTox]   배민 34,000원 → 72점, 5개 항목 막대 펼침
3. [Goal 연결] "이 패턴이면 24개월 → 28개월, D-730 → D-850"   ★
4. [처방]     K-패스 → 월 25,200원 환급 예상 (출처: 국토교통부)
5. → What-if Simulator로 전환
```

**3번이 핵심이다.** 여기서 "가계부 아니고 목표 관리"라는 게 증명된다.

### 안전장치

| 리스크 | 대비 |
|---|---|
| LLM 파서 실패 | 정규식 결과만으로 진행 + "2건 인식 실패" 표시 |
| 넛지 API 지연 | 템플릿 폴백, 별도 엔드포인트라 렌더 안 막힘 |
| 붙여넣기 실수 | `dedup_key` UNIQUE로 중복 무시 |
| 네트워크 장애 | `DEMO_MODE=1` → fixtures 재생 |

---

## 13. `AI_ARCHITECTURE.md` 대비 변경 요약

| 항목 | 기존 A6 | 확정 설계 |
|---|---|---|
| 수집 경로 | 미정 | **붙여넣기 + PWA Share Target** (네이티브 SMS 권한은 범위 밖으로 명시) |
| 파싱 | "정규식 → 사전 → LLM" 3단계 | 동일, 단 **LLM은 실패분만 배치 1회** |
| 카테고리 | 로컬 dict | dict + **LLM 폴백 + DB 영구 캐싱** |
| FinTox 점수 | 가중치 5개 나열 | **산식 확정 + 설계서 72점 재현 검증** |
| 목표 연결 | 언급만 | **`goal_impact()` 확정 — D-Day 지연일수 계산** ★ |
| 처방 | "룰 조회" | **혜택 JSON 스키마 + 절감액 산식** |
| 개인정보 | 미언급 | **클라이언트 마스킹 + `raw_text` 컬럼 부재** |

**AI 호출 수 증가: 사용자당 2회** (파싱 폴백 1 + 카테고리 1, 둘 다 배치·캐싱). 비용 영향은 무시할 수준이다.
