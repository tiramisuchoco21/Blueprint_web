/* ============================================================================
 * 청사진 · Rule Engine
 * 정책 자격 판정은 전부 여기서만 한다. LLM은 이 결과를 "설명"만 한다.
 *
 * 판정 결과 4단계 (온통청년 코드체계 기준)
 *   eligible      검토 가능   모든 핵심 요건 통과
 *   conditional   조건부      확인이 필요한 조건이 있거나 시점이 맞지 않음
 *   not_eligible  지원 어려움 핵심 요건 미충족
 *   ended         종료        aplyPrdSeCd=0057003(마감) 또는 종료일 경과
 * ========================================================================== */

export const VERDICT = {
  eligible:     { key: 'eligible',     label: '신청 가능', dot: '🟢', tone: 'green'  },
  conditional:  { key: 'conditional',  label: '조건부',    dot: '🟡', tone: 'yellow' },
  not_eligible: { key: 'not_eligible', label: '대상 아님',  dot: '🔴', tone: 'red'    },
  ended:        { key: 'ended',        label: '종료',      dot: '⚪', tone: 'gray'   },
};

/* 온통청년 코드값 (API코드정보.xlsx) */
export const CODE = {
  applyPeriod: { '0057001': '특정기간', '0057002': '상시', '0057003': '마감' },
  marriage:    { '0055001': '기혼', '0055002': '미혼', '0055003': '제한없음' },
  income:      { '0043001': '무관', '0043002': '연소득', '0043003': '기타' },
  job: {
    '0013001': '재직자', '0013002': '자영업자', '0013003': '미취업자', '0013004': '프리랜서',
    '0013005': '일용근로자', '0013006': '(예비)창업자', '0013007': '단기근로자',
    '0013008': '영농종사자', '0013009': '기타', '0013010': '제한없음',
  },
  school: {
    '0049001': '고졸 미만', '0049002': '고교 재학', '0049003': '고졸 예정', '0049004': '고교 졸업',
    '0049005': '대학 재학', '0049006': '대졸 예정', '0049007': '대학 졸업', '0049008': '석·박사',
    '0049009': '기타', '0049010': '제한없음',
  },
  sbiz: {
    '0014001': '중소기업', '0014002': '여성', '0014003': '기초생활수급자', '0014004': '한부모가정',
    '0014005': '장애인', '0014006': '농업인', '0014007': '군인', '0014008': '지역인재',
    '0014009': '기타', '0014010': '제한없음',
  },
};

const NO_LIMIT = { job: '0013010', school: '0049010', sbiz: '0014010', marriage: '0055003' };

/* ------------------------------- 유틸 ------------------------------------ */
export function koreanAge(birthYmd, today = new Date()) {
  const b = new Date(birthYmd);
  let age = today.getFullYear() - b.getFullYear();
  const m = today.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < b.getDate())) age -= 1;
  return age;
}
const won = (n) => n.toLocaleString('ko-KR') + '원';
const man = (n) => Math.round(n / 10000).toLocaleString('ko-KR') + '만 원';

/* 체크 항목 하나 */
function check(key, label, status, fact, detail) {
  return { key, label, status, fact: fact || null, detail: detail || null };
}
/* status: pass | fail | review | info | na */

/* --------------------------- 개별 조건 판정 ------------------------------- */

function checkApplyPeriod(policy, today) {
  const ap = policy.apply_period || {};
  const label = '신청기간';
  if (ap.code === '0057003') {
    return check('apply_period', label, 'ended',
      `신청기간구분 ${ap.code}(마감)`,
      ap.end ? `${ap.end} 부로 신규 지원이 종료되었습니다.` : '신규 지원이 종료되었습니다.');
  }
  /* 0057001(특정기간)은 회차 사업이므로 종료일이 지나도 '영구 종료'가 아니다.
     설계서의 "지금 불가해도 언제 가능해지는지" 원칙에 따라 다음 회차 대기로 본다. */
  if (ap.end && new Date(ap.end) < today) {
    if (ap.code === '0057001') {
      return check('apply_period', label, 'review', `직전 접수 ~ ${ap.end}`,
        '이번 회차 접수가 종료되었습니다. 다음 회차 모집 시 신청할 수 있습니다.');
    }
    return check('apply_period', label, 'ended', `종료일 ${ap.end}`, '접수 종료일이 지났습니다.');
  }
  if (ap.code === '0057001') {
    if (ap.start && new Date(ap.start) > today) {
      return check('apply_period', label, 'review',
        `접수 ${ap.start} ~ ${ap.end || '-'}`, '아직 접수 시작 전입니다. 시작일에 알림을 받도록 설정할 수 있습니다.');
    }
    return check('apply_period', label, 'pass', `접수 ${ap.start} ~ ${ap.end || '-'}`, '현재 접수 기간입니다.');
  }
  return check('apply_period', label, 'pass', ap.label || '상시', '상시 신청할 수 있습니다.');
}

