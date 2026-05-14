/**
 * メールログイン・登録・セション確認（Supabase Auth／サーバー側のみ）
 * POST JSON:
 *   { "action":"signUp"|"signIn", "email", "password" }
 *   { "action":"startTrial" } + Authorization: Bearer …
 *   { "action":"recordPlanChoice", "plan": "プラン名" } + Bearer（ユーザーメタデータに plan_selected / plan を保存）
 * - signUp: Supabase.auth.admin.generateLink(signup)+Resendで確認メール（RESEND_API_KEY・SUPABASE_SERVICE_ROLE_KEY が必要）。
 * POST ?action=resetPassword JSON: { "email" }
 *   … 復旧リンク内のパスワード変更はブラウザで Supabase に直接更新（サーバー側の update は行わない）。
 * GET ?bootstrap=1 → { supabase_url, supabase_anon_key }（ブラウザ用・認証不要）
 * GET: Authorization: Bearer <access_token> → ユーザー確認 + remaining + trial_expired + plan_selected / chosen_plan（user_metadata）
 */

import { createClient } from "@supabase/supabase-js";
import { sendSignupConfirmationEmail } from "./_lib/send-signup-verify-email.js";
import {
  createUserSupabase,
  getDailyRemaining,
  jstDateParts,
  RALLY_DAILY_LIMIT,
  trialStartDateToYmd,
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

/** Supabase auth.getUser の結果を安全に取り出す（data が null でも例外にしない） */
async function getSessionUser(sbUser) {
  const { data, error } = await sbUser.auth.getUser();
  return { user: data?.user ?? null, error };
}

/**
 * サービスロールで user_metadata をマージ（updateUser の「セッション必須」問題を回避）
 */
async function mergeUserMetadataAdmin(userId, patch) {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRole) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY が未設定のためユーザーメタデータを更新できません。"
    );
  }
  const adminAuth = createClient(baseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: gu, error: gErr } = await adminAuth.auth.admin.getUserById(
    userId
  );
  if (gErr) throw gErr;
  const u = gu?.user;
  if (!u) throw new Error("ユーザーが見つかりません。");
  const nextMeta = { ...(u.user_metadata || {}), ...patch };
  const { error: uErr } = await adminAuth.auth.admin.updateUserById(userId, {
    user_metadata: nextMeta,
  });
  if (uErr) throw uErr;
}

/** GET / signIn 用: Supabase user_metadata のプラン選択フラグ（raw_user_meta_data） */
function planChoiceFromUser(user) {
  const m = user?.user_metadata || {};
  const ps = m.plan_selected;
  const planSelected = ps === true || ps === "true";
  const chosen =
    typeof m.plan === "string" && m.plan.trim() ? m.plan.trim() : null;
  return { plan_selected: planSelected, chosen_plan: chosen };
}

