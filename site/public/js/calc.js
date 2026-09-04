/* ============================================================================
 * 청사진 · Financial Calculator
 * 금액 계산은 전부 여기서만 한다. LLM은 이 결과를 설명만 한다.
 * 모든 함수는 계산식(formula)을 함께 반환해서 화면에 근거를 그대로 노출한다.
 * ========================================================================== */

const man = (n) => Math.round(n / 10000).toLocaleString('ko-KR') + '만 원';
const eok = (n) => (n / 100000000).toFixed(n % 100000000 === 0 ? 0 : 2) + '억 원';
export const money = (n) => (Math.abs(n) >= 100000000 ? eok(n) : man(n));

/* 주택 취득 시 부대비용 (취득세·중개보수·법무비 개략치) */
const ACQUISITION_COST_RATE = 0.035;

/* ---------------------------------------------------------------------------
 * 1. 청사진(Blueprint) : 목표 자금 구조
 *    goal            { target_amount, target_months, current_asset, goal_type }
 *    appliedPolicies resolveCombination() 결과 중 applied === true 인 항목
 * ------------------------------------------------------------------------- */
export function buildBlueprint(goal, appliedPolicies) {
  const on = appliedPolicies.filter((p) => p.applied);

  const sum = (role) => on
    .filter((p) => p.amount.role === role)
    .reduce((s, p) => s + p.amount.value, 0);

  const policyLoan    = sum('policy_loan');    // 정책금융 활용가능 예상액
  const policyBenefit = sum('policy_benefit'); // 정책혜택 예상액 (지원금)
  const govMatch      = sum('future_fund');    // 정부기여금 등 미래 예상자금

  const target       = goal.target_amount;
  const currentAsset = goal.current_asset || 0;

  /* 필요 자기자본 = 목표 - 정책대출 - 정책혜택 */
  const requiredEquity = Math.max(0, target - policyLoan - policyBenefit);
  /* 추가로 모아야 하는 금액 = 필요 자기자본 - 현재자산 - 정부기여금 */
  const additionalNeeded = Math.max(0, requiredEquity - currentAsset - govMatch);

  const months = goal.target_months || 1;
  const recommendedMonthly = Math.round(additionalNeeded / months / 1000) * 1000;

  /* 부대비용 (주택 구입 목표에만) */
  const acquisitionCost = goal.goal_type === 'purchase'
    ? Math.round(target * ACQUISITION_COST_RATE) : 0;

  return {
    target, currentAsset, policyLoan, policyBenefit, govMatch,
    requiredEquity, additionalNeeded, recommendedMonthly, acquisitionCost,
    /* 목표 대응 가능 자원 (설계서의 상위 개념) */
    totalResource: currentAsset + policyLoan + policyBenefit + govMatch,
    wallet: [
      { key: 'current',  label: '보유 금융자산',        value: currentAsset,  status: '확보 완료',  tone: 'green' },
      { key: 'loan',     label: '정책금융 활용가능 예상액', value: policyLoan,    status: '검토 가능',  tone: 'blue'  },
      { key: 'benefit',  label: '정책혜택 예상액',       value: policyBenefit, status: '신청 필요',  tone: 'blue'  },
      { key: 'future',   label: '미래 예상자금',         value: additionalNeeded + govMatch, status: '저축 예정', tone: 'navy' },
    ],
    formula: {
      requiredEquity: `목표 ${money(target)} − 정책대출 ${money(policyLoan)}` +
        (policyBenefit ? ` − 정책혜택 ${money(policyBenefit)}` : '') + ` = ${money(requiredEquity)}`,
      additionalNeeded: `필요 자기자본 ${money(requiredEquity)} − 보유 ${money(currentAsset)}` +
        (govMatch ? ` − 정부기여금 ${money(govMatch)}` : '') + ` = ${money(additionalNeeded)}`,
      monthly: `${money(additionalNeeded)} ÷ ${months}개월 ≈ 월 ${money(recommendedMonthly)}`,
    },
  };
}

