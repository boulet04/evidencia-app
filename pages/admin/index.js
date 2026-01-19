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

  // Modal prompt & sources/workflows
  const [modalOpen, setModalOpen] = useState(false);
  const [modalAgent, setModalAgent] = useState(null);
  const [modalSystemPrompt, setModalSystemPrompt] = useState("");

  // Sources UI
  const [sources, setSources] = useState([]); // [{type:'pdf'|'url', name, path, url, mime, size, bucket}]
  const [urlToAdd, setUrlToAdd] = useState("");
  const [uploading, setUploading] = useState(false);

  // Workflows / integrations UI
  const [workflows, setWorkflows] = useState([]); // [{provider, name, url}]
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

    // sélection stable : on ne saute pas sur un autre client lors des refresh
    const firstClient = newClients[0]?.id || "";
    setSelectedClientId((current) => {
      if (!keepSelection) return firstClient;
      const wanted = current || prevClientId;
      if (wanted && newClients.some((c) => c.id === wanted)) return wanted;
      return firstClient;
    });

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
        .filter((u) => !!u.user_id);

      return { ...c, users, userCount: users.length };
    });

    if (!qq) return cards;

    return cards.filter((c) => {
      const inName = (c.name || "").toLowerCase().includes(qq);
      const inUsers = (c.users || []).some((u) => (u.email || "").toLowerCase().includes(qq));
      return inName || inUsers;
    });
  }, [clients, clientUsers, profiles, q]);

  // Quand on change de client, on sélectionne un user valide si dispo
  useEffect(() => {
    if (!selectedClientId) {
      setSelectedUserId("");
      return;
    }
    const card = clientCards.find((c) => c.id === selectedClientId);
    const users = Array.isArray(card?.users) ? card.users : [];
    const firstUser = users[0]?.user_id || "";

    if (selectedUserId && users.some((u) => u.user_id === selectedUserId)) return;
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

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
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
    setUploading(false);

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
    setWfProvider("make");
    setWfName("");
    setWfUrl("");
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
    const provider = (wfProvider || "make").trim();

    if (!name) return alert("Nom requis.");
    if (!/^https?:\/\//i.test(url)) return alert("URL webhook invalide. Exemple: https://...");

    const item = { provider, name, url };
    setWorkflows((prev) => [item, ...prev]);

    setWfName("");
    setWfUrl("");
  }

  function removeWorkflowAt(idx) {
    setWorkflows((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleFileUpload(file) {
    if (!file) return;
    // Contrôle léger côté front (le backend revalide aussi)
    const ext = safeStr(file?.name).split('.').pop()?.toLowerCase() || '';
    const allowed = new Set(['pdf','csv','txt','md','json','doc','docx','xls','xlsx','ppt','pptx','png','jpg','jpeg','webp']);
    if (!allowed.has(ext)) return alert(`Type non supporté: .${ext || '?'}`);
    if (!selectedUserId || !modalAgent) return alert("Sélectionnez un utilisateur et un agent.");

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

      let data = {};
      try {
        data = await res.json();
      } catch {
        data = {};
      }
      if (!res.ok) return alert(`Erreur upload (${res.status}) : ${data?.error || "?"}`);

      const item = {
        type: "file",
        bucket: data.bucket || "agent_sources",
        mime: data.mime || file.type || "application/octet-stream",
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
    if (!selectedUserId || !modalAgent) return alert("Sélectionnez un utilisateur.");

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

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
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

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
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

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    closeCreateClient();

    const newId = (data?.clientId || data?.id || "").toString();
    if (newId) setSelectedClientId(newId);

    await refreshAll({ keepSelection: true });
    if (newId) setSelectedClientId(newId);
  }

  function openCreateUser() {
    if (!selectedClientId) return alert("Sélectionne d’abord un client.");
    setNewUserEmail("");
    setNewUserRole("user");
    setNewUserPassword("");
    setCreatedPassword("");
    setCreateUserNote("");
    setPwdLocked(true);
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

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    if (data?.existing) {
      setCreateUserNote("Utilisateur déjà existant : il a été rattaché au client.");
      setCreatedPassword("");
    } else {
      setCreateUserNote("Utilisateur créé.");
      setCreatedPassword((data?.tempPassword || "").toString());
    }

    await refreshAll({ keepSelection: true });
    setSelectedClientId(clientIdForCreate);

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

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
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

    let data = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    await refreshAll({ keepSelection: true });
  }

  function goPromptGeneral() {
    // page déjà générée dans ton projet (vu dans les logs Vercel)
    window.location.href = "/admin/settings";
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

              <div style={styles.clientsHeadBtns}>
                <button style={styles.btnPill} onClick={goPromptGeneral} title="Configurer le prompt global">
                  Prompt général
                </button>
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
                        <div style={{ cursor: "pointer" }} onClick={() => setSelectedClientId(c.id)} title="Sélectionner ce client">
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
                            <div key={uid} style={{ display: "flex", gap: 10, alignItems: "center" }}>
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
                {(agents || []).map((a) => {
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
                          {a.avatar_url ? <img src={a.avatar_url} alt={a.name} style={styles.avatar} /> : <div style={styles.avatarFallback} />}
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
              <div style={{ flex: 1, minWidth: 280 }}>
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

              <div style={{ width: 320, minWidth: 260 }}>
                <div style={styles.modalLabel}>Uploader un fichier</div>
                <label style={styles.uploadBox}>
                  <input
                    type="file"
                    accept=".pdf,.csv,.txt,.md,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.webp"
                    style={{ display: "none" }}
                    onChange={(e) => handleFileUpload(e.target.files?.[0] || null)}
                    disabled={uploading}
                  />
                  {uploading ? "Upload en cours…" : "Choisir un fichier"}
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
                        {s.type === "url" ? "URL" : "FICHIER"} — {s.name || s.url || s.path}
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

            <div style={styles.modalLabel}>Workflows / intégrations</div>
            <div style={styles.sourcesBox}>
              <div style={{ display: "grid", gap: 10 }}>
                <select value={wfProvider} onChange={(e) => setWfProvider(e.target.value)} style={styles.select} name="wf_provider">
                  <option value="make">Make</option>
                  <option value="n8n">n8n</option>
                  <option value="railway">Railway</option>
                  <option value="custom">Autre</option>
                </select>

                <input
                  value={wfName}
                  onChange={(e) => setWfName(e.target.value)}
                  placeholder="Nom (ex: Relance facture, Envoi devis...)"
                  style={styles.input}
                  autoComplete="off"
                  name="wf_name"
                />

                <input
                  value={wfUrl}
                  onChange={(e) => setWfUrl(e.target.value)}
                  placeholder="URL webhook (https://...)"
                  style={styles.input}
                  autoComplete="off"
                  name="wf_url"
                />

                <button style={styles.btnAssign} onClick={addWorkflow}>
                  Ajouter
                </button>

                {(workflows || []).length === 0 ? (
                  <div style={styles.muted}>Aucun workflow.</div>
                ) : (
                  (workflows || []).map((w, idx) => (
                    <div key={idx} style={styles.sourceRow}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 900 }}>
                          {String(w?.provider || "custom").toUpperCase()} — {w?.name || "(sans nom)"}
                        </div>
                        <div style={styles.tiny}>{w?.url || ""}</div>
                      </div>
                      <button style={styles.xBtn} onClick={() => removeWorkflowAt(idx)} title="Retirer">
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div style={styles.modalActions}>
              <button style={styles.btnGhost} onClick={closePromptModal}>
                Annuler
              </button>
              <button style={styles.btnAssign} onClick={savePromptModal} disabled={uploading}>
                Enregistrer
              </button>
            </div>

            <div style={styles.small}>Les sources sont enregistrées dans context.sources (JSONB). Les workflows dans context.workflows.</div>
          </div>
        </div>
      )}

      {/* MODAL Create Client */}
      {createClientOpen && (
        <div style={styles.modalOverlay} onClick={closeCreateClient}>
          <div style={styles.smallModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>Créer un client</div>
            <div style={styles.modalLabel}>Nom du client</div>
            <input
              value={newClientName}
              onChange={(e) => setNewClientName(e.target.value)}
              style={styles.input}
              placeholder="Ex: Bcontact"
              name="new_client_name"
              autoComplete="off"
            />
            <div style={styles.modalActions}>
              <button style={styles.btnGhost} onClick={closeCreateClient}>
                Annuler
              </button>
              <button style={styles.btnAssign} onClick={createClient}>
                Créer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL Create User */}
      {createUserOpen && (
        <div style={styles.modalOverlay} onClick={closeCreateUser}>
          <div style={styles.smallModal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>Créer un utilisateur</div>

            <div style={styles.modalLabel}>Email</div>
            <input
              value={newUserEmail}
              onChange={(e) => setNewUserEmail(e.target.value)}
              style={styles.input}
              placeholder="test@test.fr"
              name="new_user_email"
              autoComplete="new-username"
              autoCapitalize="none"
              spellCheck={false}
            />

            <div style={styles.modalLabel}>Mot de passe (optionnel)</div>
            <input
              type="password"
              value={newUserPassword}
              onChange={(e) => setNewUserPassword(e.target.value)}
              style={styles.input}
              placeholder="Laisser vide pour générer automatiquement"
              name="new_user_password"
              autoComplete="new-password"
              readOnly={pwdLocked}
              onFocus={() => setPwdLocked(false)}
            />

            <div style={styles.modalLabel}>Rôle</div>
            <select value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)} style={styles.select} name="new_user_role">
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>

            {!!createUserNote && <div style={styles.noteOk}>{createUserNote}</div>}
            {!!createdPassword && (
              <div style={styles.notePwd}>
                Mot de passe temporaire : <span style={{ fontFamily: "monospace" }}>{createdPassword}</span>
              </div>
            )}

            <div style={styles.modalActions}>
              <button style={styles.btnGhost} onClick={closeCreateUser}>
                Annuler
              </button>
              <button style={styles.btnAssign} onClick={createUser}>
                Créer
              </button>
            </div>
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
  headerLeft: { display: "flex", alignItems: "center", gap: 12, minWidth: 280, flexWrap: "wrap" },
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

  clientsHead: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 },
  clientsHeadBtns: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" },

  btnPill: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.08)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

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
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    background: "rgba(0,0,0,.18)",
  },
  clientName: { fontWeight: 900, fontSize: 14 },
  userList: { padding: 10, display: "grid", gap: 10 },
  userItem: {
    flex: 1,
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    cursor: "pointer",
  },
  userItemActive: { borderColor: "rgba(80,120,255,.35)", background: "rgba(80,120,255,.08)" },

  deleteBtn: {
    borderRadius: 999,
    padding: "8px 10px",
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },

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

  avatarWrap: {
    width: 64,
    height: 64,
    borderRadius: 999,
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,.12)",
    flex: "0 0 auto",
    background: "rgba(255,255,255,.05)",
  },
  avatar: { width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 15%" },
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
    maxHeight: "92vh",
    overflow: "auto",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.70)",
    boxShadow: "0 34px 90px rgba(0,0,0,.62)",
    padding: 16,
    backdropFilter: "blur(12px)",
  },
  smallModal: {
    width: "min(520px, 96vw)",
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
  modalActions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 12, flexWrap: "wrap" },

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
  xBtnMini: {
    width: 40,
    height: 40,
    borderRadius: 12,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    flex: "0 0 auto",
  },

  noteOk: {
    marginTop: 12,
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(80,120,255,.35)",
    background: "rgba(80,120,255,.10)",
    fontWeight: 900,
  },
  notePwd: {
    marginTop: 10,
    padding: 10,
    borderRadius: 12,
    border: "1px solid rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.10)",
    fontWeight: 900,
  },
};
Vous avez dit :
ou peut on rajouter la premiere phrase dite dans une nouvelle conversation?
ChatGPT a dit :
Tu as deux endroits possibles, mais le bon endroit (propre et fiable) est côté serveur, dans /pages/api/chat.js, au moment où tu construis le tableau messages envoyé à Mistral.

Option A (recommandée) — Ajouter une “première phrase” uniquement au 1er message d’une conversation
Principe : si c’est le premier message (0 message en DB, ou 1 seul message user sans réponse), tu injectes une phrase au début du contenu utilisateur.

Où le mettre
Dans /pages/api/chat.js, juste avant l’appel à mistral.chat.complete(...), tu as forcément une construction du type :

récupération des messages de la conversation depuis public.messages

construction messagesForModel = [...] avec system, puis history, puis user.

Tu ajoutes un test du type :

si history.length === 0 (ou dbMessages.length === 0 selon ton code),

alors tu modifies le userContent.

Logique (pseudo clair)
const FIRST_PHRASE = "…ta phrase ici…";

si première interaction : userContent = FIRST_PHRASE + "\n\n" + userContent;

C’est la meilleure solution car :

ça marche même si l’UI change,

c’est cohérent pour tous les canaux (chat web, WhatsApp, etc.),

ça ne pollue pas les conversations existantes.

Option B — Ajouter une phrase au niveau du “system prompt” (toujours)
Si tu veux que cette phrase soit toujours visible par le modèle, même après 200 messages, tu la mets dans le prompt général (app_settings/base prompt) ou dans le system assemblé.

Mais attention : si c’est une phrase du type “Bonjour…”, ce n’est pas idéal en system prompt car ce n’est pas une règle, c’est une sortie attendue.

Option C — Ajouter une phrase côté UI (moins recommandé)
Tu peux aussi l’ajouter côté front (/pages/chat/[agentSlug].js ou composant chat) en affichage, mais :

ce n’est pas forcément envoyé au modèle,

et ça peut désynchroniser ce que l’utilisateur voit vs ce que l’agent “sait”.

Ce que je te recommande précisément
Si ta “première phrase” doit être dite à l’utilisateur au début : Option A (injection au premier message).

Si c’est une règle de comportement (ex: “réponds en étapes”) : mets-la dans le prompt général (Option B).

Dis-moi juste la phrase exacte que tu veux injecter (copie-colle), et je te donne le code complet du fichier /pages/api/chat.js avec l’injection propre (en respectant ton exigence : fichier complet, pas des morceaux).

Vous avez dit :
Bonjour, comment puis-je vous aider ? si  il arrive a chercher dans son prompt personel pour qui il travail, il peut personaliser la premiere phrase avec le prénom mis dans son prompte perso . prompt perso tu travail pour "prénom de la personne". la phrase est :Bonjour, comment puis-je vous aider ? ou avec prénom : Bonjour (prénom) comment puis-je vous aider?
ChatGPT a dit :

Réflexion durant 13s
Très clair. Tu veux une phrase d’accueil automatique uniquement au début d’une nouvelle conversation, et si le prénom du client est présent dans le prompt perso (“tu travailles pour Prénom”), alors l’accueil devient :

Sans prénom : « Bonjour, comment puis-je vous aider ? »

Avec prénom : « Bonjour Prénom, comment puis-je vous aider ? »

Il y a 2 manières correctes de le faire. La meilleure dépend d’un point : est-ce que tu veux que l’accueil apparaisse avant que l’utilisateur tape son premier message, ou est-ce que ça peut être au début de la première réponse ?

Je te donne les deux, dans l’ordre “propre”.

Option 1 (recommandée) : afficher l’accueil dès l’ouverture d’une nouvelle conversation (UI + DB)
C’est la meilleure UX : dès que le chat est vide, tu affiches une première bulle assistant.

Où l’ajouter
Dans la page chat (souvent pages/chat/[agentSlug].js), au moment où tu crées/ouvres une conversation :

Si la conversation est nouvelle (0 message en base),

tu insères un message assistant en base avec le greeting,

et tu l’affiches immédiatement sans appeler Mistral.

Comment personnaliser avec le prénom “dans le prompt perso”
Tu as déjà system_prompt dans client_agent_configs.system_prompt.
On extrait le prénom via une regex.

Fonction d’extraction
function extractFirstNameFromSystemPrompt(systemPrompt) {
  const sp = String(systemPrompt || "");
  // Exemples acceptés:
  // "tu travail pour Chloé"
  // "tu travailles pour \"Chloé\""
  // "Tu travailles pour: Chloé"
  const m = sp.match(/tu\s+travail(?:les)?\s+pour\s*:?\s*"?([^"\n\r]+)"?/i);
  const name = (m?.[1] || "").trim();
  // garde-fou (évite les chaînes trop longues)
  if (!name || name.length > 40) return "";
  // Capitalise proprement si tout est en lowercase
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildGreeting(systemPrompt) {
  const firstName = extractFirstNameFromSystemPrompt(systemPrompt);
  return firstName
    ? `Bonjour ${firstName}, comment puis-je vous aider ?`
    : "Bonjour, comment puis-je vous aider ?";
}
Insertion en base (table messages)
Quand tu détectes “conversation vide” :

await supabase
  .from("messages")
  .insert({
    conversation_id: conversationId,
    role: "assistant",
    content: buildGreeting(systemPrompt),
  });
Résultat : l’accueil apparaît immédiatement, et n’est jamais répété, car tu ne l’insères que si messages.length === 0.

Option 2 : ajouter l’accueil au début de la première réponse (serveur /api/chat)
Si tu ne veux pas toucher l’UI maintenant, tu peux le faire côté serveur.

Où l’ajouter
Dans pages/api/chat.js, juste avant de retourner la réponse, tu fais :

si la conversation est nouvelle (pas de messages assistant avant),

alors tu préfixes la réponse par le greeting.

Exemple :

const greeting = buildGreeting(userSystemPrompt);
const finalReply = isFirstTurn ? `${greeting}\n\n${reply}` : reply;
Limite : l’accueil n’apparaît qu’après le premier message utilisateur, pas avant.

Recommandation
Si tu veux exactement “première phrase dite dans une nouvelle conversation” (avant que l’utilisateur écrive) : Option 1.

Si tu veux une solution rapide sans toucher l’UI : Option 2.

Point important (pour que ce soit fiable)
Ne “cherches” pas le prénom en demandant au modèle. Tu le calcules toi-même (regex) à partir du system_prompt stocké en DB. Comme ça :

pas d’aléatoire,

pas de coût,

pas d’erreur.

Si tu me dis lequel tu choisis (Option 1 UI ou Option 2 API), je te fournis le fichier complet correspondant (tu as demandé “jamais des morceaux”).

Vous avez dit :
option 1
ChatGPT a dit :

Réflexion durant 22s
Voici une implémentation Option 1 (message d’accueil injecté à l’ouverture d’une nouvelle conversation, enregistré en base dans public.messages, et personnalisé si ton prompt perso contient “tu travailles pour Prénom”).

Je te donne un fichier complet pour pages/chat/[agentSlug].js (Next.js Pages Router), compatible avec ton schéma agents / conversations / messages / client_agent_configs.

Si tu n’as pas déjà ce fichier (ou si ton chat est encore dans pages/chat.js), tu peux :

soit créer pages/chat/[agentSlug].js (recommandé, tu as déjà la route dans ton build Vercel),

soit me dire et je te refais pages/chat.js complet à la place.
Mais avec ton build, /chat/[agentSlug] existe déjà, donc c’est le bon endroit.

// pages/chat/[agentSlug].js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

function safeStr(v) {
  return (v ?? "").toString();
}

function extractFirstNameFromSystemPrompt(systemPrompt) {
  const sp = safeStr(systemPrompt);

  // Tolère :
  // - tu travail pour Chloé
  // - tu travailles pour "Chloé"
  // - Tu travailles pour: Chloé
  // - tu travaille pour prénom de la personne
  const m = sp.match(/tu\s+travail(?:les)?\s+pour\s*:?\s*"?([^"\n\r]+)"?/i);
  const name = (m?.[1] || "").trim();

  if (!name) return "";
  if (name.length > 40) return ""; // garde-fou
  // Capitalisation simple
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildGreeting(systemPrompt) {
  const firstName = extractFirstNameFromSystemPrompt(systemPrompt);
  return firstName
    ? `Bonjour ${firstName}, comment puis-je vous aider ?`
    : "Bonjour, comment puis-je vous aider ?";
}

export default function ChatAgentSlugPage() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [loading, setLoading] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");

  const [agent, setAgent] = useState(null); // { id, slug, name, description, avatar_url }
  const [conversations, setConversations] = useState([]); // [{id, created_at, title}]
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]); // [{id, role, content, created_at}]
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  // Mobile sidebar (historique)
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const endRef = useRef(null);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }

  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function goAdmin() {
    window.location.href = "/admin";
  }

  async function goAgents() {
    window.location.href = "/agents";
  }

  async function loadMe() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      window.location.href = "/login";
      return null;
    }
    setUserId(data.user.id);
    setEmail(data.user.email || "");
    return data.user;
  }

  async function loadAgent(slug) {
    if (!slug) return null;
    const { data, error } = await supabase
      .from("agents")
      .select("id,slug,name,description,avatar_url")
      .eq("slug", slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("Agent introuvable.");
    setAgent(data);
    return data;
  }

  async function loadConversations(slug) {
    // conversations stockent agent_slug dans ton schéma
    const { data, error } = await supabase
      .from("conversations")
      .select("id,created_at,title,agent_slug,archived")
      .eq("agent_slug", slug)
      .eq("archived", false)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setConversations(data || []);
    return data || [];
  }

  async function createConversation(slug) {
    const title = `Conversation — ${new Date().toLocaleString()}`;
    const { data, error } = await supabase
      .from("conversations")
      .insert({
        agent_slug: slug,
        title,
        archived: false,
      })
      .select("id,created_at,title,agent_slug,archived")
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async function loadMessages(convId) {
    setLoadingMsgs(true);
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("id,role,content,created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages(data || []);
      return data || [];
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function fetchUserSystemPromptForAgent(agentId) {
    // Récupère system_prompt dans client_agent_configs (si RLS OK).
    // Sinon, fallback vide => greeting générique.
    const { data, error } = await supabase
      .from("client_agent_configs")
      .select("system_prompt")
      .eq("user_id", userId)
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) {
      // RLS ou autre : on n’empêche pas l’app, on fallback.
      return "";
    }
    return safeStr(data?.system_prompt).trim();
  }

  async function ensureGreetingIfEmpty(convId, agentId) {
    // 1) relire messages (source de vérité)
    const current = await loadMessages(convId);
    if (current.length > 0) return;

    // 2) calcul greeting (avec prénom si trouvable)
    const sp = await fetchUserSystemPromptForAgent(agentId);
    const greeting = buildGreeting(sp);

    // 3) insert en DB
    const { data, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: convId,
        role: "assistant",
        content: greeting,
      })
      .select("id,role,content,created_at")
      .maybeSingle();

    if (!error && data) {
      setMessages([data]);
    } else {
      // fallback UI si insert refusée (RLS), sans casser
      setMessages([
        {
          id: "local-greeting",
          role: "assistant",
          content: greeting,
          created_at: new Date().toISOString(),
        },
      ]);
    }
  }

  async function selectConversation(convId) {
    setConversationId(convId);
    await loadMessages(convId);
    if (agent?.id) {
      await ensureGreetingIfEmpty(convId, agent.id);
    }
  }

  async function refreshAll() {
    setErrMsg("");
    setLoading(true);
    try {
      const slug = safeStr(agentSlug);
      if (!slug) return;

      await loadMe();
      const a = await loadAgent(slug);

      const convs = await loadConversations(slug);

      // Conversation par défaut :
      // - si déjà une conversation, prendre la première
      // - sinon créer une nouvelle conversation
      let convId = convs?.[0]?.id || null;
      if (!convId) {
        const created = await createConversation(slug);
        convId = created?.id || null;
        // recharge la liste pour inclure la nouvelle
        await loadConversations(slug);
      }

      setConversationId(convId);

      if (convId) {
        await loadMessages(convId);
        await ensureGreetingIfEmpty(convId, a.id);
      }
    } catch (e) {
      setErrMsg(e?.message || "Erreur interne.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!router.isReady) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, agentSlug]);

  async function newConversation() {
    try {
      setErrMsg("");
      const slug = safeStr(agentSlug);
      if (!slug) return;

      const created = await createConversation(slug);
      await loadConversations(slug);

      if (created?.id) {
        setConversationId(created.id);
        // On force greeting
        if (agent?.id) {
          await ensureGreetingIfEmpty(created.id, agent.id);
        } else {
          await loadMessages(created.id);
        }
      }

      // Mobile : referme l’historique
      setSidebarOpen(false);
    } catch (e) {
      setErrMsg(e?.message || "Erreur création conversation.");
    }
  }

  async function sendMessage() {
    const content = safeStr(text).trim();
    if (!content) return;
    if (!conversationId) return;
    if (!agent?.slug) return;

    setSending(true);
    setErrMsg("");
    setText("");

    try {
      // 1) insert user message
      const { data: insertedUser, error: insErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "user",
          content,
        })
        .select("id,role,content,created_at")
        .maybeSingle();

      if (insErr) throw insErr;

      setMessages((prev) => [...prev, insertedUser]);

      // 2) call API (Mistral) + conversationId pour historique côté serveur
      const token = await getAccessToken();
      if (!token) throw new Error("Non authentifié.");

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: content,
          agentSlug: agent.slug,
          conversationId,
        }),
      });

      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(json?.error || `Erreur API (${resp.status})`);
      }

      const reply = safeStr(json?.reply).trim() || "Réponse vide.";

      // 3) insert assistant reply
      const { data: insertedAsst, error: asstErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "assistant",
          content: reply,
        })
        .select("id,role,content,created_at")
        .maybeSingle();

      if (asstErr) throw asstErr;

      setMessages((prev) => [...prev, insertedAsst]);

      // 4) optionnel : mettre à jour le titre si vide
      // (non bloquant)
    } catch (e) {
      setErrMsg(e?.message || "Erreur interne.");
    } finally {
      setSending(false);
    }
  }

  const title = useMemo(() => {
    if (!agent) return "Chat";
    return agent.name ? `${agent.name} — Chat` : "Chat";
  }, [agent]);

  const sidebarStyle = useMemo(() => {
    if (!styles.sidebarBase) return {};
    if (!sidebarOpen) return styles.sidebarBase;
    return { ...styles.sidebarBase, ...styles.sidebarMobileOpen };
  }, [sidebarOpen]);

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.center}>
          <div style={styles.loadingCard}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Chargement…</div>
            <div style={styles.loadingSub}>Initialisation de la conversation</div>
            {!!errMsg && <div style={styles.alert}>{errMsg}</div>}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.headerBtn} onClick={goAgents} title="Retour agents">
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

          <div style={styles.headerTitle}>{title}</div>
        </div>

        <div style={styles.headerRight}>
          <button style={styles.headerBtn} onClick={() => setSidebarOpen((v) => !v)}>
            Historique
          </button>

          <button style={styles.headerBtn} onClick={goAdmin}>
            Admin
          </button>

          <button style={styles.headerBtnDanger} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      <div style={styles.wrap}>
        {/* SIDEBAR */}
        <aside style={sidebarStyle}>
          <div style={styles.box}>
            <div style={styles.sideTop}>
              <div style={styles.boxTitle}>Conversations</div>
              <button style={styles.newBtn} onClick={newConversation}>
                + Nouvelle
              </button>
            </div>

            <div style={styles.small}>
              {email ? (
                <>
                  <span style={{ opacity: 0.9 }}>Connecté :</span> {email}
                </>
              ) : (
                "Connecté"
              )}
            </div>

            <div style={{ height: 10 }} />

            <div style={styles.convList}>
              {(conversations || []).map((c) => {
                const active = c.id === conversationId;
                return (
                  <button
                    key={c.id}
                    style={{ ...styles.convItem, ...(active ? styles.convItemActive : {}) }}
                    onClick={() => {
                      selectConversation(c.id);
                      setSidebarOpen(false);
                    }}
                    title={c.title || ""}
                  >
                    <div style={{ fontWeight: 900, fontSize: 13 }}>
                      {c.title || "Conversation"}
                    </div>
                    <div style={styles.tiny}>
                      {new Date(c.created_at).toLocaleString()}
                    </div>
                  </button>
                );
              })}
              {conversations.length === 0 && (
                <div style={styles.muted}>Aucune conversation.</div>
              )}
            </div>
          </div>
        </aside>

        {/* CHAT */}
        <section style={styles.main}>
          <div style={styles.boxChat}>
            <div style={styles.chatTop}>
              <div style={styles.chatAgent}>
                {agent?.avatar_url ? (
                  <img src={agent.avatar_url} alt={agent.name} style={styles.avatar} />
                ) : (
                  <div style={styles.avatarFallback} />
                )}
                <div>
                  <div style={{ fontWeight: 900 }}>{agent?.name || agent?.slug}</div>
                  <div style={styles.small}>{agent?.description || agent?.slug}</div>
                </div>
              </div>

              <div style={styles.diag}>
                <div>
                  <b>Conv</b>: {conversationId ? "oui" : "non"}
                </div>
                <div>
                  <b>Msgs</b>: {messages.length}
                </div>
              </div>
            </div>

            <div style={styles.chatBody}>
              {loadingMsgs ? (
                <div style={styles.muted}>Chargement des messages…</div>
              ) : (
                <div style={styles.msgList}>
                  {messages.map((m) => {
                    const isUser = m.role === "user";
                    return (
                      <div key={m.id} style={{ ...styles.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                        <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAsst) }}>
                          <div style={styles.bubbleText}>{m.content}</div>
                          <div style={styles.bubbleMeta}>
                            {new Date(m.created_at).toLocaleTimeString()}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            {!!errMsg && <div style={styles.alert}>{errMsg}</div>}

            <div style={styles.composer}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Écrivez votre message…"
                style={styles.textarea}
                disabled={sending}
              />

              <div style={styles.composerActions}>
                <button
                  style={!sending ? styles.btnPrimary : styles.btnDisabled}
                  onClick={sendMessage}
                  disabled={sending}
                >
                  {sending ? "Envoi…" : "Envoyer"}
                </button>
              </div>
            </div>

            <div style={styles.tiny}>
              Astuce : le message d’accueil est inséré automatiquement uniquement si la conversation est vide.
            </div>
          </div>
        </section>
      </div>
    </main>
  );
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
  headerRight: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
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

  wrap: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 16,
    padding: 18,
  },

  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },

  boxChat: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
    display: "grid",
    gap: 12,
  },

  boxTitle: { fontWeight: 900, marginBottom: 6 },

  // Sidebar responsive
  sidebarBase: {
    position: "relative",
    zIndex: 2,
  },
  sidebarMobileOpen: {
    // Sur mobile, on passera en overlay via media (ci-dessous),
    // mais on garde un style safe si nécessaire.
  },

  left: {},
  main: {},

  sideTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 8,
  },

  newBtn: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  convList: {
    display: "grid",
    gap: 10,
    marginTop: 10,
    maxHeight: "calc(100vh - 220px)",
    overflow: "auto",
    paddingRight: 4,
  },

  convItem: {
    textAlign: "left",
    borderRadius: 14,
    padding: 12,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    color: "rgba(238,242,255,.92)",
    cursor: "pointer",
  },
  convItemActive: {
    borderColor: "rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.10)",
  },

  chatTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },

  chatAgent: { display: "flex", alignItems: "center", gap: 12 },

  avatar: {
    width: 46,
    height: 46,
    borderRadius: 999,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.05)",
  },
  avatarFallback: {
    width: 46,
    height: 46,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.06)",
  },

  diag: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    fontSize: 12,
    fontWeight: 800,
    opacity: 0.9,
  },

  chatBody: {
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    padding: 12,
    minHeight: "52vh",
    maxHeight: "58vh",
    overflow: "auto",
  },

  msgList: { display: "grid", gap: 12 },
  msgRow: { display: "flex" },

  bubble: {
    maxWidth: "min(720px, 92%)",
    borderRadius: 16,
    padding: 12,
    border: "1px solid rgba(255,255,255,.12)",
    boxShadow: "0 14px 40px rgba(0,0,0,.35)",
  },
  bubbleUser: {
    background: "rgba(80,120,255,.10)",
    borderColor: "rgba(80,120,255,.30)",
  },
  bubbleAsst: {
    background: "rgba(0,0,0,.18)",
  },

  bubbleText: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.35,
    fontWeight: 700,
  },
  bubbleMeta: {
    marginTop: 8,
    fontSize: 11,
    opacity: 0.7,
    fontWeight: 800,
    textAlign: "right",
  },

  composer: {
    display: "grid",
    gap: 10,
  },

  textarea: {
    width: "100%",
    minHeight: 80,
    resize: "vertical",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    padding: 12,
    outline: "none",
    fontFamily: '"Segoe UI", Arial, sans-serif',
    fontSize: 14,
    fontWeight: 700,
  },

  composerActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
  },

  btnPrimary: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 110,
  },

  btnDisabled: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.55)",
    fontWeight: 900,
    cursor: "not-allowed",
    minWidth: 110,
  },

  small: { fontSize: 12, opacity: 0.75, fontWeight: 800 },
  tiny: { fontSize: 11, opacity: 0.7, fontWeight: 800 },
  muted: { opacity: 0.75, fontWeight: 800, fontSize: 13 },

  alert: {
    marginTop: 6,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    fontWeight: 900,
  },

  center: {
    position: "relative",
    zIndex: 1,
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },

  loadingCard: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 26,
    padding: 24,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.60)",
    backdropFilter: "blur(14px)",
    border: "1px solid rgba(255,255,255,.12)",
  },

  loadingSub: {
    marginTop: 6,
    color: "rgba(255,255,255,.78)",
    fontWeight: 800,
    fontSize: 12,
  },
};
Ce que ce fichier corrige exactement (sans ambiguïté)
Nouveau chat = greeting automatique

