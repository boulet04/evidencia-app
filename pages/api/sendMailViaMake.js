export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
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

    const webhookUrl = process.env.MAKE_WEBHOOK_URL; // ex: https://hook.eu1.make.com/xxxx
    if (!webhookUrl) {
      return res.status(500).json({ error: "MAKE_WEBHOOK_URL is not set" });
    }

    const url =
      `${webhookUrl}` +
      `?to=${encodeURIComponent(to)}` +
      `&subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(body)}`;

    const makeResp = await fetch(url, { method: "GET" });
    const text = await makeResp.text();

    if (!makeResp.ok) {
      return res.status(502).json({
        error: "Make webhook call failed",
        status: makeResp.status,
        response: text,
      });
    }

    return res.status(200).json({ ok: true, makeResponse: text });
  } catch (e) {
    return res.status(500).json({ error: "Internal error", details: String(e) });
  }
}
