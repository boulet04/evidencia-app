// pages/admin/conversations.js
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function AdminConversations() {
  const [loading, setLoading] = useState(true);
  const [checkingAdmin, setCheckingAdmin] = useState(true);
  const [msg, setMsg] = useState("");

  // Data
  const [clients, setClients] = useState([]);
  const [clientUsers, setClientUsers] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [agents, setAgents] = useState([]);

  // Filters
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState(""); // "" = tous
  const [selectedAgentSlug, setSelectedAgentSlug] = useState(""); // "" = tous

  // Conversations list
  const [conversations, setConversations] = useState([]);
  const [loadingConvs, setLoadingConvs] = useState(false);

  // Selection
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [deleting, setDeleting] = useState(false);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  function goBack() {
    window.location.href = "/admin";
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  // --- Guard admin
  useEffect(() => {
    (async () => {
      try {
        setCheckingAdmin(true);
        const { data } = await supabase.auth.getSession();
        const session = data?.session;
        if (!session?.user?.id) {
          window.location.href = "/login";
          return;
        }

        // role admin via profiles.role = 'admin'
        const { data: p, error } = await supabase
          .from("profiles")
          .select("role")
          .eq("user_id", session.user.id)
          .maybeSingle();

        if (error) throw error;

        if ((p?.role || "") !== "admin") {
          window.location.href = "/agents";
          return;
        }
      } catch (e) {
        console.error(e);
        window.location.href = "/login";
      } finally {
        setCheckingAdmin(false);
      }
    })();
  }, []);

  // --- Load base data
  async function refreshAll() {
    setLoading(true);
    setMsg("");

    const [cRes, cuRes, pRes, aRes] = await Promise.all([
      supabase.from("clients").select("id,name,created_at").order("created_at", { ascending: false }),
      supabase.from("client_users").select("client_id,user_id,created_at"),
      supabase.from("profiles").select("user_id,email,role"),
      supabase.from("agents").select("id,slug,name,description,avatar_url").order("name", { ascending: true }),
    ]);

    const errors = [cRes.error, cuRes.error, pRes.error, aRes.error].filter(Boolean);
    if (errors.length) setMsg(errors.map((e) => e.message).join(" | "));

    const newClients = cRes.data || [];
    setClients(newClients);
    setClientUsers(cuRes.data || []);
    setProfiles(pRes.data || []);
    setAgents(aRes.data || []);

    // default selection: first client
    setSelectedClientId((cur) => cur || newClients[0]?.id || "");
    setLoading(false);
  }

  useEffect(() => {
    if (checkingAdmin) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkingAdmin]);

  // --- USERS LIST FOR CLIENT
  const usersForClient = useMemo(() => {
    if (!selectedClientId) return [];

    const links = (clientUsers || []).filter((x) => String(x.client_id) === String(selectedClientId));

    // dedupe user_ids
    const seen = new Set();
    const ids = [];
    for (const l of links) {
      const uid = String(l?.user_id || "");
      if (!uid) continue;
      if (seen.has(uid)) continue;
      seen.add(uid);
      ids.push(uid);
    }

    return ids
      .map((uid) => {
        const p = (profiles || []).find((pp) => String(pp?.user_id || "") === uid);
        const email = (p?.email || "").trim();
        return {
          user_id: uid,
          email: email || "",
          label: email ? email : `${uid.slice(0, 8)}…`,
        };
      })
      .sort((a, b) => (a.label || "").localeCompare(b.label || "", "fr", { sensitivity: "base" }));
  }, [selectedClientId, clientUsers, profiles]);

  // Reset user filter when client changes
  useEffect(() => {
    setSelectedUserId("");
    setSelectedIds(new Set());
    setConversations([]);
  }, [selectedClientId]);

  // --- Fetch conversations via API
  async function fetchConversations() {
    if (!selectedClientId) {
      alert("Choisissez un client.");
      return;
    }
    setMsg("");
    setLoadingConvs(true);
    setSelectedIds(new Set());

    try {
      const token = await getAccessToken();
      if (!token) {
        alert("Non authentifié.");
        return;
      }

      // ✅ FIX ICI : l’API attend client_id (underscore)
      const params = new URLSearchParams();
      params.set("client_id", selectedClientId); // <-- FIX
      if (selectedUserId) params.set("user_id", selectedUserId); // cohérent si ton API utilise user_id
      if (selectedAgentSlug) params.set("agent_slug", selectedAgentSlug); // cohérent si ton API utilise agent_slug

      const res = await fetch(`/api/admin/conversations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Erreur chargement conversations");

      const list = Array.isArray(data?.conversations) ? data.conversations : Array.isArray(data) ? data : [];
      setConversations(list);
    } catch (e) {
      console.error(e);
      setMsg(e?.message || "Erreur lors du chargement.");
      setConversations([]);
    } finally {
      setLoadingConvs(false);
    }
  }

  function toggleOne(id, checked) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAll() {
    setSelectedIds((prev) => {
      const allIds = (conversations || []).map((c) => c.id).filter(Boolean);
      if (allIds.length === 0) return new Set();
      const allSelected = prev.size === allIds.length;
      return allSelected ? new Set() : new Set(allIds);
    });
  }

  async function deleteSelected() {
    const ids = Array.from(selectedIds || []);
    if (ids.length === 0) {
      alert("Sélectionnez au moins une conversation.");
      return;
    }

    const ok = window.confirm(`Supprimer définitivement ${ids.length} conversation(s) ? Cette action est irréversible.`);
    if (!ok) return;

    setDeleting(true);
    setMsg("");

    try {
      const token = await getAccessToken();
      if (!token) {
        alert("Non authentifié.");
        return;
      }

      let deleted = 0;
      for (const conversationId of ids) {
        const res = await fetch(`/api/admin/conversations/${conversationId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok && res.status !== 204) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || `Erreur suppression conversation ${conversationId}`);
        }
        deleted += 1;
      }

      setMsg(`OK : ${deleted} conversation(s) supprimée(s).`);
      await fetchConversations();
    } catch (e) {
      console.error(e);
      setMsg(e?.message || "Erreur suppression.");
    } finally {
      setDeleting(false);
      setSelectedIds(new Set());
    }
  }

  const selectedCount = selectedIds.size;
  const totalCount = (conversations || []).length;

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.headerBtn} onClick={goBack} title="Retour admin">
            ← Retour admin
          </button>
          <div style={styles.headerTitle}>Supprimer conversations</div>
        </div>

        <div style={styles.headerRight}>
          <button style={styles.headerBtnDanger} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      <div style={styles.wrap}>
        <div style={styles.box}>
          {checkingAdmin ? (
            <div style={styles.muted}>Vérification des droits…</div>
          ) : loading ? (
            <div style={styles.muted}>Chargement…</div>
          ) : (
            <>
              <div style={styles.filtersRow}>
                <select
                  value={selectedClientId}
                  onChange={(e) => setSelectedClientId(e.target.value)}
                  style={styles.select}
                  name="client_select"
                >
                  <option value="">— Choisir un client (obligatoire) —</option>
                  {(clients || []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>

                <select
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                  style={styles.select}
                  name="user_select"
                  disabled={!selectedClientId}
                  title={!selectedClientId ? "Choisissez d'abord un client" : ""}
                >
                  <option value="">— Tous les utilisateurs —</option>
                  {(usersForClient || []).map((u) => (
                    <option key={u.user_id} value={u.user_id}>
                      {u.label}
                    </option>
                  ))}
                </select>

                <select
                  value={selectedAgentSlug}
                  onChange={(e) => setSelectedAgentSlug(e.target.value)}
                  style={styles.select}
                  name="agent_select"
                >
                  <option value="">— Tous les agents —</option>
                  {(agents || []).map((a) => (
                    <option key={a.slug} value={a.slug}>
                      {a.name} ({a.slug})
                    </option>
                  ))}
                </select>

                <button style={styles.btnAction} onClick={fetchConversations} disabled={!selectedClientId || loadingConvs}>
                  {loadingConvs ? "Chargement…" : "Afficher"}
                </button>
              </div>

              <div style={styles.actionsRow}>
                <button style={styles.btnGhost} onClick={toggleAll} disabled={totalCount === 0 || loadingConvs}>
                  Tout sélectionner
                </button>
                <div style={styles.small}>
                  Sélection : <b>{selectedCount}</b> / {totalCount}
                </div>

                <div style={{ flex: 1 }} />

                <button style={styles.btnDanger} onClick={deleteSelected} disabled={selectedCount === 0 || deleting || loadingConvs}>
                  {deleting ? "Suppression…" : "Supprimer définitivement"}
                </button>
              </div>

              <div style={styles.listBox}>
                <div style={styles.listTitle}>Conversations</div>

                {loadingConvs ? (
                  <div style={styles.muted}>Chargement des conversations…</div>
                ) : totalCount === 0 ? (
                  <div style={styles.muted}>Aucune conversation (ou cliquez “Afficher”).</div>
                ) : (
                  <div style={{ display: "grid", gap: 10 }}>
                    {conversations.map((c) => {
                      const id = c?.id;
                      const checked = selectedIds.has(id);

                      const title = c?.title || "Conversation";
                      const agentSlug = c?.agent_slug || c?.agentSlug || "";
                      const createdAt = c?.created_at || c?.createdAt || "";
                      const userEmail = c?.user_email || c?.userEmail || "";
                      const userId = c?.user_id || c?.userId || "";

                      return (
                        <label key={id} style={styles.row}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => toggleOne(id, e.target.checked)}
                            style={styles.checkbox}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={styles.rowTitle}>{title}</div>
                            <div style={styles.rowMeta}>
                              {agentSlug ? `agent: ${agentSlug}` : "agent: —"} •{" "}
                              {userEmail ? `user: ${userEmail}` : userId ? `user: ${String(userId).slice(0, 8)}…` : "user: —"} •{" "}
                              {createdAt ? `créé: ${String(createdAt).slice(0, 19).replace("T", " ")}` : "créé: —"} • id:{" "}
                              <span style={{ fontFamily: "monospace" }}>{String(id).slice(0, 8)}…</span>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>

              {!!msg && <div style={styles.alert}>{msg}</div>}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#050608",
    color: "rgba(238,242,255,.92)",
    fontFamily: '"Segoe UI", Arial, sans-serif',
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "14px 16px 0",
    flexWrap: "wrap",
  },
  headerLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 280, flexWrap: "wrap" },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },

  headerTitle: { fontWeight: 900, opacity: 0.95 },

  headerBtn: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.25)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  headerBtnDanger: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  wrap: { padding: 18 },
  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },

  muted: { opacity: 0.75, fontWeight: 800, fontSize: 13 },

  filtersRow: {
    display: "grid",
    gridTemplateColumns: "1.2fr 1fr 1fr auto",
    gap: 10,
    alignItems: "center",
    marginBottom: 10,
  },

  select: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    outline: "none",
    fontWeight: 800,
  },

  btnAction: {
    borderRadius: 999,
    padding: "10px 14px",
    border: "1px solid rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.12)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  actionsRow: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    padding: "10px 2px",
  },

  btnGhost: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.20)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  btnDanger: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  small: { fontSize: 12, opacity: 0.8, fontWeight: 800 },

  listBox: {
    marginTop: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    padding: 12,
    minHeight: 120,
  },

  listTitle: { fontWeight: 900, marginBottom: 10 },

  row: {
    display: "flex",
    gap: 12,
    alignItems: "flex-start",
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.15)",
    cursor: "pointer",
  },

  checkbox: { marginTop: 3, transform: "scale(1.05)" },

  rowTitle: { fontWeight: 900, marginBottom: 4 },
  rowMeta: { fontSize: 12, opacity: 0.78, fontWeight: 800 },

  alert: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    fontWeight: 900,
  },
};