function absolutizeSupabaseVerifyLink(link, supabaseOrigin) {
  if (!link || typeof link !== "string") return "";
  const s = link.trim();
  if (/^https?:\/\//i.test(s)) return s;
  const base = String(supabaseOrigin || "").replace(/\/$/, "");
  if (!base) return s;
  return s.startsWith("/") ? `${base}${s}` : `${base}/${s}`;
}

/** Vercel 等で req.body が Buffer になることがあるため、文字列オブジェクト両対応で JSON を得る */
function parseJsonBodyLoose(req) {
  const raw = req.body;
  if (raw === undefined || raw === null || raw === "") return {};
  if (
    typeof Buffer !== "undefined" &&
    Buffer.isBuffer &&
    Buffer.isBuffer(raw)
  ) {
    return raw.length ? JSON.parse(raw.toString("utf8")) : {};
  }
  if (typeof raw === "string") {
    return JSON.parse(raw || "{}");
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw;
  }
  return {};
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
    if (getQueryParam(req, "bootstrap") === "1") {
      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          supabase_url: url,
          supabase_anon_key: anon,
        })
      );
    }

    const token = getBearer(req);
    if (!token) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "認証が必要です。" }));
    }

    try {
      const sbUser = createUserSupabase(token);
      const { user, error: ue } = await getSessionUser(sbUser);
      if (ue || !user) {
        res.statusCode = 401;
        return res.end(
          JSON.stringify({ error: ue?.message || "セッションが無効です。" })
        );
      }

      let remaining = RALLY_DAILY_LIMIT;
      let rallyLimit = RALLY_DAILY_LIMIT;
      let plan = null;
      let trial_expired = false;
      let trial_days_remaining = null;
      try {
        const r = await getDailyRemaining(sbUser, user.id);
        remaining = r.remaining;
        if (typeof r.limit === "number") rallyLimit = r.limit;
        plan = r.plan ?? null;
        trial_expired = Boolean(r.trial_expired);
        trial_days_remaining =
          typeof r.trial_days_remaining === "number"
            ? r.trial_days_remaining
            : null;
      } catch (err) {
        console.error("[auth GET] remaining:", err);
      }

      const metaChoice = planChoiceFromUser(user);

      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          user: { id: user.id, email: user.email },
          remaining,
          limit: rallyLimit,
          plan,
          trial_expired,
          trial_days_remaining,
          plan_selected: metaChoice.plan_selected,
          chosen_plan: metaChoice.chosen_plan,
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
    return res.end(JSON.stringify({ error: "この操作は許可されていません。" }));
  }

  let body = {};
  try {
    body = parseJsonBodyLoose(req);
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

  if (body.action === "startTrial") {
    const token = getBearer(req);
    if (!token) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "認証が必要です。" }));
    }
    try {
      const sbUser = createUserSupabase(token);
      const { user, error: ue } = await getSessionUser(sbUser);
      if (ue || !user) {
        res.statusCode = 401;
        return res.end(
          JSON.stringify({ error: ue?.message || "セッションが無効です。" })
        );
      }

      const { ymd: todayYmd } = jstDateParts();

      const { data: row, error: rowErr } = await sbUser
        .from("users")
        .select("plan, trial_start_date")
        .eq("id", user.id)
        .maybeSingle();

      if (rowErr) {
        console.error("[auth startTrial] select:", rowErr);
        res.statusCode = 502;
        return res.end(
          JSON.stringify({ error: "ユーザー情報の取得に失敗しました。" })
        );
      }

      const pNorm =
        row?.plan == null || row.plan === ""
          ? null
          : String(row.plan).trim().toLowerCase() || null;

      if (pNorm === "light" || pNorm === "standard") {
        let remaining = RALLY_DAILY_LIMIT;
        let rallyLimit = RALLY_DAILY_LIMIT;
        let plan = pNorm;
        let trial_expired = false;
        let trial_days_remaining = null;
        try {
          const r = await getDailyRemaining(sbUser, user.id);
          remaining = r.remaining;
          if (typeof r.limit === "number") rallyLimit = r.limit;
          plan = r.plan ?? plan;
          trial_expired = Boolean(r.trial_expired);
          trial_days_remaining =
            typeof r.trial_days_remaining === "number"
              ? r.trial_days_remaining
              : null;
        } catch (e) {
          console.error("[auth startTrial] quota:", e);
        }
        res.statusCode = 200;
        return res.end(
          JSON.stringify({
            success: true,
            skipped: true,
            remaining,
            limit: rallyLimit,
            plan,
            trial_expired,
            trial_days_remaining,
          })
        );
      }

      const emailSafe = typeof user.email === "string" ? user.email.trim() : "";

      if (!row) {
        const { error: insErr } = await sbUser.from("users").insert({
          id: user.id,
          email: emailSafe || "",
          plan: "trial",
          trial_start_date: todayYmd,
        });
        if (insErr) {
          console.error("[auth startTrial] insert:", insErr);
          res.statusCode = 502;
          return res.end(
            JSON.stringify({
              error:
                insErr.message || "トライアル開始情報を保存できませんでした。",
            })
          );
        }
      } else {
        const upd = {};
        if (!row.trial_start_date) upd.trial_start_date = todayYmd;
        if (!pNorm) upd.plan = "trial";
        if (Object.keys(upd).length) {
          const { error: upErr } = await sbUser
            .from("users")
            .update(upd)
            .eq("id", user.id);
          if (upErr) {
            console.error("[auth startTrial] update:", upErr);
            res.statusCode = 502;
            return res.end(
              JSON.stringify({
                error:
                  upErr.message || "トライアル開始情報を更新できませんでした。",
              })
            );
          }
        }
      }

      const { data: rowTrial } = await sbUser
        .from("users")
        .select("trial_start_date")
        .eq("id", user.id)
        .maybeSingle();
      const trialMetaYmd =
        trialStartDateToYmd(rowTrial?.trial_start_date) || todayYmd;

      try {
        await mergeUserMetadataAdmin(user.id, {
          plan_selected: true,
          plan: "無料トライアル",
          trial_start_ymd: trialMetaYmd,
        });
      } catch (metaErr) {
        console.error("[auth startTrial] user metadata:", metaErr);
        const msg =
          metaErr instanceof Error
            ? metaErr.message
            : String(metaErr ?? "unknown");
        res.statusCode = 502;
        return res.end(
          JSON.stringify({
            error:
              msg ||
              "プラン選択状態の保存に失敗しました。もう一度お試しください。",
          })
        );
      }

      let remaining = RALLY_DAILY_LIMIT;
      let rallyLimit = RALLY_DAILY_LIMIT;
      let plan = null;
      let trial_expired = false;
      let trial_days_remaining = null;
      try {
        const r = await getDailyRemaining(sbUser, user.id);
        remaining = r.remaining;
        if (typeof r.limit === "number") rallyLimit = r.limit;
        plan = r.plan ?? null;
        trial_expired = Boolean(r.trial_expired);
        trial_days_remaining =
          typeof r.trial_days_remaining === "number"
            ? r.trial_days_remaining
            : null;
      } catch (e) {
        console.error("[auth startTrial] remaining:", e);
      }

      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          success: true,
          remaining,
          limit: rallyLimit,
          plan,
          trial_expired,
          trial_days_remaining,
        })
      );
    } catch (err) {
      console.error("[auth startTrial]", err);
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "処理に失敗しました。" }));
    }
  }

  if (body.action === "recordPlanChoice") {
    const token = getBearer(req);
    if (!token) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "認証が必要です。" }));
    }
    const planLabel =
      typeof body.plan === "string" ? body.plan.trim() : "";
    if (!planLabel) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({ error: "plan（プラン名）が必要です。" })
      );
    }
    try {
      const sbUser = createUserSupabase(token);
      const { user, error: ue } = await getSessionUser(sbUser);
      if (ue || !user) {
        res.statusCode = 401;
        return res.end(
          JSON.stringify({ error: ue?.message || "セッションが無効です。" })
        );
      }
      try {
        await mergeUserMetadataAdmin(user.id, {
          plan_selected: true,
          plan: planLabel,
        });
      } catch (updErr) {
        console.error("[auth recordPlanChoice]", updErr);
        const msg =
          updErr instanceof Error
            ? updErr.message
            : String(updErr ?? "unknown");
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error: msg || "プラン情報を保存できませんでした。",
          })
        );
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({ success: true }));
    } catch (err) {
      console.error("[auth recordPlanChoice]", err);
      res.statusCode = 502;
      return res.end(JSON.stringify({ error: "処理に失敗しました。" }));
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
          "action(signUp/signIn)、email、password が必要です。パスワードリセットメールの送信は POST /api/auth?action=resetPassword と email のみ。復旧リンクからのパスワード変更はブラウザ上で実行してください。",
      })
    );
  }

  try {
    if (action === "signUp") {
      const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const resendKey = process.env.RESEND_API_KEY;

      if (!serviceRole || !resendKey) {
        res.statusCode = 500;
        return res.end(
          JSON.stringify({
            error:
              "サーバー設定: 新規登録確認メールには SUPABASE_SERVICE_ROLE_KEY と RESEND_API_KEY が必要です。",
          })
        );
      }

      const adminAuth = createClient(url, serviceRole, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      });

      const {
        data: linkPack,
        error: linkErr,
      } = await adminAuth.auth.admin.generateLink({
        type: "signup",
        email,
        password,
        options: {
          redirectTo: RESET_REDIRECT_TO,
        },
      });

      if (linkErr || !linkPack?.user) {
        res.statusCode = 400;
        return res.end(
          JSON.stringify({
            error:
              linkErr?.message ||
              String(linkErr ?? "ユーザー登録に失敗しました。"),
            code: linkErr?.code ?? undefined,
            status:
              typeof linkErr?.status === "number" ? linkErr.status : undefined,
          })
        );
      }

      const rawLink =
        linkPack.properties && typeof linkPack.properties.action_link === "string"
          ? linkPack.properties.action_link
          : "";

      const confirmationUrl = absolutizeSupabaseVerifyLink(rawLink, url);

      const userObj = linkPack.user;
      const userId =
        userObj?.id !== undefined && userObj?.id !== null
          ? String(userObj.id)
          : null;
      const userEmailShown =
        typeof userObj?.email === "string" ? userObj.email : email;

      if (!confirmationUrl) {
        if (userId) {
          try {
            await adminAuth.auth.admin.deleteUser(userId);
          } catch (delCleanup) {
            console.error("[auth signUp]", delCleanup);
          }
        }
        res.statusCode = 500;
        return res.end(
          JSON.stringify({ error: "確認用リンクの生成に失敗しました。" })
        );
      }

      try {
        await sendSignupConfirmationEmail({
          to: email,
          confirmationUrl,
        });
      } catch (mailErr) {
        console.error("[auth signUp Resend]", mailErr);
        if (userId) {
          try {
            await adminAuth.auth.admin.deleteUser(userId);
          } catch (delErr) {
            console.error("[auth signUp deleteUser rollback]", delErr);
          }
        }
        const msg =
          mailErr instanceof Error
            ? mailErr.message
            : "確認メールの送信に失敗しました。";
        res.statusCode = 502;
        return res.end(JSON.stringify({ error: msg }));
      }

      res.statusCode = 200;
      return res.end(
        JSON.stringify({
          needEmailConfirm: true,
          user: userId ? { id: userId, email: userEmailShown } : null,
          message:
            "確認メールを送信しました。メール内のリンクを開いてからログインしてください。",
        })
      );
    }

    const { data: signInData, error } = await adminSb.auth.signInWithPassword({
      email,
      password,
    });
    const session = signInData?.session ?? null;
    const user = signInData?.user ?? null;
    if (error || !session || !user) {
      res.statusCode = 401;
      return res.end(
        JSON.stringify({
          error: error?.message || "ログインに失敗しました。",
        })
      );
    }

    const sbUser = createUserSupabase(session.access_token);
    let remaining = RALLY_DAILY_LIMIT;
    let rallyLimit = RALLY_DAILY_LIMIT;
    let plan = null;
    let trial_expired = false;
    let trial_days_remaining = null;
    try {
      const r = await getDailyRemaining(sbUser, user.id);
      remaining = r.remaining;
      if (typeof r.limit === "number") rallyLimit = r.limit;
      plan = r.plan ?? null;
      trial_expired = Boolean(r.trial_expired);
      trial_days_remaining =
        typeof r.trial_days_remaining === "number"
          ? r.trial_days_remaining
          : null;
    } catch (e) {
      console.error("[auth signIn] remaining:", e);
    }

    const metaChoice = planChoiceFromUser(user);

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user: { id: user.id, email: user.email },
        remaining,
        limit: rallyLimit,
        plan,
        trial_expired,
        trial_days_remaining,
        plan_selected: metaChoice.plan_selected,
        chosen_plan: metaChoice.chosen_plan,
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
