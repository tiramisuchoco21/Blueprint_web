/* ============================================================================
 * 온통청년 API 정책 → 우리 판정 엔진이 읽는 형태로 변환
 *
 * 역할 분담
 *   정형 DB(policies.json) : 금융 파라미터가 있어 목표 자금을 '계산'할 수 있는 핵심 17종
 *   온통청년 API           : 계산은 못 하지만 '내가 받을 수 있는지 판정'은 되는 나머지 전부
 *
 * API 에는 대출한도·보증금 비율·금리가 없다. 그래서 금액은 만들어내지 않고
 * finance.type = 'info' 로 두어 계산에서 제외한다. (없는 숫자를 지어내지 않는다)
 * ========================================================================== */

const NO_LIMIT = { job: '0013010', school: '0049010', sbiz: '0014010', marriage: '0055003' };

function shorten(name, n = 20) {
  const t = String(name || '').replace(/\s*\[.*?\]\s*/g, '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* 지역 범위 구분
 * 온통청년에는 운영기관이 특정 지자체여도 지역코드를 전국(250여 개)으로 등록한 정책이 많다.
 * 그대로 나열하면 "마포구 사람에게 의성군 정책이 신청 가능"으로 보인다.
 * 판정은 데이터대로 하되, 화면에서는 범위를 구분해 지역 전용 정책을 앞에 올린다. */
const NATIONWIDE_THRESHOLD = 150;
export function regionScope(zipCds) {
  const n = (zipCds || []).length;
  if (n === 0 || n >= NATIONWIDE_THRESHOLD) return { key: 'national', label: '전국', rank: 1 };
  if (n <= 5) return { key: 'local', label: '우리 지역 전용', rank: 0 };
  return { key: 'regional', label: `${n}개 지역`, rank: 0 };
}

/** /api/policies 응답 1건 → policies.json 과 같은 모양 */
export function toLocalShape(p) {
  const e = p.eligibility || {};
  const pick = (arr, fallback) => (arr && arr.length ? arr : [fallback]);

  return {
    region_scope: regionScope(e.zip_cds),
    policy_id: 'yc_' + p.plcy_no,
    name: p.name,
    short_name: shorten(p.name),
    provider: p.provider || '온통청년',
    category: 'external',
    is_policy: true,
    external: true,                       // 화면에서 '판정만 가능'으로 구분
    lclsf: (p.lclsf || [])[0] || '',
    mclsf: (p.mclsf || [])[0] || '',
    keywords: p.keywords || [],
    exclusive_group: null,
    explain: p.explain,
    support: p.support,
    eligibility: {
      age: e.age && (e.age.min != null || e.age.max != null) ? e.age : { min: null, max: null },
      income_max: e.income_max,
      income_cond_code: e.income_cond_code || '0043001',
      marriage_codes: pick(e.marriage_code ? [e.marriage_code] : [], NO_LIMIT.marriage),
      job_codes: pick(e.job_codes, NO_LIMIT.job),
      school_codes: pick(e.school_codes, NO_LIMIT.school),
      sbiz_codes: pick(e.sbiz_codes, NO_LIMIT.sbiz),
      /* API 는 시군구 코드를 전부 나열해준다. 전국 정책은 목록이 비어있다. */
      regions: e.zip_cds || [],
      homeowner_allowed: true,            // API 가 무주택 요건을 따로 주지 않는다
      extra: [
        e.extra_note ? { key: 'extra_note', label: `추가 자격조건: ${e.extra_note}`, auto: false } : null,
        e.exclude_note ? { key: 'exclude_note', label: `참여 제한: ${e.exclude_note}`, auto: false } : null,
      ].filter(Boolean),
    },
    apply_period: p.apply_period || { code: null, label: null },
    /* 금액을 계산하지 않는다 — API 에 금융 파라미터가 없기 때문 */
    finance: { type: 'info', benefit_note: p.support || p.explain || '' },
    action: p.action || {},
    source: p.source || {},
  };
}

/**
 * 거주지 기준으로 받을 수 있는 정책을 불러온다.
 * 키가 없거나 실패하면 빈 배열 — 화면은 정형 DB 만으로 그대로 동작한다.
 */
export async function fetchYouthPolicies({ zipCd, lclsfNm, pageSize = 60 } = {}) {
  const q = new URLSearchParams({ pageSize: String(pageSize), pageNum: '1' });
  if (zipCd) q.set('zipCd', zipCd);
  if (lclsfNm) q.set('lclsfNm', lclsfNm);

  try {
    const r = await fetch(`/api/policies?${q}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, reason: j.message || j.error || `HTTP ${r.status}`, policies: [], total: 0 };
    }
    return {
      ok: true,
      policies: (j.policies || []).map(toLocalShape),
      total: (j.paging && j.paging.totCount) || (j.policies || []).length,
      fetchedAt: j.fetched_at,
    };
  } catch (err) {
    return { ok: false, reason: String((err && err.message) || err), policies: [], total: 0 };
  }
}

/** 거주 시군구 + 상위 시도 코드를 함께 조회해 지역 정책을 폭넓게 잡는다 */
export function regionQuery(zipCd) {
  if (!zipCd) return '';
  const sido = zipCd.slice(0, 2) + '000';
  return zipCd === sido ? zipCd : `${zipCd},${sido}`;
}
