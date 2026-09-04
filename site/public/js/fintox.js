/* ============================================================================
 * 청사진 · FinTox (소비 위험 진단)
 *
 * 설계 원칙 — 팀 더미 데이터 96건 분석 결과를 그대로 반영
 *  1) 감정·심리를 확률로 단정하지 않는다. 전부 명시적 규칙 점수다.
 *  2) 카테고리별 감점을 하지 않는다.
 *     (더미 데이터의 지출 1위가 '금융투자교육원 등 교육/자격 52만 원'이었다.
 *      카테고리로 벌점을 주면 자기계발 지출이 '낭비'로 찍힌다.)
 *  3) '야간'보다 '단건 이상치'가 강한 신호다.
 *     (야간 금액 비중 41%는 단 1건(122만 원)이 만든 착시였고,
 *       그 건을 빼면 12.5%로 떨어진다. 야간 배점을 10점으로 낮게 둔 이유.)
 *  4) 판별 불가는 판별 불가라고 쓴다. 더미 데이터의 52%가 결제대행사 이름만
 *     남아 업종을 알 수 없었다. 추측하지 않고 사용자에게 태그를 받는다.
 * ========================================================================== */

/* ------------------------- 카테고리 규칙 --------------------------------- */
export const CATEGORY_RULES = [
  { cat: '카셰어링',     keys: ['쏘카', '피플카', '그린카'] },
  { cat: '택시',        keys: ['카카오t', '택시', '타다', 'uber'] },
  { cat: '대중교통',     keys: ['기후동행', '한국철도', '코레일', '티머니', '지하철', '버스'] },
  { cat: '주차',        keys: ['아이파킹', '파킹', '주차'] },
  { cat: '배달',        keys: ['쿠팡이츠', '배달의민족', '요기요', '배민'] },
  { cat: '카페/디저트',  keys: ['스타벅스', '카페', '커피', '베이커리', '바게트', '빽다방', '이디야', '투썸'] },
  { cat: '편의점',      keys: ['세븐일레븐', '지에스25', 'gs25', 'cu ', '이마트24', '씨유'] },
  { cat: '뷰티/드럭스토어', keys: ['올리브영', '올리브네트웍스'] },
  { cat: '생활잡화',     keys: ['다이소', '무신사', '아이파크몰', '신세계사이먼'] },
  { cat: '주류',        keys: ['와인앤모어', '주류', '이마트와인'] },
  { cat: '의료/약국',    keys: ['의원', '약국', '피부과', '병원', '치과', '한의원'] },
  { cat: '통신',        keys: ['lguplus', '통신요금', 'skt', 'kt ', '알뜰폰'] },
  { cat: '보험',        keys: ['화재해상', '보험'] },
  { cat: '교육/자격',    keys: ['교육원', '투자협회', '정보인증', '법원행정처', '학원', '에듀'] },
  { cat: '여행',        keys: ['투어', '타이드스퀘어', '야놀자', '여기어때', '항공'] },
  { cat: '외식',        keys: ['식당', '고기', '치킨', '분식', '국수', '라멘', '참치', '돈까스', '샤브'] },
];

/* 결제대행사만 남아 업종을 알 수 없는 케이스 (더미 데이터의 52%) */
export const PG_ONLY = ['네이버페이', '네이버파이낸셜', '카카오페이', '쿠팡', '토스페이', 'kcp', '이니시스', 'nice결제대행', '다우데이타', '인터넷상거래'];

export function normalizeMerchant(raw) {
  const stripped = raw
    .replace(/^\[.*?\]\s*/, '')
    .replace(/(NICE결제대행|KCP\(통신판매\)|이니시스\(빌링\)|이니시스_\d+|다우데이타|인터넷상거래|카카오페이|네이버페이)[-_]?/gi, '')
    .replace(/\(주\)|주식회사|㈜/g, '')
    .trim();
  /* 결제대행사 이름만 있던 건은 원문을 그대로 남긴다 (빈 이름으로 뭉치면 안 됨) */
  return stripped || raw.trim();
}

export function categorize(rawName) {
  const s = rawName.toLowerCase();
  for (const r of CATEGORY_RULES) {
    if (r.keys.some((k) => s.includes(k))) return { category: r.cat, source: 'rule' };
  }
  if (PG_ONLY.some((k) => s.includes(k.toLowerCase()))) {
    return { category: '업종 미상', source: 'unknown' };
  }
  return { category: '외식', source: 'guess' };
}

