/* ============================================================================
 * 청사진 · 데이터 계층 (인증 + 저장)
 *
 * 두 가지 모드로 동작한다.
 *   supabase : /api/config 가 키를 내려주면 실제 Supabase Auth + Postgres 사용
 *   local    : 키가 없으면 localStorage 로 동작 (계정 발급 전에도 전부 시연 가능)
 * 화면 코드는 모드를 몰라도 되도록 인터페이스를 동일하게 맞춘다.
 * ========================================================================== */

const LS = {
  session: 'csj.session',
  users: 'csj.users',
  data: (uid) => `csj.data.${uid}`,
};

let mode = 'local';
let sb = null;          // supabase client
let cachedConfig = null;

/* --------------------------- 초기화 -------------------------------------- */
export async function initStore() {
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      cachedConfig = cfg;
      if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
        const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
        sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
        mode = 'supabase';
      }
    }
  } catch (e) {
    /* 로컬 개발 서버에는 /api 가 없다 → local 모드로 계속 */
  }
  if (mode === 'local') seedDemoAccounts();
  return { mode, config: cachedConfig };
}
/** 데모 데이터를 지금 즉시 다시 심는다 (로컬 모드 전용).
 *  비개발자도 콘솔 없이 초기화할 수 있게 화면 버튼에서 호출한다. */
export function resetDemoData() {
  if (mode !== 'local') throw new Error('데모 초기화는 로컬 모드에서만 가능합니다.');
  const users = readJSON(LS.users, {});
  ['demo1@cheongsajin.kr', 'demo2@cheongsajin.kr'].forEach((e) => {
    if (users[e]) localStorage.removeItem(LS.data(users[e].id));
  });
  localStorage.removeItem('csj.seedver');
  localStorage.removeItem(LS.session);
  seedDemoAccounts();
}

export const storeMode = () => mode;
export const aiEnabled = () => !!(cachedConfig && cachedConfig.hasAI);
export const policyApiEnabled = () => !!(cachedConfig && cachedConfig.hasPolicyApi);

/* ======================= local 모드 유틸 ================================== */
const readJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const writeJSON = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const uid = () => 'u_' + Math.random().toString(36).slice(2, 10);
const rid = () => 'r_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function emptyData() {
  return { profile: null, goals: [], goal_policies: [], simulations: [], transactions: [], checklist: [] };
}

/* 심사위원이 회원가입 없이 바로 볼 수 있도록 데모 계정 2개를 심어둔다 */
/* 데모 계정 시드 버전. 데모 데이터를 바꾸면 이 값을 올린다.
   그러면 사용자가 아무것도 하지 않아도 다음 접속에서 자동으로 갱신된다. */
