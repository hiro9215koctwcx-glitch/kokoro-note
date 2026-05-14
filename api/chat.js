/**
 * Claude API + Supabase（認証・記憶・日次ラリー）
 */

import {
  createUserSupabase,
  fetchPastDaysForSummary,
  insertConversationRows,
  getDailyRemaining,
  incrementDailyRally,
  RALLY_DAILY_LIMIT,
} from "./memory.js";

const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1000;

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

function extractTextFromAnthropic(data) {
  const blocks = data?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

async function callClaude(apiKey, system, messages, maxTokens = MAX_TOKENS) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { response, data };
}

async function summarizeTranscript(apiKey, transcript) {
  if (!transcript || !String(transcript).trim()) return "";
  try {
    const { response, data } = await callClaude(
      apiKey,
      `あなたは要約アシスタントです。
与えられたログを180字以内で日本語にまとめてください。
ユーザーの出来事・気持ち・AIが触れた要点だけ。装飾や「要約:」などの前置きは付けないでください。`,
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `過去のチャットログです（今日より前の記録）:\n\n${transcript}`,
            },
          ],
        },
      ],
      400
    );

    if (!response.ok) {
      console.error(
        "[chat] summarize Claude error:",
        data?.error?.message || response.status
      );
      return "";
    }

    return extractTextFromAnthropic(data).trim();
  } catch (err) {
    console.error("[chat] summarizeTranscript:", err);
    return "";
  }
}

function buildBaseSystemPrompt(memoryBlock) {
  const today = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "long",
  }).format(new Date());

  let base = `あなたは「こころノート」のAIパートナーです。
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

  if (memoryBlock) {
    base += `

【過去の会話の記憶（昨日以前・要約）】
${memoryBlock}

・上記の記憶にある内容が自然に触れられるときは、最初の挨拶やリード文で「○○のこと、少し気になっていました」や「前に△△のお話がありましたね」のように、短くそっと触れてから今日の振り返りに進んでください。
・記憶が空、または触れづらければ無理に触れないでください。`;
  }

  return base;
}

async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    return json(res, 405, { error: "この操作は許可されていません。" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json(res, 500, {
      error: "サーバー設定エラー: ANTHROPIC_API_KEY が未設定です。",
    });
  }

  const accessToken = getBearer(req);
  if (!accessToken) {
    return json(res, 401, { error: "ログインが必要です。" });
  }

  let sb;
  let user;
  try {
    sb = createUserSupabase(accessToken);
    const {
      data: { user: u },
      error: authErr,
    } = await sb.auth.getUser();
    if (authErr || !u) {
      return json(res, 401, {
        error: authErr?.message || "セッションが無効です。",
      });
    }
    user = u;
  } catch (err) {
    console.error("[chat] auth:", err);
    return json(res, 500, {
      error:
        err.message?.includes("SUPABASE")
          ? "サーバー設定: Supabase環境変数を確認してください。"
          : "認証に失敗しました。",
    });
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
    return json(res, 400, { error: "リクエストの形式が正しくありません。" });
  }

  const isInit = Boolean(body.init);
  const anthropicMessages = toAnthropicMessages(body.messages);
  if (anthropicMessages.length === 0) {
    return json(res, 400, { error: "messages が必要です。" });
  }

  let summary = "";
  try {
    const raw = await fetchPastDaysForSummary(sb, user.id);
    if (raw) {
      summary = await summarizeTranscript(apiKey, raw);
    }
  } catch (err) {
    console.error("[chat] memory fetch/summarize:", err);
  }

  const system = buildBaseSystemPrompt(summary);

  let remainingBefore;
  let rallyLimit = RALLY_DAILY_LIMIT;
  let trialDaysRemaining = null;
  try {
    const r = await getDailyRemaining(sb, user.id);
    remainingBefore = r.remaining;
    if (typeof r.limit === "number") rallyLimit = r.limit;
    if (typeof r.trial_days_remaining === "number") {
      trialDaysRemaining = r.trial_days_remaining;
    }
    if (r.trial_expired) {
      return json(res, 403, {
        error:
          "トライアル期間が終了しました。有料プランをお選びください。",
        trial_expired: true,
        remaining: r.remaining ?? 0,
        limit: rallyLimit,
        trial_days_remaining: trialDaysRemaining,
      });
    }
  } catch (err) {
    console.error("[chat] getDailyRemaining:", err);
    remainingBefore = RALLY_DAILY_LIMIT;
  }

  if (!isInit && remainingBefore <= 0) {
    return json(res, 429, {
      error: "本日の上限回数に達しました。",
      remaining: 0,
      limit: rallyLimit,
      trial_days_remaining: trialDaysRemaining,
    });
  }

  try {
    const { response: claudeRes, data: claudeData } = await callClaude(
      apiKey,
      system,
      anthropicMessages
    );

    if (!claudeRes.ok) {
      const msg =
        claudeData?.error?.message ||
        `Claude API エラー (${claudeRes.status})`;
      return json(res, claudeRes.status >= 500 ? 502 : claudeRes.status, {
        error: msg,
      });
    }

    const message = extractTextFromAnthropic(claudeData);
    if (!message) {
      return json(res, 502, { error: "応答を取得できませんでした。" });
    }

    let saveOk = true;
    try {
      const lastUser = [...(body.messages || [])]
        .reverse()
        .find((m) => m && m.role === "user" && typeof m.content === "string");
      const toSave = [];
      if (lastUser?.content) {
        toSave.push({ role: "user", content: lastUser.content.trim() });
      }
      toSave.push({ role: "assistant", content: message });
      if (toSave.length > 0) {
        await insertConversationRows(sb, user.id, toSave);
      }
    } catch (err) {
      saveOk = false;
      console.error("[chat] save conversations:", err);
    }

    let remainingAfter = remainingBefore;
    let responseLimit = rallyLimit;
    if (!isInit) {
      try {
        const inc = await incrementDailyRally(sb, user.id, rallyLimit);
        remainingAfter = inc.remaining;
        if (typeof inc.limit === "number") responseLimit = inc.limit;
      } catch (err) {
        console.error("[chat] incrementDailyRally:", err);
      }
    }

    return json(res, 200, {
      message,
      remaining: remainingAfter,
      limit: responseLimit,
      trial_days_remaining: trialDaysRemaining,
      saveOk,
    });
  } catch (err) {
    console.error("[chat]", err);
    return json(res, 502, {
      error: "通信に失敗しました。しばらくしてからお試しください。",
    });
  }
}

export default handler;

if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}
