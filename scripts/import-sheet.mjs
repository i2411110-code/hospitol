#!/usr/bin/env node
// ============================================================
// 인하우스 구글 시트 → Firestore 이관 스크립트
//
// 사용법
//   1) 구글 시트에서  파일 > 다운로드 > 쉼표로 구분된 값(.csv)  로 저장
//   2) 서비스 계정 키(JSON) 경로를 환경변수로 지정 (이 파일은 절대 GitHub에 올리지 마세요)
//        Windows(PowerShell):  $env:GOOGLE_APPLICATION_CREDENTIALS="C:\keys\gaon-key.json"
//        Mac/Linux:            export GOOGLE_APPLICATION_CREDENTIALS=/path/to/gaon-key.json
//   3) 먼저 "연습 실행"(DB에 아무것도 쓰지 않음) 으로 리포트 확인
//        node scripts/import-sheet.mjs ./sheet.csv
//   4) 리포트가 괜찮으면 실제 반영
//        node scripts/import-sheet.mjs ./sheet.csv --commit
//
// 다시 실행해도 안전합니다 (방문 기록은 고정 ID로 덮어쓰기 → 중복 생성 없음).
// 시트에 새 행이 추가되거나 상담내용이 수정되면 같은 명령을 다시 돌려 동기화하세요.
// ============================================================

import fs from 'node:fs';
import crypto from 'node:crypto';

/* ---------------------------------------------------------
   ★ 설정 — 반드시 확인/수정하세요
--------------------------------------------------------- */

// 시트의 '근무자' 이름 → 팀 코드 / 직책(표시용)
// - teamId 는 앱 "프로필 설정"에서 팀원들이 입력하는 팀 코드와 같아야 합니다.
// - role 은 조회 화면의 "팀장/팀원" 표시용입니다. (실제 팀장 권한은 Firestore staff 문서의 role 로만 부여됩니다)
const TEAM_ID = 'REPLACE_ME'; // 예: 'gaon-team-1'  ← 실제 팀 코드로 바꾸세요
const ROSTER = {
  '심현진': { teamId: TEAM_ID, role: 'staff' },
  '김세희': { teamId: TEAM_ID, role: 'staff' },
  '문종현': { teamId: TEAM_ID, role: 'lead' },
  '김연운': { teamId: TEAM_ID, role: 'lead' },
  '박정남': { teamId: TEAM_ID, role: 'staff' },
  '최재혁': { teamId: TEAM_ID, role: 'lead' },
  '최수아': { teamId: TEAM_ID, role: 'staff' }
};

/* ---------------------------------------------------------
   인자 처리
--------------------------------------------------------- */
const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith('--'));
const COMMIT = args.includes('--commit');

if (!csvPath) {
  console.error('사용법: node scripts/import-sheet.mjs <시트.csv> [--commit]');
  process.exit(1);
}
if (COMMIT && TEAM_ID === 'REPLACE_ME') {
  console.error('스크립트 상단의 TEAM_ID 를 실제 팀 코드로 바꾼 뒤 --commit 을 실행하세요.');
  process.exit(1);
}

/* ---------------------------------------------------------
   유틸 (앱의 app.js 와 반드시 같은 규칙을 써야 중복 판정이 맞습니다)
--------------------------------------------------------- */
const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');
const normName = (s) => String(s ?? '').replace(/\s+/g, '');
const sha256Hex = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
const sha1Hex = (t) => crypto.createHash('sha1').update(t, 'utf8').digest('hex');
const clean = (s) => String(s ?? '').trim();

const maskPhone = (d) => (d.length >= 10 ? d.slice(0, 3) + '-****-' + d.slice(-4) : '');

/* ---------------------------------------------------------
   CSV 파서 (따옴표 안의 줄바꿈 / "" 이스케이프 지원)
--------------------------------------------------------- */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ---------------------------------------------------------
   값 정규화
--------------------------------------------------------- */

// '2026.05.04' '2026/06/10(수)' '2026. 8. 24(월)' '2026.07.1' → '2026-05-04'
// 연도가 2020~2035 밖이면(예: 1905/07/18) null → 리포트에 따로 표시
function parseVisitDate(raw) {
  const m = clean(raw).match(/(\d{4})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{1,2})/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2020 || y > 2035 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// 생년월일 → 'YYMMDD' 6자리 (못 읽으면 null)
function parseBirth6(raw) {
  const s = clean(raw);
  if (!s) return null;
  let m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/); // 1963.05.07
  if (m) return m[1].slice(2) + m[2].padStart(2, '0') + m[3].padStart(2, '0');
  const d = digitsOnly(s);
  if (/^\d{6}$/.test(d) && !s.includes('.')) return d;           // 710503
  if (/^\d{8}$/.test(d)) return d.slice(2);                      // 20060409 → 060409
  if (/^\d{5}$/.test(d) && !s.includes('.')) return '0' + d;     // 60317 → 060317 (앞자리 0 유실)
  if (/^\d{7}$/.test(d) && /^(19|20)/.test(d)) {                 // 2000926 → 000926 (추정)
    return d.slice(2, 4) + '0' + d[4] + d.slice(5);
  }
  return null;
}

