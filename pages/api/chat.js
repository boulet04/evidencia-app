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
    // 1. Récupérer la config de l'agent (Prompt + Context)
    const { data: config } = await supabase
      .from("client_agent_configs")
      .select("system_prompt, context")
      .eq("user_id", user.id)
      .single();

    // 2. Préparation du contexte pour Mistral (Lecture des sources)
    let documentsContext = "";
    if (config?.context?.sources) {
      config.context.sources.forEach(s => {
        if (s.type === "url") documentsContext += `\nLien Web à consulter: ${s.value}`;
        if (s.mime === "application/pdf") documentsContext += `\nContenu du Document PDF: ${s.name}`;
      });
    }

    // 3. Appel à l'API Mistral
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
            content: `${config?.system_prompt || ""}\n\nSOURCES DE DONNÉES :\n${documentsContext}` 
          },
          { role: "user", content: message }
        ],
        temperature: 0.1
      })
    });

    const data = await response.json();
    if (!data.choices) throw new Error("Réponse Mistral vide");
    
    const reply = data.choices[0].message.content;

    // 4. Enregistrement dans la table "messages" 
    // ATTENTION : On retire user_id car ta table messages ne l'a pas (vu sur ton screen d0be03.jpg)
    await supabase.from("messages").insert([
      { conversation_id: conversationId, role: "user", content: message },
      { conversation_id: conversationId, role: "assistant", content: reply }
    ]);

    // 5. Mise à jour de la date de la conversation
    await supabase.from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    return res.status(200).json({ reply });

  } catch (error) {
    console.error("Erreur API Chat:", error);
    return res.status(500).json({ error: "L'agent rencontre une difficulté technique." });
  }
}
