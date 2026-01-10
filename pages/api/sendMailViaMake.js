// pages/api/sendMailViaMake.js

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", ["POST"]);
      return res.status(405).json({ error: "Method Not Allowed" });
    }

    const { to, subject, body } = req.body || {};

    if (!to || !subject || !body) {
      return res.status(400).json({
        error: "Missing required fields",
        missing: {
          to: !to,
          subject: !subject,
          body: !body,
        },
      });
    }

    const webhookUrl = process.env.MAKE_WEBHOOK_URL;
    if (!webhookUrl) {
      return res.status(500).json({ error: "MAKE_WEBHOOK_URL is not configured" });
    }

    const makeResp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, body }),
    });

    const makeText = await makeResp.text();

    if (!makeResp.ok) {
      return res.status(502).json({
        error: "Make webhook call failed",
        status: makeResp.status,
        response: makeText,
      });
    }

    return res.status(200).json({ ok: true, makeResponse: makeText });
  } catch (e) {
    return res.status(500).json({ error: "Internal Server Error", details: String(e?.message || e) });
  }
}
