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
  collection,
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

const digitsOnly = (s) => String(s ?? '').replace(/\D/g, '');
const normName = (s) => String(s ?? '').replace(/\s+/g, '');
const roleLabel = (role) => (role === 'lead' ? '팀장' : '팀원');

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

/* ---------------------------------------------------------
   로그인 / 로그아웃 / 최초 프로필 생성
--------------------------------------------------------- */

const loginView = document.getElementById('view-login');
const appRoot = document.getElementById('app-root');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const btnSignup = document.getElementById('btnSignup');

const setupView = document.getElementById('view-profile-setup');
const setupForm = document.getElementById('profileSetupForm');

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    loginError.textContent = '로그인 실패: 이메일 또는 비밀번호를 확인해주세요.';
  }
});

btnSignup.addEventListener('click', async () => {
  loginError.textContent = '';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
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

document.getElementById('btnLogout').addEventListener('click', () => signOut(auth));

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

const btnKakaoLogin = document.getElementById('btnKakaoLogin');
const kakaoLoginError = document.getElementById('kakaoLoginError');

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
  const name = document.getElementById('setup-name').value.trim();
  const teamId = document.getElementById('setup-teamId').value.trim();
  if (!name || !teamId) return;

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

  document.getElementById('currentStaffName').textContent = currentStaff.name;
  document.getElementById('currentStaffRole').textContent = roleLabel(currentStaff.role);

  // 팀장에게만 "팀 전체 현황" 탭 노출
  const teamTabBtn = document.getElementById('tab-team-overview');
  teamTabBtn.classList.toggle('hidden', currentStaff.role !== 'lead');

  switchTab('lookup');
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

  const targetView = document.getElementById('view-' + tabId);
  const targetTab = document.getElementById('tab-' + tabId);
  if (targetView) targetView.classList.remove('hidden');
  if (targetTab) {
    targetTab.classList.add('border-b-2', 'border-indigo-700', 'text-indigo-700', 'bg-white');
    targetTab.classList.remove('text-gray-600');
  }

  if (tabId === 'team-overview') renderTeamOverview();
  if (tabId === 'lookup') document.getElementById('lookupName').focus();
};

/* ---------------------------------------------------------
   고객 조회 (고객명 입력 → 등록 담당자 표시)
   - patients 컬렉션에서 이름(공백 제거)이 입력값으로 "시작하는" 고객을 찾습니다.
--------------------------------------------------------- */
const lookupResult = document.getElementById('lookupResult');

function staffLine(p) {
  return `담당자 : ${esc(p.staffName)} ${roleLabel(p.staffRole)}`;
}

document.getElementById('lookupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = document.getElementById('lookupName').value;
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
      .map(d => d.data())
      .sort((a, b) => (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0));

    if (list.length === 0) {
      lookupResult.className = 'border rounded-xl p-6 bg-slate-50 text-center';
      lookupResult.innerHTML = `
        <p class="text-sm text-gray-600 mb-3"><strong>${esc(raw.trim())}</strong> 님은 등록된 고객이 아닙니다.</p>
        <button type="button" id="btnGoRegister" class="px-5 py-2.5 bg-indigo-600 text-white font-bold text-sm rounded-lg hover:bg-indigo-700">
          <i class="fa-solid fa-user-plus mr-1"></i> 신규 접수하기
        </button>`;
      document.getElementById('btnGoRegister').addEventListener('click', () => {
        document.getElementById('reg-name').value = raw.trim();
        switchTab('new-registration');
        document.getElementById('reg-ssn').focus();
      });
      return;
    }

    lookupResult.className = 'space-y-2';
    lookupResult.innerHTML = list.map(p => {
      const mine = p.staffId === currentUser.uid;
      return `
        <div class="bg-white border rounded-xl p-4 text-left shadow-sm flex justify-between items-center gap-3">
          <div>
            <span class="bg-emerald-100 text-emerald-800 font-bold text-xs px-2 py-0.5 rounded">등록된 고객</span>
            ${mine ? '<span class="bg-indigo-100 text-indigo-800 font-bold text-xs px-2 py-0.5 rounded ml-1">내 고객</span>' : ''}
            <h4 class="font-bold text-lg text-gray-900 mt-1">${esc(p.name)}</h4>
            <p class="text-sm font-bold text-indigo-700 mt-0.5">${staffLine(p)}</p>
            <p class="text-xs text-gray-400 mt-1">${esc(p.phoneMasked)} · 등록일 ${esc(formatDate(p.createdAt))}</p>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    lookupResult.className = 'border rounded-xl p-4 bg-red-50 text-center text-sm text-red-600';
    lookupResult.textContent = '조회 중 오류가 발생했습니다: ' + err.message;
  }
});

/* ---------------------------------------------------------
   신규 접수 (선접수 우선 + 2가지 이상 일치 시 중복 판정)
   - 성함+주민번호 / 성함+휴대폰 / 주민번호+휴대폰 3가지 "쌍"의 해시를
     patientKeys 문서 ID로 저장합니다. 이 중 하나라도 이미 있으면 2가지 이상 일치입니다.
   - 확인과 등록을 하나의 트랜잭션으로 처리하므로, 동시에 접수해도 먼저 커밋된 사람이 담당자가 됩니다.
   - 주민번호/휴대폰 원문은 저장하지 않고 마스킹 값과 해시만 저장합니다.
--------------------------------------------------------- */
const regSsn = document.getElementById('reg-ssn');
const regPhone = document.getElementById('reg-phone');
regSsn.addEventListener('input', () => { regSsn.value = formatSsnInput(regSsn.value); });
regPhone.addEventListener('input', () => { regPhone.value = formatPhoneInput(regPhone.value); });

const registerResult = document.getElementById('registerResult');
const btnRegister = document.getElementById('btnRegister');

function showRegisterMessage(kind, html) {
  const styles = {
    ok: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    dup: 'bg-amber-50 border-amber-300 text-amber-900',
    err: 'bg-red-50 border-red-200 text-red-700'
  };
  registerResult.innerHTML = `<div class="border rounded-xl p-4 text-sm ${styles[kind]}">${html}</div>`;
}

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser || !currentStaff) return;
  registerResult.innerHTML = '';

  const name = document.getElementById('reg-name').value.trim();
  const ssn = digitsOnly(regSsn.value);
  const phone = digitsOnly(regPhone.value);
  const carrier = document.getElementById('reg-carrier').value;
  const address = document.getElementById('reg-address').value.trim();

  if (!normName(name)) return showRegisterMessage('err', '성함을 입력해주세요.');
  if (ssn.length !== 13) return showRegisterMessage('err', '주민등록번호 13자리를 정확히 입력해주세요.');
  if (phone.length < 10 || phone.length > 11) return showRegisterMessage('err', '휴대폰 번호를 정확히 입력해주세요.');

  btnRegister.disabled = true;
  try {
    const nk = normName(name);
    const hashes = await Promise.all([
      sha256Hex(`ns|${nk}|${ssn}`),     // 성함 + 주민번호
      sha256Hex(`np|${nk}|${phone}`),   // 성함 + 휴대폰
      sha256Hex(`sp|${ssn}|${phone}`)   // 주민번호 + 휴대폰
    ]);
    const keyRefs = hashes.map(h => doc(db, 'patientKeys', h));
    const patientRef = doc(collection(db, 'patients'));

    const result = await runTransaction(db, async (tx) => {
      // 트랜잭션 규칙: 모든 읽기를 먼저, 쓰기는 나중에
      const keySnaps = [];
      for (const ref of keyRefs) keySnaps.push(await tx.get(ref));
      const hit = keySnaps.find(s => s.exists());

      if (hit) {
        const pSnap = await tx.get(doc(db, 'patients', hit.data().patientId));
        return { duplicate: true, patient: pSnap.exists() ? pSnap.data() : null };
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
      return { duplicate: false };
    });

    if (result.duplicate) {
      const p = result.patient;
      showRegisterMessage('dup', `
        <p class="font-bold text-base"><i class="fa-solid fa-triangle-exclamation mr-1"></i>이미 등록된 고객입니다.</p>
        <p class="mt-1">${p
          ? `등록 담당자 : <strong>${esc(p.staffName)} ${roleLabel(p.staffRole)}</strong> (등록일 ${esc(formatDate(p.createdAt))})`
          : '등록 담당자 정보를 불러오지 못했습니다. 관리자에게 문의해주세요.'}</p>
        <p class="text-xs mt-2 opacity-80">성함 / 주민등록번호 / 휴대폰 중 2가지 이상이 기존 고객과 일치합니다. 먼저 등록한 담당자가 우선입니다.</p>`);
    } else {
      showRegisterMessage('ok', `
        <p class="font-bold text-base"><i class="fa-solid fa-circle-check mr-1"></i>신규 고객으로 등록되었습니다.</p>
        <p class="mt-1">담당자 : <strong>${esc(currentStaff.name)} ${roleLabel(currentStaff.role)}</strong></p>`);
      e.target.reset();
    }
  } catch (err) {
    showRegisterMessage('err', '등록 중 오류가 발생했습니다: ' + esc(err.message));
  } finally {
    btnRegister.disabled = false;
  }
});

/* ---------------------------------------------------------
   팀 전체 현황 (팀장만 접근 - 같은 팀 담당자들이 등록한 고객)
--------------------------------------------------------- */
async function renderTeamOverview() {
  const wrap = document.getElementById('teamOverviewBody');
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