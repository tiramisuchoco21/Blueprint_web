/* ============================================================================
 * 청사진 · 캘린더 알림 (.ics)
 *
 * 설계서 USP 04 "지금 불가해도 언제 가능해지는지 관리한다"의 실행 수단.
 * 웹은 푸시 알림을 보내기 어려우므로, 사용자의 캘린더 앱에 일정을 넣어
 * 신청 시점에 기기가 대신 알려주게 한다. (구글/애플/아웃룩 모두 .ics 지원)
 * ========================================================================== */

const pad = (n) => String(n).padStart(2, '0');
const toDate = (v) => (v instanceof Date ? v : new Date(v));

/* 종일 일정용 YYYYMMDD */
function dstamp(d) {
  const t = toDate(d);
  return `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}`;
}
/* UTC 타임스탬프 */
function utcstamp(d) {
  const t = toDate(d);
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
}
/* RFC 5545: 쉼표·세미콜론·역슬래시 이스케이프, 줄바꿈은 \n */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
/* RFC 5545: 한 줄 75옥텟 제한 → 접기 */
function fold(line) {
  const out = [];
  let buf = '';
  let bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 73) { out.push(buf); buf = ' '; bytes = 1; }
    buf += ch; bytes += b;
  }
  out.push(buf);
  return out.join('\r\n');
}

/**
 * @param events [{ uid, title, date, end, desc, url, alarmDaysBefore }]
 *        date : 'YYYY-MM-DD' 또는 Date (종일 일정)
 */
export function makeIcs(events, calName = '청사진 정책 일정') {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CheongSaJin//Policy Calendar//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(calName)}`,
    'X-WR-TIMEZONE:Asia/Seoul',
  ];

  for (const e of events) {
    const start = toDate(e.date);
    const end = e.end ? toDate(e.end) : new Date(start.getTime() + 86400000);
    /* 종일 일정의 DTEND 는 하루 다음날(exclusive) */
    const endEx = e.end ? new Date(end.getTime() + 86400000) : end;

    lines.push(
      'BEGIN:VEVENT',
      `UID:${esc(e.uid || `csj-${dstamp(start)}-${Math.random().toString(36).slice(2, 8)}`)}@cheongsajin`,
      `DTSTAMP:${utcstamp(new Date())}`,
      `DTSTART;VALUE=DATE:${dstamp(start)}`,
      `DTEND;VALUE=DATE:${dstamp(endEx)}`,
      fold(`SUMMARY:${esc(e.title)}`),
      e.desc ? fold(`DESCRIPTION:${esc(e.desc)}`) : null,
      e.url ? fold(`URL:${esc(e.url)}`) : null,
      'TRANSP:TRANSPARENT',
    );
    const days = e.alarmDaysBefore == null ? 7 : e.alarmDaysBefore;
    if (days >= 0) {
      lines.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        fold(`DESCRIPTION:${esc(e.title)}`),
        `TRIGGER:-P${days}D`,
        'END:VALARM',
      );
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.filter(Boolean).join('\r\n');
}

/** 브라우저에서 .ics 파일로 내려받기 */
export function downloadIcs(filename, icsText) {
  const blob = new Blob(['\uFEFF' + icsText], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.ics') ? filename : filename + '.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------------------------------------------------------------------
 * 목표와 확정 정책으로 일정 묶음을 만든다.
 *   · 신청기간이 있는 정책 → 접수 시작일 / 마감일
 *   · 상시 정책          → 자격 재확인 시점
 *   · 로드맵 마일스톤     → D-Day 역산
 * ------------------------------------------------------------------------- */
export function buildScheduleEvents(goal, policy, ddayDate) {
  const evts = [];
  const name = policy ? policy.name : '정책';
  const url = policy && policy.source ? policy.source.url : undefined;
  const ap = (policy && policy.apply_period) || {};

  if (ap.start) {
    evts.push({
      uid: `apply-start-${policy.policy_id}`,
      title: `[청사진] ${name} 접수 시작`,
      date: ap.start,
      desc: `신청 시작일입니다. 제출서류를 미리 준비하세요.\n출처: ${(policy.source && policy.source.name) || ''}`,
      url, alarmDaysBefore: 7,
    });
  }
  if (ap.end) {
    evts.push({
      uid: `apply-end-${policy.policy_id}`,
      title: `[청사진] ${name} 접수 마감`,
      date: ap.end,
      desc: '접수 마감일입니다. 아직 신청하지 않았다면 오늘까지 마쳐야 합니다.',
      url, alarmDaysBefore: 3,
    });
  }
  if (!ap.start && !ap.end && policy) {
    /* 상시 정책은 마감이 없으니 3개월 뒤 자격 재확인을 걸어둔다 */
    const d = new Date();
    d.setMonth(d.getMonth() + 3);
    evts.push({
      uid: `recheck-${policy.policy_id}`,
      title: `[청사진] ${name} 자격 재확인`,
      date: d,
      desc: '상시 접수 정책입니다. 소득·자산·무주택 요건에 변동이 없는지 점검하세요.',
      url, alarmDaysBefore: 3,
    });
  }

  if (ddayDate) {
    const dday = toDate(ddayDate);
    const months = goal.target_months || 24;
    /* 서류 준비 시점 = D-30, 사전 자격 재검증 = 목표기간의 40% 지점 */
    const docDay = new Date(dday); docDay.setDate(docDay.getDate() - 30);
    const recheck = new Date(dday); recheck.setMonth(recheck.getMonth() - Math.round(months * 0.4));

    if (recheck > new Date()) {
      evts.push({
        uid: `recheck-mid-${goal.id}`,
        title: '[청사진] 정책 자격 사전 재검증',
        date: recheck,
        desc: '무주택 요건과 소득·자산 변동 내역을 다시 확인할 시점입니다.',
        alarmDaysBefore: 7,
      });
    }
    if (docDay > new Date()) {
      evts.push({
        uid: `docs-${goal.id}`,
        title: '[청사진] 필요서류 준비 시작',
        date: docDay,
        desc: '신청까지 30일 남았습니다. 제출서류를 발급받아 두세요.',
        alarmDaysBefore: 3,
      });
    }
    evts.push({
      uid: `dday-${goal.id}`,
      title: '[청사진] 목표 D-Day',
      date: dday,
      desc: '목표 시점입니다.',
      alarmDaysBefore: 14,
    });
  }
  return evts;
}