// 전화번호 → 숫자 10~11자리 (자리표시자 000-0000-0000 / 010-0000-0000 / '-' 등은 null)
function parsePhone(raw) {
  const d = digitsOnly(raw);
  if (!/^01\d{8,9}$/.test(d)) return null;
  if (/^010(0000|00000)/.test(d) || /^0+$/.test(d.slice(3))) return null;
  return d;
}

// 보험 한 줄(여러 줄 셀 포함) → policies 배열
function buildPolicies(cells) {
  const [join, insurer, illIn, injIn, illOut, injOut, nonCov] = cells.map(clean);
  const split = (s) => s.split(/\r?\n/).map((x) => x.trim());
  const joins = split(join);
  const insurers = split(insurer);
  const n = Math.max(joins.length, insurers.length);
  const cols = [illIn, injIn, illOut, injOut, nonCov].map(split);
  const policies = [];
  for (let i = 0; i < n; i++) {
    const p = {
      joinDate: joins[i] || '',
      insurer: insurers[i] || '',
      illnessInpatient: cols[0][i] ?? cols[0][0] ?? '',
      injuryInpatient: cols[1][i] ?? cols[1][0] ?? '',
      illnessOutpatient: cols[2][i] ?? cols[2][0] ?? '',
      injuryOutpatient: cols[3][i] ?? cols[3][0] ?? '',
      nonCovered3: nonCov // 3대비급여 칸은 줄바꿈이 한 셀에 여러 항목이라 원문 유지
    };
    if (p.joinDate || p.insurer) policies.push(p);
  }
  return policies;
}

/* ---------------------------------------------------------
   시트 → 방문(visit) 목록
--------------------------------------------------------- */
const report = {
  mode: COMMIT ? 'COMMIT' : 'DRY-RUN',
  totalRows: 0,
  visits: 0,
  skippedNoName: [],
  skippedNoWorker: [],
  unknownWorker: [],
  dateUnreadable: [],
  birthUnreadable: [],
  phoneUnreadable: [],
  sameNameMultiPeople: [],
  continuationRows: 0
};

const raw = fs.readFileSync(csvPath, 'utf8');
const table = parseCsv(raw);
report.totalRows = table.length;

const headerIdx = table.findIndex((r) => clean(r[0]) === '방문날짜');
if (headerIdx < 0) {
  console.error("헤더 행('방문날짜')을 찾지 못했습니다. 시트 전체를 CSV로 내려받았는지 확인하세요.");
  process.exit(1);
}

const visits = [];
for (let i = headerIdx + 1; i < table.length; i++) {
  const r = table[i];
  const rowNo = i + 1; // 시트/CSV 상의 행 번호(1부터)
  const c = (k) => clean(r[k]);
  if (r.every((x) => clean(x) === '')) continue;

  const hasHead = c(0) || c(1) || c(2);

  // 이어쓰기 행: 방문날짜/근무자/이름이 비어 있고 보험 정보만 있는 행 → 직전 방문에 보험 추가
  if (!hasHead && (c(6) || c(7)) && visits.length) {
    visits[visits.length - 1].policies.push(...buildPolicies([c(6), c(7), c(8), c(9), c(10), c(11), c(12)]));
    report.continuationRows++;
    continue;
  }

  const name = c(2);
  const worker = normName(c(1));
  if (!name) {
    report.skippedNoName.push({ rowNo, visitDate: c(0), worker, memo: c(17).slice(0, 40) });
    continue;
  }
  if (!worker) {
    report.skippedNoWorker.push({ rowNo, name });
    continue;
  }
  if (!ROSTER[worker]) report.unknownWorker.push({ rowNo, worker });

  const visitDate = parseVisitDate(c(0));
  if (!visitDate) report.dateUnreadable.push({ rowNo, raw: c(0), name });

  const birth6 = parseBirth6(c(3));
  if (c(3) && !birth6) report.birthUnreadable.push({ rowNo, name, raw: c(3) });

  const phone = parsePhone(c(4));
  if (c(4) && !phone && !/^[-\s]*$/.test(c(4))) report.phoneUnreadable.push({ rowNo, name, raw: c(4) });

  const noSilson = c(6) === '미가입';
  visits.push({
    rowNo,
    visitDateRaw: c(0),
    visitDate,
    worker,
    name,
    nameKey: normName(name),
    birth6,
    birthRaw: c(3),
    phone,
    phoneRaw: c(4),
    gender: c(5),
    noSilson,
    policies: noSilson ? [] : buildPolicies([c(6), c(7), c(8), c(9), c(10), c(11), c(12)]),
    type: c(13),         // 조회 / 청구 ...
    bodyPart: c(14),
    treatment: c(15),
    admission: c(16),    // 통원 / 입원
    memo: c(17)
  });
}
report.visits = visits.length;

