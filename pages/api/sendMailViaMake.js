// pages/api/sendMailViaMake.js

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const makeWebhookUrl = process.env.MAKE_WEBHOOK_URL;
    if (!makeWebhookUrl) {
      return res.status(500).json({ error: "MAKE_WEBHOOK_URL is not set" });
    }

    const { to, subject, body } = req.body || {};

    if (!isNonEmptyString(to) || !isNonEmptyString(subject) || !isNonEmptyString(body)) {
      return res.status(400).json({
        error: "Missing required fields",
        required: ["to", "subject", "body"],
        received: { to, subject, body },
      });
    }

    const url =
      `${makeWebhookUrl}` +
      `?to=${encodeURIComponent(to)}` +
      `&subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;

    const resp = await fetch(url, { method: "GET" });
    const text = await resp.text().catch(() => "");

    if (!resp.ok) {
      return res.status(502).json({
        error: "Make webhook call failed",
        status: resp.status,
        response: text,
      });
    }

    return res.status(200).json({ ok: true, response: text });
  } catch (e) {
    return res.status(500).json({ error: "Internal error", details: String(e) });
  }
}
