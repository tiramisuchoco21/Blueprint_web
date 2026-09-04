/* ============================================================================
 * 청사진 · 신용 빌드업 (초안 5p "신용 빌드업 탭")
 *
 *  1) 비금융 신용 가점 Agent
 *     결제내역에서 통신비·보험료·공과금 자동납부를 찾아내
 *     KCB/NICE 비금융정보 반영 신청에 쓸 수 있는 정형 스크립트를 만든다.
 *  2) 청년 알뜰폰 요금제 매칭
 *     현재 통신비와 데이터 구간별 알뜰폰 가격대를 비교해 절감액을 계산한다.
 *  3) XP / 등급
 *     설계서 원칙에 따라 "대출 승인확률"이 아니라 실행 준비도로만 표현한다.
 *
 *  ⚠️ 하지 않는 것
 *   · 신용점수가 몇 점 오른다고 단정하지 않는다 (평가사 기준·반영 여부가 다름)
 *   · 특정 통신사 요금제를 확정 가격으로 제시하지 않는다 (구간 범위로만)
 * ========================================================================== */

/* 비금융 신용정보로 제출 가능한 항목 (평가사 공통으로 언급되는 범주) */
export const NON_FIN_ITEMS = [
  { key: 'telecom',  label: '이동통신 요금',   category: '통신',  keys: ['통신요금', 'lguplus', 'skt', 'kt ', '알뜰폰', 'lg유플러스'] },
  { key: 'insurance', label: '보험료',        category: '보험',  keys: ['보험', '화재해상', '생명'] },
  { key: 'utility',  label: '공과금·관리비',   category: null,   keys: ['도시가스', '한국전력', '전기요금', '수도', '관리비'] },
  { key: 'pension',  label: '국민연금·건강보험', category: null,   keys: ['국민연금', '건강보험', '공단'] },
];

const ymKey = (d) => `${new Date(d).getFullYear()}-${String(new Date(d).getMonth() + 1).padStart(2, '0')}`;

/* --------------------------------------------------------------------------
 * 1. 결제내역에서 성실납부 실적 탐지
 * ------------------------------------------------------------------------ */
export function detectNonFinancial(txs) {
  const found = [];
  for (const item of NON_FIN_ITEMS) {
    const hits = txs.filter((t) => {
      const s = `${t.merchant_raw} ${t.merchant_norm || ''}`.toLowerCase();
      if (item.category && t.category === item.category) return true;
      return item.keys.some((k) => s.includes(k));
    });
    if (!hits.length) { found.push({ ...item, found: false, months: 0, hits: [] }); continue; }

    const months = new Set(hits.map((h) => ymKey(h.occurred_at)));
    const sorted = [...hits].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
    const avg = Math.round(hits.reduce((s, h) => s + h.amount, 0) / hits.length);
    found.push({
      ...item, found: true, hits: sorted, months: months.size,
      latest: sorted[0], avgAmount: avg, provider: sorted[0].merchant_norm || sorted[0].merchant_raw,
    });
  }
  return found;
}

/* --------------------------------------------------------------------------
 * 2. 제출용 정형 스크립트 생성 (사용자가 복사해서 평가사에 제출)
 * ------------------------------------------------------------------------ */
export function buildSubmissionScript(profile, detected) {
  const usable = detected.filter((d) => d.found);
  if (!usable.length) return null;

  const lines = [
    '[비금융정보 반영 신청 자료]',
    `성명: ${profile.nickname}`,
    `생년월일: ${profile.birth_ymd}`,
    `주소지: ${profile.region_name || profile.zip_cd}`,
    '',
    '── 성실납부 실적 ──',
  ];
  usable.forEach((d, i) => {
    lines.push(
      `${i + 1}. ${d.label}`,
      `   납부처: ${d.provider}`,
      `   확인된 납부 개월수: ${d.months}개월 (등록 내역 기준)`,
      `   평균 납부액: ${d.avgAmount.toLocaleString()}원`,
      `   최근 납부일: ${new Date(d.latest.occurred_at).toISOString().slice(0, 10)}`,
    );
  });
  lines.push(
    '',
    '── 참고 ──',
    '· 위 내역은 본인이 입력한 결제 기록을 정리한 것이며, 실제 제출 시에는',
    '  통신사·보험사·공단이 발급한 납부확인서 원본이 필요합니다.',
    '· 가점 반영 여부와 폭은 신용평가사 내부 기준에 따라 달라집니다.',
  );
  return lines.join('\n');
}

