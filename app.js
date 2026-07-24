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
  collection,
  query,
  where,
  orderBy,
  getDocs,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;   // Firebase Auth user
let currentStaff = null;  // { name, teamId, role } from Firestore staff/{uid}

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
   카카오 로그인
   - KAKAO_JS_KEY는 카카오 개발자 콘솔 > 내 애플리케이션 > 앱 키 > "JavaScript 키" 값입니다.
     (JS 키는 브라우저에 노출되는 것이 정상이며, REST API 키와는 다른 값입니다.)
   - 카카오 개발자 콘솔 > 앱 설정 > 플랫폼에 이 사이트 도메인을 "Web 플랫폼"으로 등록해야 합니다.
--------------------------------------------------------- */
const KAKAO_JS_KEY = 'fe63758ba86171a9aa4341f1a6ae2052';

if (window.Kakao && !window.Kakao.isInitialized()) {
  window.Kakao.init(KAKAO_JS_KEY);
}

const btnKakaoLogin = document.getElementById('btnKakaoLogin');
const kakaoLoginError = document.getElementById('kakaoLoginError');

btnKakaoLogin.addEventListener('click', () => {
  kakaoLoginError.textContent = '';

  window.Kakao.Auth.login({
    scope: 'profile_nickname',
    success: async (authObj) => {
      try {
        const res = await fetch('/api/kakao-auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: authObj.access_token })
        });
        const data = await res.json();
        if (!res.ok) {
          kakaoLoginError.textContent = '카카오 로그인 실패: ' + (data.error || '알 수 없는 오류');
          return;
        }
        await signInWithCustomToken(auth, data.token);
        // 이후 onAuthStateChanged가 이어서 프로필 설정/승인 흐름을 처리함
      } catch (err) {
        kakaoLoginError.textContent = '카카오 로그인 처리 중 오류가 발생했습니다.';
      }
    },
    fail: (err) => {
      kakaoLoginError.textContent = '카카오 로그인이 취소되었거나 실패했습니다.';
    }
  });
});

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
  document.getElementById('currentStaffRole').textContent = currentStaff.role === 'lead' ? '팀장' : '팀원';
  document.getElementById('btnStaffName').textContent = currentStaff.name;

  // 팀장에게만 "팀 전체 현황" 탭 노출
  const teamTabBtn = document.getElementById('tab-team-overview');
  teamTabBtn.classList.toggle('hidden', currentStaff.role !== 'lead');
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

  if (tabId === 'saved-records') renderMyRecords();
  if (tabId === 'team-overview') renderTeamOverview();
};

/* ---------------------------------------------------------
   태블릿 펜 캔버스
--------------------------------------------------------- */
const canvas = document.getElementById('penCanvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;

function initCanvas() {
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
  ctx.strokeStyle = '#1e1b4b';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}
window.addEventListener('load', initCanvas);
window.addEventListener('resize', initCanvas);

function getPos(e) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return { x: clientX - rect.left, y: clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => {
  isDrawing = true;
  const pos = getPos(e);
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
});
canvas.addEventListener('pointermove', (e) => {
  if (!isDrawing) return;
  const pos = getPos(e);
  ctx.lineTo(pos.x, pos.y);
  ctx.stroke();
});
canvas.addEventListener('pointerup', () => isDrawing = false);
canvas.addEventListener('pointerleave', () => isDrawing = false);

window.clearCanvas = function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  document.getElementById('ocrStatus').textContent = '';
};