function checkAge(policy, profile, today) {
  const a = policy.eligibility.age || {};
  if (a.min == null && a.max == null) return check('age', '연령', 'na');
  const age = koreanAge(profile.birth_ymd, today);
  const fact = `만 ${a.min ?? 0}세${a.max != null ? ` ~ 만 ${a.max}세` : ' 이상'}`;
  const ok = (a.min == null || age >= a.min) && (a.max == null || age <= a.max);
  return check('age', '연령', ok ? 'pass' : 'fail', fact, `현재 만 ${age}세`);
}

function checkIncome(policy, profile) {
  const e = policy.eligibility;
  if (e.income_cond_code === '0043001' || e.income_max == null) {
    return check('income', '소득', 'na', '소득 조건 무관');
  }
  /* 소득 상한이 결혼상태(신혼)에 따라 달라지는 상품이 있다.
     예) 보금자리론 일반 7,000만 / 신혼 8,500만 */
  let limit = e.income_max;
  let via = '';
  if (e.income_max_by && e.income_max_by[profile.marriage_code] != null) {
    limit = e.income_max_by[profile.marriage_code];
    via = ` (${CODE.marriage[profile.marriage_code]} 기준)`;
  }
  const ok = profile.annual_income <= limit;
  return check('income', '소득', ok ? 'pass' : 'fail',
    `연소득 ${man(limit)} 이하${via}`,
    `신고 연소득 ${man(profile.annual_income)}`);
}

function checkHomeowner(policy, profile) {
  if (policy.eligibility.homeowner_allowed !== false) return check('homeowner', '주택 보유', 'na');
  const ok = profile.is_homeowner === false;
  return check('homeowner', '주택 보유', ok ? 'pass' : 'fail',
    '무주택 세대주(또는 예정자)', ok ? '무주택으로 등록됨' : '주택 보유로 등록됨');
}

function checkRegion(policy, profile) {
  const regions = policy.eligibility.regions || [];
  if (!regions.length) return check('region', '거주지', 'na', '전국');
  const ok = regions.some((p) => (profile.zip_cd || '').startsWith(p));
  const names = regions.map((r) => (r === '11' ? '서울특별시' : r)).join(', ');
  return check('region', '거주지', ok ? 'pass' : 'fail', `${names} 거주`,
    profile.region_name || profile.zip_cd);
}

function codeCheck(key, label, allowed, mine, dict, noLimit) {
  if (!allowed || !allowed.length || allowed.includes(noLimit)) {
    return check(key, label, 'na', '제한없음');
  }
  const list = Array.isArray(mine) ? mine : [mine];
  const ok = allowed.some((c) => list.includes(c));
  return check(key, label, ok ? 'pass' : 'fail',
    allowed.map((c) => dict[c] || c).join(' / '),
    list.map((c) => dict[c] || c).join(' / ') || '해당 없음');
}

