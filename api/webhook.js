/**
 * Stripe Webhook: checkout.session.completed で Supabase `public.users.plan` を更新
 * customer.subscription.created でキャンペーン（Subscriptions API 直作成）を反映
 * customer.subscription.deleted でプラン解除・プラン選択へ戻す
 *
 * 必要な環境変数:
 * - STRIPE_WEBHOOK_SECRET (whsec_…)
 * - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY （RLS をバイパスして DB 更新）
 * - STRIPE_SECRET_KEY （セッションに metadata が無いときサブスク metadata を取得するフォールバック）
 *
 * public.users が無い場合の例（Supabase SQL）:
 *
 * create table public.users (
 *   id uuid primary key references auth.users(id) on delete cascade,
 *   plan text,
 *   email text not null
 * );
 *
 * alter table public.users add column if not exists campaign_period_end_ymd date;
 */

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { jstDateParts } from "./memory.js";

function stripePlanKeyToColumnPlan(raw) {
  if (!raw || typeof raw !== "string") return null;
  const k = raw.trim().toLowerCase();
  if (k === "light_monthly" || k === "light_yearly") return "light";
  if (k === "standard_monthly" || k === "standard_yearly") return "standard";
  return null;
}

function readIncomingMessageBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function rawPayload(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string" && req.body.length) {
    return Buffer.from(req.body, "utf8");
  }
  const buf = await readIncomingMessageBody(req);
  if (buf.length) return buf;
  throw new Error("Webhook の raw body を取得できません。");
}

function createServiceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。");
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function mergeUserMetadataAdmin(userId, patch) {
  const baseUrl = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRole) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY が未設定です。");
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

async function resolvePlanKeyFromSession(session, stripe) {
  const fromSession = session?.metadata?.plan_key;
  if (fromSession && String(fromSession).trim()) {
    return String(fromSession).trim();
  }
  const subRef = session?.subscription;
  const subId = typeof subRef === "string" ? subRef : subRef?.id;
  if (!subId || !stripe) return "";
  try {
    const sub = await stripe.subscriptions.retrieve(subId);
    return sub.metadata?.plan_key?.trim?.() ?? "";
  } catch (e) {
    console.warn("[webhook] subscription.retrieve failed", subId, e);
    return "";
  }
}

function sessionIsKokoroCampaign(session) {
  const v = session?.metadata?.kokoro_campaign;
  return v === "1" || String(v).toLowerCase() === "true";
}

function subscriptionIsKokoroCampaign(sub) {
  const v = sub?.metadata?.kokoro_campaign;
  return v === "1" || String(v).toLowerCase() === "true";
}

/**
 * Subscriptions API で直接作成したキャンペーンサブスク（metadata kokoro_campaign）
 */
async function handleSubscriptionCreated(subscription) {
  if (!subscriptionIsKokoroCampaign(subscription)) return;

  const userIdRaw =
    typeof subscription?.metadata?.supabase_user_id === "string"
      ? subscription.metadata.supabase_user_id.trim()
      : "";
  if (!userIdRaw) {
    console.warn(
      "[webhook] subscription.created kokoro_campaign skip: no supabase_user_id"
    );
    return;
  }

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

  let campaignEndYmd = null;
  if (subscription?.current_period_end) {
    campaignEndYmd = jstDateParts(
      new Date(subscription.current_period_end * 1000)
    ).ymd;
  }

  if (stripe && subscription?.id) {
    try {
      await stripe.subscriptions.update(subscription.id, {
        cancel_at_period_end: true,
      });
    } catch (e) {
      console.error("[webhook] subscription.created cancel_at_period_end", e);
    }
  }

  const supabase = createServiceSupabase();

  const patch = { plan: "campaign" };
  if (campaignEndYmd) {
    patch.campaign_period_end_ymd = campaignEndYmd;
  }

  const { data, error } = await supabase
    .from("users")
    .update(patch)
    .eq("id", userIdRaw)
    .select("id");

  if (error) {
    console.error("[webhook] subscription.created users update failed", error);
    throw error;
  }

  if (!data?.length) {
    let email = "";
    const custId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer?.id;
    if (custId && stripe) {
      try {
        const cust = await stripe.customers.retrieve(custId);
        if (cust && !cust.deleted && typeof cust.email === "string") {
          email = cust.email.trim();
        }
      } catch (e) {
        console.warn("[webhook] subscription.created customer.retrieve", e);
      }
    }
    if (!email) {
      console.error(
        "[webhook] subscription.created users insert skipped: no email",
        userIdRaw
      );
      return;
    }

    const insertPayload = {
      id: userIdRaw,
      plan: "campaign",
      email,
    };
    if (campaignEndYmd) {
      insertPayload.campaign_period_end_ymd = campaignEndYmd;
    }

    const { error: insErr } = await supabase.from("users").insert(insertPayload);

    if (insErr) {
      console.error("[webhook] subscription.created users insert failed", insErr);
      throw insErr;
    }
  }
}

