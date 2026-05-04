/**
 * Supabase: conversations / daily_usage のサーバー側ヘルパー
 *
 * テーブル例（SQL Editor で実行）:
 *
 * create table public.conversations (
 *   id uuid primary key default gen_random_uuid(),
 *   user_id uuid not null references auth.users(id) on delete cascade,
 *   role text not null check (role in ('user','assistant')),
 *   content text not null,
 *   created_at timestamptz default now()
 * );
 * create index idx_conversations_user_created on public.conversations (user_id, created_at desc);
 *
 * create table public.daily_usage (
 *   user_id uuid not null references auth.users(id) on delete cascade,
 *   usage_date date not null,
 *   rally_count int not null default 0,
 *   primary key (user_id, usage_date)
 * );
 *
 * RLS を有効化し、authenticated ユーザーが自分の user_id の行のみ操作できるポリシーを追加してください。
 *
 * alter table public.conversations enable row level security;
 * create policy conversations_is_owner on public.conversations
 *   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
 * alter table public.daily_usage enable row level security;
 * create policy daily_usage_is_owner on public.daily_usage
 *   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
 */

import { createClient } from "@supabase/supabase-js";

const TZ = "Asia/Tokyo";
const DAILY_LIMIT = 5;

export function jstDateParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  let y;
  let m;
  let day;
  for (const p of parts) {
    if (p.type === "year") y = p.value;
    if (p.type === "month") m = p.value;
    if (p.type === "day") day = p.value;
  }
  return { ymd: `${y}-${m}-${day}` };
}

export function startOfTodayJstIso() {
  const { ymd } = jstDateParts();
  return new Date(`${ymd}T00:00:00+09:00`).toISOString();
}

export function sevenDaysAgoStartJstIso() {
  const { ymd } = jstDateParts();
  const todayStart = new Date(`${ymd}T00:00:00+09:00`);
  const from = new Date(todayStart.getTime() - 7 * 24 * 60 * 60 * 1000);
  return from.toISOString();
}
export function createUserSupabase(accessToken) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY が未設定です。");
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

/** JST で「昨日」の 00:00 〜 7日前までのメッセージ（要約用） */
export async function fetchPastDaysForSummary(sb, userId, maxChars = 8000) {
  const todayStartIso = startOfTodayJstIso();
  const fromIso = sevenDaysAgoStartJstIso();

  const { data, error } = await sb
    .from("conversations")
    .select("role,content,created_at")
    .eq("user_id", userId)
    .lt("created_at", todayStartIso)
    .gte("created_at", fromIso)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    console.error("[memory] fetchPastDaysForSummary:", error);
    throw new Error(error.message || "会話履歴の取得に失敗しました");
  }

  const rows = Array.isArray(data) ? data : [];
  let text = "";
  for (const r of rows) {
    const prefix = r.role === "assistant" ? "AI" : "ユーザー";
    const line = `[${prefix}] ${String(r.content || "").trim()}`;
    if (text.length + line.length + 1 > maxChars) break;
    text += (text ? "\n" : "") + line;
  }
  return text.trim();
}

export async function insertConversationRows(sb, userId, rows) {
  if (!rows?.length) return;
  const payload = rows.map((r) => ({
    user_id: userId,
    role: r.role,
    content: r.content,
  }));
  const { error } = await sb.from("conversations").insert(payload);
  if (error) {
    console.error("[memory] insertConversationRows:", error);
    throw new Error(error.message || "会話の保存に失敗しました");
  }
}

export async function getDailyRemaining(sb, userId) {
  const { ymd } = jstDateParts();
  const { data, error } = await sb
    .from("daily_usage")
    .select("rally_count")
    .eq("user_id", userId)
    .eq("usage_date", ymd)
    .maybeSingle();

  if (error) {
    console.error("[memory] getDailyRemaining:", error);
    throw new Error(error.message || "利用回数の取得に失敗しました");
  }

  const used = typeof data?.rally_count === "number" ? data.rally_count : 0;
  return { remaining: Math.max(0, DAILY_LIMIT - used), used, dateKey: ymd };
}

/** カウントを1増やし、その後の remaining を返す */
export async function incrementDailyRally(sb, userId) {
  const { ymd } = jstDateParts();
  const { data: row, error: selErr } = await sb
    .from("daily_usage")
    .select("rally_count")
    .eq("user_id", userId)
    .eq("usage_date", ymd)
    .maybeSingle();

  if (selErr) {
    console.error("[memory] incrementDailyRally select:", selErr);
    throw new Error(selErr.message || "利用回数の更新に失敗しました");
  }

  const next = (typeof row?.rally_count === "number" ? row.rally_count : 0) + 1;
  const { error: upErr } = await sb.from("daily_usage").upsert(
    {
      user_id: userId,
      usage_date: ymd,
      rally_count: next,
    },
    { onConflict: "user_id,usage_date" }
  );

  if (upErr) {
    console.error("[memory] incrementDailyRally upsert:", upErr);
    throw new Error(upErr.message || "利用回数の更新に失敗しました");
  }

  return { remaining: Math.max(0, DAILY_LIMIT - next), used: next, dateKey: ymd };
}

export const RALLY_DAILY_LIMIT = DAILY_LIMIT;

async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = 405;
  res.end(
    JSON.stringify({
      error:
        "このエンドポイントは内部利用です。会話・利用回数は /api/chat 経由で処理されます。",
    })
  );
}

export default handler;
