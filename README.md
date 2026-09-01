# 청사진 (CheongSaJin) — MVP 백엔드

정책금융 AI PB. `Goal → Eligibility → Feasibility → Simulation → Action`

## 빠른 시작

```bash
cd backend && pip install -r requirements.txt
```

```bash
cd backend && python -m pytest tests -q
```

```bash
cd backend && uvicorn app.api.main:app --reload
```

API 키 없이도 **모든 계산·판정 엔드포인트가 동작한다.** AI 텍스트만 템플릿으로 대체된다.
AI를 켜려면 `backend/.env`에 `ANTHROPIC_API_KEY`를 넣는다 (`.env.example` 참고).

더미 소비 데이터를 다시 만들려면:

```bash
python tools/build_fixture.py && python tools/run_impulse.py
```

---

## 설계 원칙 — 한 줄

> **화면에 뜨는 숫자 중 LLM이 만든 숫자는 0개여야 한다.**

디렉토리가 그 원칙을 물리적으로 강제한다.

```
backend/app/
├── engine/     ❌ LLM 없음 — 판정·계산이 전부 여기
│   ├── rules.py         정책 자격 판정 (Rule Engine)
│   ├── calculator.py    금융 계산 (역산·상환·LTV/DTI·금리 빌드업)
│   ├── impulse.py       충동성 채점 (규칙 기반)
│   ├── session.py       연쇄 결제 세션 탐지
│   ├── signals.py       신호 → 정책/혜택 매핑 + 절감액
│   ├── slots.py         필수 슬롯 (정책이 질문을 결정한다)
│   └── policy_db.py     정책 DB 로더
├── ai/         ✅ LLM — 이해·서술·오케스트레이션만
│   ├── goal_parser.py       A1+A2  자연어 → 프로필 + 다음 질문
│   ├── explainer.py         A3     결과 → FACT/CALC/ADVICE
│   ├── guard.py             A4     ★ Numeric Guard (LLM 아님, 검증기)
│   ├── agent.py             A9     ★ Tool-Use Agent (자유질의)
│   ├── resolver.py          A10    ★ 가맹점 해석 (충동 판정의 전제조건)
│   ├── signal_extractor.py  A11    ★ 소비 → 정책 역추적 (신규 USP)
│   ├── nudge.py                    넛지 문구
│   ├── prompts.py                  시스템 프롬프트 (버전 관리 대상)
│   └── fallback.py                 결정론적 템플릿
└── api/main.py  FastAPI
```

---

## AI 컴포넌트와 그 근거

| # | 컴포넌트 | AI가 필요한 이유 |
|---|---|---|
| **A1+A2** | Goal Parser / Slot Filler | 자연어 → 구조화. 무엇을 물을지는 **Rule Engine이 결정**한다 |
| **A3** | Explainer | 확정된 숫자를 잇는 서술. 숫자 생성 금지 |
| **A4** | **Numeric Guard** | LLM 아님. 출력의 모든 숫자를 엔진 계산값과 대조 → 위반 시 템플릿 대체 |
| **A9** | **Tool-Use Agent** | 엔진을 도구로 호출. 고정 파이프라인이 못 받는 자유질의 대응 |
| **A10** | **Merchant Resolver** | 실측 96건 중 **26%가 카테고리 미상**. 룰로 못 덮는다 |
| **A11** | **Policy Signal Extractor** | 소비 흔적 → 사용자가 모르는 정책 발굴 |
| — | 넛지 문구 | 서술만. 실패해도 템플릿 폴백 |

### A4 Numeric Guard가 이 프로젝트의 핵심이다

프롬프트에 "계산하지 마"라고 쓰는 건 **요청이지 보장이 아니다.**
Guard는 LLM 출력에서 숫자를 뽑아 엔진이 실제로 계산한 값과 대조하고,
근거 없는 숫자나 금지 표현이 있으면 결정론적 템플릿으로 대체한다.

에이전트에도 그대로 적용된다 — 화이트리스트가 "도구 호출이 반환한 모든 값"으로 넓어질 뿐이다.

### A9 Tool-Use Agent — "심사위원님이 직접 물어보세요"

```
POST /api/ask  {"question": "학자금 먼저 갚는 게 나아요?"}
```

