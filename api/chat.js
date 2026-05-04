/**
 * Claude API プロキシ（サーバーサイド）
 * Vercel Serverless / 互換ハンドラ
 */

const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1000;

function buildSystemPrompt() {
  const today = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "long",
  }).format(new Date());

  return `あなたは「こころノート」のAIパートナーです。
今日の日付は${today}です。
ユーザーの気持ちを整理するために、以下の流れで会話をリードしてください。

1. 今日はどんな1日でしたか？
2. 印象に残った出来事は？
3. どんな気持ちでしたか？
4. なぜその気持ちになりましたか？
5. 本当はどうしたかったですか？
6. 今日の気づきは？
7. 明日の小さな一歩は？

・一度に1つだけ質問する
・共感的でやさしい言葉を使う
・押しつけがましくしない
・5分で終わるように会話をコンパクトにまとめる
・日本語で返答する`;
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function toAnthropicMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string"
    )
    .map((m) => ({
      role: m.role,
      content: [{ type: "text", text: m.content }],
    }));
}

async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({ error: "サーバー設定エラー: APIキーが未設定です。" })
    );
  }

  let body;
  try {
    if (typeof req.body === "string") {
      body = JSON.parse(req.body || "{}");
    } else if (req.body && typeof req.body === "object") {
      body = req.body;
    } else {
      body = {};
    }
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "リクエストの形式が正しくありません。" }));
  }

  const anthropicMessages = toAnthropicMessages(body.messages);
  if (anthropicMessages.length === 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ error: "messages が必要です。" }));
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": ANTHROPIC_VERSION,
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: buildSystemPrompt(),
        messages: anthropicMessages,
      }),
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    if (!response.ok) {
      const msg =
        data?.error?.message ||
        `Claude API エラー (${response.status})`;
      res.statusCode = response.status >= 500 ? 502 : response.status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({ error: msg }));
    }

    const blocks = data?.content;
    let message = "";
    if (Array.isArray(blocks)) {
      message = blocks
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
    }

    if (!message) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.end(
        JSON.stringify({ error: "応答を取得できませんでした。" })
      );
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ message }));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({
        error: "通信に失敗しました。しばらくしてからお試しください。",
      })
    );
  }
}

export default handler;

// CommonJS（Node 直接実行・一部ホスティング向け）
if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}