const SEED_VER = '4';   // 4: 프로필에 debts 추가 (학자금 400만 / 신용대출 2,500만)
function seedDemoAccounts() {
  const users = readJSON(LS.users, {});
  if (localStorage.getItem('csj.seedver') === SEED_VER) return;
  localStorage.setItem('csj.seedver', SEED_VER);
  /* 데모 계정만 최신 시드로 교체한다. 실제 가입 계정은 건드리지 않는다. */
  ['demo1@cheongsajin.kr', 'demo2@cheongsajin.kr'].forEach((e) => {
    if (users[e]) { localStorage.removeItem(LS.data(users[e].id)); delete users[e]; }
  });

  /* 데모 계정은 id 를 고정한다. 시드를 갱신해도 로그인 세션이 끊기지 않는다. */
  const mk = (email, profile, goal, picked) => {
    const id = 'u_' + email.split('@')[0];
    users[email] = { id, email, password: 'demo1234', created_at: new Date().toISOString() };
    const d = emptyData();
    d.profile = { id, ...profile };
    if (goal) {
      const gid = rid();
      d.goals.push({ id: gid, user_id: id, status: 'active', started_on: new Date().toISOString().slice(0, 10), ...goal });
      d.checklist = DEFAULT_CHECKLIST.map((c, i) => ({ id: rid(), goal_id: gid, ...c, is_done: i < 2 }));
      /* 심사위원이 첫 화면에서 완성된 대시보드를 볼 수 있도록 정책 선택까지 심어둔다.
         (STEP 1~5 는 언제든 다시 열어 바꿀 수 있다) */
      (picked || []).forEach((p) => d.goal_policies.push({ id: rid(), goal_id: gid, selected_at: new Date().toISOString(), ...p }));
    }
    writeJSON(LS.data(id), d);
  };

  mk('demo1@cheongsajin.kr', {
    nickname: '김민재', birth_ymd: '2000-03-15', annual_income: 32000000, net_asset: 20000000,
    job_code: '0013001', school_code: '0049007', major_code: '0011003', marriage_code: '0055002',
    sbiz_codes: ['0014001'], zip_cd: '11440', region_name: '서울특별시 마포구', is_homeowner: false, household_size: 1,
    debts: [{ kind: 'student', balance: 4000000, rate: 0.017, remaining_months: 48 }],
  }, {
    raw_input: '2년 뒤 마포구에 1억 전세로 독립하고 싶어. 지금 600만 원 있어.',
    goal_type: 'jeonse', target_amount: 100000000, target_months: 24,
    target_zip_cd: '11440', current_asset: 6000000, monthly_saving: 583000,
  }, [
    { policy_id: 'youth_butimok', verdict: 'eligible', applied_amount: 80000000, is_final: true },
    { policy_id: 'youth_future_savings', verdict: 'conditional', applied_amount: 720000, is_final: false },
  ]);

  mk('demo2@cheongsajin.kr', {
    nickname: '이지은', birth_ymd: '1993-06-10', annual_income: 84000000, net_asset: 250000000,
    job_code: '0013001', school_code: '0049007', major_code: '0011002', marriage_code: '0055001',
    sbiz_codes: [], zip_cd: '41170', region_name: '경기도 안양시', is_homeowner: false, household_size: 2,
    /* 만기일시 신용대출 — remaining_months 가 없으면 이자만 내는 것으로 계산된다 */
    debts: [{ kind: 'credit', balance: 25000000, rate: 0.052 }],
  }, {
    raw_input: '1년 뒤에 경기권 6억 아파트를 사고 싶어요. 금융자산은 2억 정도 됩니다.',
    goal_type: 'purchase', target_amount: 600000000, target_months: 12,
    target_zip_cd: '41170', current_asset: 199000000, monthly_saving: 2000000,
  }, [
    { policy_id: 'bogeumjari', verdict: 'eligible', applied_amount: 360000000, is_final: true },
  ]);

  writeJSON(LS.users, users);
}

export const DEFAULT_CHECKLIST = [
  { item_key: 'goal_set', label: '목표 설정 완료' },
  { item_key: 'finance_input', label: '금융현황 입력' },
  { item_key: 'eligibility', label: '정책 자격 재확인' },
  { item_key: 'deposit_safety', label: '보증·안전성 체크' },
  { item_key: 'apply_alarm', label: '정책 신청일 알림 설정' },
  { item_key: 'documents', label: '필요서류 체크' },
];

/* ============================== 인증 ====================================== */
export async function signUp(email, password, profile) {
  if (mode === 'supabase') {
    const { data, error } = await sb.auth.signUp({
      email, password, options: { data: profile },
    });
    if (error) throw new Error(translate(error.message));
    return data.user;
  }
  const users = readJSON(LS.users, {});
  if (users[email]) throw new Error('이미 가입된 이메일입니다.');
  const id = uid();
  users[email] = { id, email, password, created_at: new Date().toISOString() };
  writeJSON(LS.users, users);
  const d = emptyData();
  d.profile = { id, ...profile };
  writeJSON(LS.data(id), d);
  writeJSON(LS.session, { id, email });
  return { id, email };
}

export async function signIn(email, password) {
  if (mode === 'supabase') {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(translate(error.message));
    return data.user;
  }
  const users = readJSON(LS.users, {});
  const u = users[email];
  if (!u || u.password !== password) throw new Error('이메일 또는 비밀번호가 올바르지 않습니다.');
  writeJSON(LS.session, { id: u.id, email });
  return { id: u.id, email };
}

