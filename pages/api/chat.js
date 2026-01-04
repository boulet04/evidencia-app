// pages/api/chat.js
import { Mistral } from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";

const client = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

// Rend l'extraction robuste (content peut être string ou structure)
function extractText(content) {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (typeof part.text === "string") return part.text;
        if (typeof part.content === "string") return part.content;
        return "";
      })
      .join("");
  }

  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
  }

  return "";
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    const { message, agentSlug } = req.body || {};

    if (!agentSlug) {
      return res.status(400).json({ error: "Aucun agent sélectionné." });
    }

    const agent = agentPrompts?.[agentSlug];
    if (!agent?.systemPrompt) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    if (!message || String(message).trim().length === 0) {
      return res.status(400).json({ error: "Message vide." });
    }

    if (!process.env.MISTRAL_API_KEY) {
      return res.status(500).json({ error: "MISTRAL_API_KEY manquante côté serveur." });
    }

    const completion = await client.chat.complete({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: String(message) },
      ],
      temperature: 0.7,
    });

    const raw = completion?.choices?.[0]?.message?.content;
    const reply = extractText(raw).trim() || "Réponse vide.";

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("Erreur API /api/chat :", err);
    return res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