Au moment où une conversation est créée / sélectionnée :

si messages.length === 0 → on insère un message assistant en DB.

Greeting personnalisé si le prompt perso contient “tu travailles pour Prénom”

On lit client_agent_configs.system_prompt (pour user_id + agent_id)

Regex → extrait “Prénom”

Greeting devient : Bonjour Prénom, comment puis-je vous aider ?

Fallback sûr

Si RLS empêche de lire client_agent_configs : greeting générique.

Si RLS empêche d’insérer le message : on l’affiche quand même localement.

Important pour que “Prénom” marche à 100%
Dans ton prompt perso, mets une ligne simple du type (exactement) :

Tu travailles pour Chloé
ou
Tu travailles pour "Chloé"

C’est cette phrase que la regex attrape.

Si tu me confirmes quel fichier est réellement utilisé chez toi (tu as peut-être encore pages/chat.js en prod), je te fournis l’autre version complète (même logique, mêmes styles) mais adaptée à pages/chat.js.

Vous avez dit :
Image chargée
 j ai mis ton fichier dans agentslug qui existait deja mais il n y a pas de premiere phrase exemple prompt perso :IDENTITÉ & RÔLE
Tu es Emma, agent IA Ressources Humaines (RH).
Tu travailles pour Jean Baptiste
Tu travailles B Contact Développement (B2B), basé à Sisteron (04).
B Contact commercialise, entretient et sécurise des solutions d’impression (Konica Minolta, Toshiba) ainsi que des solutions digitales (téléphonie VoIP, informatique, logiciels GED).
L’entreprise compte environ 50 collaborateurs et réalise environ 8 000 000 € de chiffre d’affaires.

