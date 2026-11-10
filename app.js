import { firebaseConfig } from './firebase-config.js';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithCustomToken,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  collection,
  collectionGroup,
  query,
  where,
  getDocs,
  runTransaction,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;   // Firebase Auth user
let currentStaff = null;  // { name, teamId, role } from Firestore staff/{uid}

/* ---------------------------------------------------------
   공용 유틸
--------------------------------------------------------- */

// innerHTML에 넣는 모든 사용자 입력값은 반드시 esc()를 거칩니다 (XSS 방지)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const $ = (id) => document.getElementById(id);
const notifyTray = $('notifyTray');
const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');
const normName = (s) => String(s ?? '').replace(/\s+/g, '');
const roleLabel = (role) => (role === 'lead' ? '팀장' : '팀원');
const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const toDateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const keyToDate = (key) => new Date(key + 'T00:00:00');
// 기존 시트 이관 기록과 같은 표기: 2026/11/09(월)
const fmtVisitDate = (key) => {
  const d = keyToDate(key);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}(${WEEKDAYS[d.getDay()]})`;
};
// 이관 데이터(visitDateKey 없음)의 "YYYY/MM/DD(요)" 문자열에서 날짜 키 복원
const legacyKey = (v) => {
  const m = String(v?.visitDate || '').match(/^(\d{4})\/(\d{2})\/(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
};
const man = (v) => {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) ? s + '만' : s;
};

function maskSsn(d) {
  return d.slice(0, 6) + '-' + d.slice(6, 7) + '******';
}
function maskPhone(d) {
  return d.slice(0, 3) + '-****-' + d.slice(-4);
}
function formatSsnInput(raw) {
  const d = digitsOnly(raw).slice(0, 13);
  return d.length > 6 ? d.slice(0, 6) + '-' + d.slice(6) : d;
}
function formatPhoneInput(raw) {
  const d = digitsOnly(raw).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 7) return d.slice(0, 3) + '-' + d.slice(3);
  return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
}
function formatDate(ts) {
  return ts?.toDate ? ts.toDate().toLocaleString('ko-KR') : '';
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 마스킹된 주민번호(990101-1******)에서 생년월일/성별 추정 (방문 기록 폼 기본값용)
function birthGenderFromMasked(m) {
  const mt = String(m || '').match(/^(\d{6})-(\d)/);
  if (!mt) return { birth: '', gender: '' };
  const c = mt[2];
  const century = '1256'.includes(c) ? '19' : '3478'.includes(c) ? '20' : '18';
  return {
    birth: `${century}${mt[1].slice(0, 2)}.${mt[1].slice(2, 4)}.${mt[1].slice(4, 6)}`,
    gender: '13579'.includes(c) ? '남' : '여'
  };
}

/* ---------------------------------------------------------
   로그인 / 로그아웃 / 최초 프로필 생성
--------------------------------------------------------- */

const loginView = $('view-login');
const appRoot = $('app-root');
const loginForm = $('loginForm');
const loginError = $('loginError');
const btnSignup = $('btnSignup');

const setupView = $('view-profile-setup');
const setupForm = $('profileSetupForm');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginError.textContent = '로그인 실패: 이메일 또는 비밀번호를 확인해주세요.';
  }
});

btnSignup.addEventListener('click', async () => {
  loginError.textContent = '';
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  if (!email || !password) {
    loginError.textContent = '이메일과 비밀번호를 입력해주세요.';
    return;
  }
  try {
    await createUserWithEmailAndPassword(auth, email, password);
    // 계정 생성 후 onAuthStateChanged가 이어서 프로필 설정 화면으로 안내함
  } catch (err) {
    loginError.textContent = '계정 생성 실패: ' + (err.code === 'auth/email-already-in-use' ? '이미 등록된 이메일입니다.' : '입력값을 확인해주세요.');
  }
});

$('btnLogout').addEventListener('click', () => signOut(auth));

/* ---------------------------------------------------------
   카카오 로그인 (Redirect 방식 — 2026-07-24 이후 카카오가 팝업 방식 지원을 종료함에 따라 전환)
   - KAKAO_JS_KEY는 카카오 개발자 콘솔 > 내 애플리케이션 > 앱 키 > "JavaScript 키" 값입니다.
   - 카카오 개발자 콘솔 > 카카오 로그인 > Redirect URI 메뉴에 아래 KAKAO_REDIRECT_URI 값을
     "정확히 그대로" 등록해야 합니다 (배포 도메인이 바뀌면 이 값과 콘솔 등록 값을 함께 갱신).
   - 카카오 개발자 콘솔 > 앱 설정 > 플랫폼에 이 사이트 도메인을 "Web 플랫폼"으로 등록해야 합니다.
--------------------------------------------------------- */
const KAKAO_JS_KEY = 'fe63758ba86171a9aa4341f1a6ae2052';
const KAKAO_REDIRECT_URI = window.location.origin + window.location.pathname;

if (window.Kakao && !window.Kakao.isInitialized()) {
  window.Kakao.init(KAKAO_JS_KEY);
}

const btnKakaoLogin = $('btnKakaoLogin');
const kakaoLoginError = $('kakaoLoginError');

btnKakaoLogin.addEventListener('click', () => {
  kakaoLoginError.textContent = '';
  if (!window.Kakao) {
    kakaoLoginError.textContent = '카카오 SDK를 불러오지 못했습니다. 새로고침 후 다시 시도해주세요.';
    return;
  }
  // 팝업 대신 페이지 전체가 카카오 로그인 화면으로 이동했다가 redirectUri로 돌아옵니다.
  window.Kakao.Auth.authorize({
    redirectUri: KAKAO_REDIRECT_URI,
    scope: 'profile_nickname'
  });
});

// 카카오 로그인 화면에서 돌아왔을 때 (?code=... 붙어서 리다이렉트됨) 처리
(async function handleKakaoRedirectCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const kakaoError = params.get('error');

  if (kakaoError) {
    history.replaceState(null, '', window.location.pathname);
    if (kakaoLoginError) kakaoLoginError.textContent = '카카오 로그인이 취소되었거나 실패했습니다.';
    return;
  }
  if (!code) return;

  // 새로고침 시 인가 코드가 재사용되어 에러나지 않도록 URL에서 즉시 제거
  history.replaceState(null, '', window.location.pathname);

  try {
    const res = await fetch('/api/kakao-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri: KAKAO_REDIRECT_URI })
    });
    const data = await res.json();
    if (!res.ok) {
      if (kakaoLoginError) kakaoLoginError.textContent = '카카오 로그인 실패: ' + (data.error || '알 수 없는 오류');
      return;
    }
    await signInWithCustomToken(auth, data.token);
    // 이후 onAuthStateChanged가 이어서 프로필 설정/승인 흐름을 처리함
  } catch (err) {
    if (kakaoLoginError) kakaoLoginError.textContent = '카카오 로그인 처리 중 오류가 발생했습니다.';
  }
})();

setupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  // 이름은 공백을 제거해 저장합니다 (시트 이관 데이터의 담당자 이름과 정확히 맞추기 위함)
  const name = normName($('setup-name').value);
  let teamId = $('setup-teamId').value.trim();
  if (!name) return;

  // 팀 명단(staffRoster)에 이름이 있으면 팀 코드를 자동 적용 → 기존 고객 기록이 이름으로 자동 연결됨
  try {
    const rosterSnap = await getDoc(doc(db, 'staffRoster', name));
    if (rosterSnap.exists()) teamId = rosterSnap.data().teamId;
  } catch (err) { /* 명단 조회 실패 시 직접 입력한 값 사용 */ }

  if (!teamId) {
    alert('팀 명단에서 이름을 찾지 못했습니다. 팀 코드를 직접 입력해주세요.');
    return;
  }

  // 최초 가입자는 기본 role 'staff'로 생성됩니다.
  // 팀장(role: 'lead') 권한은 Firebase 콘솔 > Firestore > staff/{uid} 문서에서
  // 관리자가 직접 role 필드를 'lead'로 수정해야 부여됩니다 (보안상 셀프 승격 방지).
  await setDoc(doc(db, 'staff', currentUser.uid), {
    name,
    teamId,
    role: 'staff',
    email: currentUser.email
  });

  await loadStaffProfile();
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    loginView.classList.remove('hidden');
    appRoot.classList.add('hidden');
    setupView.classList.add('hidden');
    notifyTray.innerHTML = '';
    return;
  }
  loginView.classList.add('hidden');
  await loadStaffProfile();
});

async function loadStaffProfile() {
  const snap = await getDoc(doc(db, 'staff', currentUser.uid));
  if (!snap.exists()) {
    // 최초 로그인 -> 이름/팀 코드 입력 화면
    appRoot.classList.add('hidden');
    setupView.classList.remove('hidden');
    return;
  }
  currentStaff = snap.data();
  setupView.classList.add('hidden');
  appRoot.classList.remove('hidden');

  $('currentStaffName').textContent = currentStaff.name;
  $('currentStaffRole').textContent = roleLabel(currentStaff.role);

  // 팀장에게만 "팀 전체 현황" 탭 노출
  const teamTabBtn = $('tab-team-overview');
  teamTabBtn.classList.toggle('hidden', currentStaff.role !== 'lead');

  initDailyControls();
  mountRegVisit();
  switchTab('lookup');
  loadNotifications();
}

/* ---------------------------------------------------------
   탭 전환
--------------------------------------------------------- */
window.switchTab = function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(el => {
    el.classList.remove('border-b-2', 'border-indigo-700', 'text-indigo-700', 'bg-white');
    el.classList.add('text-gray-600');
  });

  const targetView = $('view-' + tabId);
  const targetTab = $('tab-' + tabId);
  if (targetView) targetView.classList.remove('hidden');
  if (targetTab) {
    targetTab.classList.add('border-b-2', 'border-indigo-700', 'text-indigo-700', 'bg-white');
    targetTab.classList.remove('text-gray-600');
  }

  if (tabId === 'team-overview') renderTeamOverview();
  if (tabId === 'my-patients') renderMyPatients();
  if (tabId === 'lookup') $('lookupName').focus();
  if (tabId === 'daily') renderDailyReport();
};

/* ---------------------------------------------------------
   고객 카드 (고객 조회 / 내 고객 공용)
   - 담당자 이름(공백 제거)으로 연결 — 시트 이관 고객은 staffId 가 없고 이름만 있으므로,
     같은 이름으로 가입한 팀원은 별도 작업 없이 자동으로 "내 고객"이 됩니다.
   - 수정/삭제는 본인 고객(isMine)만, 방문 기록 추가는 본인 고객 또는 해당 팀의 팀장만 가능합니다.
     (화면에서 막는 것과 별개로 Firestore 보안 규칙에서도 반드시 같은 조건으로 막아야 합니다.)
--------------------------------------------------------- */
const INP = 'w-full border rounded-lg p-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500 bg-white';
const CARRIERS = ['SKT', 'KT', 'LGU+', '알뜰폰 (SKT망)', '알뜰폰 (KT망)', '알뜰폰 (LGU+망)'];
const opts = (list, sel) => {
  const l = !sel || list.includes(sel) ? list : [...list, sel];
  return l.map(o => `<option value="${esc(o)}" ${o === sel ? 'selected' : ''}>${esc(o)}</option>`).join('');
};

const patientMap = new Map();   // patientId -> patient data (렌더된 카드 기준)
const visitsCache = new Map();  // patientId -> visits[]
const commentsCache = new Map(); // patientId -> comments[] (담당자/팀장만 조회 가능)
let pendingOpenVisitsFor = null; // 알림 '보러가기'로 방문 기록을 자동으로 펼칠 고객
let pendingVisitFor = null;     // 신규 접수 직후 방문 기록 폼을 자동으로 열 고객

function isMine(p) {
  return (p.staffId && p.staffId === currentUser.uid) ||
    (currentStaff && normName(p.staffName) === normName(currentStaff.name));
}
function isLeadOf(p) {
  return currentStaff?.role === 'lead' && p.teamId === currentStaff.teamId;
}
function staffLine(p) {
  return `담당자 : ${esc(p.staffName)} ${roleLabel(p.staffRole)}`;
}
function infoLine(p) {
  return `${esc(p.phoneMasked)}${p.carrier ? ' · ' + esc(p.carrier) : ''}${p.address ? ' · ' + esc(p.address) : ''} · 등록일 ${esc(formatDate(p.createdAt))}`;
}

function cardHtml(p, { badge = true } = {}) {
  patientMap.set(p.id, p);
  const mine = isMine(p);
  const canSee = mine || isLeadOf(p);
  const id = esc(p.id);
  return `
    <div data-card="${id}" class="bg-white border rounded-xl p-4 text-left shadow-sm mb-2">
      <div>
        ${badge ? '<span class="bg-emerald-100 text-emerald-800 font-bold text-xs px-2 py-0.5 rounded">등록된 고객</span>' : ''}
        ${mine ? '<span class="bg-indigo-100 text-indigo-800 font-bold text-xs px-2 py-0.5 rounded ml-1">내 고객</span>' : ''}
        <h4 class="font-bold text-lg text-gray-900 mt-1">${esc(p.name)}</h4>
        <p class="text-sm font-bold text-indigo-700 mt-0.5">${staffLine(p)}</p>
        <p class="text-xs text-gray-400 mt-1" data-info="${id}">${infoLine(p)}</p>
      </div>
      <div class="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs font-bold">
        ${canSee ? `
        <button type="button" data-action="toggle-visits" class="text-indigo-700 hover:underline">방문 기록 보기</button>
        <button type="button" data-action="add-visit" class="text-emerald-700 hover:underline"><i class="fa-solid fa-plus mr-0.5"></i>방문 기록 추가</button>` : ''}
        <button type="button" data-action="add-comment" class="text-amber-700 hover:underline"><i class="fa-regular fa-comment mr-0.5"></i>코멘트 남기기</button>
        ${mine ? `
        <button type="button" data-action="edit-patient" class="text-gray-600 hover:underline">고객 정보 수정</button>
        <button type="button" data-action="delete-patient" class="text-red-600 hover:underline">고객 삭제</button>` : ''}
      </div>
      <div data-panel="${id}" class="mt-3"></div>
      <div data-visits-box="${id}" class="mt-2"></div>
    </div>`;
}

/* ---------- 방문 기록 ---------- */

function renderPolicies(policies) {
  if (!policies?.length) return '';
  const rows = policies.map(x => `
    <tr class="border-t">
      <td class="py-1 pr-2">${esc(x.insurer)}${x.group ? ' (단체)' : ''}</td>
      <td class="py-1 pr-2">${esc(x.joinDate)}</td>
      <td class="py-1 pr-2">질병입원 ${esc(man(x.illnessInpatient))} / 상해입원 ${esc(man(x.injuryInpatient))}</td>
      <td class="py-1 pr-2">질병통원 ${esc(man(x.illnessOutpatient))} / 상해통원 ${esc(man(x.injuryOutpatient))}</td>
      ${x.nonCovered ? `<td class="py-1">3대비급여 ${esc(x.nonCovered)}</td>` : ''}
    </tr>`).join('');
  return `<div class="overflow-x-auto mt-2"><table class="text-[11px] text-gray-600 w-full">${rows}</table></div>`;
}

const visitSortKey = (v) => v.visitDateKey || legacyKey(v);
function sortVisits(list) {
  return list.sort((a, b) => {
    const ka = visitSortKey(a), kb = visitSortKey(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    const ta = a.createdAt?.toMillis?.() ?? 0, tb = b.createdAt?.toMillis?.() ?? 0;
    if (ta !== tb) return tb - ta;
    return (b.rowNo ?? 0) - (a.rowNo ?? 0);
  });
}

// 코멘트 목록은 담당자/팀장만 읽을 수 있습니다 (Firestore 규칙과 같은 조건)
async function loadComments(pid) {
  const p = patientMap.get(pid);
  if (!p || !(isMine(p) || isLeadOf(p))) { commentsCache.set(pid, []); return []; }
  try {
    const snap = await getDocs(collection(db, 'patients', pid, 'comments'));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    commentsCache.set(pid, list);
    return list;
  } catch (err) {
    commentsCache.set(pid, []);
    return [];
  }
}

async function loadVisits(pid) {
  const snap = await getDocs(collection(db, 'patients', pid, 'visits'));
  const list = sortVisits(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  visitsCache.set(pid, list);
  await loadComments(pid);
  return list;
}

function visitHtml(p, v) {
  const mine = isMine(p);
  return `
    <div class="border rounded-lg p-3 bg-slate-50 mb-2 text-xs text-gray-700" data-visit="${esc(v.id)}">
      <div class="flex flex-wrap gap-x-3 gap-y-1 items-center">
        <span class="font-bold text-gray-900">${esc(v.visitDate || v.visitDateRaw || '날짜 미상')}</span>
        <span>근무자 ${esc(v.worker)}</span>
        ${v.kind ? `<span class="bg-amber-100 text-amber-800 font-bold px-1.5 py-0.5 rounded">${esc(v.kind)}</span>` : ''}
        ${v.type ? `<span class="bg-indigo-100 text-indigo-800 font-bold px-1.5 py-0.5 rounded">${esc(v.type)}</span>` : ''}
        ${v.type === '청구' && v.claimDone ? '<span class="bg-emerald-100 text-emerald-800 font-bold px-1.5 py-0.5 rounded">청구완료</span>' : ''}
        ${v.admission ? `<span class="bg-slate-200 px-1.5 py-0.5 rounded">${esc(v.admission)}</span>` : ''}
        ${mine ? `<span class="ml-auto flex gap-3 font-bold">
          <button type="button" data-action="edit-visit" data-visit-id="${esc(v.id)}" class="text-indigo-700 hover:underline">수정</button>
          <button type="button" data-action="delete-visit" data-visit-id="${esc(v.id)}" class="text-red-600 hover:underline">삭제</button>
        </span>` : ''}
      </div>
      ${v.birth || v.gender ? `<p class="mt-1 text-gray-500">${esc([v.birth, v.gender].filter(Boolean).join(' · '))}</p>` : ''}
      <p class="mt-1">${esc([v.bodyPart, v.treatment].filter(Boolean).join(' · '))}${v.phone ? ` · ${esc(formatPhoneInput(v.phone))}` : ''}</p>
      ${v.noSilson ? '<p class="mt-1 text-amber-700 font-bold">실손 미가입</p>' : renderPolicies(v.policies)}
      ${v.memo ? `<p class="mt-2 whitespace-pre-wrap leading-relaxed">${esc(v.memo)}</p>` : ''}
    </div>`;
}

function commentHtml(p, c) {
  const canDel = isMine(p) || c.authorUid === currentUser.uid;
  return `
    <div class="border border-amber-200 rounded-lg p-3 bg-amber-50 mb-2 text-xs text-gray-700">
      <div class="flex flex-wrap gap-x-2 items-center">
        <i class="fa-regular fa-comment text-amber-600"></i>
        <span class="font-bold text-gray-900">${esc(c.author)}</span>
        ${c.tag ? `<span class="bg-amber-200 text-amber-900 font-bold px-1.5 py-0.5 rounded">${esc(c.tag)}</span>` : ''}
        <span class="text-gray-400">${esc(formatDate(c.createdAt))}</span>
        ${canDel ? `<button type="button" data-action="delete-comment" data-comment-id="${esc(c.id)}" class="ml-auto text-red-600 font-bold hover:underline">삭제</button>` : ''}
      </div>
      <p class="mt-1.5 whitespace-pre-wrap leading-relaxed">${esc(c.text)}</p>
    </div>`;
}

function visitsHtml(pid) {
  const p = patientMap.get(pid);
  const comments = commentsCache.get(pid) || [];
  const visits = visitsCache.get(pid) || [];
  const cHtml = comments.length
    ? `<p class="text-[11px] font-bold text-amber-800 mb-1">코멘트 ${comments.length}건</p>` + comments.map(c => commentHtml(p, c)).join('')
    : '';
  const vHtml = visits.length
    ? visits.map(v => visitHtml(p, v)).join('')
    : '<p class="text-xs text-gray-400">방문 기록이 없습니다.</p>';
  return cHtml + vHtml;
}

// 같은 고객 카드가 여러 화면(고객 조회/내 고객)에 있어도 열려 있는 것만 갱신
function refreshVisitBoxes(pid) {
  document.querySelectorAll(`[data-visits-box="${pid}"]`).forEach(box => {
    if (box.dataset.open === '1') box.innerHTML = visitsHtml(pid);
  });
}

async function toggleVisits(pid, box, btn) {
  if (box.dataset.open === '1') {
    box.dataset.open = '';
    box.innerHTML = '';
    btn.textContent = '방문 기록 보기';
    return;
  }
  box.dataset.open = '1';
  btn.textContent = '방문 기록 접기';
  box.innerHTML = '<p class="text-xs text-gray-400">불러오는 중...</p>';
  try {
    await loadVisits(pid);
    box.innerHTML = visitsHtml(pid);
  } catch (err) {
    box.dataset.open = '';
    btn.textContent = '방문 기록 보기';
    box.innerHTML = `<p class="text-xs text-red-600">불러오지 못했습니다: ${esc(err.message)}</p>`;
  }
}

/* ---------- 방문 기록 입력/수정 폼 ---------- */

function policyRowHtml(x = {}) {
  return `
    <div class="policy-row border rounded-lg p-2 bg-white grid grid-cols-2 sm:grid-cols-4 gap-2">
      <input data-f="insurer" placeholder="보험회사" value="${esc(x.insurer)}" class="${INP} sm:col-span-2">
      <input data-f="joinDate" placeholder="가입날짜 (2009.12.29)" value="${esc(x.joinDate)}" class="${INP}">
      <label class="flex items-center gap-1 text-xs text-gray-700"><input type="checkbox" data-f="group" ${x.group ? 'checked' : ''}> 단체</label>
      <input data-f="illnessInpatient" placeholder="질병입원(만)" value="${esc(x.illnessInpatient)}" class="${INP}">
      <input data-f="injuryInpatient" placeholder="상해입원(만)" value="${esc(x.injuryInpatient)}" class="${INP}">
      <input data-f="illnessOutpatient" placeholder="질병통원(만)" value="${esc(x.illnessOutpatient)}" class="${INP}">
      <input data-f="injuryOutpatient" placeholder="상해통원(만)" value="${esc(x.injuryOutpatient)}" class="${INP}">
      <input data-f="nonCovered" placeholder="3대비급여" value="${esc(x.nonCovered)}" class="${INP} sm:col-span-3">
      <button type="button" data-action="remove-policy" class="text-xs text-red-600 hover:underline text-right">이 보험 삭제</button>
    </div>`;
}

// 실손정보는 고객 단위로 한 번만 입력합니다.
// 이미 입력된 기록이 있으면 그 내용을 보여주고(수정 불가), 한 번도 입력된 적이 없을 때만 입력란을 엽니다.
function findSilsonSource(pid) {
  const list = visitsCache.get(pid) || [];
  return list.find(x => x.noSilson || x.policies?.length) || null;
}
function silsonSectionHtml(p, v) {
  const src = findSilsonSource(p.id);
  const editable = !src || (v && src.id === v.id);
  if (!editable) {
    return `
      <div>
        <p class="text-xs font-bold text-gray-500 mb-1">실손정보 <span class="font-normal text-gray-400">(이미 입력된 정보${src.visitDate ? ' · ' + esc(src.visitDate) + ' 기록' : ''})</span></p>
        <div class="border rounded-lg bg-white p-2">
          ${src.noSilson ? '<p class="text-xs text-amber-700 font-bold">실손 미가입</p>' : renderPolicies(src.policies)}
        </div>
      </div>`;
  }
  const policies = v?.policies?.length ? v.policies : [{}];
  return `
      <div data-silson-editable>
        <div class="flex items-center justify-between mb-1">
          <p class="text-xs font-bold text-gray-500">실손정보 <span class="font-normal text-gray-400">(처음 한 번만 입력)</span></p>
          <label class="flex items-center gap-1 text-xs text-amber-700 font-bold"><input type="checkbox" data-f="noSilson" ${v?.noSilson ? 'checked' : ''}> 실손 미가입</label>
        </div>
        <div data-policies-wrap class="${v?.noSilson ? 'hidden' : ''}">
          <div data-policies class="space-y-2">${policies.map(policyRowHtml).join('')}</div>
          <button type="button" data-action="add-policy" class="mt-2 text-xs font-bold text-indigo-700 hover:underline"><i class="fa-solid fa-plus mr-0.5"></i>보험 추가</button>
        </div>
      </div>`;
}

function visitFormHtml(p, v) {
  const isEdit = !!v;
  const key = v ? (v.visitDateKey || legacyKey(v)) : toDateKey(new Date());
  const hasVisits = (visitsCache.get(p.id) || []).length > 0;
  const kind = v?.kind || (hasVisits ? '재방문' : '신규');
  const type = v?.type || '조회';
  return `
    <form data-form="visit" data-visit-id="${esc(v?.id || '')}" class="border-2 border-indigo-200 rounded-xl p-4 bg-indigo-50/40 space-y-4">
      <h5 class="font-bold text-sm text-indigo-900">${isEdit ? '방문 기록 수정' : '방문 기록 추가'} · ${esc(p.name)}</h5>

      <div>
        <p class="text-xs font-bold text-gray-500 mb-1">방문내용</p>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <div><label class="block text-[11px] text-gray-600 mb-0.5">방문날짜 *</label><input type="date" data-f="visitDateKey" required value="${esc(key)}" class="${INP}"></div>
          <div><label class="block text-[11px] text-gray-600 mb-0.5">근무자</label><input type="text" data-f="worker" value="${esc(v?.worker ?? currentStaff.name)}" class="${INP}"></div>
          <div><label class="block text-[11px] text-gray-600 mb-0.5">신규/재방문</label><select data-f="kind" class="${INP}">${opts(['신규', '재방문'], kind)}</select></div>
          <div><label class="block text-[11px] text-gray-600 mb-0.5">조회 or 청구</label><select data-f="type" class="${INP}">${opts(['조회', '청구'], type)}</select></div>
          <div><label class="block text-[11px] text-gray-600 mb-0.5">통원 or 입원</label><select data-f="admission" class="${INP}">${opts(['통원', '입원'], v?.admission || '통원')}</select></div>
          <div><label class="block text-[11px] text-gray-600 mb-0.5">치료부위</label><input type="text" data-f="bodyPart" value="${esc(v?.bodyPart)}" placeholder="왼쪽 손목" class="${INP}"></div>
          <div class="col-span-2"><label class="block text-[11px] text-gray-600 mb-0.5">치료내용</label><input type="text" data-f="treatment" value="${esc(v?.treatment)}" placeholder="수술" class="${INP}"></div>
        </div>
        <label data-claim-wrap class="${type === '청구' ? 'flex' : 'hidden'} items-center gap-1.5 mt-2 text-xs font-bold text-emerald-800">
          <input type="checkbox" data-f="claimDone" ${v?.claimDone ? 'checked' : ''}> 청구 완료 (일일 현황 "보험금 청구현황"에 '청구완료'로 표시)
        </label>
      </div>

      ${silsonSectionHtml(p, v)}

      <div>
        <label class="block text-xs font-bold text-gray-500 mb-1">상담내용 (보장빈틈 / 갱신여부 / 실조회자 이름, 특이사항 등)</label>
        <textarea data-f="memo" rows="3" class="${INP}">${esc(v?.memo)}</textarea>
      </div>

      <p data-form-msg class="text-xs text-red-600 min-h-[1rem]"></p>
      <div class="flex gap-2">
        <button type="submit" class="px-5 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 disabled:opacity-60">${isEdit ? '수정 저장' : '저장'}</button>
        <button type="button" data-action="cancel-panel" class="px-5 py-2 bg-gray-100 text-gray-700 text-sm font-bold rounded-lg hover:bg-gray-200">취소</button>
      </div>
    </form>`;
}

async function openVisitPanel(card, pid, visitId) {
  const p = patientMap.get(pid);
  const panel = card.querySelector('[data-panel]');
  panel.innerHTML = '<p class="text-xs text-gray-400">불러오는 중...</p>';
  try {
    // 신규/재방문 기본값 판단과 수정 대상 조회를 위해 기록을 먼저 불러옵니다
    await loadVisits(pid);
  } catch (err) {
    panel.innerHTML = `<p class="text-xs text-red-600">불러오지 못했습니다: ${esc(err.message)}</p>`;
    return;
  }
  const v = visitId ? (visitsCache.get(pid) || []).find(x => x.id === visitId) : null;
  panel.innerHTML = visitFormHtml(p, v);
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 방문 기록 입력란(root 안의 data-f 값들)을 읽어 공통 필드로 만듭니다 (방문 기록 폼 / 신규 접수 폼 공용)
function readVisitFields(root) {
  const f = (k) => root.querySelector(`[data-f="${k}"]`);
  const type = f('type').value;
  const silsonEditable = !!root.querySelector('[data-silson-editable]');
  const noSilson = silsonEditable && f('noSilson').checked;
  const policies = (!silsonEditable || noSilson) ? [] : Array.from(root.querySelectorAll('.policy-row')).map(r => {
    const g = (k) => r.querySelector(`[data-f="${k}"]`);
    return {
      insurer: g('insurer').value.trim(),
      joinDate: g('joinDate').value.trim(),
      group: g('group').checked,
      illnessInpatient: g('illnessInpatient').value.trim(),
      injuryInpatient: g('injuryInpatient').value.trim(),
      illnessOutpatient: g('illnessOutpatient').value.trim(),
      injuryOutpatient: g('injuryOutpatient').value.trim(),
      nonCovered: g('nonCovered').value.trim()
    };
  }).filter(x => x.insurer || x.joinDate || x.illnessInpatient || x.injuryInpatient ||
                 x.illnessOutpatient || x.injuryOutpatient || x.nonCovered);

  const out = {
    worker: f('worker').value.trim(),
    kind: f('kind').value,
    type,
    claimDone: type === '청구' ? f('claimDone').checked : false,
    admission: f('admission').value,
    bodyPart: f('bodyPart').value.trim(),
    treatment: f('treatment').value.trim(),
    memo: f('memo').value.trim()
  };
  // 고객정보(생년월일/성별/전화번호)는 신규 접수 폼에만 있습니다
  if (f('birth')) out.birth = f('birth').value.trim();
  if (f('gender')) out.gender = f('gender').value;
  if (f('phone')) out.phone = digitsOnly(f('phone').value);
  // 실손정보는 아직 입력된 적이 없을 때만 이 기록에 저장합니다 (이미 있으면 기존 값을 그대로 둡니다)
  if (silsonEditable) { out.noSilson = noSilson; out.policies = policies; }
  return out;
}

function visitDocFor(p, fields, key) {
  return {
    patientId: p.id,
    patientName: p.name,
    staffName: p.staffName,      // 담당자(고객 등록자) — 일일 현황 집계 기준
    teamId: p.teamId,
    recordedBy: currentStaff.name,
    visitDateKey: key,
    visitDate: fmtVisitDate(key),
    ...fields,
    updatedAt: serverTimestamp()
  };
}

// 신규 접수 화면(신규 접수 탭 / 동명이인 접수)에 들어가는 방문 기록 입력란
function regVisitHtml() {
  return `
    <div data-regvisit class="border-2 border-indigo-200 rounded-xl p-4 bg-indigo-50/40 space-y-4">
      <div>
        <h5 class="font-bold text-sm text-indigo-900">방문 기록</h5>
        <p class="text-[11px] text-gray-500 mt-0.5">접수와 동시에 오늘 날짜의 방문 기록으로 저장되며, 일일 보험조회현황에 바로 반영됩니다.</p>
      </div>
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div><label class="block text-[11px] text-gray-600 mb-0.5">근무자</label><input type="text" data-f="worker" value="${esc(currentStaff?.name)}" class="${INP}"></div>
        <div><label class="block text-[11px] text-gray-600 mb-0.5">신규/재방문</label><select data-f="kind" class="${INP}">${opts(['신규', '재방문'], '신규')}</select></div>
        <div><label class="block text-[11px] text-gray-600 mb-0.5">조회 or 청구</label><select data-f="type" class="${INP}">${opts(['조회', '청구'], '조회')}</select></div>
        <div><label class="block text-[11px] text-gray-600 mb-0.5">통원 or 입원</label><select data-f="admission" class="${INP}">${opts(['통원', '입원'], '통원')}</select></div>
        <div class="col-span-2"><label class="block text-[11px] text-gray-600 mb-0.5">치료부위</label><input type="text" data-f="bodyPart" placeholder="왼쪽 손목" class="${INP}"></div>
        <div class="col-span-2"><label class="block text-[11px] text-gray-600 mb-0.5">치료내용</label><input type="text" data-f="treatment" placeholder="수술" class="${INP}"></div>
      </div>
      <label data-claim-wrap class="hidden items-center gap-1.5 text-xs font-bold text-emerald-800">
        <input type="checkbox" data-f="claimDone"> 청구 완료 (일일 현황 "보험금 청구현황"에 '청구완료'로 표시)
      </label>

      <div>
        <p class="text-xs font-bold text-gray-500 mb-1">고객정보 <span class="font-normal text-gray-400">(주민번호·휴대폰을 입력하면 자동으로 채워지며, 직접 고칠 수 있습니다)</span></p>
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <div><label class="block text-[11px] text-gray-600 mb-0.5">생년월일</label><input type="text" data-f="birth" placeholder="1990.01.01" class="${INP}"></div>
          <div><label class="block text-[11px] text-gray-600 mb-0.5">성별</label><select data-f="gender" class="${INP}"><option value=""></option>${opts(['남', '여'], '')}</select></div>
          <div class="col-span-2 sm:col-span-1"><label class="block text-[11px] text-gray-600 mb-0.5">전화번호</label><input type="tel" data-f="phone" placeholder="010-0000-0000" class="${INP}"></div>
        </div>
      </div>

      ${silsonSectionHtml({ id: '' }, null)}

      <div>
        <label class="block text-xs font-bold text-gray-500 mb-1">상담내용 (보장빈틈 / 갱신여부 / 실조회자 이름, 특이사항 등)</label>
        <textarea data-f="memo" rows="3" class="${INP}"></textarea>
      </div>
    </div>`;
}

function mountRegVisit() {
  const m = $('regVisitMount');
  if (m && currentStaff) m.innerHTML = regVisitHtml();
}

// 주민번호/휴대폰 입력 시 생년월일·성별·전화번호를 자동으로 채움 (직접 고친 칸은 건드리지 않음)
function syncRegVisitFields(form) {
  if (!form) return;
  const ssnEl = form.querySelector('#reg-ssn, #dup-ssn');
  const phoneEl = form.querySelector('#reg-phone, #dup-phone');
  const set = (k, v) => {
    const el = form.querySelector(`[data-f="${k}"]`);
    if (el && !el.dataset.touched) el.value = v;
  };
  const d = digitsOnly(ssnEl?.value);
  if (d.length >= 7) {
    const g = birthGenderFromMasked(`${d.slice(0, 6)}-${d[6]}`);
    set('birth', g.birth);
    set('gender', g.gender);
  }
  set('phone', formatPhoneInput(phoneEl?.value));
}

async function submitVisitForm(form, card, pid) {
  const p = patientMap.get(pid);
  const f = (k) => form.querySelector(`[data-f="${k}"]`);
  const msg = form.querySelector('[data-form-msg]');
  msg.textContent = '';

  const key = f('visitDateKey').value;
  if (!key) { msg.textContent = '방문날짜를 입력해주세요.'; return; }

  const data = visitDocFor(p, readVisitFields(form), key);

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const editId = form.dataset.visitId;
    if (editId) {
      await updateDoc(doc(db, 'patients', pid, 'visits', editId), data);
    } else {
      await addDoc(collection(db, 'patients', pid, 'visits'), { ...data, createdAt: serverTimestamp() });
    }
    card.querySelector('[data-panel]').innerHTML = '';
    await loadVisits(pid);
    // 방문 기록 목록을 열어서 방금 저장한 내용을 바로 보여줍니다
    document.querySelectorAll(`[data-card="${pid}"]`).forEach(c => {
      const box = c.querySelector('[data-visits-box]');
      const btn = c.querySelector('[data-action="toggle-visits"]');
      box.dataset.open = '1';
      box.innerHTML = visitsHtml(pid);
      if (btn) btn.textContent = '방문 기록 접기';
    });
    renderDailyReport();
  } catch (err) {
    msg.textContent = '저장 중 오류가 발생했습니다: ' + err.message;
  } finally {
    submitBtn.disabled = false;
  }
}

async function deleteVisit(pid, visitId) {
  if (!confirm('이 방문 기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
  try {
    await deleteDoc(doc(db, 'patients', pid, 'visits', visitId));
    await loadVisits(pid);
    refreshVisitBoxes(pid);
    renderDailyReport();
  } catch (err) {
    alert('삭제 중 오류가 발생했습니다: ' + err.message);
  }
}

/* ---------- 코멘트 (담당자가 아니어도 작성 가능) ---------- */

function openCommentPanel(card, pid) {
  const p = patientMap.get(pid);
  const self = normName(p.staffName) === normName(currentStaff.name);
  card.querySelector('[data-panel]').innerHTML = `
    <form data-form="comment" class="border-2 border-amber-200 rounded-xl p-4 bg-amber-50/50 space-y-3">
      <h5 class="font-bold text-sm text-amber-900">코멘트 남기기 · ${esc(p.name)}</h5>
      ${self ? '' : `<p class="text-[11px] text-gray-500">담당자 <strong>${esc(p.staffName)}</strong> 님이 다음 로그인 때 알림으로 확인합니다. (작성한 코멘트는 담당자와 팀장만 볼 수 있습니다)</p>`}
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
        <div><label class="block text-[11px] text-gray-600 mb-0.5">구분</label>
          <select data-f="tag" class="${INP}">${opts(['청구 관련', '방문 관련', '기타'], '청구 관련')}</select></div>
      </div>
      <textarea data-f="text" rows="3" required maxlength="1000" placeholder="예: 추가 서류 제출해서 청구 완료했습니다." class="${INP}"></textarea>
      <p data-form-msg class="text-xs text-red-600 min-h-[1rem]"></p>
      <div class="flex gap-2">
        <button type="submit" class="px-5 py-2 bg-amber-600 text-white text-sm font-bold rounded-lg hover:bg-amber-700 disabled:opacity-60">코멘트 저장</button>
        <button type="button" data-action="cancel-panel" class="px-5 py-2 bg-gray-100 text-gray-700 text-sm font-bold rounded-lg hover:bg-gray-200">취소</button>
      </div>
    </form>`;
}

async function submitCommentForm(form, card, pid) {
  const p = patientMap.get(pid);
  const msg = form.querySelector('[data-form-msg]');
  const btn = form.querySelector('button[type="submit"]');
  const text = form.querySelector('[data-f="text"]').value.trim();
  const tag = form.querySelector('[data-f="tag"]').value;
  if (!text) { msg.textContent = '내용을 입력해주세요.'; return; }

  const ownerKey = normName(p.staffName);
  btn.disabled = true;
  try {
    const batch = writeBatch(db);
    const cRef = doc(collection(db, 'patients', pid, 'comments'));
    batch.set(cRef, {
      patientId: pid,
      patientName: p.name,
      ownerKey,
      teamId: p.teamId,
      author: currentStaff.name,
      authorUid: currentUser.uid,
      tag,
      text,
      createdAt: serverTimestamp()
    });
    // 내가 담당자가 아닐 때만 담당자에게 알림 생성
    if (ownerKey && ownerKey !== normName(currentStaff.name)) {
      batch.set(doc(collection(db, 'notifications')), {
        toKey: ownerKey,
        patientId: pid,
        patientName: p.name,
        commentId: cRef.id,
        fromName: currentStaff.name,
        fromUid: currentUser.uid,
        tag,
        preview: text.slice(0, 80),
        seen: false,
        createdAt: serverTimestamp()
      });
    }
    await batch.commit();

    card.querySelector('[data-panel]').innerHTML = messageHtml('ok', '코멘트를 저장했습니다.');
    if (isMine(p) || isLeadOf(p)) {
      await loadComments(pid);
      refreshVisitBoxes(pid);
    }
  } catch (err) {
    msg.textContent = '저장 중 오류가 발생했습니다: ' + err.message;
    btn.disabled = false;
  }
}

async function deleteComment(pid, cid) {
  if (!confirm('이 코멘트를 삭제할까요?')) return;
  try {
    await deleteDoc(doc(db, 'patients', pid, 'comments', cid));
    await loadComments(pid);
    refreshVisitBoxes(pid);
  } catch (err) {
    alert('삭제 중 오류가 발생했습니다: ' + err.message);
  }
}

/* ---------- 고객 정보 수정 / 삭제 ---------- */

function openPatientEdit(card, pid) {
  const p = patientMap.get(pid);
  card.querySelector('[data-panel]').innerHTML = `
    <form data-form="patient-edit" class="border-2 border-gray-200 rounded-xl p-4 bg-slate-50 space-y-3">
      <h5 class="font-bold text-sm text-gray-800">고객 정보 수정 · ${esc(p.name)}</h5>
      <p class="text-[11px] text-gray-500">성함·주민번호·휴대폰은 중복 판정에 쓰이므로 수정할 수 없습니다. 잘못 입력했다면 고객을 삭제하고 다시 접수해주세요.</p>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div><label class="block text-[11px] text-gray-600 mb-0.5">통신사</label><select data-f="carrier" class="${INP}">${opts(CARRIERS, p.carrier || 'SKT')}</select></div>
        <div class="sm:col-span-2"><label class="block text-[11px] text-gray-600 mb-0.5">주소</label><input type="text" data-f="address" value="${esc(p.address)}" class="${INP}"></div>
      </div>
      <p data-form-msg class="text-xs text-red-600 min-h-[1rem]"></p>
      <div class="flex gap-2">
        <button type="submit" class="px-5 py-2 bg-indigo-600 text-white text-sm font-bold rounded-lg hover:bg-indigo-700 disabled:opacity-60">저장</button>
        <button type="button" data-action="cancel-panel" class="px-5 py-2 bg-gray-100 text-gray-700 text-sm font-bold rounded-lg hover:bg-gray-200">취소</button>
      </div>
    </form>`;
}

async function submitPatientEdit(form, card, pid) {
  const p = patientMap.get(pid);
  const msg = form.querySelector('[data-form-msg]');
  const btn = form.querySelector('button[type="submit"]');
  const carrier = form.querySelector('[data-f="carrier"]').value;
  const address = form.querySelector('[data-f="address"]').value.trim();
  btn.disabled = true;
  try {
    await updateDoc(doc(db, 'patients', pid), { carrier, address });
    p.carrier = carrier;
    p.address = address;
    document.querySelectorAll(`[data-info="${pid}"]`).forEach(el => { el.innerHTML = infoLine(p); });
    card.querySelector('[data-panel]').innerHTML = '';
  } catch (err) {
    msg.textContent = '저장 중 오류가 발생했습니다: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function deletePatient(pid) {
  const p = patientMap.get(pid);
  if (!confirm(`'${p.name}' 고객을 삭제할까요?\n방문 기록·코멘트도 모두 함께 삭제되며 되돌릴 수 없습니다.`)) return;
  try {
    const visitsSnap = await getDocs(collection(db, 'patients', pid, 'visits'));
    const keysSnap = await getDocs(query(collection(db, 'patientKeys'), where('patientId', '==', pid)));
    const commentsSnap = await getDocs(collection(db, 'patients', pid, 'comments'));
    const notiSnap = await getDocs(query(collection(db, 'notifications'),
      where('toKey', '==', normName(currentStaff.name)), where('patientId', '==', pid)));
    // 고객 문서는 마지막에 지웁니다 (보안 규칙이 고객 문서로 소유자를 확인하기 때문)
    const refs = [
      ...visitsSnap.docs.map(d => d.ref),
      ...commentsSnap.docs.map(d => d.ref),
      ...notiSnap.docs.map(d => d.ref),
      ...keysSnap.docs.map(d => d.ref),
      doc(db, 'patients', pid)
    ];
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(db);
      refs.slice(i, i + 400).forEach(r => batch.delete(r));
      await batch.commit();
    }
    patientMap.delete(pid);
    visitsCache.delete(pid);
    commentsCache.delete(pid);
    document.querySelectorAll(`[data-card="${pid}"]`).forEach(el => el.remove());
    if (myPatientsCache) {
      myPatientsCache = myPatientsCache.filter(x => x.id !== pid);
      drawMyPatients();
    }
    renderDailyReport();
  } catch (err) {
    alert('삭제 중 오류가 발생했습니다: ' + err.message);
  }
}

/* ---------- 카드 영역 공용 이벤트 (고객 조회 결과 / 내 고객 목록에 각각 연결) ---------- */

async function onCardClick(e) {
  const root = e.currentTarget;
  const btn = e.target.closest('[data-action]');
  if (!btn || !root.contains(btn)) return;
  const act = btn.dataset.action;

  if (act === 'show-dup-form') {
    $('dupWrap').classList.toggle('hidden');
    return;
  }

  if (act === 'add-policy') {
    btn.closest('[data-policies-wrap]').querySelector('[data-policies]').insertAdjacentHTML('beforeend', policyRowHtml());
    return;
  }
  if (act === 'remove-policy') {
    const wrap = btn.closest('[data-policies]');
    btn.closest('.policy-row').remove();
    if (!wrap.querySelector('.policy-row')) wrap.insertAdjacentHTML('beforeend', policyRowHtml());
    return;
  }

  const card = btn.closest('[data-card]');
  if (!card) return;
  const pid = card.dataset.card;
  const p = patientMap.get(pid);
  if (!p) return;

  if (act === 'cancel-panel') { card.querySelector('[data-panel]').innerHTML = ''; return; }
  if (act === 'add-comment') return openCommentPanel(card, pid);
  if (act === 'delete-comment') return deleteComment(pid, btn.dataset.commentId);
  if (['edit-visit', 'delete-visit', 'edit-patient', 'delete-patient'].includes(act) && !isMine(p)) {
    alert('본인 고객만 수정/삭제할 수 있습니다.');
    return;
  }
  if (act === 'add-visit' && !(isMine(p) || isLeadOf(p))) {
    alert('방문 기록은 담당자 본인(또는 팀장)만 추가할 수 있습니다.');
    return;
  }

  if (act === 'toggle-visits') return toggleVisits(pid, card.querySelector('[data-visits-box]'), btn);
  if (act === 'add-visit') return openVisitPanel(card, pid, null);
  if (act === 'edit-visit') return openVisitPanel(card, pid, btn.dataset.visitId);
  if (act === 'delete-visit') return deleteVisit(pid, btn.dataset.visitId);
  if (act === 'edit-patient') return openPatientEdit(card, pid);
  if (act === 'delete-patient') return deletePatient(pid);
}

function onCardSubmit(e) {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const card = form.closest('[data-card]');
  if (!card) return;
  const pid = card.dataset.card;
  if (form.dataset.form === 'visit') submitVisitForm(form, card, pid);
  if (form.dataset.form === 'comment') submitCommentForm(form, card, pid);
  if (form.dataset.form === 'patient-edit') submitPatientEdit(form, card, pid);
}

function onCardChange(e) {
  const t = e.target;
  if (t.matches('select[data-f="type"]')) {
    t.closest('form').querySelector('[data-claim-wrap]').classList.toggle('hidden', t.value !== '청구');
    t.closest('form').querySelector('[data-claim-wrap]').classList.toggle('flex', t.value === '청구');
  }
  if (t.matches('input[data-f="noSilson"]')) {
    t.closest('form').querySelector('[data-policies-wrap]').classList.toggle('hidden', t.checked);
  }
}

function onCardInput(e) {
  const t = e.target;
  if (t.id === 'dup-ssn') t.value = formatSsnInput(t.value);
  if (t.id === 'dup-phone' || t.matches('input[data-f="phone"]')) t.value = formatPhoneInput(t.value);
  if (t.matches('[data-f="birth"], [data-f="gender"], [data-f="phone"]')) t.dataset.touched = '1';
  if (['reg-ssn', 'reg-phone', 'dup-ssn', 'dup-phone'].includes(t.id)) syncRegVisitFields(t.closest('form'));
}

function wireCardRoot(root) {
  root.addEventListener('click', onCardClick);
  root.addEventListener('submit', onCardSubmit);
  root.addEventListener('change', onCardChange);
  root.addEventListener('input', onCardInput);
}

/* ---------------------------------------------------------
   신규 접수 공용 로직 (신규 접수 탭 + 고객 조회의 동명이인 접수에서 같이 사용)
   - 성함+주민번호 / 성함+휴대폰 / 주민번호+휴대폰 3가지 "쌍"의 해시를
     patientKeys 문서 ID로 저장합니다. 이 중 하나라도 이미 있으면 2가지 이상 일치입니다.
   - 확인과 등록을 하나의 트랜잭션으로 처리하므로, 동시에 접수해도 먼저 커밋된 사람이 담당자가 됩니다.
   - 주민번호/휴대폰 원문은 저장하지 않고 마스킹 값과 해시만 저장합니다.
--------------------------------------------------------- */
function validateReg({ name, ssn, phone }) {
  if (!normName(name)) return '성함을 입력해주세요.';
  if (ssn.length !== 13) return '주민등록번호 13자리를 정확히 입력해주세요.';
  if (phone.length < 10 || phone.length > 11) return '휴대폰 번호를 정확히 입력해주세요.';
  return '';
}

async function registerPatient({ name, ssn, phone, carrier, address }) {
  const nk = normName(name);
  const hashes = await Promise.all([
    sha256Hex(`ns|${nk}|${ssn}`),     // 성함 + 주민번호
    sha256Hex(`np|${nk}|${phone}`),   // 성함 + 휴대폰
    sha256Hex(`sp|${ssn}|${phone}`),  // 주민번호 + 휴대폰
    sha256Hex(`nb|${nk}|${ssn.slice(0, 6)}`) // 성함 + 생년월일(앞 6자리) — 시트 이관 고객과의 중복 판정용
  ]);
  const keyRefs = hashes.map(h => doc(db, 'patientKeys', h));
  const patientRef = doc(collection(db, 'patients'));

  return runTransaction(db, async (tx) => {
    // 트랜잭션 규칙: 모든 읽기를 먼저, 쓰기는 나중에
    const keySnaps = [];
    for (const ref of keyRefs) keySnaps.push(await tx.get(ref));
    const hit = keySnaps.find(s => s.exists());

    if (hit) {
      const existingId = hit.data().patientId;
      const pSnap = await tx.get(doc(db, 'patients', existingId));
      return { duplicate: true, patientId: existingId, patient: pSnap.exists() ? { id: existingId, ...pSnap.data() } : null };
    }

    tx.set(patientRef, {
      name,
      nameKey: nk,
      ssnMasked: maskSsn(ssn),
      phoneMasked: maskPhone(phone),
      carrier,
      address,
      staffId: currentUser.uid,
      staffName: currentStaff.name,
      staffRole: currentStaff.role,
      teamId: currentStaff.teamId,
      createdAt: serverTimestamp()
    });
    keyRefs.forEach(ref => tx.set(ref, {
      patientId: patientRef.id,
      staffId: currentUser.uid,
      createdAt: serverTimestamp()
    }));
    return { duplicate: false, id: patientRef.id };
  });
}

// 신규 접수 + 첫 방문 기록 저장 (이미 등록된 고객이면 방문 기록은 만들지 않음)
async function registerWithVisit(root, input) {
  const r = await registerPatient(input);
  if (r.duplicate) return r;
  const p = { id: r.id, name: input.name, staffName: currentStaff.name, teamId: currentStaff.teamId };
  try {
    const fields = readVisitFields(root);
    await addDoc(collection(db, 'patients', r.id, 'visits'), {
      ...visitDocFor(p, fields, toDateKey(new Date())),
      createdAt: serverTimestamp()
    });
  } catch (err) {
    r.visitError = err.message;
  }
  return r;
}

const MSG_STYLES = {
  ok: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  dup: 'bg-amber-50 border-amber-300 text-amber-900',
  err: 'bg-red-50 border-red-200 text-red-700'
};
function messageHtml(kind, html) {
  return `<div class="border rounded-xl p-4 text-sm text-left ${MSG_STYLES[kind]}">${html}</div>`;
}
const visitBtnHtml = (pid, label) =>
  `<button type="button" data-action="record-visit-now" data-pid="${esc(pid)}" class="mt-3 px-4 py-2 bg-indigo-600 text-white text-xs font-bold rounded-lg hover:bg-indigo-700">${label}</button>`;

// 접수 결과 메시지 (성공 / 이미 등록된 고객)
function outcomeHtml(r) {
  if (r.duplicate) {
    const p = r.patient;
    const mineBtn = p && isMine(p) ? visitBtnHtml(r.patientId, '내 고객입니다 · 방문 기록 입력') : '';
    return messageHtml('dup', `
      <p class="font-bold text-base"><i class="fa-solid fa-triangle-exclamation mr-1"></i>이미 등록된 고객입니다.</p>
      <p class="mt-1">${p
        ? `담당자 : <strong>${esc(p.staffName)} ${roleLabel(p.staffRole)}</strong> (등록일 ${esc(formatDate(p.createdAt))})`
        : '등록 담당자 정보를 불러오지 못했습니다. 관리자에게 문의해주세요.'}</p>
      <p class="text-xs mt-2 opacity-80">성함 / 주민등록번호 / 휴대폰 중 2가지 이상이 기존 고객과 일치합니다. 먼저 등록한 담당자가 우선입니다.</p>
      ${mineBtn}`);
  }
  return messageHtml('ok', `
    <p class="font-bold text-base"><i class="fa-solid fa-circle-check mr-1"></i>신규 고객으로 등록되었습니다.</p>
    <p class="mt-1">담당자 : <strong>${esc(currentStaff.name)} ${roleLabel(currentStaff.role)}</strong></p>
    ${r.visitError
      ? `<p class="mt-2 text-xs text-red-700">방문 기록 저장에 실패했습니다 (${esc(r.visitError)}). 아래 버튼으로 다시 입력해주세요.</p>${visitBtnHtml(r.id, '방문 기록 바로 입력')}`
      : '<p class="mt-1 text-xs opacity-80">방문 기록도 함께 저장되었습니다.</p>'}`);
}

// 접수 직후 "방문 기록 입력" → 내 고객 탭에서 해당 고객의 입력 폼을 자동으로 엽니다
function goRecordVisit(pid) {
  pendingVisitFor = pid;
  $('myPatientsFilter').value = '';
  switchTab('my-patients');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-action="record-visit-now"]');
  if (b) goRecordVisit(b.dataset.pid);
});

/* ---------------------------------------------------------
   내 고객
--------------------------------------------------------- */
let myPatientsCache = null;
async function renderMyPatients() {
  const body = $('myPatientsBody');
  body.innerHTML = '<p class="text-sm text-gray-400 p-6 text-center">불러오는 중...</p>';
  try {
    const snap = await getDocs(query(collection(db, 'patients'), where('staffName', '==', currentStaff.name)));
    myPatientsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    drawMyPatients();
  } catch (err) {
    body.innerHTML = `<p class="text-sm text-red-600 p-6 text-center">불러오지 못했습니다: ${esc(err.message)}</p>`;
  }
}
function drawMyPatients() {
  const body = $('myPatientsBody');
  const f = normName($('myPatientsFilter').value);
  const list = (myPatientsCache || []).filter(p => !f || (p.nameKey || '').includes(f));
  if (!list.length) {
    body.innerHTML = '<p class="text-sm text-gray-400 p-6 text-center">표시할 고객이 없습니다.</p>';
  } else {
    body.innerHTML = `<p class="text-xs text-gray-500 mb-3">총 ${list.length}명</p>` +
      list.map(p => cardHtml(p, { badge: false })).join('');
  }
  if (pendingVisitFor) {
    const pid = pendingVisitFor;
    pendingVisitFor = null;
    const card = body.querySelector(`[data-card="${pid}"]`);
    if (card) openVisitPanel(card, pid, null);
  }
  if (pendingOpenVisitsFor) {
    const pid = pendingOpenVisitsFor;
    pendingOpenVisitsFor = null;
    const btn = body.querySelector(`[data-card="${pid}"] [data-action="toggle-visits"]`);
    if (btn) { btn.click(); btn.closest('[data-card]').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  }
}
$('myPatientsFilter').addEventListener('input', drawMyPatients);
wireCardRoot($('myPatientsBody'));

/* ---------------------------------------------------------
   고객 조회 (고객명 입력 → 등록 담당자 표시)
   - patients 컬렉션에서 이름(공백 제거)이 입력값으로 "시작하는" 고객을 찾습니다.
   - 동명이인일 수 있으므로 결과가 있어도 항상 "동명이인 신규 접수"를 할 수 있습니다.
--------------------------------------------------------- */
const lookupResult = $('lookupResult');
wireCardRoot(lookupResult);

function dupSectionHtml(rawName) {
  return `
    <div class="border-t pt-3 mt-3 text-left">
      <button type="button" data-action="show-dup-form" class="text-sm font-bold text-indigo-700 hover:underline">
        <i class="fa-solid fa-user-plus mr-1"></i>찾는 분이 없나요? 동명이인 신규 접수
      </button>
      <div id="dupWrap" class="hidden mt-3">
        <form id="dupForm" data-form="dup" class="border rounded-xl p-4 bg-white grid grid-cols-1 sm:grid-cols-2 gap-3">
          <p class="sm:col-span-2 text-[11px] text-gray-500">성함 / 주민등록번호 / 휴대폰 중 2가지 이상이 이미 등록된 고객과 같으면 "이미 등록된 고객"으로 안내됩니다.</p>
          <div><label class="block text-xs font-bold text-gray-700 mb-1">성함 *</label><input type="text" id="dup-name" required value="${esc(rawName)}" class="${INP}"></div>
          <div><label class="block text-xs font-bold text-gray-700 mb-1">주민등록번호 *</label><input type="text" id="dup-ssn" required inputmode="numeric" autocomplete="off" placeholder="000000-0000000" class="${INP}"></div>
          <div><label class="block text-xs font-bold text-gray-700 mb-1">휴대폰 *</label><input type="tel" id="dup-phone" required placeholder="010-0000-0000" class="${INP}"></div>
          <div><label class="block text-xs font-bold text-gray-700 mb-1">통신사</label><select id="dup-carrier" class="${INP}">${opts(CARRIERS, 'SKT')}</select></div>
          <div class="sm:col-span-2"><label class="block text-xs font-bold text-gray-700 mb-1">주소</label><input type="text" id="dup-address" class="${INP}"></div>
          <div class="sm:col-span-2">${regVisitHtml()}</div>
          <div class="sm:col-span-2"><button type="submit" id="btnDupRegister" class="w-full py-2.5 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 disabled:opacity-60"><i class="fa-solid fa-user-check mr-1"></i>동명이인 신규 등록</button></div>
          <div id="dupResult" class="sm:col-span-2"></div>
        </form>
      </div>
    </div>`;
}

let lastLookupRaw = '';

async function runLookup(raw, bannerHtml = '') {
  lastLookupRaw = raw;
  const key = normName(raw);
  if (!key) {
    lookupResult.className = 'border rounded-xl p-4 bg-slate-50 text-center text-sm text-gray-500';
    lookupResult.textContent = '고객명을 입력해주세요.';
    return;
  }

  lookupResult.className = 'border rounded-xl p-4 bg-slate-50 text-center text-sm text-gray-400';
  lookupResult.textContent = '조회 중...';

  try {
    const q = query(
      collection(db, 'patients'),
      where('nameKey', '>=', key),
      where('nameKey', '<=', key + '\uf8ff')
    );
    const snap = await getDocs(q);
    const list = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));

    if (list.length === 0) {
      lookupResult.className = 'border rounded-xl p-6 bg-slate-50 text-center';
      lookupResult.innerHTML = `
        <p class="text-sm text-gray-600 mb-3"><strong>${esc(raw.trim())}</strong> 님은 등록된 고객이 아닙니다.</p>
        <button type="button" id="btnGoRegister" class="px-5 py-2.5 bg-indigo-600 text-white font-bold text-sm rounded-lg hover:bg-indigo-700">
          <i class="fa-solid fa-user-plus mr-1"></i> 신규 접수하기
        </button>`;
      $('btnGoRegister').addEventListener('click', () => {
        $('reg-name').value = raw.trim();
        switchTab('new-registration');
        $('reg-ssn').focus();
      });
      return;
    }

    lookupResult.className = '';
    lookupResult.innerHTML = bannerHtml +
      list.map(p => cardHtml(p)).join('') +
      dupSectionHtml(raw.trim());
  } catch (err) {
    lookupResult.className = 'border rounded-xl p-4 bg-red-50 text-center text-sm text-red-600';
    lookupResult.textContent = '조회 중 오류가 발생했습니다: ' + err.message;
  }
}

$('lookupForm').addEventListener('submit', (e) => {
  e.preventDefault();
  runLookup($('lookupName').value);
});

// 동명이인 신규 접수 (고객 조회 결과 아래 폼)
lookupResult.addEventListener('submit', async (e) => {
  if (e.target.id !== 'dupForm') return;
  e.preventDefault();
  if (!currentUser || !currentStaff) return;
  const out = $('dupResult');
  out.innerHTML = '';

  const input = {
    name: $('dup-name').value.trim(),
    ssn: digitsOnly($('dup-ssn').value),
    phone: digitsOnly($('dup-phone').value),
    carrier: $('dup-carrier').value,
    address: $('dup-address').value.trim()
  };
  const bad = validateReg(input);
  if (bad) { out.innerHTML = messageHtml('err', esc(bad)); return; }

  const btn = $('btnDupRegister');
  btn.disabled = true;
  try {
    const r = await registerWithVisit($('dupForm'), input);
    if (r.duplicate) {
      out.innerHTML = outcomeHtml(r);
    } else {
      // 목록을 새로 불러와 방금 등록한 동명이인이 보이도록 하고, 성공 안내를 위에 붙입니다
      await runLookup(lastLookupRaw || input.name, outcomeHtml(r));
    }
  } catch (err) {
    out.innerHTML = messageHtml('err', '등록 중 오류가 발생했습니다: ' + esc(err.message));
  } finally {
    btn.disabled = false;
  }
});

/* ---------------------------------------------------------
   신규 접수 탭
--------------------------------------------------------- */
const regSsn = $('reg-ssn');
const regPhone = $('reg-phone');
regSsn.addEventListener('input', () => { regSsn.value = formatSsnInput(regSsn.value); });
regPhone.addEventListener('input', () => { regPhone.value = formatPhoneInput(regPhone.value); });

const registerResult = $('registerResult');
const btnRegister = $('btnRegister');
wireCardRoot($('registerForm'));

$('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser || !currentStaff) return;
  registerResult.innerHTML = '';

  const input = {
    name: $('reg-name').value.trim(),
    ssn: digitsOnly(regSsn.value),
    phone: digitsOnly(regPhone.value),
    carrier: $('reg-carrier').value,
    address: $('reg-address').value.trim()
  };
  const bad = validateReg(input);
  if (bad) { registerResult.innerHTML = messageHtml('err', esc(bad)); return; }

  btnRegister.disabled = true;
  try {
    const r = await registerWithVisit($('registerForm'), input);
    registerResult.innerHTML = outcomeHtml(r);
    if (!r.duplicate) { e.target.reset(); mountRegVisit(); }
  } catch (err) {
    registerResult.innerHTML = messageHtml('err', '등록 중 오류가 발생했습니다: ' + esc(err.message));
  } finally {
    btnRegister.disabled = false;
  }
});

/* ---------------------------------------------------------
   일일 보험조회현황 (첫 화면) — 카톡 마감 보고용
   - 방문 기록(visits)의 방문날짜/신규·재방문/조회·청구/청구완료 값으로 자동 집계됩니다.
   - 집계 범위: 팀원은 "내 고객" 기록, 팀장은 팀 전체도 선택 가능합니다.
   - collectionGroup('visits') 쿼리를 쓰므로 Firestore에서 visits 컬렉션 그룹 인덱스가 필요합니다.
--------------------------------------------------------- */
let dailyState = { key: '', visits: [] };

function initDailyControls() {
  $('dailyDate').value = toDateKey(new Date());
  let reporter = currentStaff.name;
  try { reporter = localStorage.getItem('dailyReporter') || reporter; } catch (e) { /* 무시 */ }
  $('dailyReporter').value = reporter;
  const scope = $('dailyScope');
  scope.innerHTML = '<option value="mine">내 고객 기준</option>' +
    (currentStaff.role === 'lead' ? '<option value="team">팀 전체</option>' : '');
}

function buildReportText() {
  const { key, visits } = dailyState;
  const d = keyToDate(key);
  const reporter = $('dailyReporter').value.trim();

  // 같은 고객이 하루에 여러 번 기록돼도 1명으로 셉니다 (신규 기록이 하나라도 있으면 신규)
  const byPatient = new Map();
  visits.forEach(v => {
    const id = v.patientId || v.patientName;
    const cur = byPatient.get(id) || { kind: '재방문' };
    if (v.kind === '신규') cur.kind = '신규';
    byPatient.set(id, cur);
  });
  const total = byPatient.size;
  const newCnt = Array.from(byPatient.values()).filter(x => x.kind === '신규').length;
  const revCnt = total - newCnt;

  const claims = Array.from(new Set(
    visits.filter(v => v.type === '청구')
      .map(v => `${v.patientName}(${v.staffName}) - ${v.claimDone ? '청구완료' : '청구진행'}`)
  ));

  const text = [
    '★서울연세병원 일일 보험조회현황★',
    `─ ${pad2(d.getMonth() + 1)}월/${pad2(d.getDate())}일 (${WEEKDAYS[d.getDay()]}) ─ ${reporter}`,
    `총원 : ${total}명`,
    `신규조회 : ${pad2(newCnt)}명`,
    `재방문 : ${pad2(revCnt)}명`,
    '',
    '─ 보험금 청구현황 ─',
    ...(claims.length ? claims : ['없음'])
  ].join('\n');
  return { text, total, newCnt, revCnt };
}

function drawDailyReport() {
  const { text, total, newCnt, revCnt } = buildReportText();
  $('dailyTotal').textContent = total;
  $('dailyNew').textContent = newCnt;
  $('dailyRevisit').textContent = revCnt;
  const pre = $('dailyReportText');
  pre.className = 'bg-slate-50 border rounded-xl p-4 text-sm whitespace-pre-wrap font-sans leading-relaxed text-gray-800';
  pre.textContent = text;
}

async function renderDailyReport() {
  if (!currentStaff) return;
  if ($('view-daily').classList.contains('hidden')) return; // 일일 현황 탭을 열 때 불러옵니다
  const pre = $('dailyReportText');
  const key = $('dailyDate').value || toDateKey(new Date());
  const scope = $('dailyScope').value;
  pre.className = 'bg-slate-50 border rounded-xl p-4 text-sm text-gray-400';
  pre.textContent = '불러오는 중...';
  try {
    const q = query(
      collectionGroup(db, 'visits'),
      where('visitDateKey', '==', key),
      scope === 'team' ? where('teamId', '==', currentStaff.teamId) : where('staffName', '==', currentStaff.name)
    );
    const snap = await getDocs(q);
    dailyState = { key, visits: snap.docs.map(d => d.data()) };
    drawDailyReport();
  } catch (err) {
    pre.className = 'bg-red-50 border border-red-200 rounded-xl p-4 text-xs text-red-700 whitespace-pre-wrap break-all';
    pre.textContent = '불러오지 못했습니다: ' + err.message;
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

$('dailyDate').addEventListener('change', renderDailyReport);
$('dailyScope').addEventListener('change', renderDailyReport);
$('btnDailyRefresh').addEventListener('click', renderDailyReport);
$('dailyReporter').addEventListener('input', () => {
  try { localStorage.setItem('dailyReporter', $('dailyReporter').value.trim()); } catch (e) { /* 무시 */ }
  if (dailyState.key) drawDailyReport();
});
$('btnCopyReport').addEventListener('click', async () => {
  if (!dailyState.key) return;
  await copyText(buildReportText().text);
  const btn = $('btnCopyReport');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-check mr-1"></i>복사됨 — 카톡에 붙여넣으세요';
  setTimeout(() => { btn.innerHTML = orig; }, 1800);
});

/* ---------------------------------------------------------
   로그인 시 하단 알림 (다른 담당자가 내 고객에 코멘트를 남긴 경우)
   - notifications 문서의 seen 이 false 인 것만 보여줍니다.
   - '확인'(또는 '보러가기')을 누르면 seen:true 로 저장되어 다음 로그인부터는 다시 뜨지 않습니다.
--------------------------------------------------------- */
async function loadNotifications() {
  notifyTray.innerHTML = '';
  if (!currentStaff) return;
  try {
    const snap = await getDocs(query(
      collection(db, 'notifications'),
      where('toKey', '==', normName(currentStaff.name)),
      where('seen', '==', false)
    ));
    const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));
    drawNotifications(list);
  } catch (err) {
    console.warn('알림을 불러오지 못했습니다:', err.message);
  }
}

function drawNotifications(list) {
  if (!list.length) { notifyTray.innerHTML = ''; return; }
  const cards = list.map(n => `
    <div data-nid="${esc(n.id)}" data-pid="${esc(n.patientId)}" class="bg-white border-2 border-amber-300 rounded-xl shadow-lg p-3 text-xs text-left">
      <p class="font-bold text-gray-900"><i class="fa-regular fa-comment text-amber-600 mr-1"></i>
        ${esc(n.patientName)} 고객에 <span class="text-indigo-700">${esc(n.fromName)}</span> 님이 코멘트를 남겼습니다
        ${n.tag ? `<span class="bg-amber-200 text-amber-900 px-1.5 py-0.5 rounded ml-1">${esc(n.tag)}</span>` : ''}</p>
      <p class="text-gray-600 mt-1 whitespace-pre-wrap">${esc(n.preview)}</p>
      <div class="flex gap-3 mt-2 font-bold">
        <button type="button" data-nact="go" class="text-indigo-700 hover:underline">보러가기</button>
        <button type="button" data-nact="ack" class="text-gray-600 hover:underline">확인</button>
      </div>
    </div>`).join('');
  const allBtn = list.length > 1
    ? `<button type="button" data-nact="ack-all" class="w-full py-1.5 bg-gray-800 text-white text-xs font-bold rounded-lg shadow">모두 확인 (${list.length}건)</button>`
    : '';
  notifyTray.innerHTML = cards + allBtn;
}

async function ackNotification(nid) {
  await updateDoc(doc(db, 'notifications', nid), { seen: true, seenAt: serverTimestamp() });
  notifyTray.querySelector(`[data-nid="${nid}"]`)?.remove();
}

notifyTray.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-nact]');
  if (!b) return;
  const act = b.dataset.nact;
  try {
    if (act === 'ack-all') {
      const ids = Array.from(notifyTray.querySelectorAll('[data-nid]')).map(el => el.dataset.nid);
      await Promise.all(ids.map(ackNotification));
      notifyTray.innerHTML = '';
      return;
    }
    const el = b.closest('[data-nid]');
    const nid = el.dataset.nid, pid = el.dataset.pid;
    await ackNotification(nid);
    if (act === 'go') {
      pendingOpenVisitsFor = pid;
      $('myPatientsFilter').value = '';
      switchTab('my-patients');
    }
    if (notifyTray.querySelectorAll('[data-nid]').length < 2) notifyTray.querySelector('[data-nact="ack-all"]')?.remove();
  } catch (err) {
    alert('알림 처리 중 오류가 발생했습니다: ' + err.message);
  }
});

/* ---------------------------------------------------------
   팀 전체 현황 (팀장만 접근 - 같은 팀 담당자들이 등록한 고객)
--------------------------------------------------------- */
async function renderTeamOverview() {
  const wrap = $('teamOverviewBody');
  if (currentStaff.role !== 'lead') {
    wrap.innerHTML = `<p class="text-sm text-gray-500 p-6 text-center">팀장 권한이 필요한 화면입니다.</p>`;
    return;
  }
  wrap.innerHTML = `<p class="text-sm text-gray-400 p-6 text-center">불러오는 중...</p>`;

  try {
    const q = query(collection(db, 'patients'), where('teamId', '==', currentStaff.teamId));
    const snap = await getDocs(q);
    const list = snap.docs
      .map(d => d.data())
      .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));

    if (list.length === 0) {
      wrap.innerHTML = `<p class="text-sm text-gray-400 p-6 text-center">우리 팀에 등록된 고객이 없습니다.</p>`;
      return;
    }

    // 담당자별 집계
    const byStaff = {};
    list.forEach(p => { byStaff[p.staffName] = (byStaff[p.staffName] || 0) + 1; });

    const summaryHtml = Object.entries(byStaff).map(([name, count]) => `
      <div class="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3 text-center">
        <div class="text-xs font-bold text-indigo-700">${esc(name)}</div>
        <div class="text-2xl font-extrabold text-indigo-900">${count}<span class="text-xs font-normal ml-1">명</span></div>
      </div>`).join('');

    const rowsHtml = list.map(p => `
      <tr class="hover:bg-slate-50">
        <td class="p-3 text-[11px] text-gray-400">${esc(formatDate(p.createdAt))}</td>
        <td class="p-3 font-bold text-indigo-700">${esc(p.staffName)}</td>
        <td class="p-3 font-bold">${esc(p.name)}</td>
        <td class="p-3">${esc(p.phoneMasked)}</td>
      </tr>`).join('');

    wrap.innerHTML = `
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">${summaryHtml}</div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs border-collapse">
          <thead>
            <tr class="bg-slate-100 text-gray-700 font-bold border-b">
              <th class="p-3">등록일시</th><th class="p-3">담당자</th><th class="p-3">고객명</th><th class="p-3">휴대폰</th>
            </tr>
          </thead>
          <tbody class="divide-y text-gray-600">${rowsHtml}</tbody>
        </table>
      </div>`;
  } catch (err) {
    wrap.innerHTML = `<p class="text-sm text-red-600 p-6 text-center">불러오지 못했습니다: ${esc(err.message)}</p>`;
  }
}