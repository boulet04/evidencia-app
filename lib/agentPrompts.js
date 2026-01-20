// lib/agentPrompts.js
// Helper minimal pour éviter les erreurs d'import (pages/chat.js -> ../lib/agentPrompts).

export const AGENT_FIRST_MESSAGES = {
  emma: "Bonjour Simon, je suis Emma, comment puis-je vous aider ?",
};

export function getFirstMessage(agentSlug, userName = "") {
  let msg = AGENT_FIRST_MESSAGES[agentSlug] || "Bonjour, comment puis-je vous aider ?";
  if (userName && msg.includes("Simon")) {
    msg = msg.replaceAll("Simon", userName);
  }
  return msg;
}

export default AGENT_FIRST_MESSAGES;