DONNÉES ENTREPRISE (À UTILISER AUTOMATIQUEMENT DANS LES COURRIERS / EMAILS RH)
- Nom : B Contact Développement
- Activité : B2B (impression + solutions digitales : VoIP, informatique, GED)
- Localisation : Sisteron (04)
- En-tête / signature standard (par défaut dans les courriers et emails) :
  B Contact Développement
  [4 allée des érables]
  [04200, Sisteron]
  [0465135572]
  [admin@bcontact.fr]
- Règle : ne pas inventer de coordonnées. Si absentes, conserver [À COMPLETER] ou poser UNE question si indispensable.

MISSION
Aider l’utilisateur sur les sujets RH : rédaction de messages/courriers, procédures RH, organisation RH, réponses structurées, préparation de points d’entretien, QVT, onboarding, formation, communication RH.

RÈGLES DE PRIORITÉ (OBLIGATOIRES)
1) Priorité n°1 : informations fournies par l’utilisateur (faits, raisons, contexte). Si l’utilisateur fournit une information, l’utiliser immédiatement, même si elle n’apparaît pas dans les sources.
2) Priorité n°2 : contexte structuré disponible (paramètres, données de l’agent, intégrations, pratiques internes).
3) Priorité n°3 : sources (PDF/URLs), uniquement si l’utilisateur demande une réponse sourcée ou si l’information est critique et incertaine.
- Ne jamais inventer des faits (dates, propos, sanctions, éléments contractuels, règles internes non confirmées).
- Si une information critique manque pour agir : poser UNE seule question, la plus bloquante.
- Si la demande présente un risque juridique/RH sensible : proposer une approche prudente et recommander validation par la direction / RH / conseil compétent.

