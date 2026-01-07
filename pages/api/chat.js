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
    // 1. Récupérer la config de l'agent et ses sources (PDF/URL)
    const { data: config } = await supabase
      .from("client_agent_configs")
      .select("system_prompt, context, agent_id")
      .eq("user_id", user.id)
      .single();

    let contextText = "";

    // 2. Traitement des sources (URL et PDF)
    if (config?.context?.sources) {
      for (const source of config.context.sources) {
        if (source.type === "url" && source.value) {
          // Ici on simule l'extraction, idéalement tu as un service qui fetch l'URL
          contextText += `\n[Données du site ${source.value}]`;
        } 
        else if (source.mime === "application/pdf") {
          // On construit le chemin vers le fichier dans le storage
          // Format vu dans tes screens: user_id/agent_name/filename
          const filePath = source.name; 
          contextText += `\n[Contenu extrait du PDF: ${source.name}]`;
          
          // Note : Pour un vrai OCR, il faudrait ici un appel à un service de lecture
          // ou que le texte ait été pré-extrait dans la base.
        }
      }
    }

    // 3. Appel à Mistral avec le prompt système complet
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.MISTRAL_API_KEY}`
      },
      body: JSON.stringify({
        model: "mistral-medium", 
        messages: [
          { 
            role: "system", 
            content: `${config.system_prompt}. Utilise ces informations pour répondre : ${contextText}` 
          },
          { role: "user", content: message }
        ]
      })
    });

    const data = await response.json();
    const reply = data.choices[0].message.content;

    // 4. Sauvegarde dans la table messages
    await supabase.from("messages").insert({
      conversation_id: conversationId,
      role: "assistant",
      content: reply,
      user_id: user.id
    });

    return res.status(200).json({ reply });

  } catch (error) {
    console.error("Erreur agent:", error);
    return res.status(500).json({ error: "Erreur de lecture des documents" });
  }
}