/* ---------------------------------------------------------------------------
 * 2. 달성 가능성 판정
 *    설계서의 차별점: "듣고 싶은 답이 아니라 가능한 답"
 * ------------------------------------------------------------------------- */
export function feasibility(goal, bp, monthlySaving) {
  const months = goal.target_months || 1;
  const saved = (monthlySaving || 0) * months;
  const reachable = bp.currentAsset + bp.policyLoan + bp.policyBenefit + bp.govMatch + saved;
  const need = bp.target + bp.acquisitionCost;
  const shortfall = need - reachable;

  let level, label, message;
  if (shortfall <= 0) {
    level = 'ok'; label = '달성 가능권';
    message = `현재 계획으로 목표 시점에 ${money(Math.abs(shortfall))} 여유가 예상됩니다.`;
  } else if (shortfall <= need * 0.05) {
    level = 'tight'; label = '추가자금 필요';
    message = `약 ${money(shortfall)}이 부족합니다. 기간 또는 월 저축액을 조정하면 도달할 수 있습니다.`;
  } else {
    level = 'hard'; label = '현재 계획으로는 어려움';
    message = `약 ${money(shortfall)}이 부족합니다${bp.acquisitionCost ? ' (취득 부대비용 포함)' : ''}. 목표 금액이나 기간을 조정하는 대안이 필요합니다.`;
  }
  return {
    level, label, message, shortfall, reachable, need,
    formula: `${money(need)} − (보유 ${money(bp.currentAsset)} + 정책 ${money(bp.policyLoan + bp.policyBenefit)} + 저축 ${money(saved)}) = ${shortfall > 0 ? money(shortfall) + ' 부족' : money(-shortfall) + ' 여유'}`,
  };
}

/* ---------------------------------------------------------------------------
 * 3. What-if 시뮬레이션
 * ------------------------------------------------------------------------- */
export function simulate(bp, goal, monthlySaving) {
  const target = goal.target_months || 1;
  if (!monthlySaving || monthlySaving <= 0) {
    return { monthsNeeded: Infinity, gapMonths: Infinity, level: 'hard', label: '계산 불가', message: '월 저축액을 입력해 주세요.' };
  }
  /* 보유자산 + 정책금융만으로 이미 목표에 닿는 경우 — 저축 기간이 0이다 */
  if (bp.additionalNeeded <= 0) {
    return {
      monthsNeeded: 0, gapMonths: -target, level: 'ok', ready: true,
      label: '지금 실행 가능',
      message: '추가 저축 없이 현재 자산과 정책금융만으로 목표 금액에 대응할 수 있습니다.',
      formula: `필요 자기자본 ${money(bp.requiredEquity)} ≤ 보유 ${money(bp.currentAsset)} — 추가 저축 불필요`,
    };
  }

  const monthsNeeded = Math.ceil(bp.additionalNeeded / monthlySaving);

  /* 저축 여력이 거의 없으면 수백 개월짜리 숫자가 나온다.
     'D-59961 (166년)' 같은 값을 화면에 내보내는 대신 계산 불가로 처리한다. */
  if (monthsNeeded > 600) {
    return {
      monthsNeeded: Infinity, gapMonths: Infinity, level: 'hard', unreachable: true,
      label: '현재 속도로는 도달 어려움',
      message: '저축으로 돌아가는 금액이 거의 없어 도달 시점을 계산하기 어렵습니다. 상환 비중을 낮추거나 목표를 조정해 보세요.',
      formula: `${money(bp.additionalNeeded)} ÷ 월 ${money(monthlySaving)} — 50년을 넘습니다`,
    };
  }

  const gap = monthsNeeded - target;

  let level, label, message;
  if (gap > 6)        { level = 'hard';  label = '지연';       message = `기존 목표보다 약 ${gap}개월 늦어집니다.`; }
  else if (gap > 0)   { level = 'tight'; label = '조정 필요';   message = `약 ${gap}개월 추가로 필요합니다.`; }
  else if (gap === 0) { level = 'ok';    label = '목표권';     message = '기존 목표 기간과 정확히 일치합니다.'; }
  else                { level = 'ok';    label = '조기 달성';   message = `기존 목표보다 약 ${Math.abs(gap)}개월 단축됩니다.`; }

  return {
    monthsNeeded, gapMonths: gap, level, label, message,
    formula: `${money(bp.additionalNeeded)} ÷ 월 ${money(monthlySaving)} = ${monthsNeeded}개월`,
  };
}

