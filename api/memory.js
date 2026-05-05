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
 *   date date not null,
 *   rally_count int not null default 0,
 *   primary key (user_id, date)
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
 *
 * public.users(plan) を参照して日次ラリー上限を決めます。
 * authenticated が自分の行の plan を読めるように、例えば以下のポリシーを追加してください。
 *
 * alter table public.users enable row level security;
 * create policy users_select_own on public.users for select using (auth.uid() = id);
 *
 * alter table public.users add column if not exists trial_start_date date;
 *
 * create policy users_update_own on public.users for update using (auth.uid() = id) with check (auth.uid() = id);
 */

import { createClient } from "@supabase/supabase-js";

const TZ = "Asia/Tokyo";
/** trial / null / 不明時の既定（クエリ失敗時のフォールバックにも利用） */
const TRIAL_OR_UNKNOWN_DAILY_LIMIT = 5;

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

export function dailyLimitFromPlan(planRaw) {
  if (planRaw === null || planRaw === undefined) {
    return TRIAL_OR_UNKNOWN_DAILY_LIMIT;
  }
  const p = String(planRaw).trim().toLowerCase();
  if (!p || p === "trial") return TRIAL_OR_UNKNOWN_DAILY_LIMIT;
  if (p === "light") return 10;
  if (p === "standard") return 30;
  return TRIAL_OR_UNKNOWN_DAILY_LIMIT;
}

function normalizePlanColumn(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  return s === "" ? null : s;
}

/** DB の日付値を JST の YYYY-MM-DD に統一 */
export function trialStartDateToYmd(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  try {
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    return jstDateParts(d).ymd;
  } catch {
    return null;
  }
}

export function addCalendarDaysToYmd(ymd, days) {
  const d = new Date(`${ymd}T12:00:00+09:00`);
  d.setDate(d.getDate() + days);
  return jstDateParts(d).ymd;
}

/**
 * plan が trial のときのみ判定。light / standard は対象外（常に false）。
 * trial_start_date は JST の日付。開始日から 7 暦日分をトライアルとし、その翌日から期限切れ。
 * trial_start_date が無い場合は false（未開始扱い）。
 */
export function computeTrialExpired(planNorm, trialStartRaw) {
  if (planNorm !== "trial") return false;
  const startYmd = trialStartDateToYmd(trialStartRaw);
  if (!startYmd) return false;
  const { ymd: todayYmd } = jstDateParts();
  const firstBlockedYmd = addCalendarDaysToYmd(startYmd, 7);
  return todayYmd >= firstBlockedYmd;
}

async function fetchUserPlanTrialFromUsers(sb, userId) {
  const { data, error } = await sb
    .from("users")
    .select("plan, trial_start_date")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.warn("[memory] fetchUserPlanTrialFromUsers:", error.message);
    return { planNorm: null, trial_expired: false };
  }

  const planNorm = normalizePlanColumn(data?.plan);
  const trial_expired = computeTrialExpired(planNorm, data?.trial_start_date);
  return { planNorm, trial_expired };
}

export async function getUserPlan(sb, userId) {
  const { planNorm } = await fetchUserPlanTrialFromUsers(sb, userId);
  return planNorm;
}

export async function resolveDailyRallyLimit(sb, userId) {
  const { planNorm } = await fetchUserPlanTrialFromUsers(sb, userId);
  return dailyLimitFromPlan(planNorm);
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
  const { planNorm, trial_expired } = await fetchUserPlanTrialFromUsers(
    sb,
    userId
  );
  const limit = dailyLimitFromPlan(planNorm);
  const { ymd } = jstDateParts();
  const { data, error } = await sb
    .from("daily_usage")
    .select("rally_count")
    .eq("user_id", userId)
    .eq("date", ymd)
    .maybeSingle();

  if (error) {
    console.error("[memory] getDailyRemaining:", error);
    throw new Error(error.message || "利用回数の取得に失敗しました");
  }

  const used = typeof data?.rally_count === "number" ? data.rally_count : 0;
  return {
    remaining: Math.max(0, limit - used),
    used,
    dateKey: ymd,
    limit,
    plan: planNorm,
    trial_expired,
  };
}

/** カウントを1増やし、その後の remaining を返す。limit は省略時に users.plan を再取得します。 */
export async function incrementDailyRally(sb, userId, preResolvedLimit) {
  const limit =
    typeof preResolvedLimit === "number"
      ? preResolvedLimit
      : await resolveDailyRallyLimit(sb, userId);
  const { ymd } = jstDateParts();
  const { data: row, error: selErr } = await sb
    .from("daily_usage")
    .select("rally_count")
    .eq("user_id", userId)
    .eq("date", ymd)
    .maybeSingle();

  if (selErr) {
    console.error("[memory] incrementDailyRally select:", selErr);
    throw new Error(selErr.message || "利用回数の更新に失敗しました");
  }

  const next = (typeof row?.rally_count === "number" ? row.rally_count : 0) + 1;
  const { error: upErr } = await sb.from("daily_usage").upsert(
    {
      user_id: userId,
      date: ymd,
      rally_count: next,
    },
    { onConflict: "user_id,date" }
  );

  if (upErr) {
    console.error("[memory] incrementDailyRally upsert:", upErr);
    throw new Error(upErr.message || "利用回数の更新に失敗しました");
  }

  return { remaining: Math.max(0, limit - next), used: next, dateKey: ymd, limit };
}

/** 旧コード互換・エラー時フォールバック用（trial 相当） */
export const RALLY_DAILY_LIMIT = TRIAL_OR_UNKNOWN_DAILY_LIMIT;

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
