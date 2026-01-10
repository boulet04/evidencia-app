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
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

      const list = (data || []).map((r) => ({
        user_id: r.user_id,
        email: r.profiles?.email || r.user_id,
      }));

      // Tri par email
      list.sort((a, b) => (a.email || "").localeCompare(b.email || ""));

      setClientUsers(list);
    })();
  }, [selectedClientId]);

  async function loadConversations() {
    if (!accessToken) {
      alert("Session invalide. Reconnectez-vous.");
      return;
    }
    if (!selectedClientId) {
      alert("Choisissez un client.");
      return;
    }

    setLoading(true);
    setSelectedIds(new Set());
    try {
      const params = new URLSearchParams();
      params.set("client_id", selectedClientId);
      if (selectedUserId) params.set("user_id", selectedUserId);
      if (selectedAgentSlug) params.set("agent_slug", selectedAgentSlug);

      const resp = await fetch(`/api/admin/conversations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

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

  function toggleOne(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((prev) => {
      const allIds = conversations.map((c) => c.id);
      const allSelected = prev.size === allIds.length && allIds.length > 0;
      if (allSelected) return new Set();
      return new Set(allIds);
    });
  }

  async function deleteSelected() {
    if (!accessToken) return;

    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      alert("Sélectionnez au moins une conversation.");
      return;
    }

    const ok = confirm(`Supprimer définitivement ${ids.length} conversation(s) ? (messages inclus)`);
    if (!ok) return;

    setDeleting(true);
    try {
      // Suppression en série (simple et fiable)
      for (const id of ids) {
        const resp = await fetch(`/api/admin/conversations/${id}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!resp.ok && resp.status !== 204) {
          const j = await resp.json().catch(() => null);
          throw new Error(j?.error || `Erreur suppression ${id}`);
        }
      }

      // Nettoyage UI
      setConversations((prev) => prev.filter((c) => !selectedIds.has(c.id)));
      setSelectedIds(new Set());
      alert("Suppression terminée.");
    } catch (e) {
      console.error(e);
      alert("Suppression interrompue (une erreur est survenue).");
    } finally {
      setDeleting(false);
    }
  }

  const allChecked = conversations.length > 0 && selectedIds.size === conversations.length;

  return (
    <div style={{ padding: 18, color: "#e9eef6", background: "#050608", minHeight: "100vh" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 14 }}>
        <button onClick={() => router.push("/admin")} style={btn}>
          ← Retour admin
        </button>
        <div style={{ fontWeight: 900 }}>Supprimer conversations</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, marginBottom: 12 }}>
        <select style={select} value={selectedClientId} onChange={(e) => setSelectedClientId(e.target.value)}>
          <option value="">— Choisir un client (obligatoire) —</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <select style={select} value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} disabled={!selectedClientId}>
          <option value="">— Tous les utilisateurs —</option>
          {clientUsers.map((u) => (
            <option key={u.user_id} value={u.user_id}>
              {u.email}
            </option>
          ))}
        </select>

        <select style={select} value={selectedAgentSlug} onChange={(e) => setSelectedAgentSlug(e.target.value)}>
          <option value="">— Tous les agents —</option>
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

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <button style={btn} onClick={toggleAll} disabled={conversations.length === 0}>
          {allChecked ? "Tout désélectionner" : "Tout sélectionner"}
        </button>

        <div style={{ color: "rgba(233,238,246,0.7)" }}>
          Sélection : <b>{selectedIds.size}</b> / {conversations.length}
        </div>

        <div style={{ flex: 1 }} />

        <button style={btnDanger} onClick={deleteSelected} disabled={deleting || selectedIds.size === 0}>
          {deleting ? "Suppression..." : "Supprimer définitivement"}
        </button>
      </div>

      <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: 12, borderBottom: "1px solid rgba(255,255,255,0.06)", fontWeight: 800 }}>
          Conversations
        </div>

        {conversations.length === 0 ? (
          <div style={{ padding: 12, color: "rgba(233,238,246,0.65)" }}>
            Aucune conversation (ou cliquez “Afficher”).
          </div>
        ) : (
          <div>
            {conversations.map((c) => {
              const checked = selectedIds.has(c.id);
              return (
                <div
                  key={c.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "44px 1fr",
                    gap: 8,
                    alignItems: "center",
                    padding: 12,
                    borderTop: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(c.id)}
                    style={{ width: 18, height: 18 }}
                  />

                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ fontWeight: 800 }}>
                      {c.title || "Conversation"}{" "}
                      <span style={{ fontWeight: 600, color: "rgba(233,238,246,0.6)", fontSize: 12 }}>
                        — {c.agent_slug} — {c.user_email}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(233,238,246,0.55)" }}>{c.id}</div>
                  </div>
                </div>
              );
            })}
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

const btnDanger = {
  ...btn,
  border: "1px solid rgba(255,60,60,0.35)",
  background: "rgba(255,60,60,0.12)",
  color: "rgba(255,210,210,0.95)",
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
