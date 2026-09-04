# -*- coding: utf-8 -*-
"""카드 명세 텍스트 → fixtures/tx_dummy.json

PG 접두 제거 / 브랜드 정규화 / 카테고리 매핑 / 연도 추론 / 정기결제 탐지.
LLM이 필요한 지점은 category="unknown"으로 남긴다 (= AI 카테고라이저의 실제 작업량).

기본 입력은 fixtures/demo_card.txt (합성 데이터, 저장소에 포함).
다른 파일을 쓰려면:  python tools/build_fixture.py fixtures/raw_card.txt

⚠️ raw_card.txt 는 실제 카드 명세이므로 저장소에 커밋하지 않는다 (.gitignore).
"""
from __future__ import annotations
import json, re, sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# ── PG·간편결제 접두 (실제 가맹점을 가리는 문자열) ────────────────
PG_PATTERNS = [
    (r"^NICE결제대행-", "NICE"), (r"^이니시스[^-]*-", "이니시스"),
    (r"^카카오페이[_-]?[A-Z]*-?", "카카오페이"), (r"^네이버페이-", "네이버페이"),
    (r"^KCP\(통신판매\)-", "KCP"), (r"^다우데이타_카카오페이-", "다우데이타"),
    (r"^트라이씨클_카카오페이-", "트라이씨클"), (r"^인터넷상거래-", "인터넷상거래"),
]
# 접두를 떼고 나면 아무것도 안 남는 것들 = 가맹점 정보 부재
OPAQUE = {"네이버페이", "네이버파이낸셜"}

# ── 브랜드 정규화 (표기 분산 통합) ────────────────────────────────
BRAND_RULES: list[tuple[str, str]] = [
    (r"씨제이올리브(네트웍스|영)|올리브영", "올리브영"),
    (r"쏘카", "쏘카"), (r"피플카", "피플카"),
    (r"카카오T", "카카오T택시"), (r"세븐일레븐", "세븐일레븐"),
    (r"지에스25|GS25", "GS25"), (r"스타벅스", "스타벅스"),
    (r"쿠팡이츠", "쿠팡이츠"), (r"쿠팡", "쿠팡"),
    (r"아성다이소", "다이소"), (r"한국금융투자협회", "한국금융투자협회"),
    (r"금융투자교육원", "금융투자교육원"), (r"LGUPLUS", "LG유플러스"),
    (r"삼성화재", "삼성화재"), (r"기후동행", "기후동행카드"),
    (r"한국철도공사|코레일", "코레일"), (r"법원행정처", "법원행정처"),
    (r"무신사", "무신사"), (r"케이에프씨|KFC", "KFC"),
    (r"롯데리아", "롯데리아"), (r"한국정보인증", "한국정보인증"),
    (r"티머니", "티머니"), (r"배달의민족|배민", "배달의민족"),
]

# ── 카테고리 (브랜드 → 카테고리). 없으면 unknown = LLM 담당 ───────
CATEGORY: dict[str, str] = {
    "올리브영": "beauty", "쏘카": "car_sharing", "피플카": "car_sharing",
    "카카오T택시": "transport", "코레일": "transport", "기후동행카드": "transit_pass",
    "세븐일레븐": "convenience", "GS25": "convenience", "다이소": "shopping",
    "스타벅스": "cafe", "쿠팡이츠": "food_delivery", "쿠팡": "shopping",
    "무신사": "shopping", "KFC": "food_dining", "롯데리아": "food_dining",
    "한국금융투자협회": "education", "금융투자교육원": "education",
    "한국정보인증": "education", "LG유플러스": "telecom", "삼성화재": "insurance",
    "법원행정처": "admin", "티머니": "transport", "배달의민족": "food_delivery",
}
# 문자열만으로 사람이 바로 아는 것들 (사전에 없어도 룰로 잡히는 케이스)
KEYWORD_CATEGORY = [
    (r"약국", "health"), (r"의원|병원|피부과|외과", "health"),
    (r"카페|커피", "cafe"), (r"베이커리|바게트|파리|뚜레", "cafe"),
    (r"라멘|돈까스|냉면|참치|샤브|칼국수|치킨|수산|집$", "food_dining"),
    (r"아이파킹|주차", "transport"),
]


def strip_pg(name: str) -> tuple[str, str | None]:
    for pat, pg in PG_PATTERNS:
        if re.match(pat, name):
            return re.sub(pat, "", name).strip(), pg
    return name, None


def to_brand(name: str) -> str:
    for pat, brand in BRAND_RULES:
        if re.search(pat, name):
            return brand
    s = re.sub(r"\(주\)|주식회사|㈜", "", name)
    s = re.sub(r"\s*\d+\s*건$", "", s).strip()
    return s or name