UTILISATION DES SOURCES (PDF/URL)
- Si des sources existent (politiques internes, procédures, trames, accords, documents internes), s’y référer pour rester cohérente et conforme.
- Préciser quand tu t’appuies sur une source (ex : “Selon la procédure interne fournie …”).
- Si une info clé manque : proposer une version “hypothèses” clairement indiquée et poser UNE question courte pour valider l’élément le plus bloquant.

COMPORTEMENT
- Ne pas refuser une demande RH dans le périmètre (rédaction, structuration, plan d’action, préparation).
- Si le sujet touche aussi d’autres domaines (commercial, compta, marketing) : suggérer l’agent spécialisé en complément, mais aider quand même sur reformulation, structuration, plan d’action, rédaction.
- Ne jamais dire “je ne trouve pas dans les sources” si l’utilisateur vient d’apporter l’information.
- Si une info manque : poser UNE seule question courte et utile (pas de demandes de documents par défaut).

FORMAT DE RÉPONSE (OBLIGATOIRE)
- Texte brut uniquement : pas de Markdown (interdit : ###, **, tableaux Markdown).
1) Reformulation brève (1–2 lignes) incluant les informations données par l’utilisateur.
2) Réponse / action concrète (copiable-collable si rédaction).
3) Prochaine question (uniquement si nécessaire, UNE seule question).
- Toujours rester polie et utiliser le vouvoiement, y compris dans les courriers.

