# -*- coding: utf-8 -*-
"""더미 카드 이용내역 → FinTox 규칙 근거 추출"""
import re, sys, collections, statistics
sys.stdout.reconfigure(encoding="utf-8")

RULES = [
    ("카셰어링", ["쏘카", "피플카", "그린카"]),
    ("택시", ["카카오T", "택시", "타다"]),
    ("대중교통", ["기후동행", "한국철도", "코레일", "티머니"]),
    ("주차", ["아이파킹", "파킹"]),
    ("배달", ["쿠팡이츠", "배달의민족", "요기요"]),
    ("카페/디저트", ["스타벅스", "카페", "커피", "바게트", "빽다방", "이디야"]),
    ("편의점", ["세븐일레븐", "지에스25", "GS25", "CU ", "이마트24"]),
    ("이커머스", ["쿠팡", "무신사", "네이버페이", "네이버파이낸셜", "ABLY", "와그", "e커머스", "트라이씨클"]),
    ("뷰티/드럭스토어", ["올리브영", "올리브네트웍스"]),
    ("생활잡화", ["다이소", "아이파크몰", "신세계사이먼", "소플러스"]),
    ("주류", ["와인앤모어", "신세계엘앤비"]),
    ("의료/약국", ["의원", "약국", "피부과", "병원"]),
    ("통신", ["LGUPLUS", "통신요금", "SKT", "KT "]),
    ("보험", ["화재해상", "보험"]),
    ("교육/자격", ["금융투자교육원", "금융투자협회", "한국정보인증", "법원행정처", "정한솔루션"]),
    ("여행", ["타이드스퀘어", "투어비스"]),
]


def categorize(name):
    for cat, keys in RULES:
        for k in keys:
            if k.lower() in name.lower():
                return cat
    return "외식"  # 나머지 상호는 대부분 식당


rows = []
for line in open("dummy_tx.txt", encoding="utf-8"):
    m = re.match(r"(\d\d)/(\d\d) (\d\d):(\d\d) (.+?) (\d+)$", line.strip())
    if not m:
        continue
    mm, dd, hh, mi, name, amt = m.groups()
    rows.append({
        "date": mm + "/" + dd, "hour": int(hh), "min": int(mi),
        "name": name.strip(), "amt": int(amt), "cat": categorize(name),
    })

print("총 건수:", len(rows), "| 총액: {:,}원".format(sum(r["amt"] for r in rows)))
amts = sorted(r["amt"] for r in rows)
print("금액 중앙값: {:,}원 | 평균: {:,}원 | 상위10%: {:,}원 이상 | 최대: {:,}원".format(
    statistics.median(amts), int(statistics.mean(amts)),
    amts[int(len(amts) * 0.9)], amts[-1]))

print("\n--- 시간대 분포 ---")
buckets = {"새벽(00-06)": 0, "오전(06-12)": 0, "오후(12-18)": 0, "저녁(18-22)": 0, "야간(22-24)": 0}
bamt = dict.fromkeys(buckets, 0)
for r in rows:
    h = r["hour"]
    k = ("새벽(00-06)" if h < 6 else "오전(06-12)" if h < 12 else
         "오후(12-18)" if h < 18 else "저녁(18-22)" if h < 22 else "야간(22-24)")
    buckets[k] += 1
    bamt[k] += r["amt"]
for k in buckets:
    print("  {:12s} {:3d}건 ({:4.1f}%)  {:>10,}원".format(
        k, buckets[k], buckets[k] / len(rows) * 100, bamt[k]))

print("\n--- 카테고리별 (금액순) ---")
cat = collections.defaultdict(lambda: [0, 0])
for r in rows:
    cat[r["cat"]][0] += 1
    cat[r["cat"]][1] += r["amt"]
total = sum(v[1] for v in cat.values())
for c, (n, s) in sorted(cat.items(), key=lambda x: -x[1][1]):
    print("  {:14s} {:3d}건  {:>9,}원  ({:4.1f}%)".format(c, n, s, s / total * 100))

print("\n--- 반복 결제처 (3회 이상) ---")
merch = collections.defaultdict(lambda: [0, 0])
for r in rows:
    key = re.sub(r"[(（].*", "", r["name"])
    for cat_name, keys in RULES:
        for k in keys:
            if k.lower() in r["name"].lower():
                key = k
                break
        else:
            continue
        break
    merch[key][0] += 1
    merch[key][1] += r["amt"]
for m_, (n, s) in sorted(merch.items(), key=lambda x: -x[1][0]):
    if n >= 3:
        print("  {:16s} {:2d}회  {:>8,}원".format(m_, n, s))

print("\n--- 1~2월 구간(주 데이터)만 재집계 ---")
main = [r for r in rows if r["date"] <= "02/12" and not (r["date"] in ("01/28", "02/01", "02/03") and r["amt"] > 80000)]
days = len(set(r["date"] for r in main))
print("  {}건 / {}일 / 총 {:,}원 → 일평균 {:,}원".format(
    len(main), days, sum(r["amt"] for r in main), sum(r["amt"] for r in main) // days))
night = [r for r in main if r["hour"] >= 22 or r["hour"] < 6]
print("  야간(22시~06시) {}건 ({:.1f}%), {:,}원".format(
    len(night), len(night) / len(main) * 100, sum(r["amt"] for r in night)))

TARGET = 583000
print("\n--- 월 저축목표 {:,}원 대비 단건 비중 상위 8건 ---".format(TARGET))
for r in sorted(rows, key=lambda x: -x["amt"])[:8]:
    print("  {} {:02d}:{:02d} {:28s} {:>9,}원  = 목표의 {:5.1f}%".format(
        r["date"], r["hour"], r["min"], r["name"][:28], r["amt"], r["amt"] / TARGET * 100))