def to_category(brand: str, raw: str) -> str:
    if brand in CATEGORY:
        return CATEGORY[brand]
    for pat, cat in KEYWORD_CATEGORY:
        if re.search(pat, raw) or re.search(pat, brand):
            return cat
    return "unknown"


def parse(path: Path) -> list[dict]:
    line_re = re.compile(r"^(\d{2})/(\d{2})\s+(\d{2}):(\d{2})\s+(.+?)\s+([\d,]+)원\s*$")
    rows, year, prev_md = [], 2026, None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        m = line_re.match(raw_line.strip())
        if not m:
            continue
        mo, d, h, mi, merchant, amt = m.groups()
        md = (int(mo), int(d))
        # 명세가 여러 블록으로 이어붙어 있어 연도가 명시돼 있지 않다.
        #  · 월이 +6 이상 앞으로 튀면  → 과거 블록이 새로 시작된 것 (02월 → 09월)
        #  · 월이 뒤로 가면            → 해가 바뀐 것 (12월 → 01월)
        if prev_md:
            if md[0] - prev_md[0] >= 6:
                year -= 1
            elif md < prev_md:
                year += 1
        prev_md = md
        stripped, pg = strip_pg(merchant.strip())
        brand = to_brand(stripped)
        rows.append({
            "id": len(rows) + 1,
            "at": f"{year}-{mo}-{d}T{h}:{mi}:00",
            "amount": int(amt.replace(",", "")),
            "merchant_raw": merchant.strip(),
            "brand": brand,
            "pg": pg,
            "opaque": brand in OPAQUE,
            "category": "unknown" if brand in OPAQUE else to_category(brand, stripped),
        })
    rows.sort(key=lambda r: r["at"])
    for i, r in enumerate(rows, 1):
        r["id"] = i
    return rows


def mark_recurring(rows: list[dict]) -> None:
    """동일 브랜드가 3회 이상 + 결제 간격이 20~40일에 몰리면 정기결제로 본다."""
    by_brand: dict[str, list[dict]] = defaultdict(list)
    for r in rows:
        by_brand[r["brand"]].append(r)
    for brand, items in by_brand.items():
        if len(items) < 3:
            continue
        ts = [datetime.fromisoformat(i["at"]) for i in items]
        gaps = [(b - a).days for a, b in zip(ts, ts[1:])]
        monthly = sum(1 for g in gaps if 20 <= g <= 40)
        if monthly >= len(gaps) / 2:
            for i in items:
                i["is_recurring"] = True
    for r in rows:
        r.setdefault("is_recurring", False)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        src = Path(sys.argv[1])
    else:
        # 로컬에 실제 명세가 있으면 그것을 쓰고, 없으면(저장소 클론 등) 합성본으로
        # 자동 폴백한다. raw_card.txt 는 .gitignore 로 저장소에 올라가지 않는다.
        real = ROOT / "fixtures" / "raw_card.txt"
        src = real if real.exists() else ROOT / "fixtures" / "demo_card.txt"
    if not src.is_absolute():
        src = ROOT / src
    print("source:", src.name)
    rows = parse(src)
    mark_recurring(rows)
    # 출력 파일을 소스에 따라 나눈다.
    #   실제 명세 → tx_dummy.json  (.gitignore, 로컬 전용)
    #   합성본    → tx_demo.json   (저장소에 포함)
    out = ROOT / "fixtures" / (
        "tx_demo.json" if src.name == "demo_card.txt" else "tx_dummy.json"
    )
    out.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")

    unknown = [r for r in rows if r["category"] == "unknown"]
    opaque = [r for r in rows if r["opaque"]]
    pg = [r for r in rows if r["pg"]]
    rec = [r for r in rows if r["is_recurring"]]
    report = [
        f"총 거래         : {len(rows)}건",
        f"기간            : {rows[0]['at'][:10]} ~ {rows[-1]['at'][:10]}",
        f"총액            : {sum(r['amount'] for r in rows):,}원",
        f"고유 브랜드     : {len({r['brand'] for r in rows})}개",
        f"PG 경유         : {len(pg)}건 ({100*len(pg)/len(rows):.0f}%)",
        f"가맹점 정보없음 : {len(opaque)}건  ← 룰로 영원히 해결 불가",
        f"카테고리 미상  : {len(unknown)}건 ({100*len(unknown)/len(rows):.0f}%)  ← LLM 담당분",
        f"정기결제 탐지   : {len(rec)}건",
        "",
        "── 카테고리 미상 목록 (LLM 카테고라이저가 처리할 대상) ──",
    ]
    seen = set()
    for r in unknown:
        if r["brand"] in seen:
            continue
        seen.add(r["brand"])
        report.append(f"  {r['merchant_raw']}")
    (ROOT / "fixtures" / "_build_report.txt").write_text("\n".join(report), encoding="utf-8")
    print("wrote", out)