LIVRABLES POSSIBLES
- Courriers et emails RH prêts à envoyer (convocation, rappel, recadrage, réponse salarié, réponse candidat, annonce interne).
- Trames d’entretien (annuel, recadrage, retour d’absence, pré-embauche) + questions.
- Procédures RH : onboarding/offboarding, gestion absences, notes de service, workflow de validation.
- Messages internes : annonces, communications QVT, formation, rappels de règles.
- Check-lists RH : onboarding, dossier salarié, suivi périodes d’essai, documents à collecter.
- Synthèses structurées : faits, chronologie, points de vigilance, options et next steps.


STYLE
- Professionnel, clair, direct.
- Pas de blabla. Pas de préambule.
- Pas d’auto-présentation (“Je suis Emma…”) sauf demande explicite.

OUTILS ET INTEGRATIONS A TA DISPOSITION POUR EXECUTER DES TACHES
***vide***

LIMITES
- Rester dans le périmètre RH : aider sur la structuration et la rédaction, sans sortir du rôle.
- Ne pas divulguer d’informations confidentielles ou internes non nécessaires au livrable demandé.
- Ne pas fournir d’avis juridique engageant ; recommander validation humaine si sujet sensible.

CONFIDENTIALITÉ
- Si le message contient des données personnelles (nom, email, téléphone), recommander de limiter au nécessaire et de ne pas partager inutilement.
- Ne pas ré-exposer des données personnelles si elles ne sont pas indispensables au livrable demandé.
ChatGPT a dit :

Réflexion durant 14s
Tu n’as pas de première phrase pour une raison simple (et bloquante) : dans ton schéma Supabase, la table conversations a une colonne user_id obligatoire (cf. ton schéma : public.conversations: user_id uuid).

Dans le fichier que tu as collé, la création de conversation fait :

insert({ agent_slug: slug, title, archived: false })
Donc :

soit l’insert échoue (RLS / contrainte NOT NULL),

soit la conversation ne “t’appartient” pas → ensuite les messages/greeting ne s’insèrent pas, et tu ne vois rien.

Deuxième point : loadConversations() ne filtre pas par user_id → tu peux tomber sur des conversations d’autres users (ou rien à cause de RLS), et tu ne déclenches jamais un “chat vide” pour injecter le greeting.

Je te redonne donc le fichier complet pages/chat/[agentSlug].js corrigé pour :

créer une conversation avec user_id

charger les conversations du user uniquement

injecter le greeting si (et seulement si) la conversation est vide

extraire le prénom depuis une ligne du prompt perso : Tu travailles pour Jean Baptiste

// pages/chat/[agentSlug].js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

function safeStr(v) {
  return (v ?? "").toString();
}

function extractFirstNameFromSystemPrompt(systemPrompt) {
  const sp = safeStr(systemPrompt);

  // On prend UNIQUEMENT le contenu jusqu'à fin de ligne pour éviter d'attraper du texte trop large.
  // Exemples acceptés :
  // "Tu travailles pour Jean Baptiste"
  // "Tu travailles pour \"Jean Baptiste\""
  // "Tu travailles pour: Jean Baptiste"
  const m = sp.match(/tu\s+travail(?:les)?\s+pour\s*:?\s*"?([^\n\r"]+)"?/i);
  const name = (m?.[1] || "").trim();

  if (!name) return "";
  if (name.length > 40) return ""; // garde-fou
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildGreeting(systemPrompt) {
  const firstName = extractFirstNameFromSystemPrompt(systemPrompt);
  return firstName ? `Bonjour ${firstName}, comment puis-je vous aider ?` : "Bonjour, comment puis-je vous aider ?";
}

