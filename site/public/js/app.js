/* ============================================================================
 * 청사진 · 메인 앱 컨트롤러
 * 해시 라우팅: #dashboard #step1 #step2 #step3 #step4 #step5 #history #policies #mypage
 * ========================================================================== */
import * as S from './store.js';
import { judgeAll, resolveCombination, filterByGoal, VERDICT, CODE, koreanAge } from './rules.js';
import { buildBlueprint, feasibility, simulate, tradeoff, progress, money, monthlyPayment, ddayFrom,
         debtSummary, applyRepayment, totalMonthlyDue, DEBT_LABEL,
         allocationScenarios, lumpsumScenarios, repayAdvice } from './calc.js';
import { renderDebtEditor, collectDebts, validateDebts } from './debtform.js';
import * as FT from './fintox.js';
import * as CR from './credit.js';
import { GOAL_LABEL } from './goalparse.js';
import { fetchYouthPolicies, regionQuery } from './ycapi.js';
import { makeIcs, downloadIcs, buildScheduleEvents } from './ics.js';
import { regionName } from './regions.js';

const $ = (s) => document.querySelector(s);
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h.trim(); return d.firstElementChild; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('ko-KR');

const STEPS = [
  { id: 'step1', n: 'STEP 1', title: '받을 수 있는 정책 찾기', sub: '4단계 판정 결과에서 적용할 정책을 고릅니다' },
  { id: 'step2', n: 'STEP 2', title: '필요한 돈 계산하기', sub: '목표 금액과 부족분을 확인합니다' },
  { id: 'step3', n: 'STEP 3', title: '저축 계획 시뮬레이션', sub: '정책을 비교하고 최종 하나를 확정합니다' },
  { id: 'step4', n: 'STEP 4', title: '소비 습관 진단', sub: '결제 내역으로 저축 방해 요소를 찾습니다 · 상시 이용' },
  { id: 'step5', n: 'STEP 5', title: '실행 로드맵', sub: '신청 시점까지 할 일을 관리합니다' },
];

const state = {
  user: null, profile: null, goal: null, mode: 'local',
  policies: [], groups: {}, judged: [], selected: new Set(), finalId: null,
  txs: [], checklist: [],
};

/* ============================== 부트 ====================================== */
async function boot() {
  const { mode } = await S.initStore();
  state.mode = mode;
  state.user = await S.currentUser();
  if (!state.user) { location.replace('./auth.html?mode=login'); return; }

  state.profile = await S.getProfile();
  /* 세션은 남아 있는데 프로필이 사라진 경우(저장소 초기화 등) — 로그인부터 다시 */
  if (!state.profile) { await S.signOut(); location.replace('./auth.html?mode=login'); return; }
  state.goal = await S.getActiveGoal();
  if (!state.goal) { location.replace('./index.html'); return; }

  const [db, mvno] = await Promise.all([
    (await fetch('./data/policies.json')).json(),
    (await fetch('./data/mvno.json')).json(),
  ]);
  state.policies = db.policies;
  state.groups = db.exclusive_groups;
  state.meta = db.meta;
  state.mvno = mvno;

  const saved = await S.getGoalPolicies(state.goal.id);
  saved.forEach((r) => state.selected.add(r.policy_id));
  const fin = saved.find((r) => r.is_final);
  state.finalId = fin ? fin.policy_id : null;

  state.txs = await S.getTransactions();
  state.checklist = await S.getChecklist(state.goal.id);

  rejudge();
  $('#avatar').textContent = (state.profile.nickname || '?').slice(0, 1);
  $('#avatar').addEventListener('click', () => (location.hash = '#mypage'));
  $('#dbInfo').innerHTML =
    `${esc(state.profile.nickname)} · ${esc(GOAL_LABEL[state.goal.goal_type] || '목표')}` +
    ` <span class="chip" style="margin-left:6px">${mode === 'supabase' ? '계정 연동' : '로컬 저장'}</span>` +
    ` <span class="chip" style="${S.aiEnabled() ? 'background:#ffedd5;color:#c2410c' : ''}">${S.aiEnabled() ? 'AI 연결됨' : 'AI 미연결'}</span>` +
    ` <span class="chip" style="${S.policyApiEnabled() ? 'background:#dcfce7;color:#15803d' : ''}">${S.policyApiEnabled() ? '정책 API 사용 가능' : `정책 DB ${state.policies.length}종`}</span>`;

  window.addEventListener('hashchange', route);
  route();
}

function rejudge() {
  const scoped = filterByGoal(state.policies, state.goal.goal_type);
  state.judged = judgeAll(scoped, state.profile, state.goal, new Date());
}

/* 현재 선택(또는 확정)된 정책으로 청사진 계산 */
function currentPlan() {
  const ids = state.finalId ? [state.finalId] : [...state.selected];
  const chosen = state.judged.filter((r) => ids.includes(r.policy_id));
  const comb = resolveCombination(chosen, state.groups);
  const bp = buildBlueprint(state.goal, comb.applied);
  return { comb, bp, chosen };
}

/* ============================== 라우팅 ==================================== */
const done = {
  get step1() { return state.selected.size > 0; },
  get step2() { return state.selected.size > 0; },
  get step3() { return !!state.finalId; },
};

function route() {
  const hash = (location.hash || '#dashboard').slice(1);
  renderGoalbar();
  renderSteps(hash);
  document.querySelectorAll('#gnb a').forEach((a) =>
    a.classList.toggle('on', a.getAttribute('href') === '#' + hash));

  const v = $('#view');
  v.innerHTML = '';
  ({
    dashboard: viewDashboard, step1: viewStep1, step2: viewStep2, step3: viewStep3,
    step4: viewStep4, step5: viewStep5, credit: viewCredit,
    history: viewHistory, policies: viewPolicies, mypage: viewMypage,
  }[hash] || viewDashboard)(v);
  window.scrollTo(0, 0);
}

function renderSteps(active) {
  $('#steps').innerHTML = STEPS.map((s) => {
    const locked = (s.id === 'step2' && !done.step1) || (s.id === 'step3' && !done.step2) || (s.id === 'step5' && !done.step3);
    return `<button data-go="${s.id}" class="${active === s.id ? 'on' : ''}" ${locked ? 'disabled title="이전 단계를 먼저 완료해 주세요"' : ''}>
      <span class="n">${s.n}</span>${s.title}</button>`;
  }).join('');
  $('#steps').querySelectorAll('[data-go]').forEach((b) =>
    b.addEventListener('click', () => (location.hash = '#' + b.dataset.go)));
}

function renderGoalbar() {
  const g = state.goal;
  /* 목표 바는 모든 화면 상단에 뜬다. 보유 자산과 부채를 여기에 함께 적어
     어느 단계에서든 "내 조건이 이랬지"를 다시 확인할 수 있게 한다. */
  const gd = debtSummary((state.profile && state.profile.debts) || []);
  $('#goalbar').innerHTML = `<div class="goalbar">
    <span>🎯 분석 목표: “${esc(g.raw_input || `${money(g.target_amount)} ${GOAL_LABEL[g.goal_type] || ''}`)}”</span>
    <span class="goalbar-facts">
      <span class="gb-chip">보유 자산 <b>${money(g.current_asset || 0)}</b></span>
      ${gd.has
        ? `<span class="gb-chip debt" title="${esc(gd.items.map((it) => `${it.name} ${money(it.balance)}`
            + (it.rate != null ? ` 연 ${(it.rate * 100).toFixed(1)}%` : ' 금리 미입력')).join(' · '))}">
             보유 부채 <b>${money(gd.totalBalance)}</b>
             <span class="gb-sub">${gd.items.map((it) => esc(it.name)
               + (it.rate != null ? ` ${(it.rate * 100).toFixed(1)}%` : '')).join(' · ')}</span>
           </span>`
        : `<span class="gb-chip">보유 부채 <b>없음</b></span>`}
    </span>
    <a class="edit" href="./index.html">목표 바꾸기</a>
  </div>`;
}

/* =========================== 공통 조각 ==================================== */
/* 신뢰 레이어 배지. AI가 실제로 동작할 때만 AI ADVICE 를 켠다.
   (키가 없는데 AI ADVICE 를 띄우면 화면이 거짓말을 하게 된다) */
const trustBar = () => `<div class="trust">
  <span class="t-fact">FACT</span><span class="t-calc">CALCULATION</span>
  ${S.aiEnabled() ? '<span class="t-ai">AI ADVICE</span>' : '<span class="chip">AI 미연결 · 규칙 기반</span>'}
</div>`;

/* ---------------------------------------------------------------------------
 * AI 설명 채우기
 *  · 규칙 기반 결과는 이미 화면에 있고, AI는 그 위에 "해석"만 얹는다.
 *  · 키가 없거나 실패해도 화면은 완결된 상태를 유지한다.
 *  · AI가 만든 문장에만 AI 배지를 붙여 출처를 구분한다.
 * ------------------------------------------------------------------------- */
async function fillAI(mountId, task, data) {
  const box = document.getElementById(mountId);
  if (!box) return;
  if (!S.aiEnabled()) {
    box.innerHTML = `<div class="src" style="margin-top:10px">AI 키가 설정되지 않아 규칙 기반 설명만 표시합니다.</div>`;
    return;
  }
  box.innerHTML = `<div class="src" style="margin-top:10px"><span class="spin"></span> AI가 결과를 해석하는 중…</div>`;
  try {
    const r = await fetch('/api/ai', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, data }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.text) {
      const e = new Error(j.message || j.error || `서버 응답 ${r.status}`);
      e.hint = j.hint;
      throw e;
    }
    box.innerHTML = `<div class="card" style="box-shadow:none;margin-top:12px;background:#fffdf8;border-color:#ffedd5">
      <span class="chip" style="background:#ffedd5;color:#c2410c;font-weight:800">AI ADVICE</span>
      <div style="margin-top:9px;font-size:13.5px;color:var(--tx);line-height:1.7">${esc(j.text)}</div>
      <div class="src">계산·판정은 코드가 수행했고, 위 문장은 그 결과를 해석한 것입니다</div>
    </div>`;
  } catch (e) {
    box.innerHTML = `<div class="warn" style="margin-top:10px">
      <b>AI 해석을 불러오지 못했습니다.</b> 위 규칙 기반 판정과 계산은 그대로 유효합니다.
      <div style="font-size:11px;margin-top:6px;opacity:.9">사유: ${esc(String(e.message).slice(0, 240))}</div>
      ${e.hint ? `<div style="font-size:11px;margin-top:6px;font-weight:700">👉 ${esc(e.hint)}</div>` : ''}
    </div>`;
  }
}

function sourceLine(src) {
  if (!src) return '';
  return `<div class="src">출처: <a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a>
    · 기준일 ${esc(src.based_on)}
    ${src.verified
      ? '· <b style="color:#15803d">원문 대조 완료</b>'
      : '· <b style="color:#b45309">검증 전 — 신청 전 원문 확인 필요</b>'}
    ${src.note ? `<div style="margin-top:3px">${esc(src.note)}</div>` : ''}</div>`;
}

const disclaimer = `<div class="src" style="margin-top:14px">
  ※ 표시 금액은 <b>상품상 최대한도 기준 1차 자격검토 결과</b>이며 승인·확정 금액이 아닙니다.
  실제 금액은 신청 시점의 은행·보증기관·정책 기준에 따라 달라질 수 있습니다.</div>`;

/* ---------------------------------------------------------------------------
 * 페이지네이션 — 목록이 길어지면 공지사항처럼 10개씩 끊어 보여준다.
 *   mount      결과를 그릴 요소
 *   items      전체 항목 배열
 *   renderItem 항목 1개 → HTML 문자열
 *   wrap       항목들을 감싸는 껍데기 (표는 <table>…로 감싼다)
 * ------------------------------------------------------------------------- */
