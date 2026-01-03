import OpenAI from "openai";
import agentPrompts from "../../lib/agentPrompts";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export default async function handler(req, res) {
  try {
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

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: message },
      ],
    });

    const reply = completion?.choices?.[0]?.message?.content || "Réponse vide.";

    res.status(200).json({ reply });

  } catch (err) {
    console.error("Erreur API /chat :", err);
    res.status(500).json({ error: "Erreur interne de l’agent." });
  }
}
