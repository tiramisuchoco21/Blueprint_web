# 청사진 — AI 기능 확장 설계

> "AI를 더 넣어야 한다"에 대한 답. **늘리는 방향**이 핵심이다.

---

## 0. AI를 늘리는 두 방향 — 하나는 서비스를 죽인다

| 방향 | 예시 | 결과 |
|---|---|---|
| ❌ **아래로** (엔진을 LLM으로 대체) | "이 사람 버팀목 되나요?" / "월 얼마 모아야 해?" 를 LLM에게 질문 | Trust Architecture 붕괴. 심사에서 "AI가 틀리면?"에 답 못 함 |
| ✅ **위로** (오케스트레이션을 AI가) | LLM이 Rule Engine·Calculator를 **도구로 호출** | 계산은 코드가, 판단 흐름은 AI가. 자유질의 대응 가능 |
| ✅ **옆으로** (AI만 할 수 있는 일 추가) | 비정형 데이터 이해, 의도 추론, 신호 추출 | 원칙 무손상. USP 신규 생성 |

**결론: 위·옆으로 늘린다.** 아래로는 절대 내려가지 않는다.

---

## 1. 🔴 정정: LLM 카테고라이저는 **필수**다

지난 설계에서 "더미데이터면 가맹점 카테고리는 사전으로 덮을 수 있다"고 했다. **실제 데이터 96건을 보니 틀렸다.**

### 데이터 실측 (카드 이용내역 96건 / 01-14~02-03 / 총 3,680,966원 / 고유 가맹점 63개)

| 문제 | 실측 | 룰로 해결 가능? |
|---|---|---|
| **PG·간편결제가 실제 가맹점을 가림** | **32건 (33%)** | ❌ |
| **가맹점 정보가 아예 없음** (`네이버페이` 단독) | 6건 | ❌ 불가능 |
| **같은 브랜드가 여러 표기로 분산** | 올리브영 = **6가지 표기 / 8건** | △ 정규식 계속 증식 |
| **개인 상호** (사전 불가) | `너와나` `모퉁이네` `철계단집` `콩심` `분99` `대동집별내점` … | ❌ |
| **문자열 잘림** | `북악팔각정 (하늘레스토랑. 해오름 . 커피하` | ❌ |
| **정체불명** | `(주)정한솔루션 1,250원` `ATTIC IN SEOUL` | ❌ |

**실제 사례:**
```
NICE결제대행-(주) 쏘카              ← 9건. PG사 이름이 앞, 실제는 카셰어링
이니시스 (빌링)- 주식회사피플카      ← 4건. 역시 카셰어링
카카오페이_KPN- 주식회사넌럭셔리어스컴 ← 이게 뭘까? 사람도 검색해야 안다
네이버페이                          ← 6건. 정보 0
씨제이올리브네트웍스(주) 신용산역점   ┐
씨제이올리브네트웍스(주) 아산지중해마을 │
씨제이올리브네트웍스(주)오목교역점    ├ 전부 올리브영. 6가지 표기
씨제이올리브영(주) 목동점            │
씨제이올리브영(주) 원그로브점        │
올리브영외대정문점                  ┘
```

> **63개 고유 가맹점 중 사전으로 확실히 매핑되는 건 20개 미만.** 나머지 40+개는 LLM이거나 사용자 수동 입력이다.

**이 데이터셋 자체가 "AI가 왜 필요한가"의 증거물이다.** 발표에서 이 표를 그대로 보여주면 된다 — *"정규식으로 하면 63개 중 20개밖에 못 읽습니다."*

---

## 2. ★★★ 신규 USP: Policy Signal Extractor (소비 → 정책 **역추적**)

**이 데이터를 뜯어보다 발견한 것.** 96건 안에 **정책과 직결되는 신호가 숨어 있다.**

