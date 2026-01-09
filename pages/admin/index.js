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

  // workflows / integrations UI
  const [workflows, setWorkflows] = useState([]); // [{ provider:'make'|'n8n'|'railway'|'webhook', name, url }]
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

  // Base prompt modal (prompt général)
  const [basePromptOpen, setBasePromptOpen] = useState(false);
  const [basePromptValue, setBasePromptValue] = useState("");
  const [basePromptSavedMsg, setBasePromptSavedMsg] = useState("");

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

    // sélection par défaut
    const firstClient = (cRes.data || [])[0]?.id || "";
    if (!selectedClientId && firstClient) setSelectedClientId(firstClient);

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
  }, [selectedClientId, clientCards.length]);

  function isAssigned(agentId) {
    if (!selectedUserId) return false;
    return (userAgents || []).some((ua) => ua.user_id === selectedUserId && ua.agent_id === agentId);
  }

  function getConfig(agentId) {
    if (!selectedUserId) return null;
    return (agentConfigs || []).find((c) => c.user_id === selectedUserId && c.agent_id === agentId) || null;
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
    const wf = Array.isArray(ctx?.workflows) ? ctx.workflows : [];

    setModalAgent(agent);
    setModalSystemPrompt(cfg?.system_prompt || "");
    setSources(src);
    setWorkflows(wf);

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
    setUrlToAdd("");
    setUploading(false);

    setWorkflows([]);
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
    const provider = (wfProvider || "webhook").trim();
    const name = (wfName || "").trim();
    const url = (wfUrl || "").trim();

    if (!url) return alert("URL du workflow requise.");
    if (!/^https?:\/\//i.test(url)) return alert("URL invalide. Exemple: https://...");
    const item = {
      provider,
      name: name || `${provider.toUpperCase()} workflow`,
      url,
    };
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

    const context = {
      sources,
      workflows,
    };

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
    await refreshAll();
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

    await refreshAll();
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

    await refreshAll();
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

    await refreshAll();
  }

  // --- BASE PROMPT (PROMPT GÉNÉRAL) ---
  async function openBasePrompt() {
    setBasePromptSavedMsg("");
    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/get-base-prompt", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    setBasePromptValue(data?.basePrompt || "");
    setBasePromptOpen(true);
  }

  async function saveBasePrompt() {
    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");

    const res = await fetch("/api/admin/save-base-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ basePrompt: basePromptValue || "" }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    setBasePromptSavedMsg("Enregistré.");
    setTimeout(() => setBasePromptSavedMsg(""), 1200);
    setBasePromptOpen(false);
  }

  function closeBasePrompt() {
    setBasePromptOpen(false);
    setBasePromptSavedMsg("");
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
                <button style={styles.btnPill} onClick={openBasePrompt}>
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
                        <div
                          style={{ cursor: "pointer", minWidth: 0 }}
                          onClick={() => setSelectedClientId(c.id)}
                          title="Sélectionner ce client"
                        >
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
                                  {u.role ? `role: ${u.role}` : "role: (vide)"} —{" "}
                                  <span style={{ fontFamily: "monospace" }}>{u.user_id.slice(0, 8)}…</span>
                                </div>
                              </div>

                              <button
                                style={styles.xBtnMini}
                                onClick={() => removeClientUser(c.id, u.user_id, u.email)}
                                title="Retirer l’utilisateur du client"
                              >
                                ✕
                              </button>
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
                  const wfCount = Array.isArray(ctx?.workflows) ? ctx.workflows.length : 0;
                  const hasPrompt = !!(cfg?.system_prompt || "").trim();

                  return (
                    <article key={a.id} style={styles.agentCard}>
                      <div style={styles.agentTop}>
                        <div style={styles.avatarWrap}>
                          {a.avatar_url ? <img src={a.avatar_url} alt={a.name} style={styles.avatar} /> : <div style={styles.avatarFallback} />}
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={styles.agentName}>{a.name}</div>
                          <div style={styles.agentRole}>{a.description || a.slug}</div>
                          <div style={styles.small}>
                            {assigned ? "Assigné" : "Non assigné"} • Prompt: {hasPrompt ? "personnalisé" : "défaut / vide"} • Sources: {srcCount} •
                            Workflows: {wfCount}
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

      {/* MODAL Prompt & données & workflows */}
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

              <div style={{ width: 320, minWidth: 280 }}>
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
                    <div style={{ flex: 1, minWidth: 0 }}>
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

            <div style={styles.modalLabel}>Workflows / Intégrations</div>
            <div style={styles.wfBox}>
              <div style={styles.row}>
                <select value={wfProvider} onChange={(e) => setWfProvider(e.target.value)} style={styles.select} name="wf_provider">
                  <option value="make">Make</option>
                  <option value="n8n">n8n</option>
                  <option value="railway">Railway</option>
                  <option value="webhook">Webhook</option>
                </select>

                <input
                  value={wfName}
                  onChange={(e) => setWfName(e.target.value)}
                  placeholder="Nom (ex: Relance facture, Envoi devis...)"
                  style={styles.input}
                  name="wf_name"
                  autoComplete="off"
                />

                <input
                  value={wfUrl}
                  onChange={(e) => setWfUrl(e.target.value)}
                  placeholder="URL webhook (https://...)"
                  style={styles.input}
                  name="wf_url"
                  autoComplete="off"
                />

                <button style={styles.btnAssign} onClick={addWorkflow}>
                  Ajouter
                </button>
              </div>

              <div style={{ height: 10 }} />

              {workflows.length === 0 ? (
                <div style={styles.muted}>Aucun workflow.</div>
              ) : (
                workflows.map((w, idx) => (
                  <div key={idx} style={styles.wfRow}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 900 }}>
                        {String(w.provider || "").toUpperCase()} — {w.name || "Workflow"}
                      </div>
                      <div style={styles.tiny}>{w.url}</div>
                    </div>
                    <button style={styles.xBtn} onClick={() => removeWorkflowAt(idx)} title="Retirer">
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

            <div style={styles.small}>
              Les sources sont enregistrées dans <b>context.sources</b> et les workflows dans <b>context.workflows</b> (JSONB).
            </div>
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
_toggle
      )}

      {/* MODAL Create User (original, inchangé) */}
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

      {/* MODAL Base Prompt */}
      {basePromptOpen && (
        <div style={styles.modalOverlay} onClick={closeBasePrompt}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>Prompt général (appliqué à tous les agents)</div>

            <div style={styles.modalLabel}>Base prompt</div>
            <textarea
              value={basePromptValue}
              onChange={(e) => setBasePromptValue(e.target.value)}
              style={styles.textarea}
              placeholder="Entrez ici le prompt général…"
            />

            {!!basePromptSavedMsg && <div style={styles.noteOk}>{basePromptSavedMsg}</div>}

            <div style={styles.modalActions}>
              <button style={styles.btnGhost} onClick={closeBasePrompt}>
                Annuler
              </button>
              <button style={styles.btnAssign} onClick={saveBasePrompt}>
                Enregistrer
              </button>
            </div>

            <div style={styles.small}>
              Ce prompt sera injecté côté backend avant le prompt agent (selon ton implémentation /api/chat).
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

  wrap: {
    display: "grid",
    gridTemplateColumns: "420px 1fr",
    gap: 16,
    padding: 18,
    alignItems: "start",
  },

  box: {
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 16,
    background: "rgba(0,0,0,.35)",
    backdropFilter: "blur(10px)",
    padding: 14,
    boxShadow: "0 18px 45px rgba(0,0,0,.55)",
    overflow: "hidden", // IMPORTANT : empêche tout débordement visuel
  },
  boxTitle: { fontWeight: 900, marginBottom: 10 },

  // IMPORTANT : wrap propre -> plus de chevauchement
  clientsHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
  },
  clientsHeadBtns: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    justifyContent: "flex-end",
    maxWidth: "100%",
  },

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
    marginTop: 10,
  },

  left: { minWidth: 0 },
  right: { minWidth: 0 },

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
  clientName: { fontWeight: 900, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  userList: { padding: 10, display: "grid", gap: 10 },
  userItem: {
    flex: 1,
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(255,255,255,.03)",
    cursor: "pointer",
    minWidth: 0,
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
    whiteSpace: "nowrap",
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
    minWidth: 0,
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
    minWidth: 220,
  },
  select: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(255,255,255,.06)",
    color: "rgba(238,242,255,.92)",
    outline: "none",
    fontWeight: 800,
    minWidth: 160,
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
    maxHeight: 220,
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

  wfBox: {
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.03)",
    padding: 10,
    display: "grid",
    gap: 10,
    maxHeight: 220,
    overflow: "auto",
  },
  wfRow: {
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
    flex: "0 0 auto",
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
