import Mistral from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";

const client = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

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

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: "Message vide." });
    }

    const completion = await client.chat.complete({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: message },
      ],
      temperature: 0.7,
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() || "Réponse vide.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
