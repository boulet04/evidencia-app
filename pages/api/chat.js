// pages/api/chat.js
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

    const { agentSlug, messages } = req.body || {};

    if (!agentSlug) {
      return res.status(400).json({ error: "Aucun agent sélectionné." });
    }

    const agent = agentPrompts[agentSlug];
    if (!agent) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Historique manquant." });
    }

    // Sécurité : on nettoie les rôles
    const cleanedMessages = messages
      .filter((m) => m && m.role && m.content)
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content),
      }));

    const completion = await client.chat.complete({
      model: "mistral-small-latest",
      temperature: 0.6,
      messages: [
        { role: "system", content: agent.systemPrompt },
        ...cleanedMessages,
      ],
    });

    const reply =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Je n’ai pas de réponse pour le moment.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
