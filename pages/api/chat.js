// pages/api/chat.js
import { supabase } from "../../lib/supabaseClient";
import agentPrompts from "../../lib/agentPrompts";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode invalide" });
    }

    const { message, agent } = req.body;

    if (!message || !agent) {
      return res.status(400).json({ error: "Message ou agent manquant." });
    }

    // Vérifie si l’agent existe dans la liste
    const agentData = agentPrompts[agent?.toLowerCase()];
    if (!agentData) {
      return res.status(404).json({ error: "Agent introuvable." });
    }

    // Récupération du prompt système
    const systemPrompt = agentData.systemPrompt;

    // Appel OpenAI Responses (nouvelle API OpenAI)
    const apiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1",
        input: [
          { role: "system", content: systemPrompt },
          { role: "user", content: message }
        ],
      }),
    });

    const result = await apiRes.json();

    if (!apiRes.ok) {
      return res.status(500).json({
        error: "Erreur OpenAI",
        detail: result,
      });
    }

    const reply = result.output_text || "Aucune réponse générée.";

    return res.status(200).json({ reply });

  } catch (err) {
    console.error("Erreur API Chat:", err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
}