| 소비 신호 | 실측 | 역추적되는 정책 |
|---|---|---|
| `카카오페이-한국금융투자협회` 4건 + `인터넷상거래-금융투자교육원` 3건 | **7건** | **청년 자격증·응시료 지원 조례** ← 자격증 준비 중이라는 강력한 신호 |
| `LGUPLUS통신요금자동이체` | 1건 | **비금융 신용가점 등록** (통신비 성실납부) → A8 |
| `기후동행 53건` | 1건 | **K-패스 vs 기후동행카드 유불리 비교** ← 이미 하나를 쓰고 있다 |
| `쏘카` 9건 + `피플카` 4건 + `카카오T택시` 3건 | **16건** | 청년 교통비 지원 / 차량 미보유 확인 |
| `삼성화재해상보험(주)` | 1건 | 고정비 항목 — 저축여력 계산 입력 |
| `법원행정처` 2건 | 2건 | 등기·증명 발급 → 주거 이동 준비 신호 |

### 왜 이게 강한가

기존 가계부: **"식비 30만 원 쓰셨어요"** → 그래서 뭐?
청사진: **"소비내역을 보니 자격증 준비 중이시네요. 응시료 지원 조례가 있습니다."**

- MVP 설계서의 흐름은 `Goal → Policy`(정방향) 하나뿐이다.
- 여기에 **`Consumption → Policy`(역방향)**를 추가하면, **사용자가 존재조차 모르는 정책을 소비 흔적만으로 발굴**한다.
- 초안 문서가 말한 *"청년 다수가 수백만 원 상당의 혜택을 놓치고 있음"* 이 문제 정의에 **직접 응답**하는 유일한 기능이다.

### 구조 (원칙 무손상)

```
소비 96건
   ↓  ① LLM: 소비 신호 추출        ← AI. "이 사람은 무엇을 하는 중인가"
   ↓     {studying_certificate: 0.9, no_car_owner: 0.85, moving_soon: 0.6}
   ↓  ② Rule Engine: 신호 → 정책 후보 매핑   ← ❌ 룰
   ↓  ③ Rule Engine: 자격 판정               ← ❌ 룰
   ↓  ④ Calculator: 예상 수혜액              ← ❌ 코드
   ↓  ⑤ LLM: "왜 이걸 추천하는지" 서술 + Guard
[발굴된 정책 카드]
```

**LLM은 ①과 ⑤만 한다.** 신호 추출은 확률이 아니라 **근거 거래를 반드시 함께 반환**하게 한다.

```python
class ConsumptionSignal(BaseModel):
    signal: Literal["studying_certificate", "job_seeking", "no_car_owner",
                    "moving_soon", "wedding_prep", "health_expense",
                    "transit_heavy", "telecom_autopay"]
    evidence_tx_ids: list[int]      # ← 근거 거래 필수. 이게 없으면 반환 금지
    rationale: str                  # "금융투자협회·교육원 결제 7건"
```

> **`evidence_tx_ids`가 핵심 안전장치다.** 근거 거래를 못 대면 신호를 버린다. "AI가 왜 그렇게 판단했는지"가 클릭 한 번으로 원본 거래까지 내려간다 — 정책 카드의 "왜 가능한가요?"와 동일한 패턴.

### 시연 장면
```
"소비내역 96건을 분석했습니다."
  → 자격증 관련 결제 7건 발견
  → 「청년 자격증 응시료 지원」 🟢 검토 가능 / 예상 환급 OO만 원
  → [근거 거래 7건 보기]  [공식 출처 확인]
```

---

## 3. ★★★ Tool-Use Agent — "심사위원님이 직접 물어보세요"

### 지금 설계의 약점

현재는 **고정 파이프라인**이다: 파싱 → 룰 → 계산 → 설명. 심사위원이 예상 밖 질문을 하면 **받을 수 없다.** 시연은 정해진 버튼만 누르는 데모가 된다.

### 해결: LLM에게 엔진을 **도구로** 준다

