import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);

  const [q, setQ] = useState("");

  const [clients, setClients] = useState([]);
  const [clientUsers, setClientUsers] = useState([]);
  const [profiles, setProfiles] = useState([]);

  const [agents, setAgents] = useState([]);
  const [userAgents, setUserAgents] = useState([]);
  const [agentConfigs, setAgentConfigs] = useState([]);

  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");

  const [msg, setMsg] = useState("");

  // Modals
  const [createClientOpen, setCreateClientOpen] = useState(false);
  const [newClientName, setNewClientName] = useState("");

  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState("user");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [createdPassword, setCreatedPassword] = useState("");
  const [createUserNote, setCreateUserNote] = useState("");

  // anti-autofill Chrome (password)
  const [pwdLocked, setPwdLocked] = useState(true);

  // Config prompt modal
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgAgent, setCfgAgent] = useState(null);
  const [cfgSystemPrompt, setCfgSystemPrompt] = useState("");
  const [cfgContext, setCfgContext] = useState("{}");
  const [cfgNote, setCfgNote] = useState("");

  function safeJsonParse(s, fallback) {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  }

  function getConfig(agentId) {
    if (!selectedUserId || !agentId) return null;
    return (agentConfigs || []).find((x) => x.user_id === selectedUserId && x.agent_id === agentId) || null;
  }

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  }

  async function refreshAll(opts = {}) {
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

    // Sélection : on évite de "sauter" de client après un refresh (cas création client/user)
    const prevClientId = opts?.prevClientId ?? selectedClientId;
    const forceClientId = opts?.forceClientId || "";
    const firstClient = (cRes.data || [])[0]?.id || "";

    let nextClientId = "";
    if (forceClientId && (cRes.data || []).some((c) => c.id === forceClientId)) {
      nextClientId = forceClientId;
    } else if (opts?.keepSelection && prevClientId && (cRes.data || []).some((c) => c.id === prevClientId)) {
      nextClientId = prevClientId;
    } else if (prevClientId && (cRes.data || []).some((c) => c.id === prevClientId)) {
      nextClientId = prevClientId;
    } else if (!prevClientId && firstClient) {
      nextClientId = firstClient;
    } else {
      nextClientId = firstClient || "";
    }

    if (nextClientId && nextClientId !== selectedClientId) setSelectedClientId(nextClientId);

    setLoading(false);
  }

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientCards = useMemo(() => {
    const qq = (q || "").trim().toLowerCase();

    const cards = (clients || []).map((c) => {
      const links = (clientUsers || []).filter((x) => x.client_id === c.id);
      const users = links.map((l) => {
        const p = (profiles || []).find((pp) => pp.user_id === l.user_id);
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
  }, [selectedClientId, clientCards]);

  const selectedClient = useMemo(() => {
    return (clients || []).find((c) => c.id === selectedClientId) || null;
  }, [clients, selectedClientId]);

  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    const p = (profiles || []).find((pp) => pp.user_id === selectedUserId);
    return {
      user_id: selectedUserId,
      email: p?.email || "(email non renseigné)",
      role: p?.role || "",
    };
  }, [profiles, selectedUserId]);

  const assignedAgentIds = useMemo(() => {
    if (!selectedUserId) return new Set();
    return new Set((userAgents || []).filter((x) => x.user_id === selectedUserId).map((x) => x.agent_id));
  }, [userAgents, selectedUserId]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function loadMe() {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token || null;
    if (!token) return;

    const { data: meP } = await supabase.from("profiles").select("*").eq("user_id", data.session.user.id).maybeSingle();
    setMe(meP || null);
  }

  useEffect(() => {
    loadMe();
  }, []);

  function openCreateClient() {
    setNewClientName("");
    setCreateClientOpen(true);
  }
  function closeCreateClient() {
    setCreateClientOpen(false);
    setNewClientName("");
  }

  async function createClient() {
    const name = (newClientName || "").trim();
    if (!name) return alert("Nom du client requis.");
    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/create-client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ name }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    const newClientId = data?.client?.id || "";

    closeCreateClient();

    // Si un filtre de recherche est actif, le nouveau client peut être masqué :
    // on remet la recherche à vide pour le rendre immédiatement cliquable.
    if (q) setQ("");

    await refreshAll({ keepSelection: true, forceClientId: newClientId, prevClientId: selectedClientId });
  }

  function openCreateUser() {
    if (!selectedClientId) return alert("Sélectionne d’abord un client.");
    setNewUserEmail("");
    setNewUserRole("user");
    setNewUserPassword("");
    setCreatedPassword("");
    setCreateUserNote("");
    setPwdLocked(true); // anti-autofill
    setCreateUserOpen(true);
  }
  function closeCreateUser() {
    setCreateUserOpen(false);
    setNewUserEmail("");
    setNewUserRole("user");
    setNewUserPassword("");
    setCreatedPassword("");
    setCreateUserNote("");
    setPwdLocked(true);
  }

  async function createUser() {
    if (!selectedClientId) return alert("clientId absent.");
    const email = (newUserEmail || "").trim().toLowerCase();
    if (!email) return alert("Email requis.");

    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/create-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        clientId: selectedClientId,
        email,
        role: newUserRole || "user",
        password: (newUserPassword || "").trim() || null,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    if (data?.existing) {
      setCreateUserNote("Utilisateur déjà existant : il a été rattaché au client.");
      setCreatedPassword("");
    } else {
      setCreateUserNote("Utilisateur créé.");
      setCreatedPassword(data?.tempPassword || "");
    }

    await refreshAll({ keepSelection: true, prevClientId: selectedClientId });
  }

  async function deleteClient(clientId, name) {
    const ok = window.confirm(`Supprimer le client "${name}" ? (ne supprime pas les comptes Auth)`);
    if (!ok) return;

    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/delete-client", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    await refreshAll({ keepSelection: true, prevClientId: selectedClientId });

    if (selectedClientId === clientId) {
      setSelectedClientId("");
      setSelectedUserId("");
    }
  }

  async function removeClientUser(clientId, userId, email) {
    const ok = window.confirm(`Retirer l’utilisateur "${email}" de ce client ?`);
    if (!ok) return;

    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/remove-client-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ clientId, userId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    await refreshAll({ keepSelection: true, prevClientId: selectedClientId });

    if (selectedUserId === userId) setSelectedUserId("");
  }

  function openPromptModal(agent) {
    const cfg = getConfig(agent.id);
    const ctx = cfg?.context || {};
    setCfgAgent(agent);
    setCfgSystemPrompt(cfg?.system_prompt || "");
    setCfgContext(JSON.stringify(ctx || {}, null, 2));
    setCfgNote("");
    setCfgOpen(true);
  }

  function closePromptModal() {
    setCfgOpen(false);
    setCfgAgent(null);
    setCfgSystemPrompt("");
    setCfgContext("{}");
    setCfgNote("");
  }

  async function savePromptConfig() {
    if (!cfgAgent?.id) return;
    if (!selectedUserId) return alert("Sélectionne un utilisateur.");

    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const ctxObj = safeJsonParse(cfgContext, null);
    if (ctxObj === null) return alert("Le JSON context est invalide.");

    const res = await fetch("/api/admin/set-agent-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId: selectedUserId,
        agentId: cfgAgent.id,
        systemPrompt: cfgSystemPrompt || "",
        context: ctxObj || {},
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    setCfgNote("Configuration enregistrée.");
    await refreshAll({ keepSelection: true, prevClientId: selectedClientId });
  }

  async function resetPromptConfig() {
    if (!cfgAgent?.id) return;
    if (!selectedUserId) return alert("Sélectionne un utilisateur.");

    const ok = window.confirm("Supprimer la config (retour au prompt par défaut) ?");
    if (!ok) return;

    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/delete-agent-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: selectedUserId, agentId: cfgAgent.id }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    setCfgSystemPrompt("");
    setCfgContext("{}");
    setCfgNote("Config supprimée (prompt par défaut).");

    await refreshAll({ keepSelection: true, prevClientId: selectedClientId });
  }

  async function toggleAgent(agentId) {
    if (!selectedUserId) return alert("Sélectionne un utilisateur.");
    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const already = assignedAgentIds.has(agentId);

    const res = await fetch(already ? "/api/admin/unassign-agent" : "/api/admin/assign-agent", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId: selectedUserId, agentId }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    await refreshAll({ keepSelection: true, prevClientId: selectedClientId });
  }

  if (!me && !loading) {
    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 10 }}>Admin</div>
          <div>Non authentifié.</div>
          <a href="/login" style={{ marginTop: 10, display: "inline-block" }}>
            Aller à la page de login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.topbar}>
        <div style={styles.brand}>Evidencia — Admin</div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={styles.me}>
            <div style={{ fontWeight: 900 }}>{me?.email || ""}</div>
            <div style={styles.tiny}>role: {me?.role || ""}</div>
          </div>

          <button style={styles.btn} onClick={openCreateClient}>
            + Client
          </button>

          <button style={styles.btn} onClick={openCreateUser} disabled={!selectedClientId} title={!selectedClientId ? "Sélectionne un client" : ""}>
            + Utilisateur
          </button>

          <button style={styles.btnGhost} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      {!!msg && <div style={styles.banner}>{msg}</div>}

      <div style={styles.grid}>
        <div style={styles.left}>
          <div style={styles.leftHeader}>
            <div style={{ fontWeight: 900 }}>Clients</div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Recherche client / user…" style={styles.search} />
          </div>

          <div style={styles.list}>
            {clientCards.map((c) => {
              const activeClient = c.id === selectedClientId;
              return (
                <div key={c.id} style={{ ...styles.clientCard, ...(activeClient ? styles.clientCardActive : {}) }}>
                  <div style={styles.clientHeader}>
                    <div style={{ cursor: "pointer" }} onClick={() => setSelectedClientId(c.id)} title="Sélectionner ce client">
                      <div style={styles.clientName}>{c.name}</div>
                      <div style={styles.small}>{c.userCount} user(s)</div>
                    </div>

                    <button style={styles.deleteBtn} onClick={() => deleteClient(c.id, c.name)} title="Supprimer client">
                      Supprimer
                    </button>
                  </div>

                  <div style={styles.userList}>
                    {(c.users || []).map((u) => {
                      const activeUser = activeClient && u.user_id === selectedUserId;
                      return (
                        <div key={u.user_id} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div
                            style={{ ...styles.userItem, ...(activeUser ? styles.userItemActive : {}) }}
                            onClick={() => {
                              setSelectedClientId(c.id);
                              setSelectedUserId(u.user_id);
                            }}
                          >
                            <div style={{ fontWeight: 900 }}>{u.email}</div>
                            <div style={styles.tiny}>
                              {u.role || ""}
                              <span style={{ opacity: 0.55 }}> • </span>
                              {u.user_id.slice(0, 8)}…
                            </div>
                          </div>

                          <button style={styles.ghostMini} onClick={() => removeClientUser(c.id, u.user_id, u.email)} title="Retirer du client">
                            Retirer
                          </button>
                        </div>
                      );
                    })}

                    {(!c.users || c.users.length === 0) && <div style={styles.emptyUsers}>Aucun utilisateur rattaché.</div>}
                  </div>
                </div>
              );
            })}

            {clientCards.length === 0 && <div style={styles.emptyBox}>Aucun client à afficher.</div>}
          </div>
        </div>

        <div style={styles.right}>
          <div style={styles.rightHeader}>
            <div>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Utilisateur</div>
              <div style={styles.small}>
                {selectedClient?.name ? (
                  <>
                    Client: <b>{selectedClient.name}</b>
                  </>
                ) : (
                  "—"
                )}
              </div>
            </div>

            <div style={styles.userBadge}>
              {selectedUser?.email ? (
                <>
                  <div style={{ fontWeight: 900 }}>{selectedUser.email}</div>
                  <div style={styles.tiny}>role: {selectedUser.role || ""}</div>
                </>
              ) : (
                <div style={styles.small}>Sélectionne un utilisateur</div>
              )}
            </div>
          </div>

          <div style={styles.panel}>
            <div style={{ fontWeight: 900, marginBottom: 10 }}>Agents</div>

            {!selectedUserId ? (
              <div style={styles.emptyBox}>Sélectionne un utilisateur à gauche pour gérer ses agents.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {(agents || []).map((a) => {
                  const on = assignedAgentIds.has(a.id);
                  const cfg = getConfig(a.id);
                  return (
                    <div key={a.id} style={styles.agentRow}>
                      <div style={styles.agentLeft}>
                        <div style={styles.agentName}>{a.name}</div>
                        <div style={styles.tiny}>
                          {a.slug}
                          {cfg ? <span style={styles.cfgBadge}>Config</span> : <span style={styles.cfgBadgeOff}>Default</span>}
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <button style={styles.btnSmall} onClick={() => openPromptModal(a)} disabled={!on} title={!on ? "Assigne l’agent avant de configurer" : ""}>
                          Prompt
                        </button>

                        <button style={{ ...styles.toggleBtn, ...(on ? styles.toggleOn : styles.toggleOff) }} onClick={() => toggleAgent(a.id)}>
                          {on ? "Assigné" : "Non assigné"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Modal Create Client */}
      {createClientOpen && (
        <div style={styles.modalOverlay} onMouseDown={(e) => e.target === e.currentTarget && closeCreateClient()}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div style={{ fontWeight: 900 }}>Créer un client</div>
              <button type="button" style={styles.btnGhost} onClick={closeCreateClient}>
                Fermer
              </button>
            </div>
            <div style={styles.modalBody}>
              <div style={styles.label}>Nom du client</div>
              <input value={newClientName} onChange={(e) => setNewClientName(e.target.value)} placeholder="Ex: Société X" style={styles.input} />
              <div style={{ height: 14 }} />
              <button style={styles.btn} onClick={createClient}>
                Créer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Create User */}
      {createUserOpen && (
        <div style={styles.modalOverlay} onMouseDown={(e) => e.target === e.currentTarget && closeCreateUser()}>
          <div style={styles.modal}>
            <div style={styles.modalHeader}>
              <div style={{ fontWeight: 900 }}>Créer un utilisateur</div>
              <button type="button" style={styles.btnGhost} onClick={closeCreateUser}>
                Fermer
              </button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.small}>
                Client sélectionné: <b>{selectedClient?.name || "—"}</b>
              </div>

              <div style={{ height: 10 }} />

              <div style={styles.label}>Email</div>
              <input value={newUserEmail} onChange={(e) => setNewUserEmail(e.target.value)} placeholder="email@domaine.fr" style={styles.input} />

              <div style={{ height: 10 }} />

              <div style={styles.label}>Rôle</div>
              <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)} style={styles.select}>
                <option value="user">user</option>
                <option value="admin">admin</option>
              </select>

              <div style={{ height: 10 }} />

              <div style={styles.label}>Mot de passe (optionnel)</div>
              <input
                value={newUserPassword}
                onChange={(e) => setNewUserPassword(e.target.value)}
                placeholder="Laisse vide pour générer"
                style={styles.input}
                type="password"
                name="newUserPassword"
                autoComplete="new-password"
                readOnly={pwdLocked}
                onFocus={() => setPwdLocked(false)}
              />

              <div style={{ height: 12 }} />

              <button style={styles.btn} onClick={createUser}>
                Créer
              </button>

              {!!createUserNote && <div style={styles.noteBox}>{createUserNote}</div>}

              {!!createdPassword && (
                <div style={styles.pwdBox}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Mot de passe temporaire</div>
                  <div style={styles.pwdVal}>{createdPassword}</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal Prompt Config */}
      {cfgOpen && (
        <div style={styles.modalOverlay} onMouseDown={(e) => e.target === e.currentTarget && closePromptModal()}>
          <div style={styles.modalWide}>
            <div style={styles.modalHeader}>
              <div style={{ fontWeight: 900 }}>Prompt — {cfgAgent?.name || ""}</div>
              <button type="button" style={styles.btnGhost} onClick={closePromptModal}>
                Fermer
              </button>
            </div>

            <div style={styles.modalBody}>
              {!selectedUserId ? (
                <div style={styles.emptyBox}>Sélectionne un utilisateur.</div>
              ) : (
                <>
                  <div style={styles.label}>System prompt</div>
                  <textarea value={cfgSystemPrompt} onChange={(e) => setCfgSystemPrompt(e.target.value)} rows={6} style={styles.textarea} />

                  <div style={{ height: 10 }} />

                  <div style={styles.label}>Context (JSON)</div>
                  <textarea value={cfgContext} onChange={(e) => setCfgContext(e.target.value)} rows={10} style={styles.textarea} />

                  <div style={{ height: 12 }} />

                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <button style={styles.btn} onClick={savePromptConfig}>
                      Enregistrer
                    </button>
                    <button style={styles.btnGhost} onClick={resetPromptConfig}>
                      Reset (default)
                    </button>
                    {!!cfgNote && <div style={styles.small}>{cfgNote}</div>}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {loading && <div style={styles.loading}>Chargement…</div>}
    </div>
  );
}

const styles = {
  page: { minHeight: "100vh", background: "#0b0f14", color: "#eaeef6", fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" },
  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "18px 18px",
    borderBottom: "1px solid rgba(255,255,255,.08)",
    background: "rgba(255,255,255,.02)",
    position: "sticky",
    top: 0,
    zIndex: 5,
    backdropFilter: "blur(10px)",
  },
  brand: { fontWeight: 950, letterSpacing: 0.4 },
  me: { opacity: 0.9, textAlign: "right" },

  banner: {
    padding: "10px 14px",
    margin: "12px 18px",
    borderRadius: 12,
    background: "rgba(255, 255, 255, .05)",
    border: "1px solid rgba(255,255,255,.08)",
  },

  btn: {
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "#eaeef6",
    padding: "10px 12px",
    borderRadius: 12,
    cursor: "pointer",
    fontWeight: 900,
  },
  btnGhost: {
    border: "1px solid rgba(255,255,255,.12)",
    background: "transparent",
    color: "#eaeef6",
    padding: "10px 12px",
    borderRadius: 12,
    cursor: "pointer",
    fontWeight: 900,
  },
  btnSmall: {
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.04)",
    color: "#eaeef6",
    padding: "8px 10px",
    borderRadius: 12,
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 12,
  },

  grid: { display: "grid", gridTemplateColumns: "420px 1fr", gap: 14, padding: 18 },
  left: { border: "1px solid rgba(255,255,255,.08)", borderRadius: 16, overflow: "hidden", background: "rgba(255,255,255,.02)" },
  right: { border: "1px solid rgba(255,255,255,.08)", borderRadius: 16, overflow: "hidden", background: "rgba(255,255,255,.02)" },

  leftHeader: { padding: 12, display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,.08)" },
  rightHeader: { padding: 12, display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,.08)" },

  search: {
    width: 210,
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.2)",
    color: "#eaeef6",
    outline: "none",
  },

  list: { padding: 12, display: "flex", flexDirection: "column", gap: 10, maxHeight: "calc(100vh - 150px)", overflow: "auto" },
  clientCard: { border: "1px solid rgba(255,255,255,.10)", borderRadius: 16, padding: 12, background: "rgba(0,0,0,.12)" },
  clientCardActive: { border: "1px solid rgba(120,170,255,.45)", background: "rgba(120,170,255,.10)" },

  clientHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 },
  clientName: { fontWeight: 950, fontSize: 14 },
  small: { fontSize: 12, opacity: 0.75 },
  tiny: { fontSize: 11, opacity: 0.72 },

  deleteBtn: {
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#ffd7d7",
    padding: "8px 10px",
    borderRadius: 12,
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 12,
    whiteSpace: "nowrap",
  },

  userList: { marginTop: 10, display: "flex", flexDirection: "column", gap: 8 },
  userItem: { flex: 1, cursor: "pointer", padding: 10, borderRadius: 12, border: "1px solid rgba(255,255,255,.10)", background: "rgba(255,255,255,.03)" },
  userItemActive: { border: "1px solid rgba(120,170,255,.45)", background: "rgba(120,170,255,.10)" },
  ghostMini: {
    border: "1px solid rgba(255,255,255,.12)",
    background: "transparent",
    color: "#eaeef6",
    padding: "8px 10px",
    borderRadius: 12,
    cursor: "pointer",
    fontWeight: 900,
    fontSize: 12,
    whiteSpace: "nowrap",
  },
  emptyUsers: { padding: 10, opacity: 0.75, fontSize: 12 },

  userBadge: { border: "1px solid rgba(255,255,255,.10)", borderRadius: 16, padding: 10, background: "rgba(0,0,0,.12)", minWidth: 260, textAlign: "right" },

  panel: { padding: 12 },

  agentRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: 12, borderRadius: 16, border: "1px solid rgba(255,255,255,.10)", background: "rgba(0,0,0,.12)" },
  agentLeft: { display: "flex", flexDirection: "column", gap: 4 },
  agentName: { fontWeight: 950 },

  toggleBtn: { padding: "10px 12px", borderRadius: 12, cursor: "pointer", fontWeight: 950, border: "1px solid rgba(255,255,255,.14)" },
  toggleOn: { background: "rgba(60, 200, 120, .18)", border: "1px solid rgba(60, 200, 120, .35)", color: "#dffbe9" },
  toggleOff: { background: "rgba(255,255,255,.05)", color: "#eaeef6" },

  cfgBadge: {
    marginLeft: 8,
    fontSize: 11,
    fontWeight: 950,
    padding: "2px 6px",
    borderRadius: 999,
    border: "1px solid rgba(60, 200, 120, .35)",
    background: "rgba(60, 200, 120, .14)",
    color: "#dffbe9",
  },
  cfgBadgeOff: {
    marginLeft: 8,
    fontSize: 11,
    fontWeight: 950,
    padding: "2px 6px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.06)",
    opacity: 0.85,
  },

  emptyBox: { padding: 12, borderRadius: 16, border: "1px dashed rgba(255,255,255,.16)", background: "rgba(255,255,255,.03)", opacity: 0.85 },

  // Modal
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    zIndex: 10,
  },
  modal: { width: "min(520px, 96vw)", borderRadius: 16, border: "1px solid rgba(255,255,255,.12)", background: "#0b0f14", overflow: "hidden" },
  modalWide: { width: "min(900px, 96vw)", borderRadius: 16, border: "1px solid rgba(255,255,255,.12)", background: "#0b0f14", overflow: "hidden" },
  modalHeader: { padding: 12, display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(255,255,255,.08)" },
  modalBody: { padding: 12 },
  label: { fontSize: 12, opacity: 0.85, marginBottom: 6, fontWeight: 900 },

  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.2)",
    color: "#eaeef6",
    outline: "none",
  },
  select: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.2)",
    color: "#eaeef6",
    outline: "none",
  },
  textarea: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.2)",
    color: "#eaeef6",
    outline: "none",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
  },

  noteBox: { marginTop: 12, padding: 10, borderRadius: 12, border: "1px solid rgba(255,255,255,.12)", background: "rgba(255,255,255,.05)" },
  pwdBox: { marginTop: 12, padding: 10, borderRadius: 12, border: "1px solid rgba(255,140,40,.35)", background: "rgba(255,140,40,.10)" },
  pwdVal: { fontWeight: 800, fontSize: 14, letterSpacing: 0.2 },

  loading: {
    position: "fixed",
    right: 18,
    bottom: 18,
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.10)",
    fontWeight: 900,
  },
};