function paginate(mount, items, renderItem, opts) {
  const o = opts || {};
  const perPage = o.perPage || 10;
  const wrap = o.wrap || ((h) => h);
  const unit = o.unit || '건';
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  let page = 1;

  function pageButtons() {
    /* 1 … 4 5 [6] 7 8 … 20 형태로 최대 7개 노출 */
    const out = [];
    const push = (p) => out.push(
      `<button data-page="${p}" class="${p === page ? 'on' : ''}">${p}</button>`);
    const dots = () => out.push('<span class="dots">…</span>');

    if (pages <= 7) {
      for (let p = 1; p <= pages; p++) push(p);
    } else if (page <= 4) {
      for (let p = 1; p <= 5; p++) push(p);
      dots(); push(pages);
    } else if (page >= pages - 3) {
      push(1); dots();
      for (let p = pages - 4; p <= pages; p++) push(p);
    } else {
      push(1); dots();
      for (let p = page - 1; p <= page + 1; p++) push(p);
      dots(); push(pages);
    }
    return out.join('');
  }

  function draw() {
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    mount.innerHTML = wrap(slice.map(renderItem).join('')) + (pages > 1 ? `
      <div class="pager">
        <button data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹ 이전</button>
        ${pageButtons()}
        <button data-page="${page + 1}" ${page === pages ? 'disabled' : ''}>다음 ›</button>
      </div>
      <div class="pager-info">전체 ${items.length}${unit} 중 ${start + 1}–${start + slice.length}${unit} · ${page}/${pages} 페이지</div>
    ` : `<div class="pager-info">전체 ${items.length}${unit}</div>`);

    mount.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => {
      const p = Number(b.dataset.page);
      if (!p || p < 1 || p > pages || p === page) return;
      page = p;
      draw();
      mount.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }
  draw();
}

/* ======================== STEP 1 · 정책 판정 ============================== */
function viewStep1(v) {
  /* 판정 근거가 되는 내 조건을 맨 위에 요약한다 — 부채도 여기서부터 보인다 */
  const d1 = debtSummary((state.profile && state.profile.debts) || []);

  const rows = state.judged.map((r) => {
    const on = state.selected.has(r.policy_id);
    const pick = ['eligible', 'conditional'].includes(r.verdict);
    return `<tr data-id="${r.policy_id}" class="${on ? 'sel' : ''} ${pick ? '' : 'off'}">
      <td>${pick ? `<input type="checkbox" ${on ? 'checked' : ''} data-ck="${r.policy_id}">` : ''}</td>
      <td><span class="badge ${VERDICT[r.verdict].tone}">${r.dot} ${r.label}</span></td>
      <td class="nm">${esc(r.policy.name)}${r.policy.is_policy ? '' : ' <span class="chip">민간</span>'}</td>
      <td style="color:var(--muted)">${esc(r.reason)}</td>
      <td class="amt">${r.amount.value ? money(r.amount.value) : '—'}</td>
    </tr>
    <tr class="detail hide" data-detail="${r.policy_id}"><td colspan="5" style="background:#f8fafc;padding:0">
      <div style="padding:16px 18px">
        <div style="font-size:13px;font-weight:800;color:var(--navy);margin-bottom:10px">왜 이렇게 판정했나요?</div>
        <div class="grid2" style="gap:8px">${r.checks.filter((c) => c.status !== 'na').map(checkChip).join('')}</div>
        ${r.amount.formula ? `<div class="note" style="margin-top:12px">🧮 ${esc(r.amount.formula)}</div>` : ''}
        <button class="btn ghost sm" style="margin-top:10px" data-ai="${r.policy_id}">AI에게 이 판정 설명 듣기</button>
        <div id="ai-${r.policy_id}"></div>
        ${sourceLine(r.source)}
      </div></td></tr>`;
  }).join('');

  v.append(el(`<section class="card">
    <div class="card-h">
      <div><div class="card-t">STEP 1 · 받을 수 있는 정책 찾기</div></div>
      <button class="btn" id="doneSel">선택 완료</button>
    </div>
    <p class="card-sub">적용하고 싶은 정책을 <b>여러 개</b> 고를 수 있습니다. 행을 누르면 판정 근거가 펼쳐집니다.
      <span class="badge blue" style="margin-left:6px">신청 가능 · 조건부만 선택할 수 있습니다</span></p>

    <div style="display:flex;gap:7px;flex-wrap:wrap;margin:0 0 14px">
      ${[
        ['목표', money(state.goal.target_amount) + ' · ' + state.goal.target_months + '개월'],
        ['보유 자산', money(state.goal.current_asset || 0)],
        ['연 소득', money(state.profile.annual_income)],
        ['거주지', state.profile.region_name || '-'],
      ].map(([l, val]) => `<span class="chip">${l} <b style="color:var(--navy)">${esc(val)}</b></span>`).join('')}
      ${d1.has
        ? `<span class="chip" style="background:#fff5f5;border-color:#f2c7c7">
             보유 부채 <b style="color:var(--red)">${money(d1.totalBalance)}</b>
             <span style="opacity:.75">· ${d1.items.map((it) => `${esc(it.name)} 연 ${(it.rate * 100).toFixed(1)}%`).join(' · ')}</span>
           </span>`
        : `<span class="chip">보유 부채 <b style="color:var(--navy)">없음</b></span>`}
      <a class="chip" href="#mypage" style="text-decoration:none;color:var(--blue)">조건 수정 →</a>
    </div>
    <table class="wf">
      <thead><tr><th style="width:44px"></th><th style="width:110px">상태</th><th>정책명</th><th>판정 의미</th><th style="width:120px">예상 활용액</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div id="conflict"></div>
    ${disclaimer}
  </section>`));

  v.querySelectorAll('tbody tr[data-id]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.dataset.ck) return;
    const d = v.querySelector(`[data-detail="${tr.dataset.id}"]`);
    d.classList.toggle('hide');
  }));

  /* 판정 근거를 AI가 풀어서 설명 (요청할 때만 호출) */
  v.querySelectorAll('[data-ai]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = state.judged.find((x) => x.policy_id === b.dataset.ai);
    b.disabled = true;
    fillAI(`ai-${r.policy_id}`, 'explain_verdict', {
      정책명: r.policy.name, 판정: r.label, 사유: r.reason,
      예상활용액: r.amount.value, 계산식: r.amount.formula,
      조건별_검토결과: r.checks.filter((c) => c.status !== 'na')
        .map((c) => ({ 항목: c.label, 결과: c.status, 기준: c.fact, 내값: c.detail })),
      사용자상황: { 만나이: koreanAge(state.profile.birth_ymd), 연소득: state.profile.annual_income,
        거주지: state.profile.region_name, 무주택: !state.profile.is_homeowner },
    });
  }));
  v.querySelectorAll('[data-ck]').forEach((c) => c.addEventListener('change', () => {
    c.checked ? state.selected.add(c.dataset.ck) : state.selected.delete(c.dataset.ck);
    c.closest('tr').classList.toggle('sel', c.checked);
    showConflicts();
  }));
  showConflicts();

  $('#doneSel').addEventListener('click', async () => {
    if (!state.selected.size) { alert('적용할 정책을 1개 이상 선택해 주세요.'); return; }
    const rows = state.judged.filter((r) => state.selected.has(r.policy_id))
      .map((r) => ({ policy_id: r.policy_id, verdict: r.verdict, applied_amount: r.amount.value, is_final: r.policy_id === state.finalId }));
    await S.setGoalPolicies(state.goal.id, rows);
    location.hash = '#step2';
  });

  function showConflicts() {
    const { comb } = currentPlan();
    $('#conflict').innerHTML = comb.conflicts.map((c) => `
      <div class="${c.level === 'exclusive' ? 'warn' : 'note'}" style="margin-top:12px">
        <b>${c.level === 'exclusive' ? '⚠️ 중복 수혜 불가' : '❓ 중복 확인 필요'} · ${esc(c.label)}</b><br>
        ${esc(c.reason)}<br>선택: ${c.members.map(esc).join(' / ')}<br>→ ${esc(c.resolution)}
      </div>`).join('');
  }
}

function checkChip(c) {
  const icon = { pass: '✅', fail: '❌', review: '⚠️', ended: '⛔', info: 'ℹ️' }[c.status] || '·';
  const color = { pass: 'var(--green-tx)', fail: 'var(--red-tx)', review: 'var(--yellow-tx)', ended: 'var(--slate-tx)' }[c.status] || 'var(--muted)';
  return `<div style="background:#fff;border:1px solid var(--bd);border-radius:8px;padding:9px 12px;font-size:12px">
    <span style="color:${color};font-weight:700">${icon} ${esc(c.label)}</span>
    ${c.fact ? `<div style="color:var(--muted2);font-size:11px;margin-top:3px">기준: ${esc(c.fact)}</div>` : ''}
    ${c.detail ? `<div style="color:var(--muted);font-size:11px;margin-top:2px">${esc(c.detail)}</div>` : ''}
  </div>`;
}

/* ======================== STEP 2 · 청사진 ================================= */
function viewStep2(v) {
  const { bp, comb } = currentPlan();
  const g = state.goal;
  const pct = (n) => Math.min(100, Math.round((n / Math.max(1, bp.target)) * 100));

  /* 보유 부채 — 목표 자금 계산과는 별개 계정으로 다룬다.
     목표 자기자본에서 빼버리면 "빚이 있으니 전세를 못 간다"는 잘못된 판정이 된다.
     대신 순자산과 상환 계획을 함께 보여주고, 실제 상환은 STEP 3 에서 조절한다. */
  const dSum2 = debtSummary((state.profile && state.profile.debts) || []);

  v.append(el(`<section class="card">
    <div class="card-h"><div class="card-t">STEP 2 · 필요한 돈 계산하기</div>
      <span class="tag">${comb.applied.filter((a) => a.applied).map((a) => esc(a.policy.short_name)).join(' + ') || '선택 없음'}</span></div>

    <div class="grid4">
      <div class="stat"><div class="l">목표 금액</div><div class="v">${money(bp.target)}</div></div>
      <div class="stat"><div class="l">정책금융 활용가능 예상액</div><div class="v blue">${money(bp.policyLoan)}</div><div class="f">확정 아님 · 검토 가능</div></div>
      <div class="stat"><div class="l">목표 자기자본</div><div class="v">${money(bp.requiredEquity)}</div></div>
      <div class="stat"><div class="l">현재 보유 자산</div><div class="v green">${money(bp.currentAsset)}</div>
        ${dSum2.has ? `<div class="f">부채 ${money(dSum2.totalBalance)} 별도</div>` : ''}</div>
    </div>

    <div style="background:var(--slate-bg);border-radius:12px;padding:18px;margin-top:16px">
      <div style="font-weight:700;font-size:14px;margin-bottom:12px">목표 자금 구조 (Goal Funding Map)</div>
      ${[
        ['보유 금융자산 (확보 완료)', bp.currentAsset, 'var(--green)'],
        ['향후 저축 (필요 자기자본)', bp.additionalNeeded, 'var(--navy)'],
        ['정책금융 활용 예상', bp.policyLoan, 'var(--blue)'],
        ...(bp.policyBenefit ? [['정책혜택 예상액', bp.policyBenefit, 'var(--blue2)']] : []),
      ].map(([l, val, c]) => `<div style="margin-bottom:11px">
        <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600;margin-bottom:4px">
          <span>${l}</span><span>${money(val)}</span></div>
        <div class="bar"><i style="width:${pct(val)}%;background:${c}"></i></div>
      </div>`).join('')}
    </div>

    ${dSum2.has ? `
    <div class="card" style="margin-top:16px;box-shadow:none;border-color:#f2c7c7;background:#fffafa">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <div style="font-size:14px;font-weight:800;color:var(--navy)">보유 부채</div>
        <div style="font-size:18px;font-weight:800;color:var(--red)">${money(dSum2.totalBalance)}</div>
      </div>
      <div style="display:grid;gap:6px;margin-top:10px">
        ${dSum2.items.map((it) => `<div style="display:flex;justify-content:space-between;font-size:12.5px">
          <span style="color:var(--muted)">${esc(it.name)} · 연 ${(it.rate * 100).toFixed(1)}% · 월 ${num(it.monthlyPayment)}원</span>
          <b style="color:var(--navy)">${money(it.balance)}</b></div>
          <div style="font-size:11px;color:var(--muted2);margin-top:-2px">${esc(it.interestOnly
            ? '만기일시 · 이자만 내면 원금이 줄지 않습니다'
            : `현재 속도로 ${it.monthsToClear}개월 · 총이자 ${money(it.totalInterest)}`)}</div>`).join('')}
      </div>
      <div class="note" style="margin-top:12px">
        부채는 <b>목표 자금 계산과 분리</b>해서 관리합니다.
        빚이 있다고 전세 자체가 불가능해지는 것은 아니기 때문입니다.
        다만 순자산은 <b>${money(Math.max(0, bp.currentAsset - dSum2.totalBalance))}</b>
        (보유 ${money(bp.currentAsset)} − 부채 ${money(dSum2.totalBalance)})이고,
        매달 ${num(dSum2.totalMonthly)}원이 상환에 나갑니다.
        <div style="font-size:11px;opacity:.85;margin-top:6px">
          얼마를 갚고 얼마를 모을지는 <b>STEP 3 시뮬레이션</b>에서 조절할 수 있습니다.</div>
      </div>
    </div>` : ''}

    <div class="card" style="margin-top:16px;box-shadow:0 4px 16px rgba(37,99,235,.05);border-color:#e0e7ff">
      ${trustBar()}
      <div style="font-size:17px;font-weight:800;color:var(--navy);margin-bottom:8px">
        핵심 결론 · ${money(bp.target)}을 전부 현금으로 모을 필요는 없습니다.</div>
      <div style="font-size:14px;color:#334155;line-height:1.6">
        정책금융을 <b>${money(bp.policyLoan)}</b>으로 가정하면 필요한 자기자본은 <b>${money(bp.requiredEquity)}</b>입니다.
        현재 ${money(bp.currentAsset)}이 있으므로 <b>추가 ${money(bp.additionalNeeded)} · 월 약 ${num(bp.recommendedMonthly)}원</b>이 핵심 실행목표입니다.
      </div>
      <div class="note" style="margin-top:12px">
        🧮 ${esc(bp.formula.requiredEquity)}<br>🧮 ${esc(bp.formula.additionalNeeded)}<br>🧮 ${esc(bp.formula.monthly)}
      </div>
    </div>
    <div id="aiBlueprint"></div>
    ${disclaimer}
    <div style="display:flex;gap:10px;margin-top:18px">
      <button class="btn ghost" id="back1">정책 다시 고르기</button>
      <button class="btn" id="go3" style="flex:1">확인했어요 · 시뮬레이션 해보기</button>
    </div>
  </section>`));

  $('#back1').addEventListener('click', () => (location.hash = '#step1'));
  $('#go3').addEventListener('click', () => (location.hash = '#step3'));

  /* 계산이 끝난 뒤 AI에게 "그래서 뭘 해야 하는지" 해석만 요청한다 */
  fillAI('aiBlueprint', 'explain_blueprint', {
    목표금액: bp.target, 정책금융_활용가능_예상액: bp.policyLoan,
    정책혜택_예상액: bp.policyBenefit, 필요_자기자본: bp.requiredEquity,
    현재_보유자산: bp.currentAsset, 추가로_모아야_하는_금액: bp.additionalNeeded,
    권장_월저축액: bp.recommendedMonthly, 목표기간_개월: g.target_months,
    적용정책: comb.applied.filter((a) => a.applied).map((a) => a.policy.name),
    계산식: bp.formula,
  });
}

