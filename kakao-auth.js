// /api/kakao-auth
// 브라우저는 카카오 JS SDK로 로그인해서 얻은 access token을 이 엔드포인트로 보냅니다.
// 이 함수는 (1) 카카오 서버에 그 토큰이 진짜 유효한지 확인하고,
// (2) Firebase Admin SDK로 그 카카오 사용자에 대응하는 Firebase Custom Token을 발급합니다.
// 프론트엔드는 이 custom token으로 signInWithCustomToken(auth, token)을 호출해 로그인을 완료합니다.
//
// 필요한 Vercel 환경변수 (Project Settings > Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT_KEY - Firebase 콘솔 > 프로젝트 설정 > 서비스 계정 > "새 비공개 키 생성"으로
//                                  받은 JSON 파일의 내용을 "한 줄 문자열"로 그대로 붙여넣기
//   KAKAO_APP_ID                 - 카카오 개발자 콘솔 > 내 애플리케이션 > 앱 키 > "앱 ID" (REST API 키 아님, 숫자 ID)
//                                  이 토큰이 우리 앱에서 발급된 게 맞는지 검증하는 용도

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

  const { accessToken } = req.body || {};
  if (!accessToken) {
    return res.status(400).json({ error: 'accessToken 값이 필요합니다.' });
  }

  const kakaoAppId = process.env.KAKAO_APP_ID;

  try {
    // 1) 카카오 서버에 access token 검증 요청 (우리 앱이 발급한 토큰이 맞는지 app_id 대조)
    const tokenInfoRes = await fetch('https://kapi.kakao.com/v1/user/access_token_info', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!tokenInfoRes.ok) {
      const errText = await tokenInfoRes.text();
      return res.status(401).json({ error: '카카오 토큰 검증 실패', detail: errText });
    }
    const tokenInfo = await tokenInfoRes.json();

    if (kakaoAppId && String(tokenInfo.app_id) !== String(kakaoAppId)) {
      return res.status(401).json({ error: '이 토큰은 우리 앱에서 발급된 것이 아닙니다.' });
    }

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
    const auth = adminApp.auth();

    // 3) 해당 uid의 Firebase Auth 사용자가 없으면 생성, 있으면 프로필만 최신화
    try {
      await auth.getUser(uid);
      await auth.updateUser(uid, {
        ...(email ? { email } : {}),
        ...(displayName ? { displayName } : {})
      });
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        await auth.createUser({
          uid,
          ...(email ? { email } : {}),
          ...(displayName ? { displayName } : {})
        });
      } else {
        throw err;
      }
    }

    // 4) Firebase Custom Token 발급
    const customToken = await auth.createCustomToken(uid, { provider: 'kakao' });

    return res.status(200).json({ token: customToken, uid, email, displayName });
  } catch (err) {
    return res.status(500).json({ error: '카카오 로그인 처리 중 오류가 발생했습니다.', detail: String(err) });
  }
}
