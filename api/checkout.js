/**
 * Stripe Checkout（サブスク登録）。POST JSON: { "plan": "light_monthly" | ... }
 * Authorization: Bearer <Supabase access_token>
 */

import Stripe from "stripe";
import { PLAN_TO_PRICE_ID } from "./_lib/price-map.js";
import { createUserSupabase } from "./memory.js";

const DEFAULT_SITE_ORIGIN = "https://kokoro-note-umber.vercel.app";

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

  let body = {};
  try {
    if (typeof req.body === "string") body = JSON.parse(req.body || "{}");
    else if (req.body && typeof req.body === "object") body = req.body;
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "JSON の形式が正しくありません。" }));
  }

  const planKey =
    typeof body.plan === "string" ? body.plan.trim().toLowerCase() : "";
  const priceId = PLAN_TO_PRICE_ID[planKey];

  if (!planKey || !priceId) {
    res.statusCode = 400;
    return res.end(
      JSON.stringify({
        error:
          "許可されていない plan です。light_monthly / light_yearly / standard_monthly / standard_yearly のいずれかを指定してください。",
      })
    );
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
          error: ue?.message || "セッションが無効です。ログインし直してください。",
        })
      );
    }

    const origin =
      typeof process.env.PUBLIC_SITE_ORIGIN === "string" &&
      process.env.PUBLIC_SITE_ORIGIN.trim()
        ? process.env.PUBLIC_SITE_ORIGIN.trim().replace(/\/$/, "")
        : DEFAULT_SITE_ORIGIN;

    const successUrlRaw =
      (typeof process.env.STRIPE_SUCCESS_URL === "string" &&
        process.env.STRIPE_SUCCESS_URL.trim()) ||
      `${origin}/?checkout_success=1&session_id={CHECKOUT_SESSION_ID}`;

    const cancelUrl =
      (typeof process.env.STRIPE_CANCEL_URL === "string" &&
        process.env.STRIPE_CANCEL_URL.trim()) ||
      `${origin}/?checkout_cancel=1`;

    const stripe = new Stripe(secret);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      customer_email: user.email || undefined,
      metadata: {
        supabase_user_id: user.id,
        plan_key: planKey,
      },
      subscription_data: {
        metadata: {
          supabase_user_id: user.id,
          plan_key: planKey,
        },
      },
      success_url: successUrlRaw.includes("{CHECKOUT_SESSION_ID}")
        ? successUrlRaw
        : `${successUrlRaw}${successUrlRaw.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: cancelUrl,
    });

    if (!session?.url) {
      res.statusCode = 502;
      return res.end(
        JSON.stringify({ error: "Checkout セッションの作成に失敗しました。" })
      );
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ url: session.url }));
  } catch (err) {
    console.error("[checkout]", err);
    const message =
      err instanceof Error ? err.message : String(err ?? "unknown error");
    res.statusCode = 502;
    return res.end(
      JSON.stringify({
        error: message || "Checkout の作成中にサーバー側でエラーが発生しました。",
      })
    );
  }
}

export default handler;

if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}
