// pages/api/sendMailViaMake.js

export default async function handler(req, res) {
  // Permet d'éviter un 405 si le navigateur envoie un preflight OPTIONS
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { to, subject, body } = req.body || {};

    if (!to || !subject || !body) {
      return res.status(400).json({
        error: "Missing required fields",
        details: { to: !!to, subject: !!subject, body: !!body },
      });
    }

    const webhookUrl = process.env.MAKE_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(500).json({
        error: "MAKE_WEBHOOK_URL is not set in environment variables",
      });
    }

    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, body }),
    });

    const text = await r.text();

    if (!r.ok) {
      return res.status(502).json({
        error: "Make webhook call failed",
        status: r.status,
        response: text,
      });
    }

    return res.status(200).json({ ok: true, makeResponse: text || "OK" });
  } catch (e) {
    return res.status(500).json({
      error: "Unexpected server error",
      message: e?.message || String(e),
    });
  }
}
