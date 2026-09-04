/* ============================================================================
 * 청사진 · 부채 입력 폼 (공용)
 * 회원가입(auth.html)과 마이페이지(app.js)가 같은 폼을 쓴다.
 * 금액은 사용자가 "만 원" 단위로 입력하고, 저장은 원 단위로 한다.
 * ========================================================================== */
import { DEBT_LABEL } from './calc.js';

const KINDS = ['student', 'credit', 'card', 'mortgage', 'jeonse', 'other'];

function rowHTML(d = {}) {
  const kind = d.kind || 'student';
  return `<div class="debt-row" style="display:grid;grid-template-columns:1.1fr 1fr .8fr .9fr auto;gap:6px;align-items:end;margin-bottom:8px">
    <div><label style="font-size:11px;color:var(--muted);font-weight:700">종류</label>
      <select class="inp d-kind" style="padding:9px 10px">
        ${KINDS.map((k) => `<option value="${k}"${k === kind ? ' selected' : ''}>${DEBT_LABEL[k]}</option>`).join('')}
      </select></div>
    <div><label style="font-size:11px;color:var(--muted);font-weight:700">잔액 (만 원)</label>
      <input class="inp d-bal" type="number" min="1" step="10" style="padding:9px 10px"
        value="${d.balance != null ? Math.round(d.balance / 10000) : ''}" placeholder="400"></div>
    <div><label style="font-size:11px;color:var(--muted);font-weight:700">연 금리 (%)</label>
      <input class="inp d-rate" type="number" min="0" max="30" step="0.1" style="padding:9px 10px"
        value="${d.rate != null ? +(d.rate * 100).toFixed(2) : ''}" placeholder="1.7"></div>
    <div><label style="font-size:11px;color:var(--muted);font-weight:700">남은 개월</label>
      <input class="inp d-months" type="number" min="0" max="600" step="1" style="padding:9px 10px"
        value="${d.remaining_months || ''}" placeholder="비우면 이자만"></div>
    <button type="button" class="btn ghost d-del"
      style="padding:9px 12px;font-size:12px" title="삭제">삭제</button>
  </div>`;
}

/** 컨테이너에 부채 편집 UI를 그린다. */
export function renderDebtEditor(box, debts = []) {
  box.innerHTML = `
    <div class="debt-rows">${(debts || []).map(rowHTML).join('')}</div>
    <button type="button" class="btn ghost d-add" style="padding:8px 14px;font-size:12.5px">+ 부채 추가</button>
    <div style="font-size:11px;color:var(--muted2);margin-top:6px">
      <b>선택 항목입니다.</b> 갚고 있는 대출이 없으면 아무것도 추가하지 마세요.
      넣으면 상환 계획과 목표 도달 시점을 함께 계산합니다.<br>
      잔액은 1만 원 이상만 저장됩니다. <b>남은 개월을 비우면</b> 만기일시(이자만 납부)로 계산합니다.</div>
    <div class="debt-warn" style="font-size:11.5px;color:var(--red);font-weight:700;margin-top:6px"></div>`;

  const rows = box.querySelector('.debt-rows');
  box.querySelector('.d-add').addEventListener('click', () => {
    rows.insertAdjacentHTML('beforeend', rowHTML());
  });
  /* 삭제는 위임으로 — 나중에 추가된 행에도 걸리도록 */
  box.addEventListener('click', (e) => {
    const btn = e.target.closest('.d-del');
    if (btn) btn.closest('.debt-row').remove();
  });
}

/** 편집 UI에서 debts 배열을 읽어낸다. 잔액이 없거나 0인 행은 버린다. */
export function collectDebts(box) {
  return [...box.querySelectorAll('.debt-row')].map((r) => {
    const balance = Math.round(Number(r.querySelector('.d-bal').value || 0) * 10000);
    const rateRaw = r.querySelector('.d-rate').value.trim();
    const months = Number(r.querySelector('.d-months').value || 0);
    return {
      kind: r.querySelector('.d-kind').value,
      balance,
      /* 빈 칸(미입력)과 0%(무이자)는 다르다. 미입력은 null 로 두고
         상환 조언에서 "금리를 입력해 달라"고 안내한다. */
      rate: rateRaw === '' ? null : Math.max(0, Math.min(0.3, Number(rateRaw) / 100)),
      ...(months > 0 ? { remaining_months: months } : {}),
    };
  }).filter((d) => d.balance > 0);
}

/** 저장 전 검사. 잔액이 비었거나 0인 행을 조용히 버리지 않고 알려준다.
 *  (0원짜리 부채는 존재하지 않는다 — 없으면 행을 지우는 게 맞다) */
export function validateDebts(box) {
  const rows = [...box.querySelectorAll('.debt-row')];
  const empty = rows.filter((r) => !(Number(r.querySelector('.d-bal').value) > 0));
  const noRate = rows.filter((r) => Number(r.querySelector('.d-bal').value) > 0
    && r.querySelector('.d-rate').value.trim() === '');
  const msgs = [];
  if (empty.length) msgs.push(`잔액이 비어 있거나 0인 항목 ${empty.length}개는 저장하지 않습니다. 대출이 없으면 삭제해 주세요.`);
  if (noRate.length) msgs.push(`금리를 넣지 않은 항목 ${noRate.length}개가 있습니다. 금리가 없으면 갚는 순서를 계산할 수 없습니다.`);
  const warn = box.querySelector('.debt-warn');
  if (warn) warn.textContent = msgs.join(' ');
  return { emptyCount: empty.length, noRateCount: noRate.length, messages: msgs };
}