export const BUREAUS = [
  { name: 'KCB 올크레딧', url: 'https://www.allcredit.co.kr', note: '비금융정보 등록 메뉴에서 통신·보험·공공요금 납부실적 제출' },
  { name: 'NICE 지키미', url: 'https://www.credit.co.kr', note: '비금융정보 반영 신청 메뉴 이용' },
];

/* --------------------------------------------------------------------------
 * 3. 알뜰폰 요금제 매칭
 * ------------------------------------------------------------------------ */
export function matchMvno(currentMonthlyBill, mvnoDb, tierKey = 'standard') {
  if (!currentMonthlyBill) return null;
  const tier = mvnoDb.tiers.find((t) => t.key === tierKey) || mvnoDb.tiers[1];
  const mid = Math.round((tier.price_min + tier.price_max) / 2);
  const saveMin = Math.max(0, currentMonthlyBill - tier.price_max);
  const saveMax = Math.max(0, currentMonthlyBill - tier.price_min);
  return {
    tier,
    current: currentMonthlyBill,
    expected: mid,
    saveMin, saveMax,
    saveYear: saveMin * 12,
    worthIt: saveMin > 3000,
    formula: `현재 ${currentMonthlyBill.toLocaleString()}원 − ${tier.label} ${tier.price_min.toLocaleString()}~${tier.price_max.toLocaleString()}원 = 월 ${saveMin.toLocaleString()}~${saveMax.toLocaleString()}원 절감`,
    source: { name: mvnoDb.meta.source_name, url: mvnoDb.meta.source_url, based_on: mvnoDb.meta.based_on, verified: mvnoDb.meta.verified },
    notice: mvnoDb.meta.notice,
  };
}

/* --------------------------------------------------------------------------
 * 4. XP / 등급
 *    설계서 11p Financial Execution Quest 항목을 그대로 사용한다.
 *    등급은 신용점수가 아니라 '실행 준비도'다. 이름과 문구로 그걸 못 박는다.
 * ------------------------------------------------------------------------ */
export const XP_PER_QUEST = 20;

export const TIERS = [
  { key: 'seed',     label: '씨앗',   min: 0,   color: '#94a3b8', desc: '목표를 세운 단계' },
  { key: 'sprout',   label: '새싹',   min: 40,  color: '#10b981', desc: '자격과 자금 구조를 확인한 단계' },
  { key: 'growth',   label: '성장',   min: 90,  color: '#2563eb', desc: '실행 준비가 절반을 넘은 단계' },
  { key: 'ready',    label: '실행',   min: 140, color: '#7c3aed', desc: '신청에 필요한 준비를 마친 단계' },
];

export function computeXP(checklist, detected, mvnoDone) {
  const quests = [];

  checklist.forEach((c) => quests.push({
    key: c.item_key, label: c.label, xp: XP_PER_QUEST, done: !!c.is_done, from: 'checklist',
  }));

  const telecom = detected.find((d) => d.key === 'telecom');
  const anyNonFin = detected.some((d) => d.found);
  quests.push({ key: 'nonfin_detect', label: '비금융 납부실적 확인', xp: XP_PER_QUEST, done: anyNonFin, from: 'credit' });
  quests.push({ key: 'nonfin_submit', label: '평가사 제출자료 생성', xp: XP_PER_QUEST, done: !!(telecom && telecom.found && telecom.months >= 1), from: 'credit' });
  quests.push({ key: 'mvno', label: '통신비 절감안 확인', xp: XP_PER_QUEST, done: !!mvnoDone, from: 'credit' });

  const earned = quests.filter((q) => q.done).reduce((s, q) => s + q.xp, 0);
  const total = quests.reduce((s, q) => s + q.xp, 0);

  let tier = TIERS[0];
  for (const t of TIERS) if (earned >= t.min) tier = t;
  const nextTier = TIERS.find((t) => t.min > earned) || null;

  return {
    quests, earned, total,
    pct: Math.round((earned / total) * 100),
    tier, nextTier,
    toNext: nextTier ? nextTier.min - earned : 0,
  };
}