/* Plan A / Plan B 자동 산출 */
export function tradeoff(bp, goal, monthlySaving) {
  const sim = simulate(bp, goal, monthlySaving);
  return {
    A: {
      title: '기간을 지킨다',
      detail: `${goal.target_months}개월 목표를 유지하려면 월 ${money(bp.recommendedMonthly)}이 필요합니다.`,
      value: bp.recommendedMonthly,
      recommended: sim.gapMonths <= 0,
    },
    B: {
      title: '저축 부담을 낮춘다',
      detail: `월 ${money(monthlySaving)}을 유지하면 목표 시점이 ${sim.monthsNeeded}개월로 ${sim.gapMonths > 0 ? `약 ${sim.gapMonths}개월 연장` : '단축'}됩니다.`,
      value: sim.monthsNeeded,
      recommended: sim.gapMonths > 0,
    },
  };
}

/* ---------------------------------------------------------------------------
 * 4. 대시보드 진척률
 *    설계서 원칙에 따라 "승인 확률"이 아니라 두 축으로 분리해서 보여준다.
 *      savingProgress    실제 돈이 얼마나 모였는가
 *      readiness         실행에 필요한 준비가 얼마나 됐는가
 * ------------------------------------------------------------------------- */
/* 시작일 + N개월 → D-Day.
 * 설계서 8p: 월 저축액을 올리면 D-Day가 실제로 당겨져야 한다.
 * 그래서 '목표 D-Day'(기간 기준)와 '예상 D-Day'(저축 속도 기준)를 나눠서 계산한다. */
export function ddayFrom(startedOn, months) {
  /* months 가 Infinity/NaN 이면 Date 가 Invalid 가 되고 toISOString() 이 던진다.
     simulate() 는 도달 불가일 때 Infinity 를 돌려주므로 반드시 여기서 막아야 한다.
     (막지 않으면 슬라이더 입력 핸들러가 통째로 죽어 화면이 멈춘다) */
  if (!Number.isFinite(months)) {
    return { date: null, days: null, label: '—', ymd: '—', unknown: true };
  }
  const d = new Date(startedOn || Date.now());
  d.setMonth(d.getMonth() + Math.round(months || 0));
  if (Number.isNaN(d.getTime())) {
    return { date: null, days: null, label: '—', ymd: '—', unknown: true };
  }
  const days = Math.ceil((d - new Date()) / 86400000);
  return {
    date: d, days,
    label: days >= 0 ? `D-${days}` : `D+${Math.abs(days)}`,
    ymd: d.toISOString().slice(0, 10),
  };
}

export function progress(goal, bp, checklist, monthsNeeded) {
  const equityNeeded = Math.max(1, bp.requiredEquity);
  const savedNow = Math.min(bp.currentAsset, equityNeeded);
  const savingPct = Math.round((savedNow / equityNeeded) * 100);

  const total = checklist.length || 1;
  const done = checklist.filter((c) => c.is_done).length;
  const readinessPct = Math.round((done / total) * 100);

  const target = ddayFrom(goal.started_on, goal.target_months);
  const daysLeft = target.days;
  const elapsed = Math.max(0, (goal.target_months || 0) - Math.ceil(daysLeft / 30));

  /* 현재 저축 속도로 갔을 때 실제로 도달하는 시점 */
  const projected = (monthsNeeded && isFinite(monthsNeeded))
    ? ddayFrom(goal.started_on, monthsNeeded) : null;

  return {
    savingPct, savedNow, equityNeeded,
    readinessPct, done, total,
    daysLeft, dday: target.date, elapsedMonths: elapsed,
    ddayLabel: target.label,
    targetDday: target,
    projectedDday: projected,
    /* 예상 시점이 목표보다 며칠 늦는지 (+ 지연 / − 단축) */
    ddayGapDays: projected ? projected.days - target.days : 0,
    /* 목표 저축 대비 실제 진도 (앞서가는지 뒤처지는지) */
    onTrack: savingPct >= Math.round((elapsed / Math.max(1, goal.target_months)) * 100),
    formula: `보유 ${money(savedNow)} ÷ 필요 자기자본 ${money(equityNeeded)} = ${savingPct}%`,
  };
}

