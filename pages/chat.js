// pages/admin/index.js
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [clients, setClients] = useState([]);
  const [clientUsers, setClientUsers] = useState([]);
  const [profiles, setProfiles] = useState([]);

  const [agents, setAgents] = useState([]);
  const [userAgents, setUserAgents] = useState([]);
  const [agentConfigs, setAgentConfigs] = useState([]);

  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [q, setQ] = useState("");

  // Modal prompt & sources
  const [modalOpen, setModalOpen] = useState(false);
  const [modalAgent, setModalAgent] = useState(null);
  const [modalSystemPrompt, setModalSystemPrompt] = useState("");

  // sources UI
  const [sources, setSources] = useState([]); // [{type:'pdf'|'url', name, path, url, mime, size}]
  const [urlToAdd, setUrlToAdd] = useState("");
  const [uploading, setUploading] = useState(false);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/"; // ou /login si vous avez une page dédiée
  }

  function goBack() {
    window.location.href = "/agents";
  }

  async function refreshAll() {
    setLoading(true);
    setMsg("");

    const [cRes, cuRes, pRes, aRes, uaRes, cfgRes] = await Promise.all([
      supabase.from("clients").select("id,name,created_at").order("created_at", { ascending: false }),
      supabase.from("client_users").select("client_id,user_id,created_at"),
      supabase.from("profiles").select("user_id,email,role"),
      supabase.from("agents").select("id,slug,name,description,avatar_url").order("name", { ascending: true }),
      supabase.from("user_agents").select("user_id,agent_id,created_at"),
      supabase.from("client_agent_configs").select("user_id,agent_id,system_prompt,context"),
    ]);

    const errors = [cRes.error, cuRes.error, pRes.error, aRes.error, uaRes.error, cfgRes.error].filter(Boolean);
    if (errors.length) setMsg(errors.map((e) => e.message).join(" | "));

    setClients(cRes.data || []);
    setClientUsers(cuRes.data || []);
    setProfiles(pRes.data || []);
    setAgents(aRes.data || []);
    setUserAgents(uaRes.data || []);
    setAgentConfigs(cfgRes.data || []);

    setLoading(false);
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientCards = useMemo(() => {
    const qq = (q || "").trim().toLowerCase();

    const cards = clients.map((c) => {
      const links = clientUsers.filter((x) => x.client_id === c.id);
      const users = links.map((l) => {
        const p = profiles.find((pp) => pp.user_id === l.user_id);
        return {
          user_id: l.user_id,
          email: p?.email || "(email non renseigné)",
          role: p?.role || "",
        };
      });

      return { ...c, users, userCount: users.length };
    });

    if (!qq) return cards;

    return cards.filter((c) => {
      const inName = (c.name || "").toLowerCase().includes(qq);
      const inUsers = (c.users || []).some((u) => (u.email || "").toLowerCase().includes(qq));
      return inName || inUsers;
    });
  }, [clients, clientUsers, profiles, q]);

  useEffect(() => {
    if (!selectedClientId) {
      setSelectedUserId("");
      return;
    }
    const card = clientCards.find((c) => c.id === selectedClientId);
    const firstUser = card?.users?.[0]?.user_id || "";
    if (selectedUserId && card?.users?.some((u) => u.user_id === selectedUserId)) return;
    setSelectedUserId(firstUser);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, clientCards.length]);

  function isAssigned(agentId) {
    if (!selectedUserId) return false;
    return userAgents.some((ua) => ua.user_id === selectedUserId && ua.agent_id === agentId);
  }

  function getConfig(agentId) {
    if (!selectedUserId) return null;
    return agentConfigs.find((c) => c.user_id === selectedUserId && c.agent_id === agentId) || null;
  }

  async function toggleAssign(agentId, assign) {
    if (!selectedUserId) return alert("Sélectionnez un utilisateur.");
    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/toggle-user-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: selectedUserId, agentId, assign }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    await refreshAll();
  }

  function openPromptModal(agent) {
    const cfg = getConfig(agent.id);
    const ctx = cfg?.context || {};
    const src = Array.isArray(ctx?.sources) ? ctx.sources : [];
    setModalAgent(agent);
    setModalSystemPrompt(cfg?.system_prompt || "");
    setSources(src);
    setUrlToAdd("");
    setModalOpen(true);
  }

  function closePromptModal() {
    setModalOpen(false);
    setModalAgent(null);
    setModalSystemPrompt("");
    setSources([]);
    setUrlToAdd("");
    setUploading(false);
  }

  function addUrlSource() {
    const u = (urlToAdd || "").trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) return alert("URL invalide. Exemple: https://...");
    const item = { type: "url", url: u, name: u };
    setSources((prev) => [item, ...prev]);
    setUrlToAdd("");
  }

  function removeSourceAt(idx) {
    setSources((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handlePdfUpload(file) {
    if (!file) return;
    if (file.type !== "application/pdf") return alert("Veuillez sélectionner un PDF.");
    if (!selectedUserId || !modalAgent) return;

    setUploading(true);
    try {
      const token = await getAccessToken();
      if (!token) return alert("Non authentifié.");

      const base64 = await fileToBase64(file);

      const res = await fetch("/api/admin/upload-agent-source", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          userId: selectedUserId,
          agentSlug: modalAgent.slug,
          fileName: file.name,
          mimeType: file.type,
          base64,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return alert(`Erreur upload (${res.status}) : ${data?.error || "?"}`);

      const item = {
        type: "pdf",
        bucket: data.bucket || "agent_sources",
        mime: data.mime || "application/pdf",
        name: data.name || file.name,
        path: data.path,
        size: data.size || file.size,
      };

      setSources((prev) => [item, ...prev]);
    } finally {
      setUploading(false);
    }
  }

  async function savePromptModal() {
    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");
    if (!selectedUserId || !modalAgent) return;

    const context = { sources };

    const res = await fetch("/api/admin/save-agent-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId: selectedUserId,
        agentId: modalAgent.id,
        systemPrompt: modalSystemPrompt,
        context,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    closePromptModal();
    await refreshAll();
  }

  async function deleteAgentConversations(agentSlug, agentName) {
    if (!selectedUserId) return alert("Sélectionnez un utilisateur.");
    const ok = window.confirm(`Supprimer toutes les conversations de "${agentName}" pour cet utilisateur ?`);
    if (!ok) return;

    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/delete-agent-conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: selectedUserId, agentSlug }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    alert(`OK. Conversations supprimées: ${data?.deleted ?? 0}`);
  }

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.headerBtn} onClick={goBack} title="Retour">
            ← Retour
          </button>

          <img
            src="/images/logolong.png"
            alt="Evidenc'IA"
            style={styles.headerLogo}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />

          <div style={styles.headerTitle}>Console administrateur</div>
        </div>

        <div style={styles.headerRight}>
          <button style={styles.headerBtnDanger} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      <div style={styles.wrap}>
        <aside style={styles.left}>
          <div style={styles.box}>
            <div style={styles.boxTitle}>Clients</div>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher client / email"
              style={styles.search}
            />

            {loading ? (
              <div style={styles.muted}>Chargement…</div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {clientCards.map((c) => {
                  const activeClient = c.id === selectedClientId;
                  return (
                    <div key={c.id} style={{ ...styles.clientBlock, ...(activeClient ? styles.clientBlockActive : {}) }}>
                      <div
                        style={styles.clientHeader}
                        onClick={() => setSelectedClientId(c.id)}
                        title="Sélectionner ce client"
                      >
                        <div style={styles.clientName}>{c.name}</div>
                        <div style={styles.small}>{c.userCount} user(s)</div>
                      </div>

                      <div style={styles.userList}>
                        {(c.users || []).map((u) => {
                          const activeUser = activeClient && u.user_id === selectedUserId;
                          return (
                            <div
                              key={u.user_id}
                              style={{ ...styles.userItem, ...(activeUser ? styles.userItemActive : {}) }}
                              onClick={() => {
                                setSelectedClientId(c.id);
                                setSelectedUserId(u.user_id);
                              }}
                            >
                              <div style={{ fontWeight: 900 }}>{u.email}</div>
                              <div style={styles.tiny}>
                                {u.role ? `role: ${u.role}` : "role: (vide)"} —{" "}
                                <span style={{ fontFamily: "monospace" }}>{u.user_id.slice(0, 8)}…</span>
                              </div>
                            </div>
                          );
                        })}
                        {(c.users || []).length === 0 && <div style={styles.muted}>Aucun utilisateur.</div>}
                      </div>
                    </div>
                  );
                })}

                {clientCards.length === 0 && <div style={styles.muted}>Aucun client.</div>}
              </div>
            )}
          </div>
        </aside>

        <section style={styles.right}>
          <div style={styles.box}>
            <div style={styles.boxTitle}>
              {selectedClientId
                ? selectedUserId
                  ? "Assignation agents"
                  : "Sélectionnez un utilisateur"
                : "Sélectionnez un client"}
            </div>

            <div style={styles.diag}>
              <div>
                <b>Client</b>: {selectedClientId ? "oui" : "non"}
              </div>
              <div>
                <b>User</b>: {selectedUserId ? "oui" : "non"}
              </div>
              <div>
                <b>Agents</b>: {agents.length}
              </div>
              <div>
                <b>user_agents</b>: {userAgents.length}
              </div>
              <div>
                <b>configs</b>: {agentConfigs.length}
              </div>
            </div>

            {!selectedUserId ? (
              <div style={styles.muted}>Sélectionnez un utilisateur (dans une carte client à gauche) pour gérer les agents.</div>
            ) : agents.length === 0 ? (
              <div style={styles.alert}>
                Aucun agent chargé depuis la table <b>agents</b> (table vide ou RLS).
              </div>
            ) : (
              <div style={styles.grid}>
                {agents.map((a) => {
                  const assigned = isAssigned(a.id);
                  const cfg = getConfig(a.id);
                  const ctx = cfg?.context || {};
                  const srcCount = Array.isArray(ctx?.sources) ? ctx.sources.length : 0;
                  const hasPrompt = !!(cfg?.system_prompt || "").trim();

                  return (
                    <article key={a.id} style={styles.agentCard}>
                      <div style={styles.agentTop}>
                        <div style={styles.avatarWrap}>
                          {a.avatar_url ? (
                            <img src={a.avatar_url} alt={a.name} style={styles.avatar} />
                          ) : (
                            <div style={styles.avatarFallback} />
                          )}
                        </div>

                        <div style={{ flex: 1 }}>
                          <div style={styles.agentName}>{a.name}</div>
                          <div style={styles.agentRole}>{a.description || a.slug}</div>
                          <div style={styles.small}>
                            {assigned ? "Assigné" : "Non assigné"} • Prompt: {hasPrompt ? "personnalisé" : "défaut / vide"} • Sources:{" "}
                            {srcCount}
                          </div>
                        </div>
                      </div>

                      <div style={styles.agentActions}>
                        <button
                          style={assigned ? styles.btnAssigned : styles.btnAssign}
                          onClick={() => toggleAssign(a.id, !assigned)}
                        >
                          {assigned ? "Assigné" : "Assigner"}
                        </button>

                        <button style={styles.btnGhost} onClick={() => openPromptModal(a)}>
                          Prompt & données
                        </button>

                        <button style={styles.btnDangerGhost} onClick={() => deleteAgentConversations(a.slug, a.name)}>
                          Supprimer conversations
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {!!msg && <div style={styles.alert}>{msg}</div>}
          </div>
        </section>
      </div>

      {modalOpen && modalAgent && (
        <div style={styles.modalOverlay} onClick={closePromptModal}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>Prompt & données — {modalAgent.name}</div>

            <div style={styles.modalLabel}>System prompt</div>
            <textarea
              value={modalSystemPrompt}
              onChange={(e) => setModalSystemPrompt(e.target.value)}
              style={styles.textarea}
              placeholder="Entrez ici le system prompt personnalisé…"
            />

            <div style={styles.row}>
              <div style={{ flex: 1 }}>
                <div style={styles.modalLabel}>Ajouter une URL</div>
                <div style={styles.row}>
                  <input value={urlToAdd} onChange={(e) => setUrlToAdd(e.target.value)} placeholder="https://…" style={styles.input} />
                  <button style={styles.btnAssign} onClick={addUrlSource}>
                    Ajouter
                  </button>
                </div>
              </div>

              <div style={{ width: 18 }} />

              <div style={{ width: 320 }}>
                <div style={styles.modalLabel}>Uploader un PDF</div>
                <label style={styles.uploadBox}>
                  <input
                    type="file"
                    accept="application/pdf"
                    style={{ display: "none" }}
                    onChange={(e) => handlePdfUpload(e.target.files?.[0] || null)}
                    disabled={uploading}
                  />
                  {uploading ? "Upload en cours…" : "Choisir un PDF"}
                </label>
                <div style={styles.tiny}>Bucket: agent_sources</div>
              </div>
            </div>

            <div style={styles.modalLabel}>Sources</div>
            <div style={styles.sourcesBox}>
              {sources.length === 0 ? (
                <div style={styles.muted}>Aucune source.</div>
              ) : (
                sources.map((s, idx) => (
                  <div key={idx} style={styles.sourceRow}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 900 }}>
                        {s.type === "pdf" ? "PDF" : "URL"} — {s.name || s.url || s.path}
                      </div>
                      <div style={styles.tiny}>
                        {s.type === "pdf"
                          ? `mime: ${s.mime || "application/pdf"} • size: ${s.size || "?"} • path: ${s.path}`
                          : `url: ${s.url}`}
                      </div>
                    </div>
                    <button style={styles.xBtn} onClick={() => removeSourceAt(idx)} title="Retirer">
                      ✕
                    </button>
                  </div>
                ))
              )}
            </div>

            <div style={styles.modalActions}>
              <button style={styles.btnGhost} onClick={closePromptModal}>
                Annuler
              </button>
              <button style={styles.btnAssign} onClick={savePromptModal} disabled={uploading}>
                Enregistrer
              </button>
            </div>

            <div style={styles.small}>Les sources sont enregistrées dans context.sources (JSONB).</div>
          </div>
        </div>
      )}
    </main>
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
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
  headerLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 280 },
  headerRight: { display: "flex", alignItems: "center", gap: 10 },
  headerLogo: { height: 26, width: "auto", opacity: 0.95, display: "block" },
  headerTitle: { fontWeight: 900, opacity: 0.9 },

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

  wrap: { display: "grid", gridTemplateColumns: "420px 1fr", gap: 16, padding: 18 },

  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },
  boxTitle: { fontWeight: 900, marginBottom: 10 },

  search: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    outline: "none",
    marginBottom: 12,
    fontWeight: 800,
  },

  left: {},
  right: {},

  clientBlock: {
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.03)",
    overflow: "hidden",
  },
  clientBlockActive: { borderColor: "rgba(255,140,40,.35)" },
  clientHeader: {
    padding: 12,
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
    cursor: "pointer",
    background: "rgba(0,0,0,.18)",
  },
  clientName: { fontWeight: 900, fontSize: 14 },
  userList: { padding: 10, display: "grid", gap: 10 },
  userItem: {
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    cursor: "pointer",
  },
  userItemActive: { borderColor: "rgba(80,120,255,.35)", background: "rgba(80,120,255,.08)" },

  small: { fontSize: 12, opacity: 0.75, fontWeight: 800 },
  tiny: { fontSize: 11, opacity: 0.7, fontWeight: 800 },
  muted: { opacity: 0.75, fontWeight: 800, fontSize: 13 },
  alert: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    fontWeight: 900,
  },

  diag: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    gap: 10,
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    marginBottom: 12,
    fontSize: 12,
    fontWeight: 800,
    opacity: 0.9,
  },

  grid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 14 },
  agentCard: {
    borderRadius: 16,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.03)",
    padding: 14,
    boxShadow: "0 14px 40px rgba(0,0,0,.45)",
  },
  agentTop: { display: "flex", gap: 12, alignItems: "center", marginBottom: 12 },

  // AVATAR: on veut voir la tête -> plus grand + position vers le haut
  avatarWrap: {
    width: 64,
    height: 64,
    borderRadius: 999,
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,.12)",
    flex: "0 0 auto",
    background: "rgba(255,255,255,.05)",
  },
  avatar: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    objectPosition: "center 15%",
  },
  avatarFallback: { width: "100%", height: "100%", background: "rgba(255,255,255,.06)" },

  agentName: { fontWeight: 900, fontSize: 16 },
  agentRole: { fontWeight: 800, opacity: 0.8, fontSize: 12, marginTop: 2 },
  agentActions: { display: "grid", gap: 10 },

  btnAssign: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnAssigned: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.12)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnGhost: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.20)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnDangerGhost: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.65)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    zIndex: 9999,
  },
  modal: {
    width: "min(980px, 96vw)",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.70)",
    boxShadow: "0 34px 90px rgba(0,0,0,.62)",
    padding: 16,
    backdropFilter: "blur(12px)",
  },
  modalTitle: { fontWeight: 900, fontSize: 16, marginBottom: 10 },
  modalLabel: { fontWeight: 900, marginTop: 10, marginBottom: 6, opacity: 0.9 },
  textarea: {
    width: "100%",
    minHeight: 120,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    padding: 12,
    outline: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    fontWeight: 700,
  },
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12 },

  row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    outline: "none",
    fontWeight: 800,
  },
  uploadBox: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    borderRadius: 12,
    border: "1px dashed rgba(255,255,255,.25)",
    background: "rgba(255,255,255,.04)",
    cursor: "pointer",
    fontWeight: 900,
  },
  sourcesBox: {
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.03)",
    padding: 10,
    display: "grid",
    gap: 10,
    maxHeight: 260,
    overflow: "auto",
  },
  sourceRow: {
    display: "flex",
    gap: 10,
    alignItems: "center",
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.15)",
  },
  xBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
};
