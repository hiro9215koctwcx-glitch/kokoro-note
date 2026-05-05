/**
 * Stripe カスタマーポータル（請求・解約など）
 * POST: Authorization Bearer <Supabase access_token>
 * Body: （空オブジェクトでも可）
 * レスポンス: { url: string }
 *
 * 環境変数: STRIPE_SECRET_KEY （任意で PORTAL_RETURN_URL、未設定時は本番サイト URL を利用）
 */

import Stripe from "stripe";
import { createUserSupabase, getUserPlan } from "./memory.js";

const RETURN_URL_DEFAULT = "https://kokoro-note-umber.vercel.app/";
const RETURN_URL =
  typeof process.env.PORTAL_RETURN_URL === "string" &&
  process.env.PORTAL_RETURN_URL.trim()
    ? process.env.PORTAL_RETURN_URL.trim().replace(/\/?$/, "/")
    : RETURN_URL_DEFAULT;

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

async function resolveStripeCustomerId(stripe, email) {
  if (!email || !String(email).trim()) return null;
  const list = await stripe.customers.list({
    email: String(email).trim(),
    limit: 1,
  });
  return list.data[0]?.id ?? null;
}

async function handler(req, res) {
  setCors(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "POST のみ対応です。" }));
  }

  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    res.statusCode = 500;
    return res.end(
      JSON.stringify({ error: "サーバー設定: STRIPE_SECRET_KEY が未設定です。" })
    );
  }

  const token = getBearer(req);
  if (!token) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "ログインが必要です。" }));
  }

  try {
    const sb = createUserSupabase(token);
    const {
      data: { user },
      error: ue,
    } = await sb.auth.getUser();

    if (ue || !user) {
      res.statusCode = 401;
      return res.end(
        JSON.stringify({
          error:
            ue?.message || "セッションが無効です。ログインし直してください。",
        })
      );
    }

    const plan = await getUserPlan(sb, user.id);
    if (plan !== "light" && plan !== "standard") {
      res.statusCode = 403;
      return res.end(
        JSON.stringify({
          error:
            "プラン管理は有料プランご利用の方のみご利用いただけます。",
        })
      );
    }

    const stripe = new Stripe(secret);
    let customerId = await resolveStripeCustomerId(stripe, user.email);
    if (!customerId) {
      res.statusCode = 404;
      return res.end(
        JSON.stringify({
          error:
            "Stripe の顧客情報が見つかりませんでした。決済情報の確認が必要です。",
        })
      );
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: RETURN_URL,
    });

    if (!session?.url) {
      res.statusCode = 502;
      return res.end(
        JSON.stringify({
          error: "カスタマーポータルの URL を取得できませんでした。",
        })
      );
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ url: session.url }));
  } catch (err) {
    console.error("[portal]", err);
    const message =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    res.statusCode = 502;
    return res.end(
      JSON.stringify({
        error:
          message || "ポータルの作成中にサーバー側でエラーが発生しました。",
      })
    );
  }
}

export default handler;

if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}
