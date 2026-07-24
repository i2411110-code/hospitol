# 병원 내보험 조회/청구 접수 시스템 — 설정 가이드

로그인(팀원별) + 팀 단위 현황 조회 + Naver Clova OCR 손글씨 인식이 포함된 버전입니다.
저장은 아직 담당자 계정별 `localStorage`가 아니라 Firestore(서버 DB)로 이동되어 있습니다
(로그인/팀 조회 기능 자체가 브라우저 로컬 저장으로는 불가능하기 때문입니다).

## 전체 구조

```
GitHub 저장소(gaon-portal) ─── Vercel(자동 배포) ─┬── 정적 파일 (로그인 화면, 접수 화면 등)
                                                 ├── api/ocr.js         (Naver Clova OCR 프록시)
                                                 └── api/kakao-auth.js (카카오 로그인 → Firebase Custom Token 발급)

GitHub 저장소(toinsu)      ─── Vercel(자동 배포) ─┬── 정적/Next.js 파일
                                                 └── api/kakao-auth.js (동일 코드 재사용)

                     ↓ 둘 다 같은 Firebase 프로젝트를 바라봄 ↓

Firebase 프로젝트(1개) ─── Authentication (이메일/비밀번호 + 카카오 Custom Token)
                      └── Firestore (staff, teams, records 컬렉션)
```

- **GitHub 저장소는 gaon-portal용 / toinsu용 2개를 그대로 유지**합니다 (서로 다른 서비스이므로 코드까지 합칠 필요는 없음).
- 대신 **Firebase 프로젝트는 1개만 만들어서 양쪽 `firebaseConfig`에 동일하게 넣습니다.** 그래야 같은 이메일/카카오 계정으로 두 사이트에 로그인할 수 있습니다.
- **Vercel 프로젝트도 저장소당 1개씩(총 2개)**이며, 각 저장소가 GitHub에 push될 때마다 독립적으로 자동 배포됩니다.

- **Vercel**: 정적 페이지 호스팅 + 민감한 키(Clova, Firebase 서비스 계정)를 감춰주는 서버리스 함수
- **Firebase**: 로그인(이메일+카카오), 그리고 담당자별/팀별 접수 데이터 저장

---

## 1. Firebase 설정 (gaon-portal, toinsu 공용 — 딱 1번만 하면 됨)

1. https://console.firebase.google.com 에서 새 프로젝트 생성 (예: `toinsu-auth`)
2. **Authentication** 메뉴 → 시작하기 →
   - "이메일/비밀번호" 로그인 방식 사용 설정
   - 카카오는 Firebase가 기본 제공하는 로그인 방식 목록에 없으므로 여기서 별도로 켤 항목은 없습니다.
     (대신 "Sign-in method" 탭에서 딱히 추가 설정 없이도, 서버가 발급한 Custom Token으로 로그인하는 방식이라
     이 화면에서는 이메일/비밀번호만 켜두면 충분합니다.)
3. **Firestore Database** 메뉴 → 데이터베이스 만들기 (프로덕션 모드)
4. 프로젝트 설정(⚙️) → "내 앱" → 웹 앱 추가 → 표시되는 `firebaseConfig` 값을
   `firebase-config.js` 파일에 그대로 붙여넣기 (이 값은 공개되어도 안전합니다) —
   **gaon-portal, toinsu 양쪽 저장소 모두 이 값을 동일하게 넣습니다.**
5. Firestore 규칙 배포: Firebase 콘솔의 Firestore → 규칙 탭에 이 저장소의
   `firestore.rules` 내용을 그대로 붙여넣고 게시 (또는 Firebase CLI로
   `firebase deploy --only firestore:rules`)
6. **서비스 계정 키 발급** (카카오 로그인 서버 함수가 Firebase Admin SDK를 쓰기 위해 필요):
   - 프로젝트 설정(⚙️) → **서비스 계정** 탭 → "새 비공개 키 생성" 클릭 → JSON 파일 다운로드
   - 이 JSON 파일 내용을 통째로 한 줄 문자열로 복사해서, Vercel 환경변수 `FIREBASE_SERVICE_ACCOUNT_KEY`에 붙여넣을 예정 (3단계에서 사용)
   - ⚠️ 이 파일은 절대 GitHub에 올리지 마세요. `.gitignore`에 추가해두는 것을 권장합니다.

### 팀장 권한 부여 방법
- 담당자가 앱에서 회원가입 → 이름/팀 코드 입력을 마치면 Firestore에
  `staff/{그 사람의 uid}` 문서가 자동 생성되고 `role: "staff"`로 시작합니다.
- 관리자가 Firestore 콘솔에서 해당 문서를 열어 `role` 값을 `"lead"`로
  직접 수정해주면, 그 사람은 로그인 시 "팀 전체 현황" 탭이 나타나고
  같은 `teamId`를 가진 팀원들의 접수 내역을 모두 볼 수 있게 됩니다.
