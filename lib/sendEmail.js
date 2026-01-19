// lib/sendEmail.js

export async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey) throw new Error("RESEND_API_KEY manquant (Vercel).");
  if (!from) throw new Error("EMAIL_FROM manquant (Vercel).");
  if (!to) throw new Error("Email destinataire manquant.");
  if (!subject) throw new Error("Sujet email manquant.");

  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html: html || undefined,
    text: text || undefined,
  };

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const msg = data?.message || data?.error || `Erreur Resend HTTP ${r.status}`;
    throw new Error(msg);
  }

  return data;
}