/* 대출 월 납입액 — 참고 표시용
 * 전세자금대출은 만기일시상환(이자만 납부)이 일반적이고,
 * 주택구입자금대출은 원리금균등 분할상환이 일반적이다.
 * 둘을 같은 식으로 계산하면 전세대출 월 부담이 실제의 20배로 부풀려진다. */
export function monthlyPayment(principal, annualRate, years, type = 'amortizing') {
  if (!principal) return { value: 0, label: '', note: '' };
  if (type === 'interest_only') {
    return {
      value: Math.round((principal * annualRate) / 12),
      label: '월 이자',
      note: '만기일시상환 · 원금은 만기에 상환(보증금 반환으로 충당)',
    };
  }
  const r = annualRate / 12;
  const n = (years || 30) * 12;
  const value = r === 0 ? Math.round(principal / n) : Math.round((principal * r) / (1 - Math.pow(1 + r, -n)));
  return { value, label: '월 상환액', note: `원리금균등 ${years || 30}년 상환 기준` };
}

/* ---------------------------------------------------------------------------
 * 5. 부채 : "갚는 것"과 "대출 끼고 사는 것"
 *
 *    지금까지 청사진은 더하기만 있었다 — 보유자산 + 정책대출 + 저축.
 *    기존 부채(학자금·신용대출)는 어디에도 빠지지 않았다.
 *
 *    두 축을 모두 다룬다.
 *      갚기      : 일시급 상환 / 월 상환액 배분 → 이자 절감, 완제 시점
 *      끼고 사기 : 신규 정책대출 실행 후 월 상환 부담(monthlyPayment)
 *
 *    debts = [{ kind, name, balance, rate, remaining_months }]
 * ------------------------------------------------------------------------- */
export const DEBT_LABEL = {
  student: '학자금대출', credit: '신용대출', card: '카드론·현금서비스',
  mortgage: '주택담보대출', jeonse: '전세자금대출', other: '기타 대출',
};

/* 부채 1건의 월 상환액.
 * 남은 개월수를 알면 원리금균등, 모르면 이자만 내는 것으로 본다.
 * (만기일시 신용대출이 여기 해당한다 — 원금이 저절로 줄지 않는다) */
export function debtMonthlyDue(d) {
  if (!d || !d.balance) return 0;
  if (d.monthly_payment != null) return d.monthly_payment;
  const rate = d.rate || 0;     // 금리 미입력(null)은 0으로 계산하되 조언에서는 제외한다
  if (d.remaining_months) return monthlyPayment(d.balance, rate, d.remaining_months / 12).value;
  return Math.round((d.balance * rate) / 12);
}

export function totalMonthlyDue(debts) {
  return (debts || []).reduce((s, d) => s + debtMonthlyDue(d), 0);
}