- (셀프 승격을 막기 위해 일부러 앱 화면에는 팀장 지정 기능을 넣지 않았습니다.)
- 카카오로 로그인한 사람도 uid가 `kakao_숫자` 형태일 뿐, 이후 로직은 이메일 가입자와 완전히 동일하게 동작합니다.

---

## 1-1. 카카오 개발자 콘솔 설정

1. https://developers.kakao.com → 내 애플리케이션 → 애플리케이션 추가하기
2. 앱 이름 입력 후 생성 → **앱 키** 탭에서 다음 두 값을 메모:
   - **앱 ID** (숫자) → Vercel 환경변수 `KAKAO_APP_ID`로 사용
   - **JavaScript 키** → `app.js`의 `KAKAO_JS_KEY` 상수에 붙여넣기
3. **플랫폼** 탭 → "Web 플랫폼 등록" → 실제 서비스 도메인 등록
   - gaon-portal용, toinsu용 배포 도메인을 각각 등록해야 함
   - 로컬 테스트 시 `http://localhost:포트`도 등록 필요
4. **카카오 로그인** 탭 → 활성화 설정 ON
5. **동의항목** 탭 → `profile_nickname`, `account_email` 항목을 "필수 동의" 또는 "선택 동의"로 설정
   (이메일을 못 받을 수도 있는 계정이 있어 "선택 동의"를 권장하며, 이 경우 `email`이 없을 수 있음을
   감안해 `api/kakao-auth.js`는 이메일이 없어도 동작하도록 이미 처리되어 있습니다)

---

## 2. Naver Clova OCR 설정 (gaon-portal만 해당)

1. https://console.ncloud.com 가입 → **AI·Application Service → CLOVA OCR** 이동
2. 도메인 생성 → "General" 템플릿 선택
3. 발급되는 **Invoke URL** 과 **Secret Key** 를 메모해두기 (아래 3단계에서 사용)

---

## 3. GitHub + Vercel 배포

### 3-1. gaon-portal 저장소

1. 이 프로젝트 폴더를 그대로 GitHub 저장소로 push
   ```bash
   git init
   git add .
   git commit -m "init"
   git remote add origin <gaon-portal 저장소 URL>
   git push -u origin main
   ```
2. https://vercel.com → New Project → 방금 만든 GitHub 저장소 Import
   - Framework Preset: **Other**
3. **Environment Variables**에 아래 등록 후 Deploy
   ```
   CLOVA_OCR_INVOKE_URL       = (2단계에서 발급받은 Invoke URL)
   CLOVA_OCR_SECRET_KEY       = (2단계에서 발급받은 Secret Key)
   FIREBASE_SERVICE_ACCOUNT_KEY = (1-6단계에서 받은 서비스 계정 JSON, 한 줄 문자열)
   KAKAO_APP_ID               = (1-1단계에서 받은 카카오 앱 ID)
   ```
4. 배포 완료 후 나오는 `https://프로젝트명.vercel.app` 주소로 접속 → 로그인 화면이 뜨면 정상입니다.
5. 이 배포 도메인을 카카오 개발자 콘솔의 "Web 플랫폼"에 등록하는 것을 잊지 마세요 (1-1단계 3번).

### 3-2. toinsu 저장소

- toinsu는 별도 GitHub 저장소/Vercel 프로젝트를 그대로 유지합니다.
- `firebase-config.js`에 **gaon-portal과 완전히 동일한 `firebaseConfig` 값**을 넣습니다.
- `api/kakao-auth.js`를 toinsu 저장소에도 그대로 복사하고, toinsu의 Vercel 프로젝트에도
  `FIREBASE_SERVICE_ACCOUNT_KEY`, `KAKAO_APP_ID` 환경변수를 동일하게 등록합니다.
- toinsu 배포 도메인도 카카오 "Web 플랫폼"에 추가로 등록합니다.
- 이렇게 하면 한쪽에서 만든 계정(이메일이든 카카오든)이 다른 쪽에서도 그대로 로그인됩니다.

이후 각 저장소의 `main` 브랜치에 push할 때마다 해당 Vercel 프로젝트가 자동으로 재배포합니다.

---

## 4. 남아있는 보안 숙제 (참고)

- 지금 구조에서 실사용 전 반드시 점검할 것:
  - 주민등록번호·서명 이미지가 Firestore에 저장됩니다. Firestore는 저장 시 자동 암호화되지만,
    접근 권한은 전적으로 `firestore.rules`에 달려 있으니 배포 전 규칙이 실제로 의도대로
    동작하는지 Firebase 콘솔의 "Rules Playground"로 꼭 테스트해보세요.
  - Clova OCR Playground/테스트 단계에서는 실제 환자 정보 대신 가짜 데이터로만 테스트하세요.
  - 이 버전은 회원가입이 완전 자유(누구나 이메일만 있으면 가입) 상태입니다. 병원 내부 인원만
    가입할 수 있도록 하려면 Firebase Auth의 이메일 도메인 제한 또는 관리자 초대制 로
    바꾸는 것을 권장합니다.
