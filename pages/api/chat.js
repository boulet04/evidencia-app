import { supabase } from "../../lib/supabaseClient";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message, agentSlug, conversationId } = req.body;
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: "Non autorisé" });
  const token = authHeader.split(" ")[1];
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  
  if (authError || !user) return res.status(401).json({ error: "Session invalide" });

  try {
    // 1. Récupérer la configuration complète de l'agent pour cet utilisateur
    const { data: config, error: configError } = await supabase
      .from("client_agent_configs")
      .select("system_prompt, extracted_content")
      .eq("user_id", user.id)
      .single();

    if (configError) throw new Error("Configuration agent introuvable");

    // 2. Appel à l'API Mistral avec le contexte (PDF/URL extraits dans l'Admin)
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
            content: `${config.system_prompt}\n\nDOCUMENTS ET SOURCES DE RÉFÉRENCE :\n${config.extracted_content || "Aucun document n'a été indexé pour cet agent."}` 
          },
          { role: "user", content: message }
        ],
        temperature: 0.1
      })
    });

    const data = await response.json();
    if (!data.choices) throw new Error("Erreur de réponse Mistral");
    
    const reply = data.choices[0].message.content;

    // 3. Enregistrement dans la table "messages" pour l'historique réel
    await supabase.from("messages").insert([
      { conversation_id: conversationId, role: "user", content: message },
      { conversation_id: conversationId, role: "assistant", content: reply }
    ]);

    // 4. Mise à jour de la conversation pour le tri par date
    await supabase.from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    return res.status(200).json({ reply });

} catch (error) {
    console.error("Erreur API Chat:", error);
    return res.status(500).json({ error: error.message });
  }
}