export async function signOut() {
  if (mode === 'supabase') await sb.auth.signOut();
  localStorage.removeItem(LS.session);
}

export async function currentUser() {
  if (mode === 'supabase') {
    const { data } = await sb.auth.getUser();
    return data.user || null;
  }
  return readJSON(LS.session, null);
}

function translate(msg) {
  if (/already registered/i.test(msg)) return '이미 가입된 이메일입니다.';
  if (/Invalid login/i.test(msg)) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (/Password should be/i.test(msg)) return '비밀번호는 6자 이상이어야 합니다.';
  return msg;
}

/* ============================== 프로필 ==================================== */
export async function getProfile() {
  const u = await currentUser();
  if (!u) return null;
  if (mode === 'supabase') {
    const { data } = await sb.from('profiles').select('*').eq('id', u.id).single();
    return data;
  }
  return readJSON(LS.data(u.id), emptyData()).profile;
}

export async function saveProfile(patch) {
  const u = await currentUser();
  if (!u) throw new Error('로그인이 필요합니다.');
  if (mode === 'supabase') {
    const { data, error } = await sb.from('profiles').update(patch).eq('id', u.id).select().single();
    if (error) throw error;
    return data;
  }
  const d = readJSON(LS.data(u.id), emptyData());
  d.profile = { ...d.profile, ...patch };
  writeJSON(LS.data(u.id), d);
  return d.profile;
}

/* =============================== 목표 ===================================== */
export async function getActiveGoal() {
  const u = await currentUser();
  if (!u) return null;
  if (mode === 'supabase') {
    const { data } = await sb.from('goals').select('*')
      .eq('user_id', u.id).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1);
    return (data && data[0]) || null;
  }
  const d = readJSON(LS.data(u.id), emptyData());
  return d.goals.filter((g) => g.status === 'active').pop() || null;
}

export async function createGoal(goal) {
  const u = await currentUser();
  if (!u) throw new Error('로그인이 필요합니다.');
  const row = { ...goal, user_id: u.id, status: 'active', started_on: new Date().toISOString().slice(0, 10) };
  if (mode === 'supabase') {
    await sb.from('goals').update({ status: 'archived' }).eq('user_id', u.id).eq('status', 'active');
    const { data, error } = await sb.from('goals').insert(row).select().single();
    if (error) throw error;
    await seedChecklist(data.id);
    return data;
  }
  const d = readJSON(LS.data(u.id), emptyData());
  d.goals.forEach((g) => { g.status = 'archived'; });
  const created = { id: rid(), ...row };
  d.goals.push(created);
  d.checklist = d.checklist.filter((c) => c.goal_id !== created.id);
  DEFAULT_CHECKLIST.forEach((c, i) => d.checklist.push({ id: rid(), goal_id: created.id, ...c, is_done: i < 2 }));
  writeJSON(LS.data(u.id), d);
  return created;
}

export async function updateGoal(goalId, patch) {
  const u = await currentUser();
  if (mode === 'supabase') {
    const { data, error } = await sb.from('goals').update(patch).eq('id', goalId).select().single();
    if (error) throw error;
    return data;
  }
  const d = readJSON(LS.data(u.id), emptyData());
  const g = d.goals.find((x) => x.id === goalId);
  Object.assign(g, patch);
  writeJSON(LS.data(u.id), d);
  return g;
}

/* ========================== 선택한 정책 =================================== */
export async function getGoalPolicies(goalId) {
  const u = await currentUser();
  if (mode === 'supabase') {
    const { data } = await sb.from('goal_policies').select('*').eq('goal_id', goalId);
    return data || [];
  }
  return readJSON(LS.data(u.id), emptyData()).goal_policies.filter((p) => p.goal_id === goalId);
}