/* 상환 계획 — extraMonthly 를 얹으면 완제 시점과 총이자가 줄어든다 */
export function repaymentPlan(d, extraMonthly = 0) {
  const base = debtMonthlyDue(d);
  const pay = base + Math.max(0, extraMonthly);
  const r = d.rate / 12;
  const name = d.name || DEBT_LABEL[d.kind] || '대출';

  /* 월 상환액이 이자에도 못 미치면 원금이 영원히 줄지 않는다 */
  if (pay <= d.balance * r) {
    return { name, kind: d.kind, balance: d.balance, rate: d.rate, monthlyPayment: pay,
      monthsToClear: null, totalInterest: 0, interestOnly: true,
      formula: `월 ${money(pay)} ≤ 월 이자 ${money(Math.round(d.balance * r))} — 원금이 줄지 않습니다` };
  }
  const months = r === 0
    ? Math.ceil(d.balance / pay)
    : Math.ceil(-Math.log(1 - (r * d.balance) / pay) / Math.log(1 + r));
  const totalInterest = Math.max(0, Math.round(pay * months - d.balance));
  return { name, kind: d.kind, balance: d.balance, rate: d.rate, monthlyPayment: pay,
    monthsToClear: months, totalInterest, interestOnly: false,
    formula: `${money(d.balance)} 을 월 ${money(pay)}씩 → ${months}개월, 총이자 ${money(totalInterest)}` };
}

/* 일시급 상환 + 월 상환을 months 개월 동안 굴린 결과.
 * 금리가 높은 것부터 갚는다(avalanche) — 총이자가 가장 적어지는 순서다. */
export function applyRepayment(debts, { lumpsum = 0, monthlyRepay = 0, months = 0 } = {}) {
  const items = (debts || []).map((d) => ({ ...d, _bal: d.balance }));
  let cash = Math.max(0, lumpsum);
  let interestPaid = 0;
  let clearedMonth = null;

  /* 1) 일시급 — 금리 높은 것부터 */
  items.sort((a, b) => b.rate - a.rate);
  for (const it of items) {
    if (cash <= 0) break;
    const pay = Math.min(cash, it._bal);
    it._bal -= pay; cash -= pay;
  }
  const lumpsumUsed = Math.max(0, lumpsum) - cash;
  if (items.every((it) => it._bal <= 0)) clearedMonth = 0;   // 일시급만으로 완제

  /* 2) 매월 상환 */
  for (let m = 1; m <= months; m++) {
    let budget = monthlyRepay;
    for (const it of items) {
      if (it._bal <= 0) continue;
      const interest = (it._bal * it.rate) / 12;
      interestPaid += interest;
      const pay = Math.min(budget, it._bal + interest);
      budget -= pay;
      it._bal = Math.max(0, it._bal + interest - pay);
      if (budget <= 0) break;
    }
    if (clearedMonth === null && items.every((it) => it._bal <= 0)) clearedMonth = m;
  }

  /* 완제된 뒤에는 상환에 쓰던 돈이 그대로 남는다.
     이걸 저축으로 돌려주지 않으면 '갚을수록 목표가 무한히 멀어지는' 계산이 된다. */
  const freedTotal = clearedMonth !== null
    ? Math.round(monthlyRepay * Math.max(0, months - clearedMonth)) : 0;

  const remainingBalance = Math.round(items.reduce((s, it) => s + it._bal, 0));
  const monthlyDueAfter = totalMonthlyDue(
    items.filter((it) => it._bal > 0).map((it) => ({ ...it, balance: Math.round(it._bal) })),
  );

  /* 아무것도 안 갚았을 때 붙었을 이자와 비교 */
  const doNothing = (debts || []).reduce(
    (s, d) => s + (d.balance * d.rate / 12) * months, 0);

  return {
    lumpsumUsed, remainingBalance, clearedMonth, freedTotal,
    interestPaid: Math.round(interestPaid),
    interestSaved: Math.max(0, Math.round(doNothing - interestPaid)),
    monthlyDueAfter,
    formula: lumpsumUsed
      ? `일시급 ${money(lumpsumUsed)} + 월 ${money(monthlyRepay)} × ${months}개월 → 잔액 ${money(remainingBalance)}`
      : `월 ${money(monthlyRepay)} × ${months}개월 → 잔액 ${money(remainingBalance)}`,
  };
}