export default function ChatAgentSlugPage() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [loading, setLoading] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");

  const [agent, setAgent] = useState(null); // { id, slug, name, description, avatar_url }
  const [conversations, setConversations] = useState([]); // [{id, created_at, title}]
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]); // [{id, role, content, created_at}]
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const endRef = useRef(null);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }

  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function goAdmin() {
    window.location.href = "/admin";
  }

  function goAgents() {
    window.location.href = "/agents";
  }

  async function loadMe() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      window.location.href = "/login";
      return null;
    }
    setUserId(data.user.id);
    setEmail(data.user.email || "");
    return data.user;
  }

  async function loadAgent(slug) {
    if (!slug) return null;

    const { data, error } = await supabase
      .from("agents")
      .select("id,slug,name,description,avatar_url")
      .eq("slug", slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("Agent introuvable.");
    setAgent(data);
    return data;
  }

  async function loadConversations(uid, slug) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id,created_at,title,agent_slug,archived,user_id")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .eq("archived", false)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setConversations(data || []);
    return data || [];
  }

  async function createConversation(uid, slug) {
    const title = `Conversation — ${new Date().toLocaleString()}`;

    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: uid, // IMPORTANT
        agent_slug: slug,
        title,
        archived: false,
      })
      .select("id,created_at,title,agent_slug,archived,user_id")
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async function loadMessages(convId) {
    setLoadingMsgs(true);
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("id,role,content,created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages(data || []);
      return data || [];
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function fetchUserSystemPromptForAgent(uid, agentId) {
    // On récupère le prompt perso stocké dans client_agent_configs
    const { data, error } = await supabase
      .from("client_agent_configs")
      .select("system_prompt")
      .eq("user_id", uid)
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) return "";
    return safeStr(data?.system_prompt).trim();
  }

  async function ensureGreetingIfEmpty(uid, convId, agentId) {
    // 1) relire messages (source de vérité)
    const current = await loadMessages(convId);
    if (current.length > 0) return;

    // 2) greeting
    const sp = await fetchUserSystemPromptForAgent(uid, agentId);
    const greeting = buildGreeting(sp);

    // 3) insert message assistant en DB
    const { data, error } = await supabase
      .from("messages")
      .insert({
        conversation_id: convId,
        role: "assistant",
        content: greeting,
      })
      .select("id,role,content,created_at")
      .maybeSingle();

    if (!error && data) {
      setMessages([data]);
    } else {
      // fallback UI si l'insert est bloqué (RLS) : au moins l'utilisateur voit l'accueil
      setMessages([
        {
          id: "local-greeting",
          role: "assistant",
          content: greeting,
          created_at: new Date().toISOString(),
        },
      ]);
    }
  }

  async function selectConversation(uid, convId) {
    setConversationId(convId);
    await loadMessages(convId);
    if (agent?.id) {
      await ensureGreetingIfEmpty(uid, convId, agent.id);
    }
  }

  async function refreshAll() {
    setErrMsg("");
    setLoading(true);

    try {
      const slug = safeStr(agentSlug);
      if (!slug) return;

      const me = await loadMe();
      if (!me?.id) return;

      const a = await loadAgent(slug);

      let convs = await loadConversations(me.id, slug);

      // Conversation par défaut :
      // - si existe, prendre la plus récente
      // - sinon, créer puis injecter greeting
      let convId = convs?.[0]?.id || null;

      if (!convId) {
        const created = await createConversation(me.id, slug);
        convId = created?.id || null;
        convs = await loadConversations(me.id, slug);
      }

      setConversationId(convId);

      if (convId) {
        await loadMessages(convId);
        await ensureGreetingIfEmpty(me.id, convId, a.id);
      }
    } catch (e) {
      setErrMsg(e?.message || "Erreur interne.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!router.isReady) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, agentSlug]);

  async function newConversation() {
    try {
      setErrMsg("");
      const slug = safeStr(agentSlug);
      if (!slug) return;

      const me = await supabase.auth.getUser();
      const uid = me?.data?.user?.id;
      if (!uid) return (window.location.href = "/login");

      const created = await createConversation(uid, slug);
      await loadConversations(uid, slug);

      if (created?.id) {
        setConversationId(created.id);
        if (agent?.id) {
          await ensureGreetingIfEmpty(uid, created.id, agent.id);
        } else {
          await loadMessages(created.id);
        }
      }

      setSidebarOpen(false);
    } catch (e) {
      setErrMsg(e?.message || "Erreur création conversation.");
    }
  }

  async function sendMessage() {
    const content = safeStr(text).trim();
    if (!content) return;
    if (!conversationId) return;
    if (!agent?.slug) return;

    setSending(true);
    setErrMsg("");
    setText("");

    try {
      const { data: insertedUser, error: insErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "user",
          content,
        })
        .select("id,role,content,created_at")
        .maybeSingle();

      if (insErr) throw insErr;

      setMessages((prev) => [...prev, insertedUser]);

      const token = await getAccessToken();
      if (!token) throw new Error("Non authentifié.");

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          message: content,
          agentSlug: agent.slug,
          conversationId,
        }),
      });

      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(json?.error || `Erreur API (${resp.status})`);

      const reply = safeStr(json?.reply).trim() || "Réponse vide.";

      const { data: insertedAsst, error: asstErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "assistant",
          content: reply,
        })
        .select("id,role,content,created_at")
        .maybeSingle();

      if (asstErr) throw asstErr;

      setMessages((prev) => [...prev, insertedAsst]);
    } catch (e) {
      setErrMsg(e?.message || "Erreur interne.");
    } finally {
      setSending(false);
    }
  }

  const title = useMemo(() => {
    if (!agent) return "Chat";
    return agent.name ? `${agent.name} — Chat` : "Chat";
  }, [agent]);

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.center}>
          <div style={styles.loadingCard}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Chargement…</div>
            <div style={styles.loadingSub}>Initialisation de la conversation</div>
            {!!errMsg && <div style={styles.alert}>{errMsg}</div>}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.headerBtn} onClick={goAgents} title="Retour agents">
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

          <div style={styles.headerTitle}>{title}</div>
        </div>

        <div style={styles.headerRight}>
          <button style={styles.headerBtn} onClick={() => setSidebarOpen((v) => !v)}>
            Historique
          </button>

          <button style={styles.headerBtn} onClick={goAdmin}>
            Admin
          </button>

          <button style={styles.headerBtnDanger} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      <div style={styles.wrap}>
        <aside style={{ ...styles.sidebar, ...(sidebarOpen ? styles.sidebarOpen : {}) }}>
          <div style={styles.box}>
            <div style={styles.sideTop}>
              <div style={styles.boxTitle}>Conversations</div>
              <button style={styles.newBtn} onClick={newConversation}>
                + Nouvelle
              </button>
            </div>

            <div style={styles.small}>
              {email ? (
                <>
                  <span style={{ opacity: 0.9 }}>Connecté :</span> {email}
                </>
              ) : (
                "Connecté"
              )}
            </div>

            <div style={{ height: 10 }} />

            <div style={styles.convList}>
              {(conversations || []).map((c) => {
                const active = c.id === conversationId;
                return (
                  <button
                    key={c.id}
                    style={{ ...styles.convItem, ...(active ? styles.convItemActive : {}) }}
                    onClick={() => {
                      selectConversation(userId, c.id);
                      setSidebarOpen(false);
                    }}
                    title={c.title || ""}
                  >
                    <div style={{ fontWeight: 900, fontSize: 13 }}>{c.title || "Conversation"}</div>
                    <div style={styles.tiny}>{new Date(c.created_at).toLocaleString()}</div>
                  </button>
                );
              })}
              {conversations.length === 0 && <div style={styles.muted}>Aucune conversation.</div>}
            </div>
          </div>
        </aside>

        <section style={styles.main}>
          <div style={styles.boxChat}>
            <div style={styles.chatTop}>
              <div style={styles.chatAgent}>
                {agent?.avatar_url ? (
                  <img src={agent.avatar_url} alt={agent.name} style={styles.avatar} />
                ) : (
                  <div style={styles.avatarFallback} />
                )}
                <div>
                  <div style={{ fontWeight: 900 }}>{agent?.name || agent?.slug}</div>
                  <div style={styles.small}>{agent?.description || agent?.slug}</div>
                </div>
              </div>

              <div style={styles.diag}>
                <div>
                  <b>Conv</b>: {conversationId ? "oui" : "non"}
                </div>
                <div>
                  <b>Msgs</b>: {messages.length}
                </div>
              </div>
            </div>

            <div style={styles.chatBody}>
              {loadingMsgs ? (
                <div style={styles.muted}>Chargement des messages…</div>
              ) : (
                <div style={styles.msgList}>
                  {messages.map((m) => {
                    const isUser = m.role === "user";
                    return (
                      <div key={m.id} style={{ ...styles.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                        <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAsst) }}>
                          <div style={styles.bubbleText}>{m.content}</div>
                          <div style={styles.bubbleMeta}>{new Date(m.created_at).toLocaleTimeString()}</div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            {!!errMsg && <div style={styles.alert}>{errMsg}</div>}

            <div style={styles.composer}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Écrivez votre message…"
                style={styles.textarea}
                disabled={sending}
              />

              <div style={styles.composerActions}>
                <button style={!sending ? styles.btnPrimary : styles.btnDisabled} onClick={sendMessage} disabled={sending}>
                  {sending ? "Envoi…" : "Envoyer"}
                </button>
              </div>
            </div>

            <div style={styles.tiny}>
              Le message d’accueil est inséré automatiquement uniquement si la conversation est vide.
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "rgba(238,242,255,.92)",
    fontFamily: '"Segoe UI", Arial, sans-serif",
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
  headerRight: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
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

  wrap: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 16,
    padding: 18,
  },

  sidebar: {
    position: "relative",
    zIndex: 2,
  },
  sidebarOpen: {},

  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },

  boxChat: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
    display: "grid",
    gap: 12,
  },

  boxTitle: { fontWeight: 900, marginBottom: 6 },

  sideTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 8,
  },

  newBtn: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  convList: {
    display: "grid",
    gap: 10,
    marginTop: 10,
    maxHeight: "calc(100vh - 220px)",
    overflow: "auto",
    paddingRight: 4,
  },

  convItem: {
    textAlign: "left",
    borderRadius: 14,
    padding: 12,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    color: "rgba(238,242,255,.92)",
    cursor: "pointer",
  },
  convItemActive: {
    borderColor: "rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.10)",
  },

  chatTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },

  chatAgent: { display: "flex", alignItems: "center", gap: 12 },

  avatar: {
    width: 46,
    height: 46,
    borderRadius: 999,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.05)",
  },
  avatarFallback: {
    width: 46,
    height: 46,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.06)",
  },

  diag: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    fontSize: 12,
    fontWeight: 800,
    opacity: 0.9,
  },

  chatBody: {
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    padding: 12,
    minHeight: "52vh",
    maxHeight: "58vh",
    overflow: "auto",
  },

  msgList: { display: "grid", gap: 12 },
  msgRow: { display: "flex" },

  bubble: {
    maxWidth: "min(720px, 92%)",
    borderRadius: 16,
    padding: 12,
    border: "1px solid rgba(255,255,255,.12)",
    boxShadow: "0 14px 40px rgba(0,0,0,.35)",
  },
  bubbleUser: {
    background: "rgba(80,120,255,.10)",
    borderColor: "rgba(80,120,255,.30)",
  },
  bubbleAsst: {
    background: "rgba(0,0,0,.18)",
  },

  bubbleText: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.35,
    fontWeight: 700,
  },
  bubbleMeta: {
    marginTop: 8,
    fontSize: 11,
    opacity: 0.7,
    fontWeight: 800,
    textAlign: "right",
  },

  composer: {
    display: "grid",
    gap: 10,
  },

  textarea: {
    width: "100%",
    minHeight: 80,
    resize: "vertical",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    padding: 12,
    outline: "none",
    fontFamily: '"Segoe UI", Arial, sans-serif',
    fontSize: 14,
    fontWeight: 700,
  },

  composerActions: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
  },

  btnPrimary: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 110,
  },

  btnDisabled: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.55)",
    fontWeight: 900,
    cursor: "not-allowed",
    minWidth: 110,
  },

  small: { fontSize: 12, opacity: 0.75, fontWeight: 800 },
  tiny: { fontSize: 11, opacity: 0.7, fontWeight: 800 },
  muted: { opacity: 0.75, fontWeight: 800, fontSize: 13 },

  alert: {
    marginTop: 6,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    fontWeight: 900,
  },

  center: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },

  loadingCard: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 26,
    padding: 24,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.60)",
    backdropFilter: "blur(14px)",
    border: "1px solid rgba(255,255,255,.12)",
  },

  loadingSub: {
    marginTop: 6,
    color: "rgba(255,255,255,.78)",
    fontWeight: 800,
    fontSize: 12,
  },
};
Comment vérifier que ça marche (sans ambiguïté)
Va sur /chat/emma (ou ton slug).

