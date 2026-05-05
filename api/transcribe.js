/**
 * OpenAI Whisper 文字起こし（APIキーをクライアントに出さない）
 * POST JSON: { audio_base64: string, mime?: string }
 * → { text: string }
 */

import { createUserSupabase } from "./memory.js";

const MODEL = "whisper-1";
const MAX_DECODE_BYTES = 900_000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );
}

function getBearer(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = String(h).match(/^Bearer\s+(\S+)/i);
  return m ? m[1].trim() : "";
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.end(JSON.stringify(obj));
}

function extensionForMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("webm")) return "audio.webm";
  if (m.includes("mpeg") || m === "audio/mp3") return "audio.mp3";
  if (m.includes("wav")) return "audio.wav";
  if (m.includes("m4a") || m.includes("mp4")) return "audio.m4a";
  return "recording.bin";
}

async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return json(res, 405, { error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(res, 500, {
      error: "サーバー設定エラー: OpenAI APIキーが未設定です。",
    });
  }

  const token = getBearer(req);
  if (!token) {
    return json(res, 401, { error: "ログインが必要です。" });
  }

  try {
    const sb = createUserSupabase(token);
    const {
      data: { user },
      error: ue,
    } = await sb.auth.getUser();
    if (ue || !user) {
      return json(res, 401, {
        error: ue?.message || "セッションが無効です。",
      });
    }
  } catch (err) {
    console.error("[transcribe] auth:", err);
    return json(res, 500, { error: "認証に失敗しました。" });
  }

  let body;
  try {
    body =
      typeof req.body === "object" && req.body !== null
        ? req.body
        : JSON.parse(typeof req.body === "string" ? req.body || "{}" : "{}");
  } catch {
    return json(res, 400, { error: "リクエストの形式が正しくありません。" });
  }

  const audioBase64 =
    typeof body.audio_base64 === "string" ? body.audio_base64.trim() : "";
  if (!audioBase64) {
    return json(res, 400, { error: "audio_base64 が必要です。" });
  }

  let buffer;
  try {
    buffer = Buffer.from(audioBase64, "base64");
  } catch {
    return json(res, 400, { error: "音声データが不正です。" });
  }

  if (buffer.length < 32) {
    return json(res, 400, { error: "音声データが短すぎます。" });
  }

  if (buffer.length > MAX_DECODE_BYTES) {
    return json(res, 413, {
      error: `音声サイズ上限（約${Math.floor(MAX_DECODE_BYTES / 1024)}KB）を超えています。`,
    });
  }

  const mime =
    typeof body.mime === "string" && body.mime.trim().length > 0
      ? body.mime.trim()
      : "application/octet-stream";
  const filename = extensionForMime(mime);
  const blob = new Blob([buffer], {
    type: mime.split(";")[0].trim(),
  });

  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("model", MODEL);
  formData.append("language", "ja");

  try {
    const whisperRes = await fetch(
      "https://api.openai.com/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: formData,
      }
    );

    const txt = await whisperRes.text();
    let data = {};
    try {
      data = txt ? JSON.parse(txt) : {};
    } catch {
      data = { raw: txt };
    }

    if (!whisperRes.ok) {
      const msg =
        data?.error?.message ||
        (typeof txt === "string" && txt.slice(0, 200)) ||
        `Whisper API エラー (${whisperRes.status})`;
      console.error("[transcribe] Whisper:", whisperRes.status, msg);
      return json(res, whisperRes.status >= 500 ? 502 : whisperRes.status, {
        error: msg,
      });
    }

    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (!text) {
      return json(res, 502, { error: "文字起こし結果が空です。" });
    }

    return json(res, 200, { text });
  } catch (err) {
    console.error("[transcribe]", err);
    return json(res, 502, {
      error: "文字起こしに失敗しました。しばらくしてからお試しください。",
    });
  }
}

export default handler;

if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}