```python
# app/ai/agent.py
@beta_tool
def check_policy_eligibility(policy_id: str, profile_patch: dict) -> dict:
    """정책 자격을 판정한다. 판정은 Rule Engine이 수행한다."""
    return rules.evaluate(policy_db[policy_id], profile.merge(profile_patch)).model_dump()

@beta_tool
def calculate_feasibility(target_amount: int, horizon_months: int,
                          monthly_saving: int) -> dict:
    """목표 달성 가능성을 계산한다. 계산은 Calculator가 수행한다."""
    return calculator.feasibility(...).model_dump()

@beta_tool
def simulate_what_if(change: dict) -> dict:
    """조건을 바꿔 재계산한다. (집값·기간·월저축·정책 조합)"""
    return solver.simulate(change).model_dump()

@beta_tool
def search_consumption(category: str = None, days: int = 30) -> dict:
    """소비 내역을 조회·집계한다."""
    return tx_repo.aggregate(category, days)

@beta_tool
def lookup_policy_document(policy_id: str) -> dict:
    """정책 원문·출처·기준일을 조회한다."""
    return policy_db[policy_id].source_text

runner = client.beta.messages.tool_runner(
    model="claude-opus-5",
    max_tokens=8000,
    output_config={"effort": "medium"},
    system=[{"type": "text", "text": AGENT_SYSTEM, "cache_control": {"type": "ephemeral"}},
            {"type": "text", "text": POLICY_CORPUS, "cache_control": {"type": "ephemeral"}}],
    tools=[check_policy_eligibility, calculate_feasibility, simulate_what_if,
           search_consumption, lookup_policy_document],
    messages=history,
)
answer = runner.until_done()
```

### 이게 강한 이유

| | 고정 파이프라인 | **Tool-Use Agent** |
|---|---|---|
| "월 70만 원 모으면 언제 돼요?" | 슬라이더로만 | ✅ 자연어로 |
| "학자금 먼저 갚는 게 나아요?" | ❌ 못 받음 | ✅ `simulate_what_if` 2회 호출 후 비교 |
| "배달 절반 줄이면 D-Day 얼마나 당겨져요?" | ❌ | ✅ `search_consumption` → `calculate_feasibility` |
| "버팀목 원문 조건 보여줘" | ❌ | ✅ `lookup_policy_document` |
| **숫자를 LLM이 만드나?** | 아니오 | **아니오** (도구 반환값만 인용) |

**심사위원에게 마이크를 넘길 수 있다.** *"직접 질문해보세요"* 는 어떤 슬라이드보다 강하다.

> ⚠️ **Numeric Guard는 그대로 유지한다.** 화이트리스트를 "도구 호출이 반환한 모든 값의 합집합"으로 확장하면 된다. 에이전트가 돼도 검증 구조는 동일하다.

### 안전장치
- 도구 호출 로그를 UI에 노출 → *"AI가 방금 Rule Engine을 2번, Calculator를 1번 호출했습니다"* (**계산 안 한다는 증거를 화면에 띄우는 것**)
- 시연 실패 대비: 예상 질문 6개의 응답을 미리 캐싱, 자유질의 실패 시 폴백

---

## 4. ★★ Merchant Resolver — 가맹점 정규화·추론

§1이 요구하는 필수 모듈.

```python
class ResolvedMerchant(BaseModel):
    raw: str                          # "NICE결제대행-(주) 쏘카"
    brand: str                        # "쏘카"
    pg_stripped: bool                 # True (NICE결제대행 제거됨)
    category: Literal[...]            # "transport"
    subtype: str                      # "car_sharing"
    is_fixed_cost: bool               # False
    confidence: float
    needs_user_input: bool            # 정보 부족 시 True → 사용자에게 되물음
```

**3단계 + 캐싱:**
1. PG 접두 제거 (`NICE결제대행-`, `이니시스(빌링)-`, `카카오페이_KPN-`, `KCP(통신판매)-`, `다우데이타_`, `트라이씨클_`) ← 룰
2. 브랜드 사전 + 퍼지 매칭 (올리브영 6표기 통합) ← 룰
3. **LLM 배치 추론** ← AI. `merchant_category` 테이블에 영구 캐싱
4. 그래도 모르면 **사용자에게 되묻기** (`네이버페이 1,971원 — 무엇을 결제하셨나요?`)