/* --------------------------- 문자/내역 파서 ------------------------------ */
/* 지원 형식
 *   [신한체크승인] 09/01 23:40 배달의민족 34,000원
 *   01/14 08:25 카카오페이_KPN-주식회사넌럭셔리어스컴 8,500원
 *   [Web발신] KB국민체크 09/01 23:40 34,000원 배달의민족
 */
const RE_DATE = /(\d{1,2})[./](\d{1,2})/;
const RE_TIME = /(\d{1,2}):(\d{2})/;
const RE_AMT = /([\d,]{3,})\s*원/;

export function parseLine(line, year = new Date().getFullYear()) {
  const raw = line.trim();
  if (!raw) return null;
  const d = raw.match(RE_DATE);
  const t = raw.match(RE_TIME);
  const a = raw.match(RE_AMT) || raw.match(/([\d,]{4,})\s*$/);
  if (!a) return null;

  const amount = parseInt(a[1].replace(/,/g, ''), 10);
  if (!amount || amount < 100) return null;

  let name = raw
    .replace(RE_DATE, ' ').replace(RE_TIME, ' ')
    .replace(a[0], ' ')
    .replace(/^\[.*?\]/, ' ')
    .replace(/(승인|취소|일시불|체크|신용|카드)\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!name) name = '미상';

  const month = d ? parseInt(d[1], 10) : new Date().getMonth() + 1;
  const day = d ? parseInt(d[2], 10) : new Date().getDate();
  const hour = t ? parseInt(t[1], 10) : 12;
  const min = t ? parseInt(t[2], 10) : 0;
  const occurred = new Date(year, month - 1, day, hour, min);

  const { category, source } = categorize(name);
  return {
    occurred_at: occurred.toISOString(),
    hour,
    merchant_raw: name,
    merchant_norm: normalizeMerchant(name),
    amount,
    category,
    category_source: source,
  };
}

export function parseBulk(text, year) {
  return text.split(/\r?\n/).map((l) => parseLine(l, year)).filter(Boolean);
}

/* ------------------------------ 점수 계산 -------------------------------- */
/* 배점 합계 100
 *   이상치 35 · 목표잠식 25 · 반복성 20 · 야간 10 · 예산소진 10          */
const W = { outlier: 35, goal: 25, repeat: 20, night: 10, burn: 10 };
const OUTLIER_MULTIPLE = 4.5;   // 개인 중앙값의 4.5배 = 더미 데이터 상위 10% 커트라인(66,000원)

export function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * @param tx        {amount, hour, merchant_norm, category}
 * @param ctx       {history:[tx], monthlyTarget, monthlyBudget}
 */
export function scoreTransaction(tx, ctx) {
  const history = ctx.history || [];
  const med = median(history.map((h) => h.amount)) || tx.amount;
  const monthlyTarget = ctx.monthlyTarget || 0;

  /* 1. 단건 이상치 */
  const outlierRatio = tx.amount / (med * OUTLIER_MULTIPLE);
  const outlier = Math.min(W.outlier, outlierRatio * W.outlier);

  /* 2. 목표 저축 잠식 */
  const goalShare = monthlyTarget ? tx.amount / monthlyTarget : 0;
  const goal = Math.min(W.goal, goalShare * W.goal);

  /* 3. 최근 30일 같은 가맹점 반복 */
  const cutoff = Date.now() - 30 * 86400000;
  const repeatCount = history.filter((h) =>
    h.merchant_norm === tx.merchant_norm && new Date(h.occurred_at).getTime() >= cutoff).length;
  const repeat = Math.min(W.repeat, repeatCount * 4);

  /* 4. 야간 결제 (22시~06시) */
  const isNight = tx.hour >= 22 || tx.hour < 6;
  const night = isNight ? W.night : 0;

  /* 5. 이번 달 예산 소진율 */
  const thisMonth = history.filter((h) => new Date(h.occurred_at).getMonth() === new Date(tx.occurred_at).getMonth());
  const spent = thisMonth.reduce((s, h) => s + h.amount, 0) + tx.amount;
  const budget = ctx.monthlyBudget || 0;
  const burn = budget ? Math.min(W.burn, (spent / budget) * W.burn) : 0;

  const score = Math.round(outlier + goal + repeat + night + burn);
  const level = score >= 65 ? 'caution' : score >= 35 ? 'watch' : 'safe';

  return {
    score,
    level,
    levelLabel: { safe: '양호', watch: '관찰 필요', caution: '주의' }[level],
    goalSharePct: monthlyTarget ? +(goalShare * 100).toFixed(1) : null,
    breakdown: [
      { key: 'outlier', label: '단건 이상치', point: +outlier.toFixed(1), max: W.outlier,
        fact: `평소 결제 중앙값 ${med.toLocaleString()}원의 ${(tx.amount / med).toFixed(1)}배` },
      { key: 'goal', label: '목표 저축 잠식', point: +goal.toFixed(1), max: W.goal,
        fact: monthlyTarget ? `월 저축목표 ${monthlyTarget.toLocaleString()}원의 ${(goalShare * 100).toFixed(1)}%` : '목표 미설정' },
      { key: 'repeat', label: '반복 결제', point: +repeat.toFixed(1), max: W.repeat,
        fact: `최근 30일 같은 곳에서 ${repeatCount}회` },
      { key: 'night', label: '야간 결제', point: night, max: W.night,
        fact: isNight ? `${tx.hour}시 결제` : '주간 결제' },
      { key: 'burn', label: '이번 달 예산 소진', point: +burn.toFixed(1), max: W.burn,
        fact: budget ? `${spent.toLocaleString()} / ${budget.toLocaleString()}원` : '예산 미설정' },
    ],
    tags: [
      isNight ? '야간 결제' : null,
      tx.category,
      monthlyTarget ? `월 저축목표 대비 ${(goalShare * 100).toFixed(1)}%` : null,
      repeatCount >= 3 ? `30일 내 ${repeatCount}회 반복` : null,
    ].filter(Boolean),
  };
}

