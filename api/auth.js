/**
 * メールログイン・登録・セション確認（Supabase Auth／サーバー側のみ）
 * POST JSON:
 *   { "action":"signUp"|"signIn", "email", "password" }
 * POST ?action=resetPassword JSON: { "email" }
 * GET: Authorization: Bearer <access_token> → ユーザー確認 + remaining
 */

import { createClient } from "@supabase/supabase-js";
import {
  createUserSupabase,
  getDailyRemaining,
  RALLY_DAILY_LIMIT,
} from "./memory.js";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
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

function getQueryParam(req, key) {
  try {
    const raw = typeof req.url === "string" ? req.url : "";
    const qi = raw.indexOf("?");
    const queryString = qi === -1 ? "" : raw.slice(qi + 1);
    return new URLSearchParams(queryString).get(key);
  } catch {
    return null;
  }
}

async function handler(req, res) {
  setCors(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    res.statusCode = 500;
    return res.end(
      JSON.stringify({ error: "サーバー設定: Supabase環境変数が未設定です。" })
    );
  }

  const adminSb = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (req.method === "GET") {
    const token = getBearer(req);
    if (!token) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "認証が必要です。" }));
    }

    try {
      const sbUser = createUserSupabase(token);
      const {
        data: { user },
        error: ue,
      } = await sbUser.auth.getUser();
      if (ue || !user) {
        res.statusCode = 401;
        return res.end(
          JSON.stringify({ error: ue?.message || "セッションが無効です。" })
        );
      }

      let remaining = RALLY_DAILY_LIMIT;
      try {
        const r = await getDailyRemaining(sbUser, user.id);
        remaining = r.remaining;
      } catch (err) {
        console.error("[auth GET] remaining:", err);
      }

      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          user: { id: user.id, email: user.email },
          remaining,
          limit: RALLY_DAILY_LIMIT,
        })
      );
    } catch (err) {
      console.error("[auth GET]", err);
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: "確認に失敗しました。" }));
    }
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  let body = {};
  try {
    if (typeof req.body === "string") body = JSON.parse(req.body || "{}");
    else if (req.body && typeof req.body === "object") body = req.body;
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "JSONの形式が正しくありません。" }));
  }

  const RESET_REDIRECT_TO = "https://kokoro-note-umber.vercel.app";
  const queryAction = getQueryParam(req, "action");

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password =
    typeof body.password === "string" ? body.password : "";

  const isResetPassword =
    body.action === "resetPassword" ||
    queryAction === "resetPassword";

  if (isResetPassword) {
    if (!email) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({
          error:
            'パスワードリセットには query「action=resetPassword」と JSON ボディの「email」が必要です。',
        })
      );
    }
    try {
      const { error } = await adminSb.auth.resetPasswordForEmail(email, {
        redirectTo: RESET_REDIRECT_TO,
      });
      if (error) {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error: error.message || String(error),
            code: error.code ?? undefined,
            status: typeof error.status === "number" ? error.status : undefined,
          })
        );
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.error("[auth resetPassword]", err);
      const message =
        err instanceof Error ? err.message : String(err ?? "unknown error");
      res.statusCode = 500;
      return res.end(
        JSON.stringify({
          error:
            message ||
            "パスワードリセットメールの送信処理中にサーバー側でエラーが発生しました。",
        })
      );
    }
  }

  const action =
    body.action === "signUp"
      ? "signUp"
      : body.action === "signIn"
      ? "signIn"
      : null;

  if (!action || !email || !password) {
    res.statusCode = 400;
    return res.end(
      JSON.stringify({
        error:
          "action(signUp/signIn)、email、password が必要です。パスワードリセットは POST /api/auth?action=resetPassword と email のみです。",
      })
    );
  }

  try {
    if (action === "signUp") {
      const {
        data: { session, user },
        error,
      } = await adminSb.auth.signUp({ email, password });
      if (error) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: error.message }));
      }
      if (!session || !session.access_token) {
        res.statusCode = 200;
        return res.end(
          JSON.stringify({
            needEmailConfirm: true,
            user: user ? { id: user.id, email: user.email } : null,
            message:
              "確認メールを送信しました。メール内のリンクを開いてからログインしてください。",
          })
        );
      }

      const sbUser = createUserSupabase(session.access_token);
      let remaining = RALLY_DAILY_LIMIT;
      try {
        const r = await getDailyRemaining(sbUser, user.id);
        remaining = r.remaining;
      } catch (e) {
        console.error("[auth signUp] remaining:", e);
      }

      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          user: { id: user.id, email: user.email },
          remaining,
          limit: RALLY_DAILY_LIMIT,
        })
      );
    }

    const {
      data: { session, user },
      error,
    } = await adminSb.auth.signInWithPassword({ email, password });
    if (error || !session) {
      res.statusCode = 401;
      return res.end(
        JSON.stringify({
          error: error?.message || "ログインに失敗しました。",
        })
      );
    }

    const sbUser = createUserSupabase(session.access_token);
    let remaining = RALLY_DAILY_LIMIT;
    try {
      const r = await getDailyRemaining(sbUser, user.id);
      remaining = r.remaining;
    } catch (e) {
      console.error("[auth signIn] remaining:", e);
    }

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user: { id: user.id, email: user.email },
        remaining,
        limit: RALLY_DAILY_LIMIT,
      })
    );
  } catch (err) {
    console.error("[auth POST]", err);
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "認証処理に失敗しました。" }));
  }
}

export default handler;

if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}