export async function setGoalPolicies(goalId, rows) {
  const u = await currentUser();
  if (mode === 'supabase') {
    await sb.from('goal_policies').delete().eq('goal_id', goalId);
    if (rows.length) await sb.from('goal_policies').insert(rows.map((r) => ({ ...r, goal_id: goalId })));
    return rows;
  }
  const d = readJSON(LS.data(u.id), emptyData());
  d.goal_policies = d.goal_policies.filter((p) => p.goal_id !== goalId)
    .concat(rows.map((r) => ({ id: rid(), goal_id: goalId, ...r })));
  writeJSON(LS.data(u.id), d);
  return rows;
}

export async function finalizePolicy(goalId, policyId) {
  const u = await currentUser();
  if (mode === 'supabase') {
    await sb.from('goal_policies').update({ is_final: false }).eq('goal_id', goalId);
    await sb.from('goal_policies').update({ is_final: true }).eq('goal_id', goalId).eq('policy_id', policyId);
    return;
  }
  const d = readJSON(LS.data(u.id), emptyData());
  d.goal_policies.forEach((p) => { if (p.goal_id === goalId) p.is_final = (p.policy_id === policyId); });
  writeJSON(LS.data(u.id), d);
}

/* ============================ 시뮬레이션 ================================== */
export async function addSimulation(goalId, row) {
  const u = await currentUser();
  if (mode === 'supabase') { await sb.from('simulations').insert({ goal_id: goalId, ...row }); return; }
  const d = readJSON(LS.data(u.id), emptyData());
  d.simulations.push({ id: rid(), goal_id: goalId, created_at: new Date().toISOString(), ...row });
  writeJSON(LS.data(u.id), d);
}

/* ============================== 결제내역 ================================== */
export async function getTransactions() {
  const u = await currentUser();
  if (!u) return [];
  if (mode === 'supabase') {
    const { data } = await sb.from('transactions').select('*')
      .eq('user_id', u.id).order('occurred_at', { ascending: false }).limit(500);
    return data || [];
  }
  return readJSON(LS.data(u.id), emptyData()).transactions;
}

export async function addTransactions(list) {
  const u = await currentUser();
  if (!u) throw new Error('로그인이 필요합니다.');
  if (mode === 'supabase') {
    const { data, error } = await sb.from('transactions')
      .insert(list.map((t) => ({ ...t, user_id: u.id }))).select();
    if (error) throw error;
    return data;
  }
  const d = readJSON(LS.data(u.id), emptyData());
  const rows = list.map((t) => ({ id: rid(), user_id: u.id, ...t }));
  d.transactions = rows.concat(d.transactions);
  writeJSON(LS.data(u.id), d);
  return rows;
}

export async function updateTransaction(id, patch) {
  const u = await currentUser();
  if (mode === 'supabase') { await sb.from('transactions').update(patch).eq('id', id); return; }
  const d = readJSON(LS.data(u.id), emptyData());
  const t = d.transactions.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  writeJSON(LS.data(u.id), d);
}

/* ============================= 체크리스트 ================================= */
async function seedChecklist(goalId) {
  await sb.from('checklist_items').insert(
    DEFAULT_CHECKLIST.map((c, i) => ({ goal_id: goalId, ...c, is_done: i < 2 })));
}

export async function getChecklist(goalId) {
  const u = await currentUser();
  if (mode === 'supabase') {
    const { data } = await sb.from('checklist_items').select('*').eq('goal_id', goalId).order('item_key');
    return data || [];
  }
  return readJSON(LS.data(u.id), emptyData()).checklist.filter((c) => c.goal_id === goalId);
}

export async function toggleChecklist(goalId, itemKey, isDone) {
  const u = await currentUser();
  if (mode === 'supabase') {
    await sb.from('checklist_items').update({ is_done: isDone, done_at: isDone ? new Date().toISOString() : null })
      .eq('goal_id', goalId).eq('item_key', itemKey);
    return;
  }
  const d = readJSON(LS.data(u.id), emptyData());
  const c = d.checklist.find((x) => x.goal_id === goalId && x.item_key === itemKey);
  if (c) c.is_done = isDone;
  writeJSON(LS.data(u.id), d);
}