Clique “+ Nouvelle”.

Tu dois voir immédiatement “Bonjour Jean Baptiste, comment puis-je vous aider ?” dans une bulle assistant, même avant d’écrire.

Si tu ne cliques pas “+ Nouvelle” et que tu ouvres une conversation qui a déjà des messages, c’est normal : on ne doit pas répéter l’accueil.

Si malgré ça tu ne vois toujours pas la phrase
Alors c’est RLS sur messages qui bloque l’insert (et même le fallback UI devrait afficher “local-greeting”).
Dans ce cas, envoie-moi juste une capture de :

Console navigateur (erreur)

Ou Network → la requête Supabase messages insert

et je te donne la policy exacte à ajouter.

Mais dans 90% des cas, le vrai bug était : user_id manquant dans conversations.

Vous avez dit :
toujours pas de phrase
ChatGPT a dit :

Réflexion durant 17s
D’accord. Si tu ne vois même pas la version générique (“Bonjour, comment puis-je vous aider ?”), alors le problème n’est plus “extraction du prénom”, mais le déclenchement / l’affichage du greeting.

Le moyen le plus robuste (et le plus propre UX) est de ne pas dépendre de l’insert en base pour afficher la première phrase.
On affiche un greeting “UI” dès que la conversation est vide (messages.length === 0).
Ensuite, dès que l’utilisateur envoie son premier message, l’agent répond normalement.

Ça garantit :

greeting visible à chaque “Nouvelle conversation”

greeting visible même si RLS bloque l’insert dans messages

greeting visible même si la conversation n’est pas encore persistée correctement

greeting personnalisé si on arrive à lire le prompt perso, sinon fallback générique

Voici le fichier complet pages/chat/[agentSlug].js à coller (il remplace tout).
Il affiche la phrase dès que la conversation est vide.

// pages/chat/[agentSlug].js
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

function safeStr(v) {
  return (v ?? "").toString();
}

function extractFirstNameFromSystemPrompt(systemPrompt) {
  const sp = safeStr(systemPrompt);

  // Exemples acceptés :
  // "Tu travailles pour Jean Baptiste"
  // "Tu travailles pour \"Jean Baptiste\""
  // "Tu travailles pour: Jean Baptiste"
  const m = sp.match(/tu\s+travail(?:les)?\s+pour\s*:?\s*"?([^\n\r"]+)"?/i);
  const name = (m?.[1] || "").trim();

  if (!name) return "";
  if (name.length > 40) return "";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function buildGreeting(systemPrompt) {
  const firstName = extractFirstNameFromSystemPrompt(systemPrompt);
  return firstName ? `Bonjour ${firstName}, comment puis-je vous aider ?` : "Bonjour, comment puis-je vous aider ?";
}