/* 상환 vs 저축 배분 비교 — 같은 월 가용액을 어떻게 나눌지 */
export function allocationScenarios(debts, goal, bp, monthlyAvailable, lumpsum = 0) {
  const months = goal.target_months || 1;
  const minDue = Math.min(totalMonthlyDue(debts), monthlyAvailable);
  const surplus = Math.max(0, monthlyAvailable - minDue);

  return [
    { key: 'save',    label: '저축 우선',  ratio: 0,   desc: '최소 상환만 하고 자기자본을 모읍니다' },
    { key: 'balance', label: '병행',      ratio: 0.5, desc: '최소 상환 + 여유분을 절반씩 나눕니다' },
    { key: 'repay',   label: '상환 우선',  ratio: 1,   desc: '빚부터 정리하고 그다음 저축합니다' },
  ].map((s) => {
    const toRepay = minDue + Math.round(surplus * s.ratio);
    const toSave = monthlyAvailable - toRepay;
    const rep = applyRepayment(debts, { lumpsum, monthlyRepay: toRepay, months });
    const equity = Math.max(0, (bp.currentAsset - rep.lumpsumUsed) + toSave * months);
    const reachable = equity + bp.policyLoan + bp.policyBenefit + bp.govMatch;
    const shortfall = Math.max(0, bp.target + bp.acquisitionCost - reachable);
    return {
      ...s, toRepay, toSave,
      clearedMonth: rep.clearedMonth, interestPaid: rep.interestPaid,
      remainingDebt: rep.remainingBalance,
      equity, shortfall, reachable: shortfall <= 0,
    };
  });
}

/* 부채 요약 — 화면 상단 카드용 */
export function debtSummary(debts, extraMonthly = 0) {
  const list = (debts || []).filter((d) => d && d.balance > 0);
  if (!list.length) return { has: false, totalBalance: 0, totalMonthly: 0, items: [] };
  const totalBalance = list.reduce((s, d) => s + d.balance, 0);
  const weightedRate = list.reduce((s, d) => s + d.balance * d.rate, 0) / totalBalance;
  return {
    has: true, totalBalance, weightedRate,
    totalMonthly: totalMonthlyDue(list),
    items: list.map((d) => repaymentPlan(d, extraMonthly)),
  };
}

/* ---------------------------------------------------------------------------
 * 6. 완납 vs 일부 상환 — 금리가 낮으면 서둘러 갚을 실익이 적다
 *
 *    학자금 1.7% 처럼 금리가 낮은 대출을 목돈으로 완납하면
 *    이자는 아끼지만 자기자본이 그만큼 줄어 목표가 늦어진다.
 *    어느 쪽이 유리한지는 "부채 금리 vs 저축의 기회비용"으로 갈린다.
 * ------------------------------------------------------------------------- */

/* 저축의 기회비용(연). 이 값보다 금리가 낮은 부채는 서둘러 갚을 실익이 적다고 본다.
 *
 * 예금 금리 수준으로 보수적으로 잡는다. 투자 수익률을 가정하지 않는다 —
 * 확정되지 않은 수익을 근거로 "갚지 마세요"라고 말할 수 없기 때문이다.
 * ('대출금 수정된 시나리오' 문서는 청년도약계좌 실질수익률 9.2%를 근거로 들지만,
 *  해당 상품은 신규가입이 종료됐고 확정 수익률 가정은 설계 원칙과 맞지 않는다.)
 *
 * 이 값을 바꾸면 repayAdvice 의 권고 방향이 바뀐다. 화면에도 함께 표시된다. */
export const SAVING_BENCHMARK_RATE = 0.03;

