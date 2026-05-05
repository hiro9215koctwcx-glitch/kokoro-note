/**
 * Stripe Webhook: checkout.session.completed で Supabase `public.users.plan` を更新
 *
 * 必要な環境変数:
 * - STRIPE_WEBHOOK_SECRET (whsec_…)
 * - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY （RLS をバイパスして DB 更新）
 * - STRIPE_SECRET_KEY （サブスク metadata フォールバック／insert 時の Customer email 取得に使用）
 *
 * public.users が無い場合の例（Supabase SQL）:
 *
 * create table public.users (
 *   id uuid primary key references auth.users(id) on delete cascade,
 *   plan text,
 *   email text not null
 * );
 */

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

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

async function handleCheckoutSessionCompleted(session) {
  if (session.mode !== "subscription") return;

  const stripeSecret = process.env.STRIPE_SECRET_KEY;
  const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

  const planKeyRaw = await resolvePlanKeyFromSession(session, stripe);
  const planColumn = stripePlanKeyToColumnPlan(planKeyRaw);

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
    });
    return;
  }

  const supabase = createServiceSupabase();

  const { data, error } = await supabase
    .from("users")
    .update({ plan: planColumn })
    .eq("id", userIdRaw)
    .select("id");

  if (error) {
    console.error("[webhook] users update failed", error);
    throw error;
  }

  if (!data?.length) {
    if (!stripe) {
      console.error(
        "[webhook] users insert をスキップ: STRIPE_SECRET_KEY がなく customer を取得できません。"
      );
      return;
    }
    const customerRef = session.customer;
    const customerId =
      typeof customerRef === "string" ? customerRef : customerRef?.id;
    if (!customerId) {
      console.error(
        "[webhook] users insert をスキップ: session.customer がありません。"
      );
      return;
    }

    const customer = await stripe.customers.retrieve(customerId);
    const email =
      customer && !customer.deleted && "email" in customer
        ? customer.email ?? null
        : null;

    if (!email) {
      console.error(
        "[webhook] users insert をスキップ: customer.email が取得できません。",
        customerId
      );
      return;
    }

    const { error: insErr } = await supabase.from("users").insert({
      id: userIdRaw,
      plan: planColumn,
      email,
    });

    if (insErr) {
      console.error("[webhook] users insert failed", insErr);
      throw insErr;
    }
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
    case "checkout.session.completed":
      try {
        await handleCheckoutSessionCompleted(event.data.object);
      } catch (e) {
        console.error("[webhook] checkout.session.completed 処理エラー", e);
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
