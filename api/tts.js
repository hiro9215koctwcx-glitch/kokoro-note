/**
 * OpenAI TTS プロキシ（APIキーをクライアントに出さない）
 * POST { "text": string } → audio/mpeg
 */

const MODEL = "tts-1";
const VOICE = "shimmer";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "この操作は許可されていません。" }));
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({ error: "サーバー設定エラー: OpenAI APIキーが未設定です。" })
    );
  }

  let body;
  try {
    body =
      typeof req.body === "object" && req.body !== null
        ? req.body
        : JSON.parse(
            typeof req.body === "string" ? req.body : "{}"
          );
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "リクエストの形式が正しくありません。" }));
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "text が必要です。" }));
  }

  const input = text.slice(0, 4096);

  try {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        voice: VOICE,
        input,
      }),
    });

    if (!response.ok) {
      let errMsg = `OpenAI API エラー (${response.status})`;
      try {
        const j = await response.json();
        if (j?.error?.message) errMsg = j.error.message;
      } catch {
        /* ignore */
      }
      console.error("[api/tts] OpenAI失敗:", errMsg);
      res.statusCode = response.status >= 500 ? 502 : response.status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: errMsg }));
    }

    const buf = Buffer.from(await response.arrayBuffer());
    res.statusCode = 200;
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "no-store");
    return res.end(buf);
  } catch (err) {
    console.error("[api/tts] 音声取得エラー:", err);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({
        error: "音声の取得に失敗しました。しばらくしてからお試しください。",
      })
    );
  }
}

export default handler;

if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}