/* ------------------------------- 넛지 저축 -------------------------------
 * 설계서 10p: "3,400원 10% 셀프저축"
 * 소비를 막는 대신, 쓴 만큼의 일부를 즉시 목표 저축으로 옮기게 한다.
 * 위험도가 높을수록 비율을 올리되 상한을 둬서 부담이 되지 않게 한다.
 * ----------------------------------------------------------------------- */
const NUDGE_RATE = { safe: 0.05, watch: 0.10, caution: 0.15 };
const NUDGE_CAP = 50000;

export function nudgeFor(tx, score) {
  const rate = NUDGE_RATE[score.level] || 0.1;
  const raw = tx.amount * rate;
  const amount = Math.min(NUDGE_CAP, Math.round(raw / 100) * 100);
  return {
    amount,
    rate,
    ratePct: Math.round(rate * 100),
    capped: raw > NUDGE_CAP,
    reason: {
      safe: '가벼운 지출입니다. 5%만 옮겨도 습관이 됩니다.',
      watch: '평소보다 큰 지출입니다. 10%를 목표 저축으로 옮겨 상쇄해 보세요.',
      caution: '목표에 영향이 큰 지출입니다. 15%를 옮겨 속도를 지키세요.',
    }[score.level],
    formula: `${tx.amount.toLocaleString()}원 × ${Math.round(rate * 100)}% = ${amount.toLocaleString()}원`,
  };
}

/** 넛지 저축 누적이 목표에 주는 효과 */
export function nudgeImpact(totalSaved, monthlySaving, additionalNeeded) {
  if (!totalSaved || !monthlySaving) return { days: 0, months: 0, pct: 0 };
  const months = totalSaved / monthlySaving;
  return {
    days: Math.round(months * 30),
    months: +months.toFixed(1),
    pct: additionalNeeded ? +(totalSaved / additionalNeeded * 100).toFixed(1) : 0,
  };
}

/* --------------------------- 월간 집계 리포트 ---------------------------- */
export function monthlyReport(history, ctx = {}) {
  if (!history.length) return null;
  const byCat = {};
  let night = 0, nightAmt = 0, unknown = 0;

  for (const h of history) {
    const c = (byCat[h.category] = byCat[h.category] || { count: 0, amount: 0 });
    c.count += 1; c.amount += h.amount;
    const hr = h.hour != null ? h.hour : new Date(h.occurred_at).getHours();
    if (hr >= 22 || hr < 6) { night += 1; nightAmt += h.amount; }
    if (h.category === '업종 미상') unknown += 1;
  }
  const total = history.reduce((s, h) => s + h.amount, 0);
  const categories = Object.entries(byCat)
    .map(([cat, v]) => ({ cat, ...v, pct: +(v.amount / total * 100).toFixed(1) }))
    .sort((a, b) => b.amount - a.amount);

  const merch = {};
  history.forEach((h) => {
    const m = (merch[h.merchant_norm] = merch[h.merchant_norm] || { count: 0, amount: 0 });
    m.count += 1; m.amount += h.amount;
  });
  const repeats = Object.entries(merch)
    .map(([name, v]) => ({ name, ...v }))
    .filter((m) => m.count >= 3)
    .sort((a, b) => b.count - a.count);

  return {
    count: history.length, total, median: median(history.map((h) => h.amount)),
    categories, repeats,
    night: { count: night, amount: nightAmt, pct: +(night / history.length * 100).toFixed(1) },
    unknownCount: unknown,
    unknownPct: +(unknown / history.length * 100).toFixed(1),
    monthlyTarget: ctx.monthlyTarget || 0,
  };
}

