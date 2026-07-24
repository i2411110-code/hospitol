// /api/ocr
// 브라우저는 이 엔드포인트만 호출합니다. Naver Clova OCR의 Secret Key는
// 이 서버 코드 안(Vercel 환경변수)에만 존재하고 클라이언트로는 절대 내려가지 않습니다.
//
// 필요한 Vercel 환경변수 (Project Settings > Environment Variables):
//   CLOVA_OCR_INVOKE_URL  - Clova Console에서 발급받은 Invoke URL
//   CLOVA_OCR_SECRET_KEY  - Clova Console에서 발급받은 Secret Key

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST 요청만 허용됩니다.' });
  }

  const invokeUrl = process.env.CLOVA_OCR_INVOKE_URL;
  const secretKey = process.env.CLOVA_OCR_SECRET_KEY;

  if (!invokeUrl || !secretKey) {
    return res.status(500).json({
      error: '서버에 CLOVA_OCR_INVOKE_URL / CLOVA_OCR_SECRET_KEY 환경변수가 설정되지 않았습니다.'
    });
  }

  const { imageBase64 } = req.body || {};
  if (!imageBase64) {
    return res.status(400).json({ error: 'imageBase64 값이 필요합니다.' });
  }

  // "data:image/png;base64,...." 형태에서 순수 base64만 추출
  const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;

  const requestBody = {
    version: 'V2',
    requestId: `req-${Date.now()}`,
    timestamp: Date.now(),
    images: [
      {
        format: 'png',
        name: 'handwriting',
        data: base64Data
      }
    ]
  };

  try {
    const clovaRes = await fetch(invokeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OCR-SECRET': secretKey
      },
      body: JSON.stringify(requestBody)
    });

    if (!clovaRes.ok) {
      const errText = await clovaRes.text();
      return res.status(clovaRes.status).json({ error: 'Clova OCR 호출 실패', detail: errText });
    }

    const data = await clovaRes.json();

    // 이미지 하나에서 인식된 모든 필드의 inferText를 순서대로 이어붙임
    const fields = data?.images?.[0]?.fields || [];
    const text = fields.map(f => f.inferText).join(' ');

    return res.status(200).json({ text, raw: data });
  } catch (err) {
    return res.status(500).json({ error: 'OCR 처리 중 오류가 발생했습니다.', detail: String(err) });
  }
}
