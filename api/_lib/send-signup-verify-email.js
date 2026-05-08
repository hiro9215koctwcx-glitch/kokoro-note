/**
 * Supabase が generateLink で返す確認 URL で Resend にメール送信（新規登録確認用）。
 * 環境変数 RESEND_API_KEY が必須。
 */

const FROM = "こころノート <noreply@kokoronotes.com>";
const SUBJECT = "【こころノート】メールアドレスの確認";
const BODY_INTRO =
  "ご登録ありがとうございます。以下のリンクをクリックしてメールアドレスを確認してください。";

function escapeAttr(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/'/g, "&#39;");
}

/**
 * @param {{ to: string; confirmationUrl: string }} opts
 */
export async function sendSignupConfirmationEmail(opts) {
  const to = typeof opts?.to === "string" ? opts.to.trim() : "";
  const confirmationUrl =
    typeof opts?.confirmationUrl === "string"
      ? opts.confirmationUrl.trim()
      : "";
  if (!to || !confirmationUrl) {
    throw new Error("to と confirmationUrl が必要です");
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    throw new Error("RESEND_API_KEY が未設定です");
  }

  const hrefEsc = escapeAttr(confirmationUrl);
  const html = `<p>${BODY_INTRO}</p><p><a href="${hrefEsc}">メールアドレスを確認する</a></p><p style="font-size:12px;color:#666;">上手くクリックできない場合は、このURLをブラウザに貼り付けてください。<br>${escapeAttr(
    confirmationUrl
  )}</p>`;
  const text = `${BODY_INTRO}\n\n${confirmationUrl}`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject: SUBJECT,
      html,
      text,
    }),
  });

  let raw = "";
  try {
    raw = await res.text();
  } catch {
    raw = "";
  }

  if (!res.ok) {
    let msg = `Resend が ${res.status} を返しました`;
    try {
      const j = JSON.parse(raw);
      if (j.message) msg = `${msg}: ${j.message}`;
    } catch {
      if (raw) msg = `${msg}: ${raw.slice(0, 500)}`;
    }
    throw new Error(msg);
  }

  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
