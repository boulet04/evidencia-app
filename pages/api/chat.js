// pages/api/chat.js
import Mistral from "@mistralai/mistralai";
import agentPrompts from "../../lib/agentPrompts";
import { createClient } from "@supabase/supabase-js";

const mistral = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY,
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // IMPORTANT
);

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Méthode non autorisée" });
    }

    const { message, agentSlug, conversationId, userId } = req.body;

    if (!message || !agentSlug || !conversationId || !userId) {
      return res.status(400).json({ error: "Données manquantes" });
    }

    const agent = agentPrompts[agentSlug];
    if (!agent) {
      return res.status(404).json({ error: "Agent introuvable" });
    }

    // 🔹 Récupère l’historique
    const { data: history } = await supabase
      .from("messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(20);

    const messages = [
      { role: "system", content: agent.systemPrompt },
      ...(history || []),
      { role: "user", content: message },
    ];

    const completion = await mistral.chat.complete({
      model: "mistral-small-latest",
      messages,
      temperature: 0.7,
    });

    const reply =
      completion?.choices?.[0]?.message?.content ||
      "Je n’ai pas compris votre demande.";

    // 🔹 Sauvegarde réponse agent
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      user_id: userId,
      role: "assistant",
      content: reply,
    });

    return res.status(200).json({ reply });
  } catch (err) {
    console.error("API CHAT ERROR:", err);
    return res.status(500).json({ error: "Erreur serveur IA" });
  }
}
