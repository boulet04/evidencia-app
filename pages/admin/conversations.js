// pages/admin/conversations.js
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/router";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

export default function AdminConversationsPage() {
  const router = useRouter();

  const [session, setSession] = useState(null);
  const accessToken = useMemo(() => session?.access_token || null, [session]);

  const [clients, setClients] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState("");

  const [clientUsers, setClientUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");

  const [agents, setAgents] = useState([]);
  const [selectedAgentSlug, setSelectedAgentSlug] = useState("");

  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s || null));
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("clients").select("id,name").order("name");
      if (error) {
        console.error(error);
        setClients([]);
        return;
      }
      setClients(data || []);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.from("agents").select("slug,name").order("name");
      if (error) {
        console.error(error);
        setAgents([]);
        return;
      }
      setAgents(data || []);
    })();
  }, []);

  useEffect(() => {
    if (!selectedClientId) {
      setClientUsers([]);
      setSelectedUserId("");
      return;
    }

    (async () => {
      const { data, error } = await supabase
        .from("client_users")
        .select("user_id,profiles:profiles!client_users_user_id_fkey(email)")
        .eq("client_id", selectedClientId);

      if (error) {
        console.error(error);
        setClientUsers([]);
        return;
      }

      // Normalisation
      const list = (data || []).map((r) => ({
        user_id: r.user_id,
        email: r.profiles?.email || r.user_id,
      }));

      setClientUsers(list);
    })();
  }, [selectedClientId]);

  async function loadConversations() {
    if (!accessToken) {
      alert("Session invalide. Reconnectez-vous.");
      return;
    }
    if (!selectedUserId || !selectedAgentSlug) {
      alert("Choisissez un utilisateur et un agent.");
      return;
    }

    setLoading(true);
    try {
      const url = `/api/admin/conversations?user_id=${encodeURIComponent(selectedUserId)}&agent_slug=${encodeURIComponent(selectedAgentSlug)}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const j = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error(j?.error || "Erreur chargement conversations");
      setConversations(j?.conversations || []);
    } catch (e) {
      console.error(e);
      alert("Impossible de charger les conversations.");
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }

  async function deleteConversation(conversationId) {
    if (!accessToken) return;
    const ok = confirm("Supprimer cette conversation ? (messages inclus)");
    if (!ok) return;

    try {
      const resp = await fetch(`/api/admin/conversations/${conversationId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!resp.ok && resp.status !== 204) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || "Erreur suppression");
      }

      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
    } catch (e) {
      console.error(e);
      alert("Impossible de supprimer la conversation.");
    }
  }

  return (
    <div style={{ padding: 18, color: "#e9eef6", background: "#050608", minHeight: "100vh" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <button onClick={() => router.push("/admin")} style={btn}>
          ← Retour admin
        </button>
        <div style={{ fontWeight: 900 }}>Conversations (admin)</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, marginBottom: 12 }}>
        <select style={select} value={selectedClientId} onChange={(e) => setSelectedClientId(e.target.value)}>
          <option value="">— Choisir un client —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select style={select} value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
          <option value="">— Choisir un utilisateur —</option>
          {clientUsers.map((u) => (
            <option key={u.user_id} value={u.user_id}>
              {u.email}
            </option>
          ))}
        </select>

        <select style={select} value={selectedAgentSlug} onChange={(e) => setSelectedAgentSlug(e.target.value)}>
          <option value="">— Choisir un agent —</option>
          {agents.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.name} ({a.slug})
            </option>
          ))}
        </select>

        <button style={btnPrimary} onClick={loadConversations} disabled={loading}>
          {loading ? "Chargement..." : "Afficher"}
        </button>
      </div>

      <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: 12, borderBottom: "1px solid rgba(255,255,255,0.06)", fontWeight: 800 }}>
          Liste des conversations
        </div>

        {conversations.length === 0 ? (
          <div style={{ padding: 12, color: "rgba(233,238,246,0.65)" }}>
            Aucune conversation (ou cliquez “Afficher”).
          </div>
        ) : (
          <div>
            {conversations.map((c) => (
              <div
                key={c.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: 12,
                  borderTop: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <div style={{ fontWeight: 800 }}>{c.title || "Conversation"}</div>
                  <div style={{ fontSize: 12, color: "rgba(233,238,246,0.6)" }}>{c.id}</div>
                </div>

                <button
                  onClick={() => deleteConversation(c.id)}
                  title="Supprimer"
                  style={deleteBtn}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const btn = {
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.04)",
  color: "#e9eef6",
  padding: "10px 12px",
  borderRadius: 12,
  cursor: "pointer",
  fontWeight: 700,
};

const btnPrimary = {
  ...btn,
  border: "1px solid rgba(255,130,30,0.35)",
  background: "rgba(255,130,30,0.12)",
};

const deleteBtn = {
  border: "1px solid rgba(255,60,60,0.35)",
  background: "rgba(255,60,60,0.12)",
  color: "rgba(255,210,210,0.95)",
  width: 34,
  height: 34,
  borderRadius: 12,
  fontSize: 20,
  lineHeight: "28px",
  cursor: "pointer",
};

const select = {
  height: 42,
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,0.14)",
  background: "rgba(255,255,255,0.04)",
  color: "#e9eef6",
  padding: "0 10px",
  outline: "none",
};