/* extra: 정책별 개별 조건. auto=false 면 사용자 확인 필요(조건부) */
function checkExtras(policy, profile, goal) {
  return (policy.eligibility.extra || []).map((x) => {
    if (!x.auto) return check(x.key, x.label, 'review', x.label, '신청 전 직접 확인이 필요합니다.');

    if (x.goal_types && goal && !x.goal_types.includes(goal.goal_type)) {
      return check(x.key, x.label, 'fail', x.label, '현재 목표 유형과 맞지 않습니다.');
    }
    if (x.max_target && goal && goal.target_amount > x.max_target) {
      return check(x.key, x.label, 'fail', x.label,
        `목표 금액 ${man(goal.target_amount)} > 기준 ${man(x.max_target)}`);
    }
    if (x.max_net_asset != null) {
      if (profile.net_asset == null) {
        return check(x.key, x.label, 'review', x.label, '순자산 정보가 없어 확인이 필요합니다.');
      }
      const ok = profile.net_asset <= x.max_net_asset;
      return check(x.key, x.label, ok ? 'pass' : 'fail', x.label,
        `신고 순자산 ${man(profile.net_asset)} ${ok ? '≤' : '>'} 기준 ${man(x.max_net_asset)}`);
    }
    if (x.min_months && goal && goal.target_months < x.min_months) {
      return check(x.key, x.label, 'review', x.label,
        `상품 만기 ${x.min_months}개월 > 목표 기간 ${goal.target_months}개월 — 시점이 맞지 않습니다.`);
    }
    return check(x.key, x.label, 'info', x.label);
  });
}

/* ------------------------------ 최종 판정 -------------------------------- */
export function judge(policy, profile, goal, today = new Date()) {
  const e = policy.eligibility;
  const checks = [
    checkApplyPeriod(policy, today),
    checkAge(policy, profile, today),
    checkIncome(policy, profile),
    checkHomeowner(policy, profile),
    checkRegion(policy, profile),
    codeCheck('marriage', '결혼 상태', e.marriage_codes, profile.marriage_code, CODE.marriage, NO_LIMIT.marriage),
    codeCheck('job', '취업 형태', e.job_codes, profile.job_code, CODE.job, NO_LIMIT.job),
    codeCheck('school', '학력', e.school_codes, profile.school_code, CODE.school, NO_LIMIT.school),
    codeCheck('sbiz', '특화 요건', e.sbiz_codes, profile.sbiz_codes || [], CODE.sbiz, NO_LIMIT.sbiz),
    ...checkExtras(policy, profile, goal),
  ];

  let verdict = 'eligible';
  if (checks.some((c) => c.status === 'ended')) verdict = 'ended';
  else if (checks.some((c) => c.status === 'fail')) verdict = 'not_eligible';
  else if (checks.some((c) => c.status === 'review')) verdict = 'conditional';

  const reason = summarize(verdict, checks);
  return {
    policy_id: policy.policy_id,
    verdict,
    label: VERDICT[verdict].label,
    dot: VERDICT[verdict].dot,
    reason,
    checks,
    amount: estimateAmount(policy, goal),
    source: policy.source,
  };
}

function summarize(verdict, checks) {
  if (verdict === 'ended') {
    const c = checks.find((x) => x.status === 'ended');
    return c.detail;
  }
  if (verdict === 'not_eligible') {
    const c = checks.find((x) => x.status === 'fail');
    return `${c.label} 요건 미충족 · ${c.detail}`;
  }
  if (verdict === 'conditional') {
    const c = checks.find((x) => x.status === 'review');
    return c.detail || `${c.label} 확인 필요`;
  }
  const passed = checks.filter((x) => x.status === 'pass').length;
  return `핵심 조건 ${passed}개를 모두 충족합니다.`;
}

/* ---------------------- 이 정책으로 확보 가능한 금액 ---------------------- */
export function estimateAmount(policy, goal) {
  const f = policy.finance || {};
  const target = goal ? goal.target_amount : 0;
  const months = goal ? goal.target_months : 0;

  switch (f.type) {
    case 'loan': {
      const byRatio = Math.floor(target * (f.ratio_of_target || 1));
      const value = Math.min(f.max_amount || Infinity, byRatio);
      return {
        role: 'policy_loan', value,
        formula: `min(상품한도 ${man(f.max_amount)}, 목표금액 ${man(target)} × ${Math.round((f.ratio_of_target || 1) * 100)}%) = ${man(value)}`,
        note: f.benefit_note,
      };
    }
    case 'grant': {
      const n = Math.min(f.months || 0, months || f.months || 0);
      const value = (f.monthly_amount || 0) * n;
      return {
        role: 'policy_benefit', value,
        formula: `월 ${man(f.monthly_amount)} × ${n}개월 = ${man(value)}`,
        note: f.benefit_note,
      };
    }
    case 'savings': {
      const n = Math.min((f.term_years || 0) * 12, months || 0);
      const value = Math.floor((f.monthly_limit || 0) * (f.gov_match_rate || 0) * n);
      return {
        role: 'future_fund', value,
        formula: `월 납입 ${man(f.monthly_limit)} × 정부지원율 ${Math.round((f.gov_match_rate || 0) * 100)}% × ${n}개월 = ${man(value)}`,
        note: f.benefit_note + ' (본인 납입금은 미래 예상자금에 별도 반영)',
      };
    }
    case 'tax':
      return { role: 'future_fund', value: 0, formula: '비과세 한도 적용 — 실현 이자에 따라 달라져 금액을 확정하지 않습니다.', note: f.benefit_note };
    case 'discount':
      return { role: 'cost_saving', value: 0, formula: '소비 내역을 입력하면 절감 예상액을 계산합니다.', note: f.benefit_note };
    default:
      return { role: 'none', value: 0, formula: '', note: '' };
  }
}

