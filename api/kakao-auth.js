// /api/kakao-auth  (Redirect 방식 — 2026-07-24 카카오 팝업 로그인 지원 종료에 따라 전환)
// 브라우저는 Kakao.Auth.authorize({ redirectUri })로 카카오 로그인 화면에 이동했다가,
// 로그인 후 ?code=... 를 붙여 redirectUri로 돌아옵니다.
// 이 함수는 (1) 그 인가 코드(code)를 카카오 토큰 서버와 교환해 access token을 받고,
// (2) 그 토큰으로 카카오 사용자 정보를 조회한 뒤,
// (3) Firebase Admin SDK로 그 사용자에 대응하는 Firebase Custom Token을 발급합니다.
// 프론트엔드는 이 custom token으로 signInWithCustomToken(auth, token)을 호출해 로그인을 완료합니다.
//
// 필요한 Vercel 환경변수 (Project Settings > Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT_KEY - Firebase 콘솔 > 프로젝트 설정 > 서비스 계정 > "새 비공개 키 생성"으로
//                                  받은 JSON 파일의 내용을 "한 줄 문자열"로 그대로 붙여넣기
//   KAKAO_REST_API_KEY           - 카카오 개발자 콘솔 > 내 애플리케이션 > 앱 키 > "REST API 키"
//                                  (⚠️ JavaScript 키가 아닙니다! 토큰 교환에는 REST API 키를 씁니다.)
//   KAKAO_CLIENT_SECRET          - (선택) 카카오 콘솔 > 보안 > Client Secret을 "사용함"으로 켠 경우에만 필요.
//                                  꺼져 있으면 이 환경변수는 등록하지 않아도 됩니다.

import admin from 'firebase-admin';

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY 환경변수가 설정되지 않았습니다.');
  }
  const serviceAccount = JSON.parse(raw);

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
  }

  const { code, redirectUri } = req.body || {};
  if (!code || !redirectUri) {
    return res.status(400).json({ error: 'code, redirectUri 값이 필요합니다.' });
  }

  const restApiKey = process.env.KAKAO_REST_API_KEY;
  if (!restApiKey) {
    return res.status(500).json({ error: 'KAKAO_REST_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  try {
    // 1) 인가 코드(code)를 access token으로 교환
    const tokenParams = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: restApiKey,
      redirect_uri: redirectUri,
      code
    });
    if (process.env.KAKAO_CLIENT_SECRET) {
      tokenParams.set('client_secret', process.env.KAKAO_CLIENT_SECRET);
    }

    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      return res.status(401).json({ error: '카카오 토큰 교환 실패', detail: tokenData });
    }
    const accessToken = tokenData.access_token;

    // 2) 카카오 사용자 프로필 조회
    const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!meRes.ok) {
      const errText = await meRes.text();
      return res.status(401).json({ error: '카카오 사용자 정보 조회 실패', detail: errText });
    }
    const kakaoUser = await meRes.json();

    const kakaoId = kakaoUser.id;
    if (!kakaoId) {
      return res.status(400).json({ error: '카카오 사용자 id를 확인할 수 없습니다.' });
    }

    const kakaoAccount = kakaoUser.kakao_account || {};
    const profile = kakaoAccount.profile || {};
    const email = kakaoAccount.email || null;
    const displayName = profile.nickname || null;

    // Firebase uid는 카카오 id와 1:1로 고정 매핑 (다른 로그인 수단과 겹치지 않도록 접두어 부여)
    const uid = `kakao_${kakaoId}`;

    const adminApp = getAdminApp();
    const authAdmin = adminApp.auth();

    // 3) 해당 uid의 Firebase Auth 사용자가 없으면 생성, 있으면 프로필만 최신화
    try {
      await authAdmin.getUser(uid);
      await authAdmin.updateUser(uid, {
        ...(email ? { email } : {}),
        ...(displayName ? { displayName } : {})
      });
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        await authAdmin.createUser({
          uid,
          ...(email ? { email } : {}),
          ...(displayName ? { displayName } : {})
        });
      } else {
        throw err;
      }
    }

    // 4) Firebase Custom Token 발급
    const customToken = await authAdmin.createCustomToken(uid, { provider: 'kakao' });

    return res.status(200).json({ token: customToken, uid, email, displayName });
  } catch (err) {
    return res.status(500).json({ error: '카카오 로그인 처리 중 오류가 발생했습니다.', detail: String(err) });
  }
}