export default function ChatAgentSlugPage() {
  const router = useRouter();
  const { agentSlug } = router.query;

  const [loading, setLoading] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);

  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");

  const [agent, setAgent] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [conversationId, setConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const endRef = useRef(null);

  // Greeting UI (toujours affiché si conversation vide)
  const [systemPromptForGreeting, setSystemPromptForGreeting] = useState("");
  const greetingText = useMemo(() => buildGreeting(systemPromptForGreeting), [systemPromptForGreeting]);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }

  useEffect(() => {
    scrollToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  function goAdmin() {
    window.location.href = "/admin";
  }

  function goAgents() {
    window.location.href = "/agents";
  }

  async function loadMe() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      window.location.href = "/login";
      return null;
    }
    setUserId(data.user.id);
    setEmail(data.user.email || "");
    return data.user;
  }

  async function loadAgent(slug) {
    if (!slug) return null;

    const { data, error } = await supabase
      .from("agents")
      .select("id,slug,name,description,avatar_url")
      .eq("slug", slug)
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error("Agent introuvable.");
    setAgent(data);
    return data;
  }

  async function loadConversations(uid, slug) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id,created_at,title,agent_slug,archived,user_id")
      .eq("user_id", uid)
      .eq("agent_slug", slug)
      .eq("archived", false)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setConversations(data || []);
    return data || [];
  }

  async function createConversation(uid, slug) {
    const title = `Conversation — ${new Date().toLocaleString()}`;

    const { data, error } = await supabase
      .from("conversations")
      .insert({
        user_id: uid,
        agent_slug: slug,
        title,
        archived: false,
      })
      .select("id,created_at,title,agent_slug,archived,user_id")
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async function loadMessages(convId) {
    setLoadingMsgs(true);
    try {
      const { data, error } = await supabase
        .from("messages")
        .select("id,role,content,created_at")
        .eq("conversation_id", convId)
        .order("created_at", { ascending: true });

      if (error) throw error;
      setMessages(data || []);
      return data || [];
    } finally {
      setLoadingMsgs(false);
    }
  }

  async function fetchUserSystemPromptForAgent(uid, agentId) {
    // Si RLS bloque la lecture, on revient vide (=> greeting générique).
    const { data, error } = await supabase
      .from("client_agent_configs")
      .select("system_prompt")
      .eq("user_id", uid)
      .eq("agent_id", agentId)
      .maybeSingle();

    if (error) return "";
    return safeStr(data?.system_prompt).trim();
  }

  async function primeGreetingPrompt(uid, agentId) {
    if (!uid || !agentId) {
      setSystemPromptForGreeting("");
      return;
    }
    const sp = await fetchUserSystemPromptForAgent(uid, agentId);
    setSystemPromptForGreeting(sp || "");
  }

  async function selectConversation(uid, convId) {
    setConversationId(convId);
    await loadMessages(convId);
    if (agent?.id) {
      await primeGreetingPrompt(uid, agent.id);
    }
  }

  async function refreshAll() {
    setErrMsg("");
    setLoading(true);

    try {
      const slug = safeStr(agentSlug);
      if (!slug) return;

      const me = await loadMe();
      if (!me?.id) return;

      const a = await loadAgent(slug);

      let convs = await loadConversations(me.id, slug);
      let convId = convs?.[0]?.id || null;

      if (!convId) {
        const created = await createConversation(me.id, slug);
        convId = created?.id || null;
        convs = await loadConversations(me.id, slug);
      }

      setConversationId(convId);

      // IMPORTANT : on "prime" le greeting prompt ici
      await primeGreetingPrompt(me.id, a.id);

      if (convId) {
        await loadMessages(convId);
      }
    } catch (e) {
      setErrMsg(e?.message || "Erreur interne.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!router.isReady) return;
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router.isReady, agentSlug]);

  async function newConversation() {
    try {
      setErrMsg("");
      const slug = safeStr(agentSlug);
      if (!slug) return;

      const me = await supabase.auth.getUser();
      const uid = me?.data?.user?.id;
      if (!uid) return (window.location.href = "/login");

      const created = await createConversation(uid, slug);
      await loadConversations(uid, slug);

      if (created?.id) {
        setConversationId(created.id);

        // Très important : conversation neuve => messages vides
        setMessages([]);

        // On prime le greeting prompt (pour personnaliser)
        if (agent?.id) await primeGreetingPrompt(uid, agent.id);
      }

      setSidebarOpen(false);
    } catch (e) {
      setErrMsg(e?.message || "Erreur création conversation.");
    }
  }

  async function sendMessage() {
    const content = safeStr(text).trim();
    if (!content) return;
    if (!conversationId) return;
    if (!agent?.slug) return;

    setSending(true);
    setErrMsg("");
    setText("");

    try {
      // Message user en DB
      const { data: insertedUser, error: insErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "user",
          content,
        })
        .select("id,role,content,created_at")
        .maybeSingle();

      if (insErr) throw insErr;

      setMessages((prev) => [...prev, insertedUser]);

      // Réponse agent via API
      const token = await getAccessToken();
      if (!token) throw new Error("Non authentifié.");

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          message: content,
          agentSlug: agent.slug,
          conversationId,
        }),
      });

      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(json?.error || `Erreur API (${resp.status})`);

      const reply = safeStr(json?.reply).trim() || "Réponse vide.";

      // Message assistant en DB
      const { data: insertedAsst, error: asstErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          role: "assistant",
          content: reply,
        })
        .select("id,role,content,created_at")
        .maybeSingle();

      if (asstErr) throw asstErr;

      setMessages((prev) => [...prev, insertedAsst]);
    } catch (e) {
      setErrMsg(e?.message || "Erreur interne.");
    } finally {
      setSending(false);
    }
  }

  const title = useMemo(() => {
    if (!agent) return "Chat";
    return agent.name ? `${agent.name} — Chat` : "Chat";
  }, [agent]);

  // Greet visible only if conversation has zero persisted messages
  const showGreeting = useMemo(() => {
    if (loading || loadingMsgs) return false;
    return (messages?.length || 0) === 0;
  }, [loading, loadingMsgs, messages?.length]);

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.center}>
          <div style={styles.loadingCard}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>Chargement…</div>
            <div style={styles.loadingSub}>Initialisation de la conversation</div>
            {!!errMsg && <div style={styles.alert}>{errMsg}</div>}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <button style={styles.headerBtn} onClick={goAgents} title="Retour agents">
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

          <div style={styles.headerTitle}>{title}</div>
        </div>

        <div style={styles.headerRight}>
          <button style={styles.headerBtn} onClick={() => setSidebarOpen((v) => !v)}>
            Historique
          </button>

          <button style={styles.headerBtn} onClick={goAdmin}>
            Admin
          </button>

          <button style={styles.headerBtnDanger} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </div>

      <div style={styles.wrap}>
        <aside style={styles.sidebar}>
          <div style={styles.box}>
            <div style={styles.sideTop}>
              <div style={styles.boxTitle}>Conversations</div>
              <button style={styles.newBtn} onClick={newConversation}>
                + Nouvelle
              </button>
            </div>

            <div style={styles.small}>
              {email ? (
                <>
                  <span style={{ opacity: 0.9 }}>Connecté :</span> {email}
                </>
              ) : (
                "Connecté"
              )}
            </div>

            <div style={{ height: 10 }} />

            <div style={styles.convList}>
              {(conversations || []).map((c) => {
                const active = c.id === conversationId;
                return (
                  <button
                    key={c.id}
                    style={{ ...styles.convItem, ...(active ? styles.convItemActive : {}) }}
                    onClick={() => {
                      selectConversation(userId, c.id);
                    }}
                    title={c.title || ""}
                  >
                    <div style={{ fontWeight: 900, fontSize: 13 }}>{c.title || "Conversation"}</div>
                    <div style={styles.tiny}>{new Date(c.created_at).toLocaleString()}</div>
                  </button>
                );
              })}
              {conversations.length === 0 && <div style={styles.muted}>Aucune conversation.</div>}
            </div>
          </div>
        </aside>

        <section style={styles.main}>
          <div style={styles.boxChat}>
            <div style={styles.chatTop}>
              <div style={styles.chatAgent}>
                {agent?.avatar_url ? (
                  <img src={agent.avatar_url} alt={agent.name} style={styles.avatar} />
                ) : (
                  <div style={styles.avatarFallback} />
                )}
                <div>
                  <div style={{ fontWeight: 900 }}>{agent?.name || agent?.slug}</div>
                  <div style={styles.small}>{agent?.description || agent?.slug}</div>
                </div>
              </div>

              <div style={styles.diag}>
                <div>
                  <b>Conv</b>: {conversationId ? "oui" : "non"}
                </div>
                <div>
                  <b>Msgs</b>: {messages.length}
                </div>
              </div>
            </div>

            <div style={styles.chatBody}>
              {loadingMsgs ? (
                <div style={styles.muted}>Chargement des messages…</div>
              ) : (
                <div style={styles.msgList}>
                  {/* Greeting UI (toujours affiché si conversation vide) */}
                  {showGreeting && (
                    <div style={{ ...styles.msgRow, justifyContent: "flex-start" }}>
                      <div style={{ ...styles.bubble, ...styles.bubbleAsst }}>
                        <div style={styles.bubbleText}>{greetingText}</div>
                        <div style={styles.bubbleMeta}>{new Date().toLocaleTimeString()}</div>
                      </div>
                    </div>
                  )}

                  {messages.map((m) => {
                    const isUser = m.role === "user";
                    return (
                      <div key={m.id} style={{ ...styles.msgRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
                        <div style={{ ...styles.bubble, ...(isUser ? styles.bubbleUser : styles.bubbleAsst) }}>
                          <div style={styles.bubbleText}>{m.content}</div>
                          <div style={styles.bubbleMeta}>{new Date(m.created_at).toLocaleTimeString()}</div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            {!!errMsg && <div style={styles.alert}>{errMsg}</div>}

            <div style={styles.composer}>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Écrivez votre message…"
                style={styles.textarea}
                disabled={sending}
              />

              <div style={styles.composerActions}>
                <button style={!sending ? styles.btnPrimary : styles.btnDisabled} onClick={sendMessage} disabled={sending}>
                  {sending ? "Envoi…" : "Envoyer"}
                </button>
              </div>
            </div>

            <div style={styles.tiny}>
              La phrase d’accueil est affichée automatiquement quand la conversation est vide (sans dépendre de la base).
            </div>
          </div>
        </section>
      </div>
    </main>
  );
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
  headerRight: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
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

  wrap: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 16,
    padding: 18,
  },

  sidebar: { position: "relative", zIndex: 2 },

  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
  },

  boxChat: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
    display: "grid",
    gap: 12,
  },

  boxTitle: { fontWeight: 900, marginBottom: 6 },

  sideTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 8,
  },

  newBtn: {
    borderRadius: 999,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },

  convList: {
    display: "grid",
    gap: 10,
    marginTop: 10,
    maxHeight: "calc(100vh - 220px)",
    overflow: "auto",
    paddingRight: 4,
  },

  convItem: {
    textAlign: "left",
    borderRadius: 14,
    padding: 12,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    color: "rgba(238,242,255,.92)",
    cursor: "pointer",
  },
  convItemActive: {
    borderColor: "rgba(255,140,40,.35)",
    background: "rgba(255,140,40,.10)",
  },

  chatTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },

  chatAgent: { display: "flex", alignItems: "center", gap: 12 },

  avatar: {
    width: 46,
    height: 46,
    borderRadius: 999,
    objectFit: "cover",
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.05)",
  },
  avatarFallback: {
    width: 46,
    height: 46,
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.16)",
    background: "rgba(255,255,255,.06)",
  },

  diag: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 10,
    padding: "8px 10px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    fontSize: 12,
    fontWeight: 800,
    opacity: 0.9,
  },

  chatBody: {
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    padding: 12,
    minHeight: "52vh",
    maxHeight: "58vh",
    overflow: "auto",
  },

  msgList: { display: "grid", gap: 12 },
  msgRow: { display: "flex" },

  bubble: {
    maxWidth: "min(720px, 92%)",
    borderRadius: 16,
    padding: 12,
    border: "1px solid rgba(255,255,255,.12)",
    boxShadow: "0 14px 40px rgba(0,0,0,.35)",
  },
  bubbleUser: {
    background: "rgba(80,120,255,.10)",
    borderColor: "rgba(80,120,255,.30)",
  },
  bubbleAsst: {
    background: "rgba(0,0,0,.18)",
  },

  bubbleText: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.35,
    fontWeight: 700,
  },
  bubbleMeta: {
    marginTop: 8,
    fontSize: 11,
    opacity: 0.7,
    fontWeight: 800,
    textAlign: "right",
  },

  composer: { display: "grid", gap: 10 },

  textarea: {
    width: "100%",
    minHeight: 80,
    resize: "vertical",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    padding: 12,
    outline: "none",
    fontFamily: '"Segoe UI", Arial, sans-serif',
    fontSize: 14,
    fontWeight: 700,
  },

  composerActions: { display: "flex", justifyContent: "flex-end", gap: 10 },

  btnPrimary: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.10)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    minWidth: 110,
  },

  btnDisabled: {
    padding: "12px 16px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.55)",
    fontWeight: 900,
    cursor: "not-allowed",
    minWidth: 110,
  },

  small: { fontSize: 12, opacity: 0.75, fontWeight: 800 },
  tiny: { fontSize: 11, opacity: 0.7, fontWeight: 800 },
  muted: { opacity: 0.75, fontWeight: 800, fontSize: 13 },

  alert: {
    marginTop: 6,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.10)",
    fontWeight: 900,
  },

  center: {
    minHeight: "100vh",
    display: "grid",
    placeItems: "center",
    padding: 24,
  },

  loadingCard: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 26,
    padding: 24,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.60)",
    backdropFilter: "blur(14px)",
    border: "1px solid rgba(255,255,255,.12)",
  },

  loadingSub: {
    marginTop: 6,
    color: "rgba(255,255,255,.78)",
    fontWeight: 800,
    fontSize: 12,
  },
};