/* ======================== 중복 수혜 조합 판정 ==============================
 * 초안의 문제의식("중복 수혜 가능/불가 규정이 복잡")을 화면에 그대로 보여준다.
 *   rule "one"    같은 그룹에서 1개만 실행 가능 → 금액이 가장 큰 것만 적용
 *   rule "review" 동시 수혜 가능 여부 확인 필요 → 경고만, 계산은 유지
 *   그룹 없음      성격이 다르므로 합산
 * ========================================================================= */
export function resolveCombination(selected, groupsDef) {
  const byGroup = {};
  const conflicts = [];
  const applied = [];

  for (const s of selected) {
    const g = s.policy.exclusive_group;
    if (!g) { applied.push({ ...s, applied: true }); continue; }
    (byGroup[g] = byGroup[g] || []).push(s);
  }

  for (const [g, list] of Object.entries(byGroup)) {
    const def = groupsDef[g] || { rule: 'one', label: g, reason: '' };
    if (list.length === 1 || def.rule === 'review') {
      list.forEach((s) => applied.push({ ...s, applied: true }));
      if (list.length > 1) {
        conflicts.push({
          group: g, level: 'review', label: def.label, reason: def.reason,
          members: list.map((s) => s.policy.name),
          resolution: '두 정책을 모두 후보로 두되, 소관기관에 동시 수혜 가능 여부를 확인해야 합니다.',
        });
      }
      continue;
    }
    /* rule === 'one' : 신청 가능한 것 우선, 그중 활용액이 가장 큰 것 1개만 적용 */
    const sorted = [...list].sort((a, b) =>
      ORDER[a.verdict] - ORDER[b.verdict] || b.amount.value - a.amount.value);
    applied.push({ ...sorted[0], applied: true });
    sorted.slice(1).forEach((s) => applied.push({ ...s, applied: false }));
    conflicts.push({
      group: g, level: 'exclusive', label: def.label, reason: def.reason,
      members: list.map((s) => s.policy.name),
      resolution: `${sorted[0].policy.name}만 계산에 반영했습니다 (활용액이 가장 큼).`,
    });
  }
  return { applied, conflicts };
}

/* 목표 유형별로 볼 필요가 있는 정책 카테고리만 남긴다 */
export const GOAL_SCOPE = {
  jeonse:   ['housing_loan', 'housing_grant', 'asset_building', 'tax_benefit', 'living_discount'],
  purchase: ['purchase_loan', 'asset_building', 'tax_benefit', 'living_discount'],
  fund:     ['asset_building', 'tax_benefit', 'living_discount'],
  wedding:  ['purchase_loan', 'housing_loan', 'asset_building', 'tax_benefit', 'living_discount'],
};
export function filterByGoal(policies, goalType) {
  const scope = GOAL_SCOPE[goalType] || GOAL_SCOPE.jeonse;
  return policies.filter((p) => scope.includes(p.category));
}

/* 목록 전체 판정 + 정렬 (검토 가능 → 조건부 → 대상 아님 → 종료) */
const ORDER = { eligible: 0, conditional: 1, not_eligible: 2, ended: 3 };
export function judgeAll(policies, profile, goal, today = new Date()) {
  return policies
    .map((p) => ({ policy: p, ...judge(p, profile, goal, today) }))
    .sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || b.amount.value - a.amount.value);
}