/* ---------------------------------------------------------
   같은 사람 묶기 (이름이 같고, 전화번호 또는 생년월일이 같으면 동일인)
   - 생년월일이 서로 다르면 다른 사람 (예: 동명이인)
   - 이름만 있는 행은, 같은 이름의 사람이 한 명뿐이면 그 사람에게 합칩니다
--------------------------------------------------------- */
const clusters = []; // { nameKey, name, phones:Set, births:Set, visits:[] }
const byName = new Map();

function attach(cl, v) {
  cl.visits.push(v);
  if (v.phone) cl.phones.add(v.phone);
  if (v.birth6) cl.births.add(v.birth6);
}

for (const v of visits) {
  const list = byName.get(v.nameKey) || [];
  const birthConflict = (cl) => v.birth6 && cl.births.size && !cl.births.has(v.birth6);
  const sameId = (cl) => !birthConflict(cl) && ((v.phone && cl.phones.has(v.phone)) || (v.birth6 && cl.births.has(v.birth6)));
  const weak = (cl) => !birthConflict(cl) && ((!v.phone && !v.birth6) || (!cl.phones.size && !cl.births.size));

  let target = list.find(sameId);
  if (!target) {
    const cand = list.filter(weak);
    if (cand.length) target = cand[0];
  }
  if (!target) {
    target = { nameKey: v.nameKey, name: v.name, phones: new Set(), births: new Set(), visits: [] };
    clusters.push(target);
    list.push(target);
    byName.set(v.nameKey, list);
  }
  attach(target, v);
}
for (const [nk, list] of byName) {
  if (list.length > 1) report.sameNameMultiPeople.push({ name: nk, people: list.length });
}

/* ---------------------------------------------------------
   Firestore 문서 구성
--------------------------------------------------------- */
function toKeys(cl) {
  const keys = [];
  for (const p of cl.phones) keys.push(sha256Hex(`np|${cl.nameKey}|${p}`));     // 성함+휴대폰 (앱과 동일)
  for (const b of cl.births) keys.push(sha256Hex(`nb|${cl.nameKey}|${b}`));     // 성함+생년월일 (앱에 추가되는 키)
  return keys;
}

const summary = {
  patients: clusters.length,
  byStaff: {}
};
for (const cl of clusters) {
  const owner = cl.visits[0].worker; // 시트에서 가장 먼저 나온 방문의 근무자 = 선접수 담당자
  summary.byStaff[owner] = (summary.byStaff[owner] || 0) + 1;
}

console.log('\n===== 이관 리포트 (' + report.mode + ') =====');
console.log(`시트 행 ${report.totalRows} → 방문 기록 ${report.visits}건 / 고객 ${summary.patients}명 (이어쓰기 행 ${report.continuationRows}건 병합)`);
console.log('담당자별 고객 수:', summary.byStaff);
const show = (label, arr) => { if (arr.length) console.log(`- ${label}: ${arr.length}건`); };
show('이름 없어서 건너뜀', report.skippedNoName);
show('근무자 없어서 건너뜀', report.skippedNoWorker);
show('명단(ROSTER)에 없는 근무자', report.unknownWorker);
show('방문날짜를 못 읽음(날짜 null로 저장)', report.dateUnreadable);
show('생년월일을 못 읽음', report.birthUnreadable);
show('전화번호를 못 읽음', report.phoneUnreadable);
show('동명이인/중복 가능성(같은 이름이 여러 명으로 분리됨)', report.sameNameMultiPeople);
fs.writeFileSync('import-report.json', JSON.stringify({ report, summary }, null, 2));
console.log('\n상세 내역은 import-report.json 에 저장했습니다.');

