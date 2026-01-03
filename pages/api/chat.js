import { SALES_AGENT_SYSTEM_PROMPT } from "../../lib/agentPrompts";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message } = req.body || {};
  if (!message) return res.status(400).json({ error: "Missing message" });

  // Pour l’instant: réponse “mock” structurée (on branchera l’IA juste après)
  const reply =
    "Max (Agent commercial) — Reçu. Pour te répondre précisément, j’ai besoin de 3 infos :\n" +
    "1) Quel est ton offre et ton prix ?\n" +
    "2) Quelle cible vises-tu (secteur + taille) ?\n" +
    "3) Quel canal tu veux utiliser (appel/email/LinkedIn) ?\n\n" +
    "Ensuite je te donne un script + plan de relance.\n\n" +
    "Contexte système: " + SALES_AGENT_SYSTEM_PROMPT.slice(0, 160) + "…";

  return res.status(200).json({ reply });
}