/* ======================= Smart Prescription ================================
 * 소비를 막는 대신 실질지출을 낮춘다. 정책 DB의 living_discount 정책과 연결.
 * ========================================================================= */
export function prescribe(report, policies, verdictByPolicy = {}) {
  if (!report) return [];
  const out = [];
  const catAmt = (name) => (report.categories.find((c) => c.cat === name) || {}).amount || 0;

  const transportSpend = catAmt('대중교통') + catAmt('택시');
  const carShare = catAmt('카셰어링');
  const dailySpend = catAmt('외식') + catAmt('카페/디저트') + catAmt('편의점') + catAmt('생활잡화');

  const find = (id) => policies.find((p) => p.policy_id === id);
  const usable = (id) => !verdictByPolicy[id] || ['eligible', 'conditional'].includes(verdictByPolicy[id]);

  /* 1) 교통 이중지출 — 더미 데이터에서 실제로 발견된 패턴 */
  const hasPass = report.repeats.some((r) => /기후동행|정기권/.test(r.name)) ||
    report.categories.some((c) => c.cat === '대중교통' && c.amount >= 50000);
  if (hasPass && carShare > 0) {
    out.push({
      type: 'warning',
      title: '교통비가 두 번 나가고 있습니다',
      body: `대중교통 정기권을 쓰면서 카셰어링에 ${carShare.toLocaleString()}원을 추가 지출했습니다. 정기권 사용 구간과 겹치는지 점검해 보세요.`,
      saving: Math.round(carShare * 0.4),
      basis: '정기권 보유 + 카셰어링 결제 동시 발생',
    });
  }

  /* 2) K-패스 */
  const kpass = find('kpass');
  if (kpass && usable('kpass') && transportSpend > 0) {
    const rate = kpass.finance.refund_rate_youth || 0.3;
    out.push({
      type: 'policy', policy_id: 'kpass',
      title: `${kpass.name} 연계`,
      body: `대중교통·택시 ${transportSpend.toLocaleString()}원 중 환급 대상 금액에 ${Math.round(rate * 100)}%가 환급됩니다.`,
      saving: Math.round(transportSpend * rate),
      basis: `${kpass.source.name} · 기준일 ${kpass.source.based_on}`,
      source: kpass.source,
    });
  }

  /* 3) 지역사랑상품권 */
  const lc = find('local_currency');
  if (lc && usable('local_currency') && dailySpend > 0) {
    const rate = lc.finance.discount_rate || 0.07;
    const limit = lc.finance.monthly_purchase_limit || Infinity;
    const applied = Math.min(dailySpend, limit);
    out.push({
      type: 'policy', policy_id: 'local_currency',
      title: `${lc.name} 결제로 전환`,
      body: `외식·카페·편의점·생활잡화 ${dailySpend.toLocaleString()}원 중 월 구매한도 ${limit.toLocaleString()}원까지 ${Math.round(rate * 100)}% 할인 구매할 수 있습니다.`,
      saving: Math.round(applied * rate),
      basis: `${lc.source.name} · 지자체별 할인율 상이`,
      source: lc.source,
    });
  }

  /* 4) 업종 미상 태깅 요청 */
  if (report.unknownPct >= 20) {
    out.push({
      type: 'action',
      title: `결제 ${report.unknownPct}%는 업종을 알 수 없습니다`,
      body: `${report.unknownCount}건이 결제대행사 이름만 남아 업종을 판별할 수 없습니다. 직접 분류해 주시면 더 정확한 혜택을 찾을 수 있습니다. 추측하지 않습니다.`,
      saving: 0,
      basis: '규칙 기반 분류 실패 건수',
    });
  }

  return out.sort((a, b) => b.saving - a.saving);
}