/* ---------------------------------------------------------
   Naver Clova OCR 연동 (서버리스 함수 /api/ocr 경유)
--------------------------------------------------------- */
window.convertHandwritingToText = async function convertHandwritingToText() {
  const ocrStatus = document.getElementById('ocrStatus');
  const formNotes = document.getElementById('form-notes');

  ocrStatus.textContent = '✨ Clova OCR로 손글씨 인식 중...';

  try {
    const imageBase64 = canvas.toDataURL('image/png');
    const res = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64 })
    });
    const data = await res.json();

    if (!res.ok) {
      ocrStatus.textContent = '❌ 인식 실패: ' + (data.error || '알 수 없는 오류');
      return;
    }

    const recognized = (data.text || '').trim();
    if (!recognized) {
      ocrStatus.textContent = '⚠️ 인식된 텍스트가 없습니다. 조금 더 또박또박 작성해보세요.';
      return;
    }

    formNotes.value = (formNotes.value ? formNotes.value + '\n' : '') + '[손글씨 OCR 변환]: ' + recognized;
    ocrStatus.textContent = '✅ 손글씨 텍스트 변환 완료!';
  } catch (err) {
    ocrStatus.textContent = '❌ 네트워크 오류로 인식에 실패했습니다.';
  }
};

/* ---------------------------------------------------------
   접수 서류 저장 (Firestore)
--------------------------------------------------------- */
document.getElementById('insuranceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentUser || !currentStaff) return;

  const record = {
    staffId: currentUser.uid,
    staffName: currentStaff.name,
    teamId: currentStaff.teamId,
    name: document.getElementById('form-name').value || '',
    ssn: document.getElementById('form-ssn').value || '',
    phone: document.getElementById('form-phone').value || '',
    insurer: document.getElementById('form-insurer').value || '',
    notes: document.getElementById('form-notes').value || '',
    canvasImg: canvas.toDataURL('image/png'),
    createdAt: serverTimestamp()
  };

  try {
    await addDoc(collection(db, 'records'), record);
    alert(`${currentStaff.name} 담당자 계정으로 서류가 저장되었습니다.`);
    clearCanvas();
    e.target.reset();
    switchTab('saved-records');
  } catch (err) {
    alert('저장 중 오류가 발생했습니다: ' + err.message);
  }
});

/* ---------------------------------------------------------
   내 접수 목록 (본인 데이터만)
--------------------------------------------------------- */
async function renderMyRecords() {
  const tbody = document.getElementById('savedTableBody');
  tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-gray-400">불러오는 중...</td></tr>`;

  const q = query(
    collection(db, 'records'),
    where('staffId', '==', currentUser.uid),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(q);

  if (snap.empty) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-gray-400">저장된 접수 내역이 없습니다.</td></tr>`;
    return;
  }

  tbody.innerHTML = snap.docs.map(d => {
    const r = d.data();
    const date = r.createdAt?.toDate ? r.createdAt.toDate().toLocaleString('ko-KR') : '';
    return `
      <tr class="hover:bg-slate-50">
        <td class="p-3 text-[11px] text-gray-400">${date}</td>
        <td class="p-3 font-bold">${r.name}</td>
        <td class="p-3">${r.ssn}</td>
        <td class="p-3">${r.insurer}</td>
        <td class="p-3 max-w-xs truncate">${r.notes}</td>
        <td class="p-3"><img src="${r.canvasImg}" class="h-8 border rounded bg-white" alt="서명"></td>
      </tr>`;
  }).join('');
}