LLM이 `simulate_what_if`를 두 번 호출해 비교한다. 응답의 `tool_calls`를 화면에 노출하면
*AI가 계산하지 않는다*는 증거가 그 자리에 남는다.

---

## 검증된 숫자 (골든 테스트 16개)

페르소나 문서의 숫자가 코드로 재현되는지 고정한다. **AI보다 먼저 통과시켜야 한다** —
정답 숫자가 확정돼야 Numeric Guard의 화이트리스트가 성립하기 때문이다.

| 검증 | 값 |
|---|---|
| 페르소나1 자기자본 / 추가필요 / 월저축 | 2,000만 / 1,400만 / 583,334 |
| 슬라이더 월 70만 → 목표 도달 | 24개월 → **20개월 (−4)** |
| 페르소나2 부족액 | **81,000,000** = 6억 − (1.99억 + 3.2억) |
| 3.2억 / 3.55% / 30년 원리금균등 | **1,445,889원** |
| 신용대출 상환 이자절감 | 1,300,000 (2,500만 × 5.2%) |
| 정책 워터폴 | 🟢🟡🔴⚫ **4가지 상태 전부** 한 화면에 |
| 충동성 Planned Gate | 교육비 118,000원 ≤ 20점 < 다이소 1,000원 55점 |

---

## 설계상 중요한 판단 4가지

**1. 종료된 정책을 지우지 않고 `ENDED`로 남긴다.**
1세대 기획이 주력으로 밀던 중기청 전세대출·청년도약계좌가 지금은 종료 상태다.
이 둘이 워터폴에 ⚫로 뜨는 장면이 "다른 서비스는 아직도 이걸 추천합니다"의 근거가 된다.

**2. 만기 ↔ 목표시점 적합성을 별도 룰로 판정한다.**
청년미래적금은 자격이 되지만 3년 만기라 24개월 목표에 못 쓴다.
일반 자격 룰로는 절대 안 나오는 축이고, "받을 수 있는 정책"과 "내 목표에 쓸 수 있는 정책"이
다르다는 걸 보여주는 유일한 장면이다.

**3. 대표 정책은 한도가 큰 것이 아니라 검증된 것을 고른다.**
`verified: false`인 정책(수치 미확인)의 한도를 대표 숫자로 내세우면 신뢰가 깨진다.
`select_primary_loan()`이 검증 여부 → 자격 상태 → 금액 순으로 고른다.

**4. 충동성을 심리가 아니라 행동으로 정의한다.**
`"스트레스 때문에 사셨네요"`(검증 불가) 대신
`"야간 + 직전 결제 15분 후 + 재량지출"`(원본 거래로 확인 가능).
Planned Gate 덕분에 **1,000원짜리가 118,000원짜리보다 3배 높은 점수**를 받는다.

---

## ⚠️ 남은 작업 / 주의

- `fixtures/raw_card.txt`는 **실제 카드 명세로 보인다.** 의료 이용 기록·부분 마스킹된
  번호·생활 반경이 들어 있다. **깃 커밋과 팀 공유 금지.** 포맷의 지저분함(PG 접두,
  표기 분산, 개인 상호)만 유지하고 값은 합성할 것.
- 정책 레코드 중 `verified: false`(4건)는 공식 출처 검증이 필요하다. API 응답의
  `unverified_policies`가 이를 노출한다.
- 취득부대비용 요율은 의도적으로 비워뒀다 (`calculator.acquisition_costs`).
  세율을 코드에 박지 말고 정책 DB 조회값으로 넣을 것.
- 현재 더미 데이터는 2025-09 ~ 2026-02의 5개월인데 앞 구간이 듬성하다.
  시연에는 조밀한 구간(01/14~02/12)만 쓰는 편이 월 소비 추정에 정확하다.
- 밴드 경계(충동성·세션)는 이 96건에 맞춰 보정한 값이다. 데이터가 바뀌면 재보정할 것.

## 문서

[AI_ARCHITECTURE.md](docs/AI_ARCHITECTURE.md) · [CALC_ENGINE.md](docs/CALC_ENGINE.md) ·
[AI_FEATURES.md](docs/AI_FEATURES.md) · [IMPULSE_DESIGN.md](docs/IMPULSE_DESIGN.md) ·
[AI_FINTOX.md](docs/AI_FINTOX.md)