> 4번이 UX 포인트다. **AI가 모를 때 모른다고 말하는 것**이 No False Certainty 원칙의 소비 버전이다.

---

## 5. ★★ Leak Finder — 누수 탐지 → D-Day 연결

```
[LLM] 96건에서 절감 후보 클러스터링
   ↓  카셰어링 16건 / 편의점·카페 소액 다빈도 / 구독 중복
[룰]  절감 가능액 산정 (공공혜택 대체 우선)
   ↓  기후동행 ↔ K-패스 유불리 비교
[계산] 절감액 → 월 저축 증가 → D-Day 단축일수
   ↓
"이 3가지를 조정하면 월 OO원 → 목표 OO일 단축"
```

**"아끼세요"가 아니라 "OO일 당겨집니다"로 끝나는 게 핵심이다.** 초안 문서의 *"경고성 알림에 그칠 뿐"* 이라는 문제 정의에 대한 답.

---

## 6. ★ 고정비/변동비 자동 분류

96건이면 주기성 탐지가 실제로 의미 있다.

- 룰: 30일 주기 + 동일 금액 → `is_recurring`
- LLM: 가맹점 성격 판단 (`삼성화재해상보험` = 보험료 고정비, `LGUPLUS자동이체` = 통신비 고정비)
- 결과 → `goal_impact()` 계산의 `fixed_cost` 입력

---

## 7. 종합 — AI 컴포넌트 재정리

| # | 컴포넌트 | AI 필요성 | 우선순위 |
|---|---|---|---|
| A1+A2 | Goal Parser / Slot Filler | 필수 | P0 |
| A3 | Explainer | 필수 | P0 |
| A4 | Numeric Guard | (비-AI 검증) | P0 |
| **A9** | **Tool-Use Agent** | **오케스트레이션** | **P0 승격 권고** |
| **A10** | **Merchant Resolver** | **데이터가 요구** | **P0 승격** |
| **A11** | **Policy Signal Extractor** | **신규 USP** | **P0~P1** |
| A5 | Alternative Writer | 필수 | P1 |
| **A12** | **Leak Finder** | 클러스터링 | P1 |
| A6-⑪ | 넛지 문구 | 서술 | P1 |
| **A13** | 고정비/변동비 분류 | 보조 | P1 |
| A7 | Policy RAG (corpus 삽입) | 근거 인용 | P1 |
| A8 | Credit Build Writer | 서술 | P2 |

**AI 컴포넌트 5개 → 11개.** 그런데 **계산·판정은 여전히 코드가 100% 담당한다.**

### 발표 문장

> "저희는 AI를 계산기로 쓰지 않습니다. **AI는 비정형 데이터를 이해하고, 도구를 호출하고, 결과를 설명합니다.**
> 숫자를 만드는 건 검증 가능한 코드입니다. 그래서 심사위원님이 직접 질문하셔도 괜찮습니다."

---

## 8. ⚠️ 데이터 취급 주의

받은 `카드 이용내역.docx`는 **더미가 아니라 실제 카드 명세**로 보인다.

- `LGUPLUS통신요금자동이체(93**67**)` — 부분 마스킹된 실번호
- `연세위드유외과의원`, `에이치약국`, `대한피부과학연구소` — **의료 이용 기록 (민감정보)**
- 생활 반경 특정 가능 (외대·용산·여의도·목동)

**권고:**
1. 이 파일을 **깃에 커밋하지 말 것.** 팀 공유·발표자료에도 원본 금지.
2. 시연용 fixture는 **이 데이터를 참고해 합성**한다 — 포맷의 지저분함(PG 접두, 표기 분산, 개인 상호)은 그대로 살리고 **가맹점·금액·날짜는 바꾼다.** AI 필요성 논증은 포맷에서 나오지 실제 값에서 나오지 않는다.
3. 의료 관련 거래는 fixture에서 제외하거나 일반 카테고리로 치환.
4. 총액 368만/21일 → 월 환산 약 526만 원. **페르소나 1(월 실수령 235만)과 스케일이 안 맞는다.** 합성 시 금액을 페르소나에 맞춰 조정할 것.