async function handleCheckoutSessionCompleted(session) {
  if (session.mode !== "subscription") return;

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

  const planKeyRaw = await resolvePlanKeyFromSession(session, stripe);
  const isCampaign = sessionIsKokoroCampaign(session);
  const planColumn = isCampaign
    ? "campaign"
    : stripePlanKeyToColumnPlan(planKeyRaw);

  const userIdRaw =
    (typeof session.metadata?.supabase_user_id === "string" &&
      session.metadata.supabase_user_id.trim()) ||
    (typeof session.client_reference_id === "string" &&
      session.client_reference_id.trim()) ||
    "";

  if (!userIdRaw || !planColumn) {
    console.warn("[webhook] checkout.session.completed skip", {
      userId: userIdRaw || null,
      planKeyRaw: planKeyRaw || null,
      isCampaign,
    });
    return;
  }

  const supabase = createServiceSupabase();

  const subRef = session?.subscription;
  const subId = typeof subRef === "string" ? subRef : subRef?.id;

  let campaignEndYmd = null;
  if (isCampaign && stripe && subId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subId);
      if (sub?.current_period_end) {
        campaignEndYmd = jstDateParts(
          new Date(sub.current_period_end * 1000)
        ).ymd;
      }
      await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    } catch (e) {
      console.error("[webhook] campaign subscription setup failed", e);
    }
  }

  const patch = { plan: planColumn };
  if (campaignEndYmd) {
    patch.campaign_period_end_ymd = campaignEndYmd;
  }

  const { data, error } = await supabase
    .from("users")
    .update(patch)
    .eq("id", userIdRaw)
    .select("id");

  if (error) {
    console.error("[webhook] users update failed", error);
    throw error;
  }

  if (!data?.length) {
    const email = session.customer_details?.email;

    if (!email) {
      console.error(
        "[webhook] users insert をスキップ: session.customer_details.email がありません。"
      );
      return;
    }

    const insertPayload = {
      id: userIdRaw,
      plan: planColumn,
      email,
    };
    if (campaignEndYmd) {
      insertPayload.campaign_period_end_ymd = campaignEndYmd;
    }

    const { error: insErr } = await supabase.from("users").insert(insertPayload);

    if (insErr) {
      console.error("[webhook] users insert failed", insErr);
      throw insErr;
    }
  }
}

async function handleSubscriptionDeleted(subscription) {
  const userIdRaw =
    typeof subscription?.metadata?.supabase_user_id === "string"
      ? subscription.metadata.supabase_user_id.trim()
      : "";
  if (!userIdRaw) {
    console.warn("[webhook] subscription.deleted skip: no supabase_user_id");
    return;
  }

  const supabase = createServiceSupabase();
  const { error } = await supabase
    .from("users")
    .update({ plan: null, campaign_period_end_ymd: null })
    .eq("id", userIdRaw);

  if (error) {
    console.error("[webhook] subscription.deleted users update", error);
    throw error;
  }

  try {
    await mergeUserMetadataAdmin(userIdRaw, {
      plan_selected: false,
    });
  } catch (e) {
    console.error("[webhook] subscription.deleted metadata", e);
  }
}

async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "POST のみ対応です。" }));
  }

  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!whSecret) {
    res.statusCode = 500;
    return res.end(
      JSON.stringify({ error: "STRIPE_WEBHOOK_SECRET が未設定です。" })
    );
  }

  let buf;
  try {
    buf = await rawPayload(req);
  } catch (e) {
    console.error("[webhook] body", e);
    res.statusCode = 400;
    return res.end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
    );
  }

  const sigHeader = req.headers?.["stripe-signature"];
  const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!sig) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "stripe-signature がありません。" }));
  }

  let event;
  try {
    event = Stripe.webhooks.constructEvent(buf, sig, whSecret);
  } catch (err) {
    console.error("[webhook] signature", err);
    res.statusCode = 400;
    return res.end(
      JSON.stringify({
        error:
          err instanceof Error ? err.message : "Webhook 署名検証に失敗しました。",
      })
    );
  }

  switch (event.type) {
    case "customer.subscription.created":
      try {
        await handleSubscriptionCreated(event.data.object);
      } catch (e) {
        console.error("[webhook] subscription.created 処理エラー", e);
      }
      break;
    case "checkout.session.completed":
      try {
        await handleCheckoutSessionCompleted(event.data.object);
      } catch (e) {
        console.error("[webhook] checkout.session.completed 処理エラー", e);
      }
      break;
    case "customer.subscription.deleted":
      try {
        await handleSubscriptionDeleted(event.data.object);
      } catch (e) {
        console.error("[webhook] subscription.deleted 処理エラー", e);
      }
      break;
    default:
      break;
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ received: true }));
}

export default handler;

if (typeof module !== "undefined" && module.exports) {
  module.exports = handler;
}
