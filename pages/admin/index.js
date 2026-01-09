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

  // Workflows / integrations UI (dans context)
  const [workflows, setWorkflows] = useState([]); // [{provider:'make'|'n8n'|'railway'|'custom', name, url}]
  const [wfProvider, setWfProvider] = useState("make");
  const [wfName, setWfName] = useState("");
  const [wfUrl, setWfUrl] = useState("");

  // Create client modal
  const [createClientOpen, setCreateClientOpen] = useState(false);
  const [newClientName, setNewClientName] = useState("");

  // Create user modal
  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState("user");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [pwdLocked, setPwdLocked] = useState(true); // anti autofill
  const [createdPassword, setCreatedPassword] = useState(""); // affichage one-shot
  const [createUserNote, setCreateUserNote] = useState("");

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function goBack() {
    window.location.href = "/agents";
  }

  async function refreshAll({ keepSelection = true } = {}) {
    setLoading(true);
    setMsg("");

    const prevClientId = selectedClientId;
    const prevUserId = selectedUserId;

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

    const newClients = cRes.data || [];
    const newClientUsers = cuRes.data || [];
    const newProfiles = pRes.data || [];
    const newAgents = aRes.data || [];
    const newUserAgents = uaRes.data || [];
    const newAgentConfigs = cfgRes.data || [];

    setClients(newClients);
    setClientUsers(newClientUsers);
    setProfiles(newProfiles);
    setAgents(newAgents);
    setUserAgents(newUserAgents);
    setAgentConfigs(newAgentConfigs);

    // Sélection stable (évite de “sauter” sur un autre client)
    const firstClient = newClients[0]?.id || "";
    setSelectedClientId((current) => {
      if (!keepSelection) return firstClient;
      const wanted = current || prevClientId;
      if (wanted && newClients.some((c) => c.id === wanted)) return wanted;
      return firstClient;
    });

    // user sélection : on le revalide plus bas via useEffect (clientCards)
    setSelectedUserId((current) => {
      if (!keepSelection) return "";
      return current || prevUserId || "";
    });

    setLoading(false);
  }

  useEffect(() => {
    refreshAll({ keepSelection: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clientCards = useMemo(() => {
    const qq = (q || "").trim().toLowerCase();

    const cards = (clients || []).map((c) => {
      const links = (clientUsers || []).filter((x) => x.client_id === c.id);

      const users = links
        .map((l) => {
          const uid = (l?.user_id || "").toString();
          const p = (profiles || []).find((pp) => (pp?.user_id || "").toString() === uid);
          return {
            user_id: uid,
            email: p?.email || "(email non renseigné)",
            role: p?.role || "",
          };
        })
        .filter((u) => !!u.user_id); // sécurité

      return { ...c, users, userCount: users.length };
    });

    if (!qq) return cards;

    return cards.filter((c) => {
      const inName = (c.name || "").toLowerCase().includes(qq);
      const inUsers = (c.users || []).some((u) => (u.email || "").toLowerCase().includes(qq));
      return inName || inUsers;
    });
  }, [clients, clientUsers, profiles, q]);

  // Quand on change de client, on choisit un user valide si dispo.
  useEffect(() => {
    if (!selectedClientId) {
      setSelectedUserId("");
      return;
    }

    const card = clientCards.find((c) => c.id === selectedClientId);
    const users = Array.isArray(card?.users) ? card.users : [];
    const firstUser = users[0]?.user_id || "";

    // si user déjà ok, on garde
    if (selectedUserId && users.some((u) => u.user_id === selectedUserId)) return;

    // sinon on place le 1er (ou vide)
    setSelectedUserId(firstUser);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, clientCards]);

  function isAssigned(agentId) {
    if (!selectedUserId) return false;
    return (userAgents || []).some((ua) => (ua?.user_id || "") === selectedUserId && (ua?.agent_id || "") === agentId);
  }

  function getConfig(agentId) {
    if (!selectedUserId) return null;
    return (agentConfigs || []).find((c) => (c?.user_id || "") === selectedUserId && (c?.agent_id || "") === agentId) || null;
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

    await refreshAll({ keepSelection: true });
  }

  function openPromptModal(agent) {
    const cfg = getConfig(agent.id);
    const ctx = cfg?.context || {};
    const src = Array.isArray(ctx?.sources) ? ctx.sources : [];
    const wfs = Array.isArray(ctx?.workflows) ? ctx.workflows : [];

    setModalAgent(agent);
    setModalSystemPrompt(cfg?.system_prompt || "");
    setSources(src);
    setWorkflows(wfs);

    setUrlToAdd("");
    setWfProvider("make");
    setWfName("");
    setWfUrl("");

    setModalOpen(true);
  }

  function closePromptModal() {
    setModalOpen(false);
    setModalAgent(null);
    setModalSystemPrompt("");
    setSources([]);
    setWorkflows([]);
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

  function addWorkflow() {
    const name = (wfName || "").trim();
    const url = (wfUrl || "").trim();
    if (!name) return alert("Nom requis.");
    if (!/^https?:\/\//i.test(url)) return alert("URL webhook invalide. Exemple: https://...");

    const item = { provider: wfProvider || "make", name, url };
    setWorkflows((prev) => [item, ...prev]);

    setWfName("");
    setWfUrl("");
  }

  function removeWorkflowAt(idx) {
    setWorkflows((prev) => prev.filter((_, i) => i !== idx));
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

    const context = { sources, workflows };

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
    await refreshAll({ keepSelection: true });
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

  // --- CREATE CLIENT / USER ---
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

    closeCreateClient();

    // IMPORTANT : sélectionner le client créé si l’API renvoie l’id
    const newId = (data?.clientId || data?.id || "").toString();
    if (newId) setSelectedClientId(newId);

    await refreshAll({ keepSelection: true });
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

    const clientIdForCreate = selectedClientId;

    const res = await fetch("/api/admin/create-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        clientId: clientIdForCreate,
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
      setCreatedPassword((data?.tempPassword || "").toString());
    }

    // refresh puis rester sur le bon client
    await refreshAll({ keepSelection: true });
    setSelectedClientId(clientIdForCreate);

    // si l’API renvoie l'id user, le sélectionner
    const newUid = (data?.userId || data?.user_id || "").toString();
    if (newUid) setSelectedUserId(newUid);
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

    await refreshAll({ keepSelection: false });
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

    await refreshAll({ keepSelection: true });
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
            <div style={styles.clientsHead}>
              <div style={styles.boxTitle}>Clients</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button style={styles.btnPill} onClick={openCreateClient}>
                  + Client
                </button>
                <button style={styles.btnPill} onClick={openCreateUser}>
                  + Utilisateur
                </button>
              </div>
            </div>

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher client / email"
              style={styles.search}
              name="client_search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />

            {loading ? (
              <div style={styles.muted}>Chargement…</div>
            ) : (
              <div style={{ display: "grid", gap: 12 }}>
                {clientCards.map((c) => {
                  const activeClient = c.id === selectedClientId;
                  return (
                    <div key={c.id} style={{ ...styles.clientBlock, ...(activeClient ? styles.clientBlockActive : {}) }}>
                      <div style={styles.clientHeader}>
                        <div
                          style={{ cursor: "pointer" }}
                          onClick={() => setSelectedClientId(c.id)}
                          title="Sélectionner ce client"
                        >
                          <div style={styles.clientName}>{c.name}</div>
                          <div style={styles.small}>{(c.userCount || 0).toString()} user(s)</div>
                        </div>

                        <button style={styles.deleteBtn} onClick={() => deleteClient(c.id, c.name)} title="Supprimer client">
                          Supprimer
                        </button>
                      </div>

                      <div style={styles.userList}>
                        {(Array.isArray(c.users) ? c.users : []).map((u) => {
                          const uid = (u?.user_id || "").toString();
                          const activeUser = activeClient && uid && uid === selectedUserId;
                          const shortId = uid ? `${uid.slice(0, 8)}…` : "(id manquant)";

                          return (
                            <div key={uid || Math.random()} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                              <div
                                style={{ ...styles.userItem, ...(activeUser ? styles.userItemActive : {}) }}
                                onClick={() => {
                                  setSelectedClientId(c.id);
                                  if (uid) setSelectedUserId(uid);
                                }}
                              >
                                <div style={{ fontWeight: 900 }}>{u.email}</div>
                                <div style={styles.tiny}>
                                  {u.role ? `role: ${u.role}` : "role: (vide)"} —{" "}
                                  <span style={{ fontFamily: "monospace" }}>{shortId}</span>
                                </div>
                              </div>

                              <button
                                style={styles.xBtnMini}
                                onClick={() => removeClientUser(c.id, uid, u.email)}
                                title="Retirer l’utilisateur du client"
                              >
                                ✕
                              </button>
                            </div>
                          );
                        })}
                        {(Array.isArray(c.users) ? c.users : []).length === 0 && <div style={styles.muted}>Aucun utilisateur.</div>}
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
              {selectedClientId ? (selectedUserId ? "Assignation agents" : "Sélectionnez un utilisateur") : "Sélectionnez un client"}
            </div>

            <div style={styles.diag}>
              <div>
                <b>Client</b>: {selectedClientId ? "oui" : "non"}
              </div>
              <div>
                <b>User</b>: {selectedUserId ? "oui" : "non"}
              </div>
              <div>
                <b>Agents</b>: {(agents || []).length}
              </div>
              <div>
                <b>user_agents</b>: {(userAgents || []).length}
              </div>
              <div>
                <b>configs</b>: {(agentConfigs || []).length}
              </div>
            </div>

            {!selectedUserId ? (
              <div style={styles.muted}>Sélectionnez un utilisateur (dans une carte client à gauche) pour gérer les agents.</div>
            ) : (agents || []).length === 0 ? (
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
                  const wfCount = Array.isArray(ctx?.workflows) ? ctx.workflows.length : 0;
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
                            {srcCount} • Workflows: {wfCount}
                          </div>
                        </div>
                      </div>

                      <div style={styles.agentActions}>
                        <button style={assigned ? styles.btnAssigned : styles.btnAssign} onClick={() => toggleAssign(a.id, !assigned)}>
                          {assigned ? "Assigné" : "Assigner"}
                        </button>

                        <button style={styles.btnGhost} onClick={() => openPromptModal(a)}>
                          Prompt, données & workflows
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

      {/* MODAL Prompt & données */}
      {modalOpen && modalAgent && (
        <div style={styles.modalOverlay} onClick={closePromptModal}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>Prompt, données & workflows — {modalAgent.name}</div>

            <div style={styles.modalLabel}>System prompt</div>
            <textarea
              value={modalSystemPrompt}
              onChange={(e) => setModalSystemPrompt(e.target.value)}
              style={styles.textarea}
              placeholder="Entrez ici le system prompt personnalisé…"
            />

            <div style={styles.row}>
              <div style={{ flex: 1 }}>
                <div style={styles.modalLabel}>Ajouter une URL (source)</div>
                <div style={styles.row}>
                  <input
                    value={urlToAdd}
                    onChange={(e) => setUrlToAdd(e.target.value)}
                    placeholder="https://…"
                    style={styles.input}
                    name="agent_source_url"
                    autoComplete="off"
                  />
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
              {sources.length === 0
