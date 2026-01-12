async function deleteConversation(convId) {
  const ok = window.confirm("Supprimer définitivement cette conversation ?");
  if (!ok) return;

  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token || "";
    if (!token) throw new Error("Session expirée, reconnectez-vous.");

    const r = await fetch("/api/conversations/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ conversationId: convId }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.error || "Suppression impossible.");

    // Retirer côté UI
    setConversations((prev) => (prev || []).filter((c) => c.id !== convId));

    // Si c’était la conversation active, reset
    if (convId === selectedConversationId || convId === conversationId) {
      if (typeof setConversationId === "function") setConversationId(null);
      if (typeof setSelectedConversationId === "function") setSelectedConversationId("");
      if (typeof setMessages === "function") setMessages([]);
    }
  } catch (e) {
    alert((e?.message || "Erreur suppression").toString());
  }
}
