import { supabase } from "../../lib/supabaseClient";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message, agentSlug, conversationId } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: "Non autorisé" });
  const token = authHeader.split(" ")[1];
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: "Session invalide" });

  try {
    // 1. On récupère le prompt et le contenu des documents (extracted_content)
    const { data: config } = await supabase
      .from("client_agent_configs")
      .select("system_prompt, extracted_content")
      .eq("user_id", user.id)
      .single();

    // 2. Appel à Mistral avec le contexte réel
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: [
          { 
            role: "system", 
            content: `${config?.system_prompt || "Tu es un assistant."}\n\nVOICI TES DOCUMENTS DE RÉFÉRENCE :\n${config?.extracted_content || "Aucun document fourni."}` 
          },
          { role: "user", content: message }
        ],
        temperature: 0.1
      })
    });

    const data = await response.json();
    const reply = data.choices[0].message.content;

    // 3. Sauvegarde dans l'historique réel (table messages)
    await supabase.from("messages").insert([
      { conversation_id: conversationId, role: "user", content: message },
      { conversation_id: conversationId, role: "assistant", content: reply }
    ]);

    // 4. Mise à jour de la conversation pour qu'elle remonte en haut de l'historique
    await supabase.from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    return res.status(200).json({ reply });

  } catch (error) {
    console.error("Erreur Chat:", error);
    return res.status(500).json({ error: "L'agent est indisponible." });
  }
}
