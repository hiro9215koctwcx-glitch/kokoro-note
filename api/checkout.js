/**
 * Stripe Checkout（サブスク登録）。POST JSON: { "plan": "light_monthly" | ... }
 * キャンペーン時は use_kokoro_campaign: true と plan: light_monthly。promotion_code は検証用（省略可）。
 * Authorization: Bearer <Supabase access_token>
 */

import Stripe from "stripe";
import { PLAN_TO_PRICE_ID } from "./_lib/price-map.js";
import { createUserSupabase, jstDateParts } from "./memory.js";

const DEFAULT_SITE_ORIGIN = "https://kokoro-note-umber.vercel.app";
const CAMPAIGN_PROMO_EXPECT = "KOKORO800";
const CAMPAIGN_LAST_YMD = "2026-05-31";

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

async function resolveKokoroPromotionCodeId(stripe) {
  const envId =
    typeof process.env.STRIPE_CAMPAIGN_PROMOTION_CODE_ID === "string"
      ? process.env.STRIPE_CAMPAIGN_PROMOTION_CODE_ID.trim()
      : "";
  if (envId) return envId;
  const list = await stripe.promotionCodes.list({
    code: CAMPAIGN_PROMO_EXPECT,
    active: true,
    limit: 10,
  });
  const rows = Array.isArray(list.data) ? list.data : [];
  const exact = rows.find(
    (pc) =>
      pc &&
      typeof pc.code === "string" &&
      pc.code.toUpperCase() === CAMPAIGN_PROMO_EXPECT
  );
  if (exact?.id) return exact.id;
  if (rows[0]?.id) return rows[0].id;

  const couponId =
    typeof process.env.STRIPE_CAMPAIGN_COUPON_ID === "string"
      ? process.env.STRIPE_CAMPAIGN_COUPON_ID.trim()
      : "";
  if (!couponId) return null;
  const listC = await stripe.promotionCodes.list({
    coupon: couponId,
    active: true,
    limit: 10,
  });
  const rowsC = Array.isArray(listC.data) ? listC.data : [];
  const exactC = rowsC.find(
    (pc) =>
      pc &&
      typeof pc.code === "string" &&
      pc.code.toUpperCase() === CAMPAIGN_PROMO_EXPECT
  );
  return exactC?.id ?? rowsC[0]?.id ?? null;
}

/** キャンペーン用：カード不要のサブスク作成に使う Stripe Customer（metadata に supabase_user_id） */
async function getOrCreateStripeCustomerForCampaign(stripe, user) {
  const email =
    typeof user.email === "string" && user.email.trim()
      ? user.email.trim()
      : undefined;
  if (email) {
    const listed = await stripe.customers.list({ email, limit: 20 });
    const rows = Array.isArray(listed.data) ? listed.data : [];
    const byMeta = rows.find(
      (c) => c?.metadata?.supabase_user_id === user.id
    );
    if (byMeta) return byMeta.id;
    if (rows.length === 1) {
      await stripe.customers.update(rows[0].id, {
        metadata: {
          ...(rows[0].metadata || {}),
          supabase_user_id: user.id,
        },
      });
      return rows[0].id;
    }
    if (rows.length > 1) {
      const created = await stripe.customers.create({
        email,
        metadata: { supabase_user_id: user.id },
      });
      return created.id;
    }
  }
  const created = await stripe.customers.create({
    email: email || undefined,
    metadata: { supabase_user_id: user.id },
  });
  return created.id;
}

const CAMPAIGN_APP_RETURN_URL = `${DEFAULT_SITE_ORIGIN}/`;

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

  const useKokoroCampaign = body.use_kokoro_campaign === true;
  const promoNorm =
    typeof body.promotion_code === "string"
      ? body.promotion_code.trim().toUpperCase()
      : "";

  if (useKokoroCampaign && planKey !== "light_monthly") {
    res.statusCode = 400;
    return res.end(
      JSON.stringify({
        error:
          "キャンペーンコードはライト月額プランのみご利用いただけます。",
      })
    );
  }

  if (!planKey || !priceId) {
    res.statusCode = 400;
    return res.end(
      JSON.stringify({
        error:
          "許可されていない plan です。light_monthly / light_yearly / standard_monthly / standard_yearly のいずれかを指定してください。",
      })
    );
  }

  if (useKokoroCampaign) {
    const { ymd: todayYmd } = jstDateParts();
    if (todayYmd > CAMPAIGN_LAST_YMD) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({
          error: "このキャンペーンは終了しました。",
        })
      );
    }
    if (promoNorm && promoNorm !== CAMPAIGN_PROMO_EXPECT) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({
          error: "コードが無効です",
        })
      );
    }
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

    const stripe = new Stripe(secret);

    if (useKokoroCampaign) {
      const promoId = await resolveKokoroPromotionCodeId(stripe);
      if (!promoId) {
        res.statusCode = 500;
        return res.end(
          JSON.stringify({
            error:
              "キャンペーンの Stripe プロモーションコードが見つかりません。STRIPE_CAMPAIGN_PROMOTION_CODE_ID を設定するか、KOKORO800 が有効か確認してください。",
          })
        );
      }

      const customerId = await getOrCreateStripeCustomerForCampaign(
        stripe,
        user
      );

      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        discounts: [{ promotion_code: promoId }],
        collection_method: "charge_automatically",
        metadata: {
          supabase_user_id: user.id,
          plan_key: planKey,
          kokoro_campaign: "1",
        },
      });

      await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: true,
      });

      res.statusCode = 200;
      return res.end(JSON.stringify({ url: CAMPAIGN_APP_RETURN_URL }));
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

    const sessionPayload = {
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
    };

    const session = await stripe.checkout.sessions.create(sessionPayload);

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
