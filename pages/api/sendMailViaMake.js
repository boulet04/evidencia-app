// pages/api/sendMailViaMake.js

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const makeUrl = process.env.MAKE_WEBHOOK_URL;
  if (!makeUrl) {
    return res.status(500).json({
      ok: false,
      error: "Missing env var MAKE_WEBHOOK_URL",
    });
  }

  try {
    const {
      provider = "outlook",
      to,
      subject,
      text,
      html,
      meta,
      debug,
    } = req.body || {};

    // Validation minimale (évite 400 “bêtes” côté Make)
    const toStr = (to || "").toString().trim();
    const subjectStr = (subject || "").toString().trim();

    if (!toStr || !toStr.includes("@")) {
      return res.status(400).json({
        ok: false,
        error: "Invalid 'to' email",
        payloadSent: debug ? req.body : undefined,
      });
    }

    if (!subjectStr) {
      return res.status(400).json({
        ok: false,
        error: "Missing 'subject'",
        payloadSent: debug ? req.body : undefined,
      });
    }

    // Corps : on accepte text OU html, mais pas vide
    const textStr = (text || "").toString();
    const htmlStr = (html || "").toString();

    if (!textStr && !htmlStr) {
      return res.status(400).json({
        ok: false,
        error: "Missing email body (text/html)",
        payloadSent: debug ? req.body : undefined,
      });
    }

    // Payload standardisé pour Make
    const payload = {
      ok: true,
      provider,
      to: toStr,
      subject: subjectStr,
      text: textStr || undefined,
      html: htmlStr || undefined,
      meta: meta || {},
    };

    const makeResp = await fetch(makeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const makeText = await makeResp.text();
    let makeJson = null;
    try {
      makeJson = JSON.parse(makeText);
    } catch (_) {
      // Make peut répondre autre chose qu'un JSON
    }

    if (!makeResp.ok) {
      return res.status(502).json({
        ok: false,
        error: "Make webhook error",
        makeStatus: makeResp.status,
        makeBody: makeJson || makeText,
        payloadSent: debug ? payload : undefined,
      });
    }

    return res.status(200).json({
      ok: true,
      makeStatus: makeResp.status,
      makeBody: makeJson || makeText,
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "sendMailViaMake exception",
      details: e?.message || String(e),
    });
  }
}