/* ---------------------------------------------------------
   팀 전체 현황 (팀장만 접근 - 화면 노출 + Firestore Rules 이중 방어)
--------------------------------------------------------- */
async function renderTeamOverview() {
  const wrap = document.getElementById('teamOverviewBody');
  if (currentStaff.role !== 'lead') {
    wrap.innerHTML = `<p class="text-sm text-gray-500 p-6 text-center">팀장 권한이 필요한 화면입니다.</p>`;
    return;
  }
  wrap.innerHTML = `<p class="text-sm text-gray-400 p-6 text-center">불러오는 중...</p>`;

  const q = query(
    collection(db, 'records'),
    where('teamId', '==', currentStaff.teamId),
    orderBy('createdAt', 'desc')
  );
  const snap = await getDocs(q);

  if (snap.empty) {
    wrap.innerHTML = `<p class="text-sm text-gray-400 p-6 text-center">우리 팀에 저장된 접수 내역이 없습니다.</p>`;
    return;
  }

  // 담당자별 집계
  const byStaff = {};
  snap.docs.forEach(d => {
    const r = d.data();
    byStaff[r.staffName] = (byStaff[r.staffName] || 0) + 1;
  });

  const summaryHtml = Object.entries(byStaff).map(([name, count]) => `
    <div class="bg-indigo-50 border border-indigo-100 rounded-xl px-4 py-3 text-center">
      <div class="text-xs font-bold text-indigo-700">${name}</div>
      <div class="text-2xl font-extrabold text-indigo-900">${count}<span class="text-xs font-normal ml-1">건</span></div>
    </div>`).join('');

  const rowsHtml = snap.docs.map(d => {
    const r = d.data();
    const date = r.createdAt?.toDate ? r.createdAt.toDate().toLocaleString('ko-KR') : '';
    return `
      <tr class="hover:bg-slate-50">
        <td class="p-3 text-[11px] text-gray-400">${date}</td>
        <td class="p-3 font-bold text-indigo-700">${r.staffName}</td>
        <td class="p-3 font-bold">${r.name}</td>
        <td class="p-3">${r.insurer}</td>
        <td class="p-3 max-w-xs truncate">${r.notes}</td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">${summaryHtml}</div>
    <div class="overflow-x-auto">
      <table class="w-full text-left text-xs border-collapse">
        <thead>
          <tr class="bg-slate-100 text-gray-700 font-bold border-b">
            <th class="p-3">일시</th><th class="p-3">담당자</th><th class="p-3">환자명</th><th class="p-3">보험사</th><th class="p-3">특이사항</th>
          </tr>
        </thead>
        <tbody class="divide-y text-gray-600">${rowsHtml}</tbody>
      </table>
    </div>`;
}

/* ---------------------------------------------------------
   재방문 검색 (Firestore 기반, 본인 기록 중 검색)
--------------------------------------------------------- */
window.searchPatient = async function searchPatient() {
  const qText = document.getElementById('revisitSearch').value.trim();
  const res = document.getElementById('searchResult');
  if (!qText) {
    alert('검색어를 입력하세요.');
    return;
  }
  res.innerHTML = `<p class="text-sm text-gray-400">검색 중...</p>`;

  const q = query(collection(db, 'records'), where('staffId', '==', currentUser.uid));
  const snap = await getDocs(q);
  const matched = snap.docs.map(d => d.data()).filter(r => r.name.includes(qText) || (r.phone || '').includes(qText));

  if (matched.length === 0) {
    res.innerHTML = `<p class="text-sm text-gray-400 text-center py-4">일치하는 내 접수 기록이 없습니다.</p>`;
    return;
  }

  res.innerHTML = matched.map(r => `
    <div class="bg-white border rounded-xl p-4 text-left flex justify-between items-center shadow-sm mb-2">
      <div>
        <span class="bg-emerald-100 text-emerald-800 font-bold text-xs px-2 py-0.5 rounded">기존 환자</span>
        <h4 class="font-bold text-base text-gray-900 mt-1">${r.name} 환자님</h4>
        <p class="text-xs text-gray-500">보험사: ${r.insurer || '-'} | 담당: ${r.staffName}</p>
      </div>
      <button onclick="switchTab('insurance-form')" class="px-4 py-2 bg-indigo-600 text-white font-bold text-xs rounded-lg hover:bg-indigo-700">
        조회/청구 서류 작성하기
      </button>
    </div>`).join('');
};

/* ---------------------------------------------------------
   Claude 프롬프트 탭 - 복사 버튼
--------------------------------------------------------- */
window.copyPromptText = function copyPromptText() {
  const text = document.getElementById('promptText').innerText;
  navigator.clipboard.writeText(text).then(() => {
    alert('클립보드에 복사되었습니다.');
  });
};