/* ======================== STEP 3 · 시뮬레이션 ============================= */
function viewStep3(v) {
  const g = state.goal;
  const picked = [...state.selected];

  /* 탐색용 목표 금액 — 저장하지 않는다. 확정하려면 아래 버튼을 눌러야 한다. */
  let simTarget = state.simTarget || g.target_amount;
  let saving = g.monthly_saving || 0;

  /* ── 부채 : 갚는 축 ─────────────────────────────────────────────────
     debts 는 프로필에 있다. 없으면 상환 UI 전체를 숨긴다. */
  const debts = (state.profile && state.profile.debts) || [];
  const dSum = debtSummary(debts);
  const minDue = totalMonthlyDue(debts);
  let lump = 0;                 // 일시급 상환액 (보유 현금에서)
  let repay = Math.min(minDue, saving);   // 월 상환액 (최소 상환에서 시작)

  /* 목표금액 / 월저축액을 바꿨을 때 전체를 다시 계산한다.
     목표금액이 바뀌면 정책 판정 자체가 달라진다(예: 주택가격 상한 조건). */
  function planFor(targetAmount, monthlySaving, lumpsum = 0, monthlyRepay = 0) {
    /* 일시급 상환은 보유 현금에서 빠져나간다 — 자기자본이 그만큼 줄어든다.
       월 상환액은 저축으로 갈 돈을 나눠 쓰는 것이므로 monthlySaving 이 이미 차감된 값이다. */
    const months = g.target_months || 1;
    const gg = { ...g, target_amount: targetAmount,
      current_asset: Math.max(0, (g.current_asset || 0) - lumpsum) };
    const judged = judgeAll(filterByGoal(state.policies, g.goal_type), state.profile, gg, new Date());
    const chosen = judged.filter((r) => picked.includes(r.policy_id));
    const comb = resolveCombination(chosen, state.groups);
    const bp = buildBlueprint(gg, comb.applied);
    const sim = simulate(bp, gg, monthlySaving);
    const fe = feasibility(gg, bp, monthlySaving);
    const rep = applyRepayment(debts, { lumpsum, monthlyRepay, months });
    return {
      gg, judged, comb, bp, sim, fe, rep,
      dday: ddayFrom(g.started_on, sim.monthsNeeded),
      targetDday: ddayFrom(g.started_on, g.target_months),
    };
  }

  const base = planFor(g.target_amount, Math.max(1, (saving || 1) - repay), lump, repay);
  if (!saving) saving = Math.max(100000, base.bp.recommendedMonthly);

  /* 일시급 상환 상한 = 보유 현금과 총 부채 중 작은 쪽 */
  const lumpMax = Math.min(g.current_asset || 0, dSum.totalBalance || 0);

  const step = g.target_amount >= 100000000 ? 10000000 : 1000000;
  const tMin = Math.max(step, Math.round(g.target_amount * 0.4 / step) * step);
  const tMax = Math.round(g.target_amount * 1.6 / step) * step;

  v.append(el(`<section class="card">
    <div class="card-h"><div class="card-t">STEP 3 · 저축 계획 시뮬레이션</div><span class="tag">실시간 계산</span></div>
    <p class="card-sub">목표 금액과 월 저축액을 움직이면 <b>도달 시점(D-Day)과 정책 판정이 즉시 다시 계산됩니다.</b>
      비교해 보고 실행할 정책 하나를 확정하세요.</p>

    <div id="explore"></div>

    <div class="grid2" style="align-items:start;margin-top:4px">
      <div class="card" style="box-shadow:none">
        <div class="mini">WHAT-IF SIMULATOR</div>

        <div style="margin-top:14px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <label style="font-size:12px;font-weight:700;color:var(--muted)">목표 금액</label>
            <b id="tv" style="font-size:17px;color:var(--navy)">${money(simTarget)}</b>
          </div>
          <input type="range" id="tSl" min="${tMin}" max="${tMax}" step="${step}" value="${simTarget}"
            style="width:100%;accent-color:var(--navy);margin-top:6px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted2)">
            <span>${money(tMin)}</span><span>${money(tMax)}</span></div>
        </div>

        <div style="margin-top:18px">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <label style="font-size:12px;font-weight:700;color:var(--muted)">월 저축액</label>
            <b id="sv" style="font-size:17px;color:var(--navy)">${num(saving)}원</b>
          </div>
          <input type="range" id="sSl" min="100000" max="3000000" step="10000" value="${saving}"
            style="width:100%;accent-color:var(--blue);margin-top:6px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted2)">
            <span>10만 원</span><span>300만 원</span></div>
          ${dSum.has ? `<div style="font-size:11px;color:var(--muted2);margin-top:4px">
            저축과 대출 상환에 나눠 쓰는 금액입니다.</div>` : ''}
        </div>

        ${dSum.has ? `
        <div style="margin-top:18px;padding-top:18px;border-top:1px dashed var(--bd)">
          <div class="mini" style="margin-bottom:10px">DEBT · 대출금 갚기</div>

          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <label style="font-size:12px;font-weight:700;color:var(--muted)">지금 일시급으로 갚기</label>
            <b id="lv" style="font-size:17px;color:var(--navy)">${num(lump)}원</b>
          </div>
          <input type="range" id="lSl" min="0" max="${lumpMax}" step="100000" value="${lump}"
            style="width:100%;accent-color:var(--red);margin-top:6px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted2)">
            <span>0원</span><span>${money(lumpMax)}</span></div>
          <div style="font-size:11px;color:var(--muted2);margin-top:4px">
            보유 현금 ${money(g.current_asset || 0)} 중에서 지금 상환합니다. 자기자본이 그만큼 줄어듭니다.</div>

          <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:baseline">
            <label style="font-size:12px;font-weight:700;color:var(--muted)">월 상환액</label>
            <b id="rv" style="font-size:17px;color:var(--navy)">${num(repay)}원</b>
          </div>
          <input type="range" id="rSl" min="${minDue}" max="${saving}" step="10000" value="${repay}"
            style="width:100%;accent-color:var(--red);margin-top:6px">
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted2)">
            <span>최소 ${money(minDue)}</span><span>${money(saving)}</span></div>
          <div id="splitBox" style="margin-top:8px"></div>
        </div>` : ''}

        <div id="ddayBox" style="margin-top:18px"></div>
        <div id="simres" style="margin-top:12px"></div>
      </div>

      <div><div id="rightCol"></div>${dSum.has ? '<div id="debtBox" style="margin-top:14px"></div>' : ''}</div>
    </div>

    <div style="margin-top:20px">
      <div class="mini" style="margin-bottom:8px">정책별 비교 · 실행할 하나를 확정하세요</div>
      <div id="cmp" class="grid2"></div>
      <div id="companion"></div>
    </div>
    ${disclaimer}
  </section>`));

  /* ------------------------------ 렌더 ---------------------------------- */
  function redraw() {
    /* 월 가용액을 상환/저축으로 나눈다. 상환분은 저축에서 빠진다. */
    repay = Math.max(minDue, Math.min(repay, saving));
    const netSaving = Math.max(0, saving - repay);
    /* 완제 이후에는 상환에 쓰던 돈이 저축으로 돌아온다.
       목표 기간 전체로 평균 낸 '실효 저축액'으로 도달 시점을 계산한다. */
    const months0 = g.target_months || 1;
    const pre = applyRepayment(debts, { lumpsum: lump, monthlyRepay: repay, months: months0 });
    const effSaving = netSaving + Math.round(pre.freedTotal / months0);
    const cur = planFor(simTarget, effSaving, lump, repay);
    const changed = simTarget !== g.target_amount;

    $('#tv').textContent = money(simTarget);
    $('#sv').textContent = num(saving) + '원';
    if (dSum.has) {
      $('#lv').textContent = num(lump) + '원';
      $('#rv').textContent = num(repay) + '원';
      const rs = $('#rSl');
      if (rs && Number(rs.max) !== saving) { rs.max = saving; rs.value = repay; }
      renderDebt(cur, netSaving, effSaving);
    }

    $('#explore').innerHTML = changed ? `
      <div class="warn" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span>🔍 탐색 중 · 목표를 <b>${money(g.target_amount)} → ${money(simTarget)}</b>으로 가정하고 계산했습니다. 아직 저장되지 않았습니다.</span>
        <span style="display:flex;gap:8px">
          <button class="btn ghost sm" id="resetTarget">원래대로</button>
          <button class="btn sm" id="applyTarget">이 금액으로 목표 변경</button>
        </span>
      </div>` : '';

    /* D-Day — 목표 기간 기준과 저축 속도 기준을 나란히 */
    const unknownDday = cur.dday.unknown || cur.dday.days === null;
    const gapDays = unknownDday ? null : cur.dday.days - cur.targetDday.days;
    const tone = unknownDday ? 'var(--red)' : gapDays > 0 ? 'var(--red)' : gapDays < 0 ? 'var(--green)' : 'var(--blue)';
    $('#ddayBox').innerHTML = unknownDday ? `
      <div class="stat" style="text-align:left;background:#fff;border-color:var(--red)">
        <div class="l">예상 도달 시점 (현재 저축 속도 기준)</div>
        <div style="font-size:19px;font-weight:800;color:var(--red);margin-top:4px">계산할 수 없음</div>
        <div class="f" style="margin-top:6px">${esc(cur.sim.message || '저축으로 돌아가는 금액이 거의 없습니다.')}</div>
      </div>` : `
      <div class="stat" style="text-align:left;background:#fff;border-color:${tone}">
        <div class="l">예상 도달 시점 (현재 저축 속도 기준)</div>
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-top:4px">
          <div style="font-size:${cur.sim.ready ? 24 : 32}px;font-weight:800;color:${cur.sim.ready ? 'var(--green)' : tone}">
            ${cur.sim.ready ? '지금 실행 가능' : esc(cur.dday.label)}</div>
          <div style="font-size:12px;color:var(--muted)">
            ${cur.sim.ready ? '추가 저축 없이 목표 금액에 대응 가능' : `${esc(cur.dday.ymd)} · 약 ${cur.sim.monthsNeeded}개월`}</div>
        </div>
        <div class="f" style="margin-top:6px">
          목표 D-Day ${esc(cur.targetDday.label)} (${esc(cur.targetDday.ymd)}) 대비
          <b style="color:${cur.sim.ready ? 'var(--green)' : tone}">${cur.sim.ready
            ? `${cur.targetDday.days}일 앞당김`
            : gapDays === 0 ? '동일' : gapDays > 0 ? `${gapDays}일 지연` : `${Math.abs(gapDays)}일 단축`}</b>
        </div>
      </div>`;

    $('#simres').innerHTML = `<div class="${cur.sim.level === 'ok' ? 'note' : 'warn'}">
      <b>${esc(cur.sim.label)}</b> · ${esc(cur.sim.message)}
      <div style="font-size:11px;opacity:.85;margin-top:6px">🧮 ${esc(cur.sim.formula)}</div></div>`;

    /* 오른쪽: 달성 가능성 + Plan A/B + 판정 변화 */
    const t = tradeoff(cur.bp, cur.gg, saving);
    const diffs = cur.judged
      .map((r) => ({ r, was: (base.judged.find((b) => b.policy_id === r.policy_id) || {}).verdict }))
      .filter((d) => d.was && d.was !== d.r.verdict);

    $('#rightCol').innerHTML = `
      <div class="card" style="box-shadow:none">
        <div class="mini">FEASIBILITY</div>
        <div style="font-size:16px;font-weight:800;color:var(--navy);margin:6px 0 6px">${esc(cur.fe.label)}</div>
        <div style="font-size:13px;color:var(--muted);line-height:1.6">${esc(cur.fe.message)}</div>
        <div class="note" style="margin-top:10px">🧮 ${esc(cur.fe.formula)}</div>
      </div>
      <div class="card" style="box-shadow:none;margin-top:14px">
        <div class="mini">GOAL TRADE-OFF</div>
        <div style="font-size:17px;font-weight:800;color:var(--navy);margin:4px 0 12px">Plan A / Plan B</div>
        <div class="grid2">
          ${[['A', t.A], ['B', t.B]].map(([k, p]) => `<div style="border:${p.recommended ? '2px solid var(--blue)' : '1px solid var(--bd)'};background:${p.recommended ? 'var(--sky)' : '#fff'};border-radius:12px;padding:14px">
            <div style="font-size:11px;font-weight:800;color:var(--blue)">Plan ${k}</div>
            <div style="font-size:14px;font-weight:800;color:var(--navy);margin:6px 0 4px">${esc(p.title)}</div>
            <div style="font-size:12px;color:var(--muted);line-height:1.5">${esc(p.detail)}</div></div>`).join('')}
        </div>
      </div>
      ${dSum.has ? `<div class="card" style="box-shadow:none;margin-top:14px">
        <div class="mini">REPAY vs SAVE · 같은 돈을 어떻게 나눌까</div>
        <div style="font-size:12px;color:var(--muted);margin:6px 0 10px">
          월 ${num(saving)}원을 상환과 저축에 나누는 세 가지 방식입니다. 위 슬라이더로 직접 조절할 수도 있습니다.</div>
        <div style="display:grid;gap:8px">
          ${allocationScenarios(debts, cur.gg, cur.bp, saving, lump).map((sc) => {
            const on = Math.abs(sc.toRepay - repay) < 15000;
            return `<div style="border:${on ? '2px solid var(--blue)' : '1px solid var(--bd)'};background:${on ? 'var(--sky)' : '#fff'};border-radius:11px;padding:11px 13px">
              <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
                <b style="font-size:13px;color:var(--navy)">${esc(sc.label)}${on ? ' · 현재' : ''}</b>
                <span style="font-size:11.5px;color:var(--muted)">상환 ${num(sc.toRepay)} / 저축 ${num(sc.toSave)}</span>
              </div>
              <div style="font-size:11.5px;color:var(--muted);margin-top:4px">${esc(sc.desc)}</div>
              <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11.5px;margin-top:6px">
                <span>완제 <b>${sc.clearedMonth === 0 ? '즉시' : sc.clearedMonth ? sc.clearedMonth + '개월' : '기간 내 미완제'}</b></span>
                <span>총이자 <b>${money(sc.interestPaid)}</b></span>
                <span>목표시점 자기자본 <b>${money(sc.equity)}</b></span>
                <span style="color:${sc.reachable ? 'var(--green)' : 'var(--red)'}">
                  <b>${sc.reachable ? '목표 달성' : money(sc.shortfall) + ' 부족'}</b></span>
              </div>
              ${!on ? `<button class="btn ghost" data-alloc="${sc.toRepay}"
                style="margin-top:8px;padding:6px 12px;font-size:11.5px">이 방식으로 맞추기</button>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div class="note" style="margin-top:10px;font-size:11.5px">
          이자를 덜 내는 쪽과 목표에 빨리 닿는 쪽이 다를 수 있습니다. 어느 쪽을 우선할지는 선택입니다.</div>
      </div>` : ''}
      ${diffs.length ? `<div class="card" style="box-shadow:none;margin-top:14px;background:var(--sky);border-color:var(--blue-bd)">
        <div class="mini">판정이 바뀌었습니다</div>
        <div style="display:grid;gap:7px;margin-top:8px">
          ${diffs.map((d) => `<div style="font-size:12.5px">
            <b>${esc(d.r.policy.short_name)}</b>
            <span class="badge ${VERDICT[d.was].tone}">${VERDICT[d.was].label}</span> →
            <span class="badge ${VERDICT[d.r.verdict].tone}">${d.r.dot} ${d.r.label}</span>
            <div style="color:var(--muted);margin-top:2px">${esc(d.r.reason)}</div></div>`).join('')}
        </div>
        <div class="src">목표 금액을 바꾸면 주택가격·보증금 상한 조건에 걸리는 정책이 달라집니다.</div>
      </div>` : ''}`;

    /* 정책 비교 카드 */
    const cand = cur.judged.filter((r) => picked.includes(r.policy_id) && r.policy.finance.type === 'loan');
    const comp = cur.judged.filter((r) => picked.includes(r.policy_id) && r.policy.finance.type !== 'loan');

    $('#cmp').innerHTML = cand.map((r) => {
      const one = resolveCombination([r], state.groups);
      const bp1 = buildBlueprint(cur.gg, one.applied);
      const f = r.policy.finance;
      const pay = monthlyPayment(bp1.policyLoan, (f.rate_min + f.rate_max) / 2, f.term_years, f.repay_type);
      return `<div class="card" style="box-shadow:none">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
          <div style="font-size:15px;font-weight:800;color:var(--navy)">${esc(r.policy.short_name)}</div>
          <span class="badge ${VERDICT[r.verdict].tone}">${r.dot} ${r.label}</span>
        </div>
        <div class="grid3" style="margin-top:12px;gap:8px">
          <div class="stat" style="padding:11px"><div class="l">활용액</div><div class="v" style="font-size:15px">${money(bp1.policyLoan)}</div></div>
          <div class="stat" style="padding:11px"><div class="l">금리</div><div class="v" style="font-size:15px">${(f.rate_min * 100).toFixed(1)}~${(f.rate_max * 100).toFixed(1)}%</div></div>
          <div class="stat" style="padding:11px"><div class="l">필요 자기자본</div><div class="v" style="font-size:15px">${money(bp1.requiredEquity)}</div></div>
        </div>
        ${pay.value ? `<div class="src">참고 · ${esc(pay.label)} 약 ${num(pay.value)}원 · ${esc(pay.note)}</div>` : ''}
        <button class="btn sm full ${state.finalId === r.policy_id ? '' : 'ghost'}" style="margin-top:12px" data-final="${r.policy_id}">
          ${state.finalId === r.policy_id ? '✓ 확정됨' : '이 정책으로 확정'}</button>
      </div>`;
    }).join('') || '<div class="empty" style="grid-column:1/-1">STEP 1에서 대출 정책을 선택하면 여기서 비교할 수 있습니다.</div>';

    $('#companion').innerHTML = comp.length ? `<div class="note" style="margin-top:12px">
      🧩 함께 적용되는 정책: ${comp.map((c) => `${esc(c.policy.short_name)}(${c.amount.value ? money(c.amount.value) : '혜택형'})`).join(' · ')}
      <div style="font-size:11px;font-weight:500;margin-top:4px;opacity:.85">적금·지원금·할인은 대출과 성격이 달라 목표 자금에 합산됩니다. 위 비교는 대출 정책끼리만 합니다.</div>
    </div>` : '';

    bindDynamic();
  }

  /* 부채 — 상환 결과와 목표 영향 */
  function renderDebt(cur, netSaving, effSaving) {
    const r = cur.rep;
    /* clearedMonth === 0 은 '일시급만으로 즉시 완제'다. 0 은 falsy 라서
       `r.clearedMonth ? ...` 로 쓰면 이 경우가 조용히 다른 분기로 샌다. */
    const cleared = r.clearedMonth === 0 ? '지금 일시급으로 전액 상환'
      : r.clearedMonth ? `${r.clearedMonth}개월 뒤 완제`
      : (r.remainingBalance > 0 ? `목표 시점에 ${money(r.remainingBalance)} 남음` : '완제');
    /* 상환을 전혀 늘리지 않았을 때와 비교해서 목표가 얼마나 밀리는지 */
    const base0 = applyRepayment(debts, { lumpsum: 0, monthlyRepay: minDue, months: g.target_months || 1 });
    const noRepay = planFor(simTarget,
      Math.max(0, saving - minDue) + Math.round(base0.freedTotal / (g.target_months || 1)), 0, minDue);
    const dMonths = (isFinite(cur.sim.monthsNeeded) && isFinite(noRepay.sim.monthsNeeded))
      ? cur.sim.monthsNeeded - noRepay.sim.monthsNeeded : null;

    $('#splitBox').innerHTML = `
      <div style="display:flex;gap:8px">
        <div style="flex:1;background:var(--sky);border:1px solid var(--blue-bd);border-radius:10px;padding:8px 10px">
          <div style="font-size:10px;font-weight:800;color:var(--blue)">저축</div>
          <div style="font-size:14px;font-weight:800;color:var(--navy)">${num(netSaving)}원</div></div>
        <div style="flex:1;background:#fff5f5;border:1px solid #f2c7c7;border-radius:10px;padding:8px 10px">
          <div style="font-size:10px;font-weight:800;color:var(--red)">상환</div>
          <div style="font-size:14px;font-weight:800;color:var(--navy)">${num(repay)}원</div></div>
      </div>
      ${r.clearedMonth !== null && r.freedTotal > 0 ? `<div style="font-size:11px;color:var(--muted2);margin-top:6px">
        완제 후 상환액이 저축으로 돌아와 실효 저축액은 월 ${num(effSaving)}원입니다.</div>` : ''}`;

    $('#debtBox').innerHTML = `
      <div class="card" style="box-shadow:none">
        <div class="mini">DEBT · 대출금 갚기</div>
        <div style="font-size:17px;font-weight:800;color:var(--navy);margin:6px 0 10px">
          보유 부채 ${money(dSum.totalBalance)}</div>

        <div style="display:grid;gap:7px">
          ${dSum.items.map((it) => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:12px">
            <span style="color:var(--muted)">${esc(it.name)} · 연 ${(it.rate * 100).toFixed(1)}%</span>
            <b style="color:var(--navy)">${money(it.balance)}</b></div>
            <div style="font-size:11px;color:var(--muted2);margin-top:-3px">${esc(it.interestOnly
              ? '만기일시 · 이자만 내면 원금이 줄지 않습니다'
              : `현재 속도로 ${it.monthsToClear}개월 · 총이자 ${money(it.totalInterest)}`)}</div>`).join('')}
        </div>

        <div class="note" style="margin-top:12px">
          <b>${esc(cleared)}</b>
          ${r.interestSaved > 0 ? ` · 이자 <b>${money(r.interestSaved)}</b> 절감` : ''}
          <div style="font-size:11px;opacity:.85;margin-top:6px">🧮 ${esc(r.formula)}</div>
        </div>

        ${(() => {
          const adv = repayAdvice(debts);
          if (!adv) return '';
          return `<div class="${adv.tone === 'repay' ? 'warn' : 'note'}" style="margin-top:12px">
            <b>${esc(adv.headline)}</b>
            <div style="font-size:11.5px;opacity:.9;margin-top:4px">${esc(adv.body)}</div></div>`;
        })()}

        <div style="margin-top:14px">
          <div class="mini" style="margin-bottom:8px">완납 vs 일부 상환</div>
          <div style="display:grid;gap:7px">
            ${lumpsumScenarios(debts, cur.gg, cur.bp, repay, netSaving).map((o) => {
              const on = Math.abs(o.lump - lump) < 150000;
              return `<div style="border:${on ? '2px solid var(--blue)' : '1px solid var(--bd)'};background:${on ? 'var(--sky)' : '#fff'};border-radius:10px;padding:10px 12px">
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap">
                  <b style="font-size:12.5px;color:var(--navy)">${esc(o.label)}${on ? ' · 현재' : ''}</b>
                  <span style="font-size:11px;color:var(--muted)">일시급 ${num(o.lumpUsed)}원</span>
                </div>
                <div style="font-size:11px;color:var(--muted);margin-top:3px">${esc(o.desc)}</div>
                <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;margin-top:5px">
                  <span>이자 절감 <b>${money(o.interestSaved)}</b></span>
                  <span>남는 부채 <b>${money(o.remainingDebt)}</b></span>
                  <span style="color:${o.reachable ? 'var(--green)' : 'var(--red)'}">
                    <b>${o.reachable ? '목표 달성' : money(o.shortfall) + ' 부족'}</b></span>
                </div>
                ${!on ? `<button class="btn ghost" data-lump="${o.lump}"
                  style="margin-top:7px;padding:5px 11px;font-size:11px">이 방식으로 맞추기</button>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>

        <div class="${dMonths === null || dMonths > 0 ? 'warn' : 'note'}" style="margin-top:12px">
          목표 도달 시점 영향:
          <b>${dMonths === null ? '계산 불가 — 상환 비중이 너무 큽니다'
            : dMonths > 0 ? `약 ${dMonths}개월 지연` : dMonths < 0 ? `약 ${Math.abs(dMonths)}개월 단축` : '변화 없음'}</b>
          <div style="font-size:11px;opacity:.85;margin-top:4px">
            상환에 쓴 돈은 자기자본에서 빠지므로 목표는 늦어질 수 있습니다.
            대신 이자 부담과 잔여 부채가 줄어듭니다. 어느 쪽을 우선할지는 선택입니다.</div>
        </div>
      </div>`;

    /* debtBox 는 redraw 마다 다시 그려지므로 여기서 바로 바인딩한다 */
    $('#debtBox').querySelectorAll('[data-lump]').forEach((b) => b.addEventListener('click', () => {
      lump = Number(b.dataset.lump);
      const ls = $('#lSl'); if (ls) ls.value = lump;
      redraw();
    }));
  }

  /* 재렌더되는 영역의 이벤트 재바인딩 */
  function bindDynamic() {
    $('#applyTarget')?.addEventListener('click', async () => {
      await S.updateGoal(g.id, { target_amount: simTarget });
      g.target_amount = simTarget;
      state.simTarget = null;
      rejudge();
      route();
    });
    $('#resetTarget')?.addEventListener('click', () => {
      simTarget = g.target_amount;
      state.simTarget = null;
      $('#tSl').value = simTarget;
      redraw();
    });
    document.querySelectorAll('[data-alloc]').forEach((b) => b.addEventListener('click', () => {
      repay = Number(b.dataset.alloc);
      const rs = $('#rSl'); if (rs) rs.value = repay;
      redraw();
    }));
    document.querySelectorAll('[data-final]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      state.finalId = b.dataset.final;
      await S.finalizePolicy(g.id, state.finalId);
      await S.toggleChecklist(g.id, 'eligibility', true);
      state.checklist = await S.getChecklist(g.id);
      location.hash = '#step4';
    }));
  }

  /* 슬라이더 — 드래그 중에는 화면만, 놓았을 때 저장 */
  $('#tSl').addEventListener('input', (e) => { simTarget = Number(e.target.value); state.simTarget = simTarget; redraw(); });
  /* 렌더 중 예외가 나면 이후 입력이 통째로 먹통이 된다.
     한 번의 계산 실패가 슬라이더 전체를 죽이지 않도록 감싼다. */
  const safeRedraw = () => { try { redraw(); } catch (err) { console.error('redraw 실패', err); } };
  $('#sSl').addEventListener('input', (e) => { saving = Number(e.target.value); safeRedraw(); });
  $('#lSl')?.addEventListener('input', (e) => { lump = Number(e.target.value); safeRedraw(); });
  $('#rSl')?.addEventListener('input', (e) => { repay = Number(e.target.value); safeRedraw(); });
  $('#sSl').addEventListener('change', async () => {
    const cur = planFor(simTarget, saving);
    await S.updateGoal(g.id, { monthly_saving: saving });
    g.monthly_saving = saving;
    await S.addSimulation(g.id, {
      monthly_saving: saving, months_needed: cur.sim.monthsNeeded,
      gap_months: cur.sim.gapMonths, plan: cur.sim.gapMonths > 0 ? 'B' : 'A',
    });
  });

  redraw();
}

/* ======================== STEP 4 · FinTox ================================= */
function viewStep4(v) {
  const g = state.goal;
  const target = g.monthly_saving || 0;

  v.append(el(`<section class="card">
    <div class="card-h"><div class="card-t">STEP 4 · 소비 습관 진단</div><span class="tag">언제든 이용 가능</span></div>
    <p class="card-sub">결제 문자나 카드 이용내역을 붙여넣으면, 그 소비가 <b>목표 달성 시점에 주는 영향</b>을 계산합니다.
      감정이나 심리를 추측하지 않고 명시적 규칙으로만 채점합니다.</p>

    <div class="field">
      <label>결제 문자 붙여넣기 (여러 줄 가능)</label>
      <textarea class="inp" id="paste" rows="5" placeholder="[신한체크승인] 09/01 23:40 배달의민족 34,000원
01/14 18:12 치킨에 꼬치다(외대역점) 43,400원"></textarea>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" id="ana">분석하기</button>
      <button class="btn ghost" id="sample">샘플 내역 불러오기</button>
      ${state.txs.length ? `<button class="btn ghost" id="clear">내역 비우기</button>` : ''}
    </div>
    <div id="ftres" style="margin-top:20px"></div>

    <div class="note" style="margin-top:20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <span>${state.finalId
        ? '↓ 최종 점검: STEP 5 실행 로드맵에서 준비도와 신청 일정을 확인하세요'
        : '먼저 STEP 3에서 실행할 정책을 확정하면 실행 로드맵이 열립니다'}</span>
      <a class="btn sm" href="${state.finalId ? '#step5' : '#step3'}">
        ${state.finalId ? 'STEP 5 실행 로드맵으로 →' : 'STEP 3으로 돌아가기 →'}</a>
    </div>
    <div class="src" style="margin-top:10px">
      통신비·보험료 같은 성실납부 실적이 있으면 <a href="#credit">신용 빌드업</a>에서 평가사 제출자료를 만들 수 있습니다.
    </div>
  </section>`));

  $('#sample').addEventListener('click', async () => {
    const txt = await (await fetch('./data/dummy_tx.txt')).text();
    $('#paste').value = txt.trim();   // 통신비·보험료 자동이체까지 포함해야 신용 빌드업이 동작한다
  });
  $('#clear')?.addEventListener('click', () => { alert('로컬 모드에서는 브라우저 저장소를 비우면 초기화됩니다.'); });

  $('#ana').addEventListener('click', async () => {
    const parsed = FT.parseBulk($('#paste').value, new Date().getFullYear());
    if (!parsed.length) { alert('인식할 수 있는 결제 내역이 없습니다. 날짜·금액이 포함된 문자를 넣어 주세요.'); return; }
    await S.addTransactions(parsed);
    state.txs = await S.getTransactions();
    $('#paste').value = '';
    renderFT();
  });

  renderFT();

  function renderFT() {
    const box = $('#ftres');
    if (!state.txs.length) { box.innerHTML = '<div class="empty">아직 등록된 결제 내역이 없습니다.</div>'; return; }
    const hist = state.txs.map((t) => ({ ...t, hour: t.hour ?? new Date(t.occurred_at).getHours() }))
      .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
    const latest = hist[0];
    const rest = hist.slice(1);
    const sc = FT.scoreTransaction(latest, { history: rest, monthlyTarget: target, monthlyBudget: monthlyBudget() });
    const rep = FT.monthlyReport(hist, { monthlyTarget: target });
    const verdictMap = Object.fromEntries(state.judged.map((r) => [r.policy_id, r.verdict]));
    const rx = FT.prescribe(rep, state.policies, verdictMap);
    const nudge = FT.nudgeFor(latest, sc);
    const nudgeState = getNudge();
    const { bp: bpNow } = currentPlan();
    const impact = FT.nudgeImpact(nudgeState.total, g.monthly_saving, bpNow.additionalNeeded);
    const tone = { safe: 'green', watch: 'yellow', caution: 'red' }[sc.level];

    box.innerHTML = `
      <div class="card" style="box-shadow:none;background:var(--purple-bg);border-color:var(--purple-bd)">
        <div class="mini" style="color:var(--purple)">RISK INDEX · 최근 결제</div>
        <div style="display:flex;gap:22px;align-items:center;margin-top:12px;flex-wrap:wrap">
          <div style="width:86px;height:86px;border-radius:50%;border:6px solid var(--purple);display:grid;place-items:center;background:#fff">
            <div style="font-size:21px;font-weight:800;color:#6d28d9">${sc.score}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:-4px">/100</div>
          </div>
          <div style="flex:1;min-width:220px">
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">
              ${sc.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
            </div>
            <div style="font-size:17px;font-weight:800;color:#5b21b6">소비위험지수: ${esc(sc.levelLabel)}</div>
            <div style="font-size:13px;color:var(--muted);margin-top:4px">
              ${esc(latest.merchant_raw)} · ${num(latest.amount)}원</div>
          </div>
        </div>
        <div style="margin-top:14px;display:grid;gap:6px">
          ${sc.breakdown.map((b) => `<div style="display:flex;align-items:center;gap:10px;font-size:12px">
            <span style="width:104px;font-weight:700;color:var(--navy)">${esc(b.label)}</span>
            <div class="bar" style="flex:1;height:8px"><i style="width:${(b.point / b.max) * 100}%;background:var(--purple)"></i></div>
            <span style="width:56px;text-align:right;color:var(--muted)">${b.point}/${b.max}</span>
            <span style="flex:1.2;color:var(--muted2)">${esc(b.fact)}</span></div>`).join('')}
        </div>
        ${target ? `<div class="warn" style="margin-top:14px">이번 <b>${num(latest.amount)}원</b> 지출은 월 목표 저축액 ${num(target)}원의
          <b>약 ${sc.goalSharePct}%</b>입니다. 감정을 추정하지 않고 목표 저축과의 상대적 영향만 계산합니다.</div>` : ''}
      </div>

      <div class="card" style="box-shadow:none;margin-top:16px;background:#f0fdf4;border-color:#bbf7d0">
        <div class="mini" style="color:var(--green-tx)">SELF-SAVING NUDGE</div>
        <div style="font-size:17px;font-weight:800;color:var(--navy);margin:6px 0 4px">
          쓴 만큼의 ${nudge.ratePct}%를 지금 목표 저축으로 옮기세요</div>
        <div style="font-size:13px;color:var(--muted);line-height:1.6">${esc(nudge.reason)}
          소비를 되돌릴 수는 없지만, 일부를 즉시 저축으로 넘기면 목표 속도는 지킬 수 있습니다.</div>
        <div style="display:flex;align-items:center;gap:16px;margin-top:14px;flex-wrap:wrap">
          <div class="stat" style="text-align:left;background:#fff;min-width:150px">
            <div class="l">이번 넛지 금액</div>
            <div class="v green" style="font-size:26px">${num(nudge.amount)}원</div>
            <div class="f">🧮 ${esc(nudge.formula)}${nudge.capped ? ' (상한 50,000원 적용)' : ''}</div>
          </div>
          <button class="btn sm" id="doNudge">이 금액 저축으로 옮기기</button>
        </div>
        ${nudgeState.total ? `
          <div class="note" style="margin-top:14px">
            💰 누적 넛지 저축 <b>${num(nudgeState.total)}원</b>
            ${impact.days ? ` · 목표 도달을 약 <b>${impact.days}일</b> 앞당깁니다` : ''}
            ${impact.pct ? ` (추가 필요자금의 ${impact.pct}%)` : ''}
            <div style="font-size:11px;font-weight:500;margin-top:5px;opacity:.85">
              최근: ${nudgeState.items.slice(0, 3).map((x) => `${esc(x.label)} ${num(x.amount)}원`).join(' · ')}
            </div>
          </div>` : ''}
      </div>

      <div class="card" style="box-shadow:none;margin-top:16px">
        <div class="mini">SMART PRESCRIPTION</div>
        <div style="font-size:17px;font-weight:800;color:var(--navy);margin:6px 0 4px">소비를 막기보다 실질지출을 낮춥니다</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:14px">총 절감 예상 <b style="color:var(--blue)">${num(rx.reduce((s, r) => s + r.saving, 0))}원</b></div>
        <div style="display:grid;gap:10px">
          ${rx.map((r) => `<div style="border:1px solid ${r.type === 'warning' ? '#fde68a' : 'var(--bd)'};background:${r.type === 'warning' ? '#fffbe3' : '#fff'};border-radius:12px;padding:14px 16px">
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
              <b style="font-size:14px;color:var(--navy)">${esc(r.title)}</b>
              ${r.saving ? `<span class="badge green">-${num(r.saving)}원</span>` : ''}</div>
            <div style="font-size:12.5px;color:var(--muted);line-height:1.6;margin-top:5px">${esc(r.body)}</div>
            <div class="src">근거: ${esc(r.basis)}</div></div>`).join('')}
        </div>
      </div>

      <div class="card" style="box-shadow:none;margin-top:16px">
        <div class="mini">MONTHLY REPORT</div>
        <div class="grid4" style="margin-top:10px">
          <div class="stat"><div class="l">등록 건수</div><div class="v">${rep.count}건</div></div>
          <div class="stat"><div class="l">총 지출</div><div class="v">${num(rep.total)}원</div></div>
          <div class="stat"><div class="l">야간(22~06시)</div><div class="v">${rep.night.pct}%</div><div class="f">${rep.night.count}건</div></div>
          <div class="stat"><div class="l">업종 미상</div><div class="v ${rep.unknownPct >= 20 ? 'red' : ''}">${rep.unknownPct}%</div><div class="f">${rep.unknownCount}건</div></div>
        </div>
        <div style="margin-top:16px;display:grid;gap:7px">
          ${rep.categories.slice(0, 8).map((c) => `<div>
            <div style="display:flex;justify-content:space-between;font-size:12.5px;font-weight:600"><span>${esc(c.cat)}</span><span>${num(c.amount)}원 · ${c.pct}%</span></div>
            <div class="bar" style="height:7px"><i style="width:${c.pct}%"></i></div></div>`).join('')}
        </div>
        ${rep.repeats.length ? `<div class="note" style="margin-top:14px">🔁 30일 내 3회 이상 반복: ${rep.repeats.slice(0, 6).map((r) => `${esc(r.name)}×${r.count}`).join(' · ')}</div>` : ''}
      </div>
      <div id="aiFintox"></div>`;

    fillAI('aiFintox', 'explain_fintox', {
      최근결제: { 가맹점: latest.merchant_raw, 금액: latest.amount, 분류: latest.category, 시각: `${latest.hour}시` },
      위험점수: sc.score, 판정: sc.levelLabel,
      월저축목표: target, 목표대비_비중_퍼센트: sc.goalSharePct,
      점수_산출근거: sc.breakdown.map((b) => ({ 항목: b.label, 점수: b.point, 만점: b.max, 근거: b.fact })),
      월간요약: { 총지출: rep.total, 야간비중: rep.night.pct, 업종미상비중: rep.unknownPct,
        상위카테고리: rep.categories.slice(0, 3).map((c) => ({ 분류: c.cat, 금액: c.amount, 비중: c.pct })) },
      제안가능한_공공혜택: rx.map((r) => ({ 제목: r.title, 절감예상: r.saving })),
    });

    $('#doNudge')?.addEventListener('click', () => {
      addNudge(nudge.amount, latest.merchant_norm || latest.merchant_raw);
      renderFT();
    });
  }

  function monthlyBudget() {
    const income = state.profile.annual_income / 12;
    return Math.max(300000, Math.round(income - (g.monthly_saving || 0)));
  }
}

/* ======================== STEP 5 · 실행 로드맵 ============================ */
function viewStep5(v) {
  const g = state.goal;
  const { bp } = currentPlan();
  const pr = progress(g, bp, state.checklist);
  const finalPolicy = state.policies.find((p) => p.policy_id === state.finalId);
  const docState = finalPolicy ? getDocs(finalPolicy.policy_id) : {};
  const docDone = finalPolicy && finalPolicy.documents
    ? finalPolicy.documents.filter((_, i) => docState[i]).length : 0;
  const schedule = buildScheduleEvents(g, finalPolicy, pr.targetDday.date);

  const months = g.target_months || 24;
  const nodes = [
    { d: `D-${months * 30}`, t: '목표 설정 및 저축 플랜 확정', s: 'done',
      p: `${finalPolicy ? finalPolicy.short_name + ' 기준 ' : ''}필요 자금 ${money(bp.additionalNeeded)} 저축 목표 설정 완료.` },
    { d: `D-${Math.round(months * 30 * 0.8)}`, t: '소비 진단 연동 및 월 저축 자동화', s: 'now',
      p: `월 ${num(g.monthly_saving || bp.recommendedMonthly)}원 저축을 지키기 위해 지출 누수를 상시 점검합니다.` },
    { d: `D-${Math.round(months * 30 * 0.4)}`, t: '정책 자격 사전 재검증', s: '',
      p: '무주택 요건과 소득·자산 변동 내역을 다시 확인하고 제출서류를 준비합니다.' },
    { d: 'D-DAY', t: '정책 실행 및 목표 달성', s: 'goal',
      p: `${GOAL_LABEL[g.goal_type] || '목표'} 완료.` },
  ];

  v.append(el(`<section class="card">
    <div class="card-h"><div class="card-t">STEP 5 · 실행 로드맵</div><span class="tag">Financial Readiness</span></div>
    <p class="card-sub">신청 시점까지 필요한 준비를 하나의 로드맵으로 관리합니다.</p>

    <div class="card" style="box-shadow:none">
      <div class="mini">FINANCIAL READINESS</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin:8px 0 12px">
        <div style="font-size:21px;font-weight:800;color:var(--navy)">실행 준비도</div>
        <div style="font-size:27px;font-weight:800;color:var(--blue)">${pr.readinessPct}%</div>
      </div>
      <div class="bar lg"><i style="width:${pr.readinessPct}%"></i></div>
      <div style="display:grid;gap:9px;margin-top:18px" id="cl">
        ${state.checklist.map((c) => `<label class="check ${c.is_done ? 'on' : ''}" data-k="${c.item_key}">
          <input type="checkbox" ${c.is_done ? 'checked' : ''}><span style="flex:1">${esc(c.label)}</span>
          <span class="badge ${c.is_done ? 'green' : 'gray'}">+${CR.XP_PER_QUEST}XP</span></label>`).join('')}
      </div>
      <div class="note" style="margin-top:14px">📌 <b>중요:</b> 준비도는 대출 승인확률이 아닙니다. 목표 실행에 필요한 정보·서류·행동의 완료율입니다.</div>
    </div>

    ${finalPolicy && finalPolicy.documents ? `
    <div class="card" style="box-shadow:none;margin-top:16px">
      <div class="card-h" style="margin-bottom:8px">
        <div><div class="mini">REQUIRED DOCUMENTS</div>
          <div style="font-size:17px;font-weight:800;color:var(--navy);margin-top:4px">필요 서류 체크리스트</div></div>
        <span class="badge ${docDone === finalPolicy.documents.length ? 'green' : 'blue'}">${docDone} / ${finalPolicy.documents.length}</span>
      </div>
      <div style="font-size:13px;color:var(--muted);margin-bottom:12px">
        <b>${esc(finalPolicy.name)}</b> 신청에 일반적으로 필요한 서류입니다. 미리 발급받아 두면 신청일에 바로 접수할 수 있습니다.</div>
      <div class="bar lg" style="margin-bottom:14px"><i style="width:${Math.round(docDone / finalPolicy.documents.length * 100)}%;background:var(--green)"></i></div>
      <div style="display:grid;gap:9px">
        ${finalPolicy.documents.map((d, i) => `
          <label class="check ${docState[i] ? 'on' : ''}" data-doc="${i}">
            <input type="checkbox" ${docState[i] ? 'checked' : ''}>
            <span style="flex:1">${esc(d)}</span></label>`).join('')}
      </div>
      <div class="warn" style="margin-top:12px">${esc(finalPolicy.documents_note || '')}</div>
      ${finalPolicy.source && finalPolicy.source.url ? `<a class="btn ghost sm" style="margin-top:10px"
        href="${esc(finalPolicy.source.url)}" target="_blank" rel="noopener">공고에서 제출서류 확인 →</a>` : ''}
    </div>` : ''}

    <div class="card" style="box-shadow:none;margin-top:16px">
      <div class="mini">SCHEDULE ALERT</div>
      <div style="font-size:17px;font-weight:800;color:var(--navy);margin:6px 0 4px">신청일 알림 받기</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:12px">
        아래 일정을 캘린더 파일(.ics)로 내려받아 구글·애플·아웃룩 캘린더에 넣으면,
        <b>신청 시점에 기기가 대신 알려줍니다.</b> 각 일정에는 미리 알림이 설정되어 있습니다.</div>
      ${schedule.length ? `
        <div style="display:grid;gap:8px">
          ${schedule.map((e) => `
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;
                        border:1px solid var(--bd);border-radius:10px;padding:11px 14px;background:#fff">
              <span style="font-size:13px;font-weight:600;color:var(--navy)">${esc(e.title.replace('[청사진] ', ''))}</span>
              <span style="font-size:12px;color:var(--muted)">
                ${esc(typeof e.date === 'string' ? e.date : new Date(e.date).toISOString().slice(0, 10))}
                · ${e.alarmDaysBefore}일 전 알림</span>
            </div>`).join('')}
        </div>
        <button class="btn sm" style="margin-top:14px" id="dlIcs">📅 캘린더에 추가 (.ics 내려받기)</button>
        <div class="src">파일을 열면 캘린더 앱이 일정을 가져옵니다. 구독형이 아니라 한 번 내려받는 방식이라, 정책 일정이 바뀌면 다시 받아야 합니다.</div>`
      : '<div class="empty">알림으로 만들 일정이 아직 없습니다. STEP 3에서 정책을 확정해 주세요.</div>'}
    </div>

    <div class="tl" style="margin-top:20px">
      ${nodes.map((n) => `<div class="node ${n.s}">
        <div class="dot">${esc(n.d)}</div>
        <div class="body"><h4>${esc(n.t)}</h4><p>${esc(n.p)}</p></div></div>`).join('')}
    </div>

    ${finalPolicy ? `<div class="card" style="margin-top:18px;box-shadow:none">
      <div class="mini">NEXT ACTION</div>
      <div style="font-size:16px;font-weight:800;color:var(--navy);margin:6px 0 8px">${esc(finalPolicy.name)} 신청 준비</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6">${esc(finalPolicy.finance.benefit_note || '')}</div>
      <a class="btn sm" style="margin-top:12px" href="${esc(finalPolicy.source.url)}" target="_blank" rel="noopener">공식 페이지에서 확인하기 →</a>
      ${sourceLine(finalPolicy.source)}
    </div>` : ''}

    <div style="background:var(--navy);color:#fff;border-radius:16px;padding:22px;margin-top:18px;text-align:center">
      <div style="font-size:11px;font-weight:800;color:var(--blue-bd2);letter-spacing:.5px">READY TO START</div>
      <div style="font-size:18px;font-weight:800;margin:6px 0 8px">${esc(GOAL_LABEL[g.goal_type] || '목표')} 플랜이 준비되었습니다</div>
      <div style="font-size:13px;color:#94a3b8;line-height:1.6">
        필요 자기자본 ${money(bp.requiredEquity)} 중 ${money(bp.currentAsset)}을 확보했고,
        남은 ${money(bp.additionalNeeded)}을 월 ${num(g.monthly_saving || bp.recommendedMonthly)}원씩 모으는 계획입니다.
      </div>
    </div>
  </section>`));

  /* 제출서류 체크 — 전부 체크되면 준비도의 '필요서류 체크' 항목도 함께 완료 처리 */
  v.querySelectorAll('[data-doc]').forEach((l) => l.addEventListener('click', async (e) => {
    e.preventDefault();
    const i = Number(l.dataset.doc);
    const next = !docState[i];
    toggleDoc(finalPolicy.policy_id, i, next);
    const d = getDocs(finalPolicy.policy_id);
    const all = finalPolicy.documents.every((_, k) => d[k]);
    const item = state.checklist.find((c) => c.item_key === 'documents');
    if (item && item.is_done !== all) {
      item.is_done = all;
      await S.toggleChecklist(g.id, 'documents', all);
    }
    route();
  }));

  /* 캘린더 내려받기 — 알림 설정 항목 완료 처리 */
  $('#dlIcs')?.addEventListener('click', async () => {
    downloadIcs(`청사진_${GOAL_LABEL[g.goal_type] || '목표'}_일정`, makeIcs(schedule));
    const item = state.checklist.find((c) => c.item_key === 'apply_alarm');
    if (item && !item.is_done) {
      item.is_done = true;
      await S.toggleChecklist(g.id, 'apply_alarm', true);
      route();
    }
  });

  v.querySelectorAll('#cl label').forEach((l) => l.addEventListener('click', async (e) => {
    e.preventDefault();
    const key = l.dataset.k;
    const item = state.checklist.find((c) => c.item_key === key);
    item.is_done = !item.is_done;
    await S.toggleChecklist(g.id, key, item.is_done);
    route();
  }));
}

/* ======================== 대시보드 ======================================== */
function viewDashboard(v) {
  const g = state.goal;
  const { bp } = currentPlan();
  const sim = simulate(bp, g, g.monthly_saving || bp.recommendedMonthly);
  const pr = progress(g, bp, state.checklist, sim.monthsNeeded);
  const finalPolicy = state.policies.find((p) => p.policy_id === state.finalId);

  const next = !state.selected.size ? ['받을 수 있는 정책을 골라 주세요', '#step1']
    : !state.finalId ? ['시뮬레이션에서 실행할 정책을 확정해 주세요', '#step3']
    : state.checklist.some((c) => !c.is_done) ? ['실행 준비도 체크리스트를 완료해 주세요', '#step5']
    : ['소비 진단으로 저축 계획을 점검해 보세요', '#step4'];

  v.append(el(`<section class="card">
    <div class="card-h">
      <div><div class="mini">MY GOAL</div>
        <div class="card-t" style="margin-top:4px">${esc(GOAL_LABEL[g.goal_type] || '목표')} · ${money(g.target_amount)}</div></div>
      <div style="text-align:right">
        <div style="font-size:26px;font-weight:800;color:${sim.ready ? 'var(--green)' : pr.ddayGapDays > 0 ? 'var(--red)' : 'var(--navy)'}">
          ${sim.ready ? '지금 실행 가능' : (pr.projectedDday ? pr.projectedDday.label : pr.ddayLabel)}</div>
        <div style="font-size:11px;color:var(--muted)">
          ${sim.ready ? '추가 저축 불필요' : `예상 도달 · 목표 ${pr.ddayLabel} 대비
            ${pr.ddayGapDays === 0 ? '동일' : pr.ddayGapDays > 0 ? `${pr.ddayGapDays}일 지연` : `${Math.abs(pr.ddayGapDays)}일 단축`}`}
        </div>
      </div>
    </div>

    <div class="grid2" style="margin-top:6px">
      <div class="card" style="box-shadow:none">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <b style="font-size:14px;color:var(--navy)">자금 달성률</b>
          <span style="font-size:24px;font-weight:800;color:var(--blue)">${pr.savingPct}%</span></div>
        <div class="bar lg" style="margin:10px 0 8px"><i style="width:${pr.savingPct}%"></i></div>
        <div style="font-size:12px;color:var(--muted)">${money(pr.savedNow)} / 필요 자기자본 ${money(pr.equityNeeded)}</div>
        <div class="src">🧮 ${esc(pr.formula)}</div>
        <div class="${pr.onTrack ? 'note' : 'warn'}" style="margin-top:10px">
          ${pr.onTrack ? '✅ 계획대로 진행 중입니다.' : '⚠️ 목표 진도보다 뒤처져 있습니다. 시뮬레이션에서 월 저축액을 조정해 보세요.'}</div>
      </div>
      <div class="card" style="box-shadow:none">
        <div style="display:flex;justify-content:space-between;align-items:baseline">
          <b style="font-size:14px;color:var(--navy)">실행 준비도</b>
          <span style="font-size:24px;font-weight:800;color:var(--navy)">${pr.readinessPct}%</span></div>
        <div class="bar lg" style="margin:10px 0 8px"><i style="width:${pr.readinessPct}%;background:var(--navy)"></i></div>
        <div style="font-size:12px;color:var(--muted)">체크리스트 ${pr.done}/${pr.total} 완료</div>
        <div class="src">준비도는 승인 확률이 아니라 준비 완료율입니다.</div>
        <a class="btn ghost sm" style="margin-top:10px" href="#step5">로드맵 열기</a>
      </div>
    </div>

    <div class="grid4" style="margin-top:16px">
      <div class="stat"><div class="l">적용 정책</div><div class="v" style="font-size:15px">${finalPolicy ? esc(finalPolicy.short_name) : '미확정'}</div></div>
      <div class="stat"><div class="l">정책금융 예상</div><div class="v blue" style="font-size:17px">${money(bp.policyLoan)}</div></div>
      <div class="stat"><div class="l">남은 필요 자금</div><div class="v" style="font-size:17px">${money(Math.max(0, bp.additionalNeeded - 0))}</div></div>
      <div class="stat"><div class="l">권장 월 저축</div><div class="v" style="font-size:17px">${num(g.monthly_saving || bp.recommendedMonthly)}원</div></div>
    </div>

    <div class="note" style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <span>👉 다음 할 일: ${esc(next[0])}</span>
      <a class="btn sm" href="${next[1]}">바로 가기</a>
    </div>
    ${sim.monthsNeeded !== Infinity ? `<div class="src">현재 저축 속도 기준 예상 소요 ${sim.monthsNeeded}개월 · ${esc(sim.message)}</div>` : ''}
  </section>`));

  /* 실행 등급 (XP) */
  const { xp } = creditState();
  v.append(el(`<section class="card">
    <div class="card-h" style="margin-bottom:8px">
      <div><div class="mini">EXECUTION LEVEL</div>
        <div style="font-size:19px;font-weight:800;color:${xp.tier.color};margin-top:4px">${esc(xp.tier.label)}</div></div>
      <div style="text-align:right">
        <div style="font-size:20px;font-weight:800;color:var(--navy)">${xp.earned} <span style="font-size:12px;color:var(--muted)">/ ${xp.total} XP</span></div>
        ${xp.nextTier ? `<div style="font-size:11px;color:var(--muted)">다음 등급 ‘${esc(xp.nextTier.label)}’까지 ${xp.toNext} XP</div>` : ''}
      </div>
    </div>
    <div class="bar lg"><i style="width:${xp.pct}%;background:${xp.tier.color}"></i></div>
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap">
      <span class="src" style="margin:0">실행 준비도 기준 등급입니다. 신용점수·승인확률과 무관합니다.</span>
      <a class="btn ghost sm" href="#credit">신용 빌드업 열기</a>
    </div>
  </section>`));

  if (state.txs.length) {
    const hist = state.txs.map((t) => ({ ...t, hour: t.hour ?? new Date(t.occurred_at).getHours() }));
    const rep = FT.monthlyReport(hist, { monthlyTarget: g.monthly_saving });
    v.append(el(`<section class="card">
      <div class="card-h"><div class="card-t" style="font-size:16px">소비 요약</div><a class="btn ghost sm" href="#step4">진단 열기</a></div>
      <div class="grid4">
        <div class="stat"><div class="l">등록 건수</div><div class="v" style="font-size:17px">${rep.count}건</div></div>
        <div class="stat"><div class="l">총 지출</div><div class="v" style="font-size:17px">${num(rep.total)}원</div></div>
        <div class="stat"><div class="l">최다 지출</div><div class="v" style="font-size:15px">${esc(rep.categories[0].cat)}</div><div class="f">${rep.categories[0].pct}%</div></div>
        <div class="stat"><div class="l">야간 결제</div><div class="v" style="font-size:17px">${rep.night.pct}%</div></div>
      </div>
    </section>`));
  }
}

/* ======================== 신용 빌드업 ==================================== */
const flagKey = (k) => `csj.flag.${state.goal.id}.${k}`;

/* 넛지 저축 누적 */
const nudgeKey = () => `csj.nudge.${state.goal.id}`;
function getNudge() {
  try { return JSON.parse(localStorage.getItem(nudgeKey())) || { total: 0, items: [] }; }
  catch { return { total: 0, items: [] }; }
}
function addNudge(amount, label) {
  const n = getNudge();
  n.total += amount;
  n.items.unshift({ amount, label, at: new Date().toISOString() });
  n.items = n.items.slice(0, 50);
  localStorage.setItem(nudgeKey(), JSON.stringify(n));
  return n;
}
/* 제출서류 체크 상태 */
const docKey = (pid) => `csj.docs.${state.goal.id}.${pid}`;
function getDocs(pid) {
  try { return JSON.parse(localStorage.getItem(docKey(pid))) || {}; } catch { return {}; }
}
function toggleDoc(pid, i, on) {
  const d = getDocs(pid); d[i] = on; localStorage.setItem(docKey(pid), JSON.stringify(d)); return d;
}
const getFlag = (k) => localStorage.getItem(flagKey(k)) === '1';
const setFlag = (k, v) => localStorage.setItem(flagKey(k), v ? '1' : '0');

function creditState() {
  const detected = CR.detectNonFinancial(state.txs);
  const xp = CR.computeXP(state.checklist, detected, getFlag('mvno'));
  return { detected, xp };
}

function viewCredit(v) {
  const { detected, xp } = creditState();
  const telecom = detected.find((d) => d.key === 'telecom');
  const script = CR.buildSubmissionScript(state.profile, detected);
  const tierKey = localStorage.getItem('csj.mvnoTier') || 'standard';
  const mv = telecom && telecom.found ? CR.matchMvno(telecom.avgAmount, state.mvno, tierKey) : null;

  v.append(el(`<section class="card">
    <div class="card-h"><div class="card-t">신용 빌드업</div><span class="tag">언제든 이용 가능</span></div>
    <p class="card-sub">이미 성실하게 내고 있는 통신비·보험료를 <b>금융이력으로 바꾸고</b>, 고정비 자체를 낮춥니다.
      금융 이력이 얇은 사회초년생에게 가장 빠른 지렛대입니다.</p>

    <!-- XP / 등급 -->
    <div class="card" style="box-shadow:none">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <div class="mini">EXECUTION LEVEL</div>
          <div style="font-size:22px;font-weight:800;color:${xp.tier.color};margin-top:4px">
            ${esc(xp.tier.label)} <span style="font-size:13px;color:var(--muted);font-weight:600">${esc(xp.tier.desc)}</span></div>
        </div>
        <div style="text-align:right">
          <div style="font-size:26px;font-weight:800;color:var(--navy)">${xp.earned} <span style="font-size:14px;color:var(--muted)">/ ${xp.total} XP</span></div>
          ${xp.nextTier ? `<div style="font-size:11px;color:var(--muted)">다음 등급까지 ${xp.toNext} XP</div>` : '<div style="font-size:11px;color:var(--muted)">최고 등급</div>'}
        </div>
      </div>
      <div class="bar lg" style="margin-top:12px"><i style="width:${xp.pct}%;background:${xp.tier.color}"></i></div>
      <div style="display:grid;gap:7px;margin-top:14px">
        ${xp.quests.map((q) => `<div style="display:flex;align-items:center;gap:9px;font-size:12.5px;
          color:${q.done ? 'var(--blue)' : 'var(--muted)'}">
          <span>${q.done ? '✅' : '⬜'}</span><span style="flex:1">${esc(q.label)}</span>
          <span class="badge ${q.done ? 'green' : 'gray'}">+${q.xp}XP</span></div>`).join('')}
      </div>
      <div class="note" style="margin-top:14px">
        📌 이 등급은 <b>실행 준비도</b>입니다. 신용점수나 대출 승인확률과는 무관합니다.
      </div>
    </div>

    <!-- 비금융 신용 가점 -->
    <div class="card" style="box-shadow:none;margin-top:16px">
      <div class="mini">NON-FINANCIAL CREDIT</div>
      <div style="font-size:17px;font-weight:800;color:var(--navy);margin:6px 0 4px">비금융 납부실적 찾기</div>
      <div style="font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:14px">
        통신요금·보험료·공과금·4대보험을 꾸준히 냈다면 신용평가사에 제출해 평가에 반영을 요청할 수 있습니다.
        등록된 결제내역에서 자동으로 찾아봤습니다.</div>

      <div style="display:grid;gap:9px">
        ${detected.map((d) => `<div style="border:1px solid ${d.found ? 'var(--blue-bd2)' : 'var(--bd)'};
          background:${d.found ? 'var(--sky)' : '#fff'};border-radius:11px;padding:13px 15px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <b style="font-size:14px;color:${d.found ? 'var(--blue)' : 'var(--muted)'}">${d.found ? '✅' : '⬜'} ${esc(d.label)}</b>
            ${d.found ? `<span class="badge blue">${d.months}개월 · 평균 ${num(d.avgAmount)}원</span>` : '<span class="chip">내역 없음</span>'}
          </div>
          ${d.found ? `<div style="font-size:12px;color:var(--muted);margin-top:5px">
            납부처 ${esc(d.provider)} · 최근 ${new Date(d.latest.occurred_at).toISOString().slice(0, 10)}</div>` : ''}
        </div>`).join('')}
      </div>

      ${script ? `
        <div style="margin-top:16px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <b style="font-size:13px;color:var(--navy)">제출용 자료 (복사해서 사용)</b>
            <button class="btn ghost sm" id="copyScript">복사하기</button>
          </div>
          <textarea class="inp" id="script" rows="11" readonly style="font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.6">${esc(script)}</textarea>
        </div>
        <div class="grid2" style="margin-top:12px">
          ${CR.BUREAUS.map((b) => `<a class="btn ghost sm" href="${esc(b.url)}" target="_blank" rel="noopener"
            style="flex-direction:column;align-items:flex-start;gap:3px;padding:13px 15px;text-align:left">
            <b style="font-size:13px">${esc(b.name)} →</b>
            <span style="font-size:11px;color:var(--muted);font-weight:500">${esc(b.note)}</span></a>`).join('')}
        </div>
        <div class="warn" style="margin-top:12px">
          실제 제출에는 통신사·보험사·공단이 발급한 <b>납부확인서 원본</b>이 필요합니다.
          가점 반영 여부와 폭은 평가사 내부 기준에 따라 달라지므로, 점수 상승을 보장하지 않습니다.
        </div>`
      : `<div class="warn" style="margin-top:14px">
          아직 찾은 납부실적이 없습니다. <a href="#step4" style="color:inherit;text-decoration:underline">STEP 4 소비 습관 진단</a>에서
          통신비·보험료가 포함된 결제내역을 등록하면 자동으로 인식합니다.</div>`}
    </div>

    <!-- 알뜰폰 -->
    <div class="card" style="box-shadow:none;margin-top:16px">
      <div class="mini">MVNO MATCHING</div>
      <div style="font-size:17px;font-weight:800;color:var(--navy);margin:6px 0 4px">청년 알뜰폰 요금제 매칭</div>
      ${mv ? `
        <div style="font-size:13px;color:var(--muted);margin-bottom:14px">
          통신비를 낮추면 <b>월 저축액이 그만큼 늘어납니다.</b> 목표 달성 시점에 직접 영향을 줍니다.</div>
        <div class="field" style="max-width:280px">
          <label>필요한 데이터 구간</label>
          <select class="inp" id="mvnoTier">
            ${state.mvno.tiers.map((t) => `<option value="${t.key}" ${t.key === tierKey ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
          </select>
        </div>
        <div class="grid3">
          <div class="stat"><div class="l">현재 통신비</div><div class="v" style="font-size:17px">${num(mv.current)}원</div></div>
          <div class="stat"><div class="l">${esc(mv.tier.label)} 예상</div><div class="v blue" style="font-size:17px">${num(mv.tier.price_min)}~${num(mv.tier.price_max)}원</div></div>
          <div class="stat"><div class="l">연간 절감</div><div class="v green" style="font-size:17px">${num(mv.saveYear)}원</div></div>
        </div>
        <div class="note" style="margin-top:12px">🧮 ${esc(mv.formula)}</div>
        ${mv.worthIt ? `
          <div class="card" style="box-shadow:none;margin-top:12px;background:var(--sky);border-color:var(--blue-bd)">
            <div style="font-size:13px;color:var(--navy);line-height:1.6">
              월 <b>${num(mv.saveMin)}원</b>을 아끼면 목표 월 저축액 ${num(state.goal.monthly_saving || 0)}원의
              <b>${state.goal.monthly_saving ? Math.round(mv.saveMin / state.goal.monthly_saving * 100) : 0}%</b>를 통신비 하나로 채웁니다.</div>
            <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
              <a class="btn sm" href="${esc(mv.source.url)}" target="_blank" rel="noopener">요금제 찾아보기 →</a>
              <button class="btn ghost sm" id="mvnoDone">${getFlag('mvno') ? '✓ 확인함 (+20XP)' : '절감안 확인 완료 (+20XP)'}</button>
            </div>
          </div>` : `<div class="note" style="margin-top:12px">현재 요금이 이미 낮은 편이라 전환 실익이 크지 않습니다.</div>`}
        <div class="warn" style="margin-top:12px">${esc(mv.notice)}</div>
        <div class="src">출처: <a href="${esc(mv.source.url)}" target="_blank" rel="noopener">${esc(mv.source.name)}</a>
          · 기준일 ${esc(mv.source.based_on)}
          ${mv.source.verified ? '· <b style="color:#15803d">시세 대조 완료</b>' : '· <b style="color:#b45309">검증 전</b>'}</div>`
      : `<div class="warn" style="margin-top:10px">통신비 결제내역이 없어 비교할 수 없습니다.
          STEP 4에서 통신요금 자동이체 내역을 등록해 주세요.</div>`}
    </div>
  </section>`));

  $('#copyScript')?.addEventListener('click', async () => {
    const ta = $('#script');
    ta.select();
    try { await navigator.clipboard.writeText(ta.value); $('#copyScript').textContent = '✓ 복사됨'; }
    catch { document.execCommand('copy'); $('#copyScript').textContent = '✓ 복사됨'; }
  });
  $('#mvnoTier')?.addEventListener('change', (e) => {
    localStorage.setItem('csj.mvnoTier', e.target.value);
    route();
  });
  $('#mvnoDone')?.addEventListener('click', () => { setFlag('mvno', !getFlag('mvno')); route(); });
}

/* ======================== 히스토리 / 정책 모아보기 / 마이페이지 ============ */
function viewHistory(v) {
  const hist = state.txs.slice(0, 60);
  v.append(el(`<section class="card">
    <div class="card-t">히스토리</div>
    <p class="card-sub">등록된 결제 내역과 목표 설정 이력입니다.</p>
    <div class="stat" style="text-align:left;margin-bottom:14px">
      <div class="l">목표 생성</div>
      <div class="v" style="font-size:14px">${esc(state.goal.raw_input || '-')}</div>
      <div class="f">${esc(state.goal.started_on)} · ${money(state.goal.target_amount)} / ${state.goal.target_months}개월</div>
    </div>
    ${hist.length ? `<table class="wf"><thead><tr><th>일시</th><th>가맹점</th><th>분류</th><th style="text-align:right">금액</th></tr></thead>
      <tbody>${hist.map((t) => `<tr><td>${new Date(t.occurred_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
        <td class="nm">${esc(t.merchant_raw)}</td>
        <td>${t.category === '업종 미상' ? `<span class="chip warn">${esc(t.category)}</span>` : esc(t.category)}</td>
        <td class="amt" style="text-align:right">${num(t.amount)}원</td></tr>`).join('')}</tbody></table>`
      : '<div class="empty">등록된 결제 내역이 없습니다.</div>'}
  </section>`));
}

function viewPolicies(v) {
  const judgedLocal = judgeAll(state.policies, state.profile, state.goal, new Date());

  v.append(el(`<section class="card">
    <div class="card-h"><div class="card-t">정책 모아보기</div>
      <span class="tag">정형 DB ${state.policies.length}종 · 기준일 ${esc(state.meta.based_on)}</span></div>
    <p class="card-sub">현재 프로필 기준 판정 결과입니다. 목표와 무관한 정책도 모두 보여줍니다.</p>
    <div id="localList"></div>
    <div class="note" style="margin-top:12px">
      이 17종은 대출한도·금리 같은 <b>금융 파라미터를 갖고 있어 목표 자금 계산에 직접 쓰입니다.</b>
    </div>
    <div class="warn" style="margin-top:10px">${esc(state.meta.review_notice)}</div>
  </section>`));

  paginate($('#localList'), judgedLocal, (r) => `<tr>
      <td><span class="badge ${VERDICT[r.verdict].tone}">${r.dot} ${r.label}</span></td>
      <td class="nm">${esc(r.policy.name)}</td>
      <td>${esc(r.policy.lclsf)} · ${esc(r.policy.mclsf)}</td>
      <td style="color:var(--muted)">${esc(r.policy.provider)}</td>
      <td style="color:var(--muted)">${esc(r.policy.apply_period.label || '-')}</td></tr>`, {
    perPage: 10, unit: '종',
    wrap: (rows) => `<table class="wf"><thead><tr><th style="width:110px">상태</th><th>정책명</th>
      <th>분류</th><th>기관</th><th>신청기간</th></tr></thead><tbody>${rows}</tbody></table>`,
  });

  /* ── 온통청년 API 로 지역 정책 확장 ── */
  const box = el(`<section class="card">
    <div class="card-h">
      <div><div class="mini">NATIONAL POLICY API</div>
        <div class="card-t" style="margin-top:4px">내 지역에서 더 받을 수 있는 정책</div></div>
      <span class="tag" id="ycTag">불러오는 중…</span>
    </div>
    <p class="card-sub">온통청년(한국고용정보원) 청년정책 API에서 <b>${esc(state.profile.region_name || state.profile.zip_cd)}</b> 기준으로
      조회한 정책입니다. 위 17종과 달리 <b>금액 계산에는 쓰지 않고 자격 판정만</b> 합니다 —
      이 API는 대출한도·금리 같은 금융 파라미터를 제공하지 않기 때문입니다.</p>
    <div id="ycBody"><div class="empty"><span class="spin"></span> 정책을 불러오는 중…</div></div>
  </section>`);
  v.append(box);

  (async () => {
    const res = await fetchYouthPolicies({ zipCd: regionQuery(state.profile.zip_cd), pageSize: 100 });
    const tag = $('#ycTag'); const body = $('#ycBody');

    if (!res.ok) {
      tag.textContent = '연결 안 됨';
      body.innerHTML = `<div class="warn">
        <b>정책 API를 불러오지 못했습니다.</b> 위 정형 DB ${state.policies.length}종은 그대로 사용할 수 있습니다.
        <div style="font-size:11px;margin-top:6px;opacity:.9">사유: ${esc(String(res.reason).slice(0, 200))}</div>
        ${/no_api_key/.test(res.reason) ? '<div style="font-size:11px;margin-top:6px;font-weight:700">👉 환경변수 YOUTH_API_KEY 를 설정하고 재배포하세요.</div>' : ''}
      </div>`;
      return;
    }
    if (!res.policies.length) {
      tag.textContent = '해당 없음';
      body.innerHTML = '<div class="empty">이 지역 조건으로 조회된 추가 정책이 없습니다.</div>';
      return;
    }

    const judged = judgeAll(res.policies, state.profile, state.goal, new Date());
    /* 판정 순서를 먼저 지키고, 같은 판정 안에서 우리 지역 전용을 위로 올린다 */
    const VORDER = { eligible: 0, conditional: 1, not_eligible: 2, ended: 3 };
    judged.sort((a, b) => (VORDER[a.verdict] - VORDER[b.verdict])
      || (a.policy.region_scope.rank - b.policy.region_scope.rank));
    const usable = judged.filter((r) => ['eligible', 'conditional'].includes(r.verdict));
    const localOnly = judged.filter((r) => r.policy.region_scope.rank === 0 && ['eligible','conditional'].includes(r.verdict));
    tag.textContent = `${res.total.toLocaleString()}건 중 ${judged.length}건 조회 · 신청 가능 ${usable.length}건 (지역 전용 ${localOnly.length}건)`;

    body.innerHTML = `
      <div class="grid4" style="margin-bottom:14px">
        ${['eligible', 'conditional', 'not_eligible', 'ended'].map((k) => `
          <div class="stat"><div class="l">${VERDICT[k].dot} ${VERDICT[k].label}</div>
            <div class="v" style="font-size:19px">${judged.filter((r) => r.verdict === k).length}건</div></div>`).join('')}
      </div>
      <div id="ycList"></div>
      <div class="note" style="margin-top:14px">
        판정은 API가 내려준 연령·소득·지역·취업 요건을 우리 규칙 엔진에 그대로 넣어 계산한 것입니다. 금액은 API에 없어 표시하지 않습니다.<br>‘전국’으로 표시된 정책은 <b>운영기관이 특정 지자체여도 지역코드가 전국으로 등록된 것</b>이라 실제 신청 가능 여부는 공고 원문 확인이 필요합니다.
      </div>`;

    paginate($('#ycList'), judged, (r) => `
      <div style="border:1px solid var(--bd);border-radius:11px;padding:13px 15px;margin-bottom:9px;background:${r.verdict === 'eligible' ? 'var(--sky)' : '#fff'}">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap">
          <b style="font-size:13.5px;color:var(--navy)">${esc(r.policy.name)}</b>
          <span style="display:flex;gap:6px;align-items:center">
            <span class="chip" style="${r.policy.region_scope.rank === 0 ? 'background:#dcfce7;color:#15803d' : ''}">${esc(r.policy.region_scope.label)}</span>
            <span class="badge ${VERDICT[r.verdict].tone}">${r.dot} ${r.label}</span>
          </span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:5px">${esc(r.reason)}</div>
        <div class="src" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <span>${esc(r.policy.provider)}</span>
          <span>· ${esc(r.policy.apply_period.label || '기간 미상')}${r.policy.apply_period.start ? ` ${esc(r.policy.apply_period.start)} ~ ${esc(r.policy.apply_period.end || '')}` : ''}</span>
          ${r.policy.source.based_on ? `<span>· 기준일 ${esc(r.policy.source.based_on)}</span>` : ''}
          ${r.policy.action.apply_url ? `<a href="${esc(r.policy.action.apply_url)}" target="_blank" rel="noopener">신청 페이지 →</a>` : ''}
        </div>
      </div>`, { perPage: 10, unit: '건' });
  })();
}

function viewMypage(v) {
  const p = state.profile;
  const rows = [
    ['이름', p.nickname], ['만 나이', koreanAge(p.birth_ymd) + '세'],
    ['세전 연소득', money(p.annual_income)], ['순자산', p.net_asset != null ? money(p.net_asset) : '미입력'],
    ['취업 형태', CODE.job[p.job_code]], ['학력', CODE.school[p.school_code]],
    ['결혼 상태', CODE.marriage[p.marriage_code]],
    ['거주지', p.region_name || regionName(p.zip_cd)],
    ['주택 보유', p.is_homeowner ? '보유' : '무주택'],
    ['특화 요건', (p.sbiz_codes || []).map((c) => CODE.sbiz[c]).join(', ') || '없음'],
  ];
  v.append(el(`<section class="card">
    <div class="card-t">마이페이지</div>
    <p class="card-sub">여기 값이 바뀌면 정책 판정이 즉시 다시 계산됩니다.</p>
    <div class="grid2">${rows.map(([l, val]) => `<div class="stat" style="text-align:left">
      <div class="l">${l}</div><div class="v" style="font-size:15px">${esc(val)}</div></div>`).join('')}</div>
    <div style="border-top:1px solid var(--bd);margin-top:20px;padding-top:18px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
        <div>
          <div style="font-size:14px;font-weight:800;color:var(--navy)">보유 부채</div>
          <div style="font-size:12px;color:var(--muted);margin-top:3px">
            <b>선택 항목</b>입니다. 갚고 있는 대출이 있을 때만 넣으세요.
            상환 계획과 목표 도달 시점 계산에 사용되며, 저장하면 즉시 반영됩니다.</div>
        </div>
        <div id="debtTotal" style="font-size:16px;font-weight:800;color:var(--red)"></div>
      </div>
      <div id="myDebtBox" style="margin-top:12px"></div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
        <button class="btn" id="saveDebt" style="padding:9px 18px;font-size:13px">부채 저장</button>
        <span id="debtMsg" style="font-size:12px;color:var(--green);font-weight:700"></span>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin-top:18px">
      <button class="btn ghost" id="logout">로그아웃</button>
      <a class="btn ghost" href="./index.html">새 목표 설정</a>
    </div>
    <div class="src" style="margin-top:14px">저장 위치: ${state.mode === 'supabase' ? 'Supabase (계정 연동)' : '이 브라우저 (localStorage)'}</div>
  </section>`));

  /* ── 부채 편집 ─────────────────────────────────────────── */
  const box = $('#myDebtBox');
  const showTotal = (list) => {
    const t = (list || []).reduce((a, d) => a + d.balance, 0);
    $('#debtTotal').textContent = t ? money(t) : '없음';
  };
  renderDebtEditor(box, p.debts || []);
  showTotal(p.debts);
  box.addEventListener('input', () => showTotal(collectDebts(box)));
  box.addEventListener('click', () => setTimeout(() => showTotal(collectDebts(box)), 0));

  $('#saveDebt').addEventListener('click', async () => {
    const v = validateDebts(box);
    const debts = collectDebts(box);
    await S.saveProfile({ debts });
    state.profile = { ...state.profile, debts };
    /* 저장된 값으로 폼을 다시 그린다 — 버려진 행이 화면에 남아
       "저장됐다"고 오해하지 않도록. */
    renderDebtEditor(box, debts);
    /* 폼을 다시 그리면 경고문도 같이 지워진다 — 새 폼에 다시 써 준다 */
    if (v.messages.length) {
      const w = box.querySelector('.debt-warn');
      if (w) w.textContent = v.messages.join(' ');
    }
    showTotal(debts);
    $('#debtMsg').style.color = v.emptyCount ? 'var(--red)' : 'var(--green)';
    $('#debtMsg').textContent = debts.length
      ? `${debts.length}건 저장했습니다 · 정책 판정과 시뮬레이션에 반영됩니다`
      : '부채 없음으로 저장했습니다';
    setTimeout(() => { $('#debtMsg').textContent = ''; }, 4000);
  });

  $('#logout').addEventListener('click', async () => { await S.signOut(); location.href = './index.html'; });
}

boot();