if (!COMMIT) {
  console.log('\n(연습 실행입니다. DB에는 아무것도 쓰지 않았습니다. 확인 후 --commit 을 붙여 다시 실행하세요.)');
  process.exit(0);
}

/* ---------------------------------------------------------
   실제 반영 (--commit)
--------------------------------------------------------- */
const { default: admin } = await import('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
const Timestamp = admin.firestore.Timestamp;
const FieldValue = admin.firestore.FieldValue;

// 쓰기를 500건 단위 배치로 처리
let batch = db.batch();
let ops = 0;
let totalOps = 0;
async function queue(fn) {
  fn(batch);
  ops++; totalOps++;
  if (ops >= 450) { await batch.commit(); batch = db.batch(); ops = 0; }
}

// 1) 팀원 명단 (신규 가입자가 이름만 입력하면 팀 코드가 자동으로 채워지게 하는 용도)
for (const [name, info] of Object.entries(ROSTER)) {
  await queue((b) => b.set(db.collection('staffRoster').doc(name), { name, teamId: info.teamId }, { merge: true }));
}

// 2) 고객 + 중복판정 키 + 방문 기록
let created = 0, merged = 0;
for (const cl of clusters) {
  const keys = toKeys(cl);
  const first = cl.visits[0];
  const owner = ROSTER[first.worker] || { teamId: TEAM_ID, role: 'staff' };

  // 이미 앱에서 등록된 고객이면 그 고객에 방문 기록만 붙입니다 (먼저 등록한 담당자 우선)
  let patientId = null;
  for (const k of keys) {
    const s = await db.collection('patientKeys').doc(k).get();
    if (s.exists) { patientId = s.data().patientId; break; }
  }
  let teamId = owner.teamId;

  if (patientId) {
    merged++;
    const p = await db.collection('patients').doc(patientId).get();
    if (p.exists) teamId = p.data().teamId || teamId;
  } else {
    created++;
    // 고객 ID 는 키 해시에서 만들어 재실행 시에도 같은 ID 가 되게 함
    patientId = 'imp_' + sha1Hex(keys.sort().join('|') || `${cl.nameKey}|row${first.rowNo}`).slice(0, 20);
    const firstDate = cl.visits.find((v) => v.visitDate)?.visitDate;
    const phone0 = [...cl.phones][0] || '';
    const birth0 = [...cl.births][0] || '';
    await queue((b) => b.set(db.collection('patients').doc(patientId), {
      name: cl.name,
      nameKey: cl.nameKey,
      ssnMasked: birth0 ? `${birth0}-*******` : '',
      phoneMasked: phone0 ? maskPhone(phone0) : '',
      carrier: '',
      address: '',
      staffId: null,                 // 담당자가 가입하면 이름(staffName)으로 자동 연결됨
      staffName: first.worker,
      staffRole: owner.role,
      teamId,
      source: 'sheet-import',
      createdAt: firstDate ? Timestamp.fromDate(new Date(firstDate + 'T09:00:00+09:00')) : FieldValue.serverTimestamp()
    }));
    for (const k of keys) {
      await queue((b) => b.set(db.collection('patientKeys').doc(k), {
        patientId, staffId: null, source: 'sheet-import', createdAt: FieldValue.serverTimestamp()
      }));
    }
  }

  // 방문 기록 (같은 날·같은 근무자·같은 부위가 겹치면 순번을 붙여 ID 충돌 방지)
  const seen = new Map();
  for (const v of cl.visits) {
    const base = `${v.worker}|${v.nameKey}|${v.visitDateRaw}|${v.bodyPart}|${v.treatment}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const visitId = sha1Hex(`${base}|${n}`).slice(0, 20);
    await queue((b) => b.set(db.collection('patients').doc(patientId).collection('visits').doc(visitId), {
      rowNo: v.rowNo,
      visitDate: v.visitDate,
      visitDateRaw: v.visitDateRaw,
      worker: v.worker,
      teamId,
      birthRaw: v.birthRaw,
      phone: v.phone || '',
      phoneRaw: v.phoneRaw,
      gender: v.gender,
      noSilson: v.noSilson,
      policies: v.policies,
      type: v.type,
      bodyPart: v.bodyPart,
      treatment: v.treatment,
      admission: v.admission,
      memo: v.memo,
      source: 'sheet-import',
      importedAt: FieldValue.serverTimestamp()
    }));
  }
}
if (ops > 0) await batch.commit();

console.log(`\n✅ 반영 완료 — 신규 고객 ${created}명, 기존 고객에 병합 ${merged}명, 총 쓰기 ${totalOps}건`);
