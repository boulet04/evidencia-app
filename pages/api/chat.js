import agentPrompts from "../../lib/agentPrompts";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    const { message, agentSlug } = req.body || {};

    if (!agentSlug) {
      return res.status(400).json({ error: "Aucun agent sélectionné." });
    }

    const agent = agentPrompts[agentSlug];
    if (!agent) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Message vide." });
    }

    const resp = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`,
      },
      body: JSON.stringify({
        model: "mistral-small",
        temperature: 0.7,
        messages: [
          { role: "system", content: agent.systemPrompt },
          { role: "user", content: message },
        ],
      }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error("Mistral API error:", txt);
      throw new Error("Mistral API error");
    }

    const json = await resp.json();

    const reply =
      json?.choices?.[0]?.message?.content || "Réponse vide.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