/* 일시급 상환 3단계 비교: 안 갚음 / 절반 / 완납 */
export function lumpsumScenarios(debts, goal, bp, monthlyRepay = 0, monthlySave = 0) {
  const months = goal.target_months || 1;
  const total = (debts || []).reduce((s, d) => s + d.balance, 0);
  const cash = bp.currentAsset;
  const cap = Math.min(cash, total);

  return [
    { key: 'none', label: '안 갚음', lump: 0, desc: '지금은 갚지 않고 목표 자금에 집중합니다' },
    { key: 'half', label: '일부 상환', lump: Math.round(cap / 2 / 100000) * 100000,
      desc: '절반만 갚아 이자와 목표를 나눠 챙깁니다' },
    { key: 'full', label: '완납', lump: cap,
      desc: cap >= total ? '지금 전액 상환합니다' : '보유 현금 전부로 갚습니다(완납은 아님)' },
  ].map((o) => {
    const rep = applyRepayment(debts, { lumpsum: o.lump, monthlyRepay, months });
    /* 완제 뒤에는 상환액이 저축으로 돌아온다 */
    const effSave = monthlySave + Math.round(rep.freedTotal / months);
    const equity = Math.max(0, (cash - rep.lumpsumUsed) + effSave * months);
    const reachable = equity + bp.policyLoan + bp.policyBenefit + bp.govMatch;
    const shortfall = Math.max(0, bp.target + bp.acquisitionCost - reachable);
    return {
      ...o, lumpUsed: rep.lumpsumUsed,
      interestSaved: rep.interestSaved, interestPaid: rep.interestPaid,
      remainingDebt: rep.remainingBalance, clearedMonth: rep.clearedMonth,
      equity, shortfall, reachable: shortfall <= 0,
    };
  });
}

/* 상환 우선순위 조언 — 규칙 기반. 확정적 표현을 쓰지 않는다. */
export function repayAdvice(debts, benchmark = SAVING_BENCHMARK_RATE) {
  const all = (debts || []).filter((d) => d.balance > 0);
  if (!all.length) return null;

  /* 금리를 모르는 부채로는 유불리를 말할 수 없다.
     0% 로 두면 "서둘러 갚을 실익 없음"이 되는데, 실제로는 카드론일 수도 있다. */
  const unknown = all.filter((d) => d.rate == null);      // 0% 무이자와 구분한다
  const list = all.filter((d) => d.rate != null);
  if (!list.length) {
    return { tone: 'unknown', headline: '금리를 입력하면 상환 순서를 계산해 드립니다',
      body: `${unknown.map((d) => d.name || DEBT_LABEL[d.kind] || '대출').join(' · ')}의 금리가 없습니다. `
        + '마이페이지에서 금리를 넣으면 갚는 것과 모으는 것 중 무엇이 유리한지 비교할 수 있습니다.' };
  }

  const high = list.filter((d) => d.rate > benchmark);
  const low = list.filter((d) => d.rate <= benchmark);
  const nameOf = (d) => d.name || DEBT_LABEL[d.kind] || '대출';

  if (high.length && !low.length) {
    return { tone: 'repay', headline: '먼저 갚는 쪽이 유리한 구간입니다',
      body: `${high.map(nameOf).join(' · ')}의 금리가 연 ${(Math.max(...high.map((d) => d.rate)) * 100).toFixed(1)}%로 `
        + `저축으로 기대할 수 있는 수준(연 ${(benchmark * 100).toFixed(0)}% 가정)보다 높습니다. `
        + '이자 부담을 먼저 줄이는 선택을 검토해 볼 수 있습니다.' };
  }
  if (low.length && !high.length) {
    return { tone: 'keep', headline: '서둘러 갚을 실익은 크지 않습니다',
      body: `${low.map(nameOf).join(' · ')}의 금리가 연 ${(Math.min(...low.map((d) => d.rate)) * 100).toFixed(1)}%로, `
        + `저축으로 기대할 수 있는 수준(연 ${(benchmark * 100).toFixed(0)}% 가정)보다 낮습니다. `
        + `완납하면 이자는 줄지만 자기자본이 그만큼 빠져 목표 시점이 늦어질 수 있습니다. `
        + '최소 상환을 유지하면서 목표 자금을 모으는 쪽도 합리적인 선택입니다.' };
  }
  const tail = unknown.length
    ? ` (${unknown.map(nameOf).join(' · ')}는 금리가 없어 비교에서 제외했습니다)` : '';
  return { tone: 'mixed', headline: '금리가 높은 것부터 갚는 것이 순서입니다',
    body: `${high.map(nameOf).join(' · ')}(높은 금리)를 먼저 정리하고, `
      + `${low.map(nameOf).join(' · ')}는 최소 상환을 유지하는 조합을 검토해 볼 수 있습니다.${tail}` };
}
