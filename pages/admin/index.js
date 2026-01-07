// pages/admin/index.js
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);

  // Data
  const [clients, setClients] = useState([]);
  const [clientUsers, setClientUsers] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [agents, setAgents] = useState([]);
  const [userAgents, setUserAgents] = useState([]);

  // UI state
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  // Create modals
  const [createClientOpen, setCreateClientOpen] = useState(false);
  const [createClientName, setCreateClientName] = useState("");

  const [createUserOpen, setCreateUserOpen] = useState(false);
  const [createUserEmail, setCreateUserEmail] = useState("");
  const [createUserPassword, setCreateUserPassword] = useState("");
  const [createUserRole, setCreateUserRole] = useState("user");

  // Conversations modal
  const [convOpen, setConvOpen] = useState(false);
  const [convLoading, setConvLoading] = useState(false);
  const [convErr, setConvErr] = useState("");
  const [convList, setConvList] = useState([]);

  // Prompt & data modal state (existant)
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgAgent, setCfgAgent] = useState(null);
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgTab, setCfgTab] = useState("prompt"); // prompt | sources | workflow

  const [cfgPrompt, setCfgPrompt] = useState("");
  const [cfgWorkflowProvider, setCfgWorkflowProvider] = useState(""); // "", "n8n", "make"
  const [cfgWorkflowId, setCfgWorkflowId] = useState("");
  const [cfgSources, setCfgSources] = useState([]); // [{type:'url'|'file', ...}]
  const [cfgUrlDraft, setCfgUrlDraft] = useState("");
  const [cfgErr, setCfgErr] = useState("");

  const isAdmin = useMemo(() => (me?.role === "admin") || (me?.is_admin === true), [me]);

  function clientLabel(c) {
    const v = (c?.name || c?.customer_name || c?.company_name || c?.title || "").trim();
    return v || "Client";
  }

  function safeStr(v) {
    return (v ?? "").toString();
  }

  function normalizeImgSrc(src) {
    const s = safeStr(src).trim();
    if (!s) return "";
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    if (s.startsWith("/")) return s;
    return "/" + s;
  }

  // Indexes
  const profileByUserId = useMemo(() => {
    const m = new Map();
    for (const p of profiles) m.set(p.user_id, p);
    return m;
  }, [profiles]);

  const clientById = useMemo(() => {
    const m = new Map();
    for (const c of clients) m.set(c.id, c);
    return m;
  }, [clients]);

  // Build: Client -> Users
  const clientTree = useMemo(() => {
    const usersByClient = new Map();

    for (const cu of clientUsers) {
      if (!usersByClient.has(cu.client_id)) usersByClient.set(cu.client_id, []);
      const p = profileByUserId.get(cu.user_id);
      usersByClient.get(cu.client_id).push({
        user_id: cu.user_id,
        email: safeStr(p?.email),
        role: safeStr(p?.role) || (p?.is_admin ? "admin" : "user"),
      });
    }

    let list = (clients || []).map((c) => ({
      id: c.id,
      raw: c,
      label: clientLabel(c),
      users: usersByClient.get(c.id) || [],
    }));

    list.sort((a, b) => a.label.localeCompare(b.label, "fr"));

    for (const item of list) {
      item.users.sort((a, b) => {
        if (a.role === "admin" && b.role !== "admin") return 1;
        if (a.role !== "admin" && b.role === "admin") return -1;
        return safeStr(a.email).localeCompare(safeStr(b.email), "fr");
      });
    }

    const s = q.trim().toLowerCase();
    if (!s) return list;

    return list
      .map((c) => {
        const labelMatch = safeStr(c.label).toLowerCase().includes(s);
        const usersFiltered = (c.users || []).filter((u) => {
          const email = safeStr(u.email).toLowerCase();
          const uid = safeStr(u.user_id).toLowerCase();
          return email.includes(s) || uid.includes(s);
        });
        if (!labelMatch && usersFiltered.length === 0) return null;
        return { ...c, users: labelMatch ? c.users : usersFiltered };
      })
      .filter(Boolean);
  }, [clients, clientUsers, profileByUserId, q]);

  const selectedClient = useMemo(() => {
    return selectedClientId ? clientById.get(selectedClientId) || null : null;
  }, [clientById, selectedClientId]);

  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    const p = profileByUserId.get(selectedUserId);
    return {
      user_id: selectedUserId,
      email: safeStr(p?.email),
      role: safeStr(p?.role) || (p?.is_admin ? "admin" : "user"),
    };
  }, [profileByUserId, selectedUserId]);

  const assignedSet = useMemo(() => {
    const set = new Set();
    for (const row of userAgents) {
      if (row.user_id === selectedUserId) set.add(row.agent_id);
    }
    return set;
  }, [userAgents, selectedUserId]);

  // -------- helpers API admin --------
  async function getAccessToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || "";
  }

  async function adminPost(path, body) {
    const token = await getAccessToken();
    const r = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token ? `Bearer ${token}` : "",
      },
      body: JSON.stringify(body || {}),
    });

    let json = null;
    try { json = await r.json(); } catch {}
    if (!r.ok) {
      const e = json?.error || `Erreur HTTP ${r.status}`;
      throw new Error(e);
    }
    return json;
  }

  // -------- BOOT --------
  useEffect(() => {
    let mounted = true;

    async function boot() {
      setMsg("");
      setLoading(true);

      const { data: { session } } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }

      // Lire profil connecté
      const { data: myP1, error: myE1 } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", session.user.id)
        .maybeSingle();

      let myProfile = myP1;

      // si absent, créer profil minimal
      if (!myE1 && !myProfile) {
        const newRow = {
          user_id: session.user.id,
          email: session.user.email,
          role: "user",
        };

        const { error: insErr } = await supabase.from("profiles").insert(newRow);
        if (insErr) {
          if (!mounted) return;
          setLoading(false);
          setMsg(`Création du profil impossible : ${insErr.message}`);
          return;
        }

        const { data: myP2, error: myE2 } = await supabase
          .from("profiles")
          .select("*")
          .eq("user_id", session.user.id)
          .maybeSingle();

        if (myE2) {
          if (!mounted) return;
          setLoading(false);
          setMsg(`Lecture du profil impossible : ${myE2.message}`);
          return;
        }

        myProfile = myP2 || null;
      }

      if (!mounted) return;

      if (myE1 || !myProfile) {
        setLoading(false);
        setMsg(myE1 ? `Lecture du profil impossible : ${myE1.message}` : "Profil introuvable (table profiles).");
        return;
      }

      const myProfileSafe = {
        ...myProfile,
        email: myProfile.email || session.user.email || null,
      };
      setMe(myProfileSafe);

      const isAdminNow = (myProfileSafe.role === "admin") || (myProfileSafe.is_admin === true);
      if (!isAdminNow) {
        setLoading(false);
        setMsg("Accès refusé : vous n’êtes pas admin.");
        return;
      }

      // Charger données
      const [cRes, cuRes, pRes, aRes, uaRes] = await Promise.all([
        supabase.from("clients").select("*"),
        supabase.from("client_users").select("client_id, user_id"),
        supabase.from("profiles").select("user_id, email, role, is_admin"),
        supabase.from("agents").select("id, slug, name, description, avatar_url"),
        supabase.from("user_agents").select("user_id, agent_id, created_at").order("created_at", { ascending: false }),
      ]);

      if (!mounted) return;

      const errors = [cRes.error, cuRes.error, pRes.error, aRes.error, uaRes.error];
      if (errors.some(Boolean)) {
        const parts = [];
        if (cRes.error) parts.push(`clients: ${cRes.error.message}`);
        if (cuRes.error) parts.push(`client_users: ${cuRes.error.message}`);
        if (pRes.error) parts.push(`profiles: ${pRes.error.message}`);
        if (aRes.error) parts.push(`agents: ${aRes.error.message}`);
        if (uaRes.error) parts.push(`user_agents: ${uaRes.error.message}`);
        setMsg("Chargement partiel : " + parts.join(" | "));
      }

      const clientsSafe = cRes.data || [];
      const clientUsersSafe = cuRes.data || [];
      const profilesSafe = pRes.data || [];
      const agentsSafe = aRes.data || [];
      const userAgentsSafe = uaRes.data || [];

      setClients(clientsSafe);
      setClientUsers(clientUsersSafe);
      setProfiles(profilesSafe);
      setAgents(agentsSafe);
      setUserAgents(userAgentsSafe);

      // Sélections par défaut
      let defaultClientId = "";
      let defaultUserId = "";

      const firstWithUser = clientsSafe.find((c) => clientUsersSafe.some((x) => x.client_id === c.id));
      defaultClientId = firstWithUser?.id || clientsSafe[0]?.id || "";

      if (defaultClientId) {
        defaultUserId = clientUsersSafe.find((x) => x.client_id === defaultClientId)?.user_id || "";
      }

      setSelectedClientId(defaultClientId);
      setSelectedUserId(defaultUserId);

      setLoading(false);
    }

    boot();
    return () => { mounted = false; };
  }, []);

  // Quand on change de client => sélectionner le premier user du client
  useEffect(() => {
    if (!selectedClientId) return;
    const firstUserId = clientUsers.find((x) => x.client_id === selectedClientId)?.user_id || "";
    setSelectedUserId(firstUserId);
  }, [selectedClientId, clientUsers]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  // -------- Assign agents --------
  async function toggleAgent(agentId) {
    if (!selectedUserId || !agentId) return;
    if (!isAdmin) return;

    setSaving(true);
    setMsg("");

    const already = assignedSet.has(agentId);

    try {
      if (already) {
        const { error } = await supabase
          .from("user_agents")
          .delete()
          .eq("user_id", selectedUserId)
          .eq("agent_id", agentId);

        if (error) throw error;

        setUserAgents((prev) => prev.filter((r) => !(r.user_id === selectedUserId && r.agent_id === agentId)));
      } else {
        const { data, error } = await supabase
          .from("user_agents")
          .insert({ user_id: selectedUserId, agent_id: agentId })
          .select("user_id, agent_id, created_at")
          .single();

        if (error) throw error;

        setUserAgents((prev) => [data, ...prev]);
      }
    } catch (e) {
      setMsg(e?.message || "Erreur lors de la mise à jour.");
    } finally {
      setSaving(false);
    }
  }

  // -------- PROMPT & DATA MODAL --------
  async function openConfig(agent) {
    if (!selectedUserId || !agent?.id) return;

    setCfgErr("");
    setCfgAgent(agent);
    setCfgTab("prompt");
    setCfgPrompt("");
    setCfgWorkflowProvider("");
    setCfgWorkflowId("");
    setCfgSources([]);
    setCfgUrlDraft("");
    setCfgOpen(true);

    setCfgLoading(true);
    try {
      const { data, error } = await supabase
        .from("client_agent_configs")
        .select("id, user_id, agent_id, system_prompt, context")
        .eq("user_id", selectedUserId)
        .eq("agent_id", agent.id)
        .maybeSingle();

      if (error) throw error;

      const ctx = data?.context || {};
      const wf = ctx?.workflow || {};
      const sources = Array.isArray(ctx?.sources) ? ctx.sources : [];

      setCfgPrompt(data?.system_prompt || "");
      setCfgWorkflowProvider(wf?.provider || "");
      setCfgWorkflowId(wf?.id || "");
      setCfgSources(sources);
    } catch (e) {
      setCfgErr(e?.message || "Impossible de charger la configuration.");
    } finally {
      setCfgLoading(false);
    }
  }

  function closeConfig() {
    setCfgOpen(false);
    setCfgAgent(null);
    setCfgErr("");
  }

  function addUrlSource() {
    const url = cfgUrlDraft.trim();
    if (!url) return;

    setCfgSources((prev) => [{ type: "url", value: url, created_at: new Date().toISOString() }, ...prev]);
    setCfgUrlDraft("");
  }

  function removeSource(idx) {
    setCfgSources((prev) => prev.filter((_, i) => i !== idx));
  }

  async function uploadFile(file) {
    if (!file || !selectedUserId || !cfgAgent?.slug) return;
    setCfgErr("");

    try {
      const bucket = "agent_sources";
      const safeName = file.name.replace(/[^\w.\-() ]+/g, "_");
      const path = `${selectedUserId}/${cfgAgent.slug}/${Date.now()}_${safeName}`;

      const { error } = await supabase.storage.from(bucket).upload(path, file, { upsert: true });
      if (error) throw error;

      setCfgSources((prev) => [
        {
          type: "file",
          bucket,
          path,
          name: file.name,
          mime: file.type || "application/octet-stream",
          size: file.size || null,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ]);
    } catch (e) {
      setCfgErr(e?.message || "Upload impossible.");
    }
  }

  async function saveConfig() {
    if (!selectedUserId || !cfgAgent?.id) return;
    setCfgSaving(true);
    setCfgErr("");

    try {
      const context = {
        workflow: { provider: cfgWorkflowProvider || "", id: cfgWorkflowId || "" },
        sources: cfgSources,
      };

      const { error } = await supabase
        .from("client_agent_configs")
        .upsert(
          { user_id: selectedUserId, agent_id: cfgAgent.id, system_prompt: cfgPrompt || "", context },
          { onConflict: "user_id,agent_id" }
        );

      if (error) throw error;

      closeConfig();
      setMsg("Configuration enregistrée.");
      setTimeout(() => setMsg(""), 2500);
    } catch (e) {
      setCfgErr(e?.message || "Enregistrement impossible.");
    } finally {
      setCfgSaving(false);
    }
  }

  // -------- CREATE / DELETE CLIENTS & USERS --------
  async function refreshAll() {
    setMsg("");
    const [cRes, cuRes, pRes, aRes, uaRes] = await Promise.all([
      supabase.from("clients").select("*"),
      supabase.from("client_users").select("client_id, user_id"),
      supabase.from("profiles").select("user_id, email, role, is_admin"),
      supabase.from("agents").select("id, slug, name, description, avatar_url"),
      supabase.from("user_agents").select("user_id, agent_id, created_at").order("created_at", { ascending: false }),
    ]);

    if (cRes.error || cuRes.error || pRes.error || aRes.error || uaRes.error) {
      const parts = [];
      if (cRes.error) parts.push(`clients: ${cRes.error.message}`);
      if (cuRes.error) parts.push(`client_users: ${cuRes.error.message}`);
      if (pRes.error) parts.push(`profiles: ${pRes.error.message}`);
      if (aRes.error) parts.push(`agents: ${aRes.error.message}`);
      if (uaRes.error) parts.push(`user_agents: ${uaRes.error.message}`);
      setMsg("Refresh partiel : " + parts.join(" | "));
    }

    setClients(cRes.data || []);
    setClientUsers(cuRes.data || []);
    setProfiles(pRes.data || []);
    setAgents(aRes.data || []);
    setUserAgents(uaRes.data || []);
  }

  async function createClient() {
    const name = createClientName.trim();
    if (!name) return;

    try {
      setSaving(true);
      setMsg("");
      const out = await adminPost("/api/admin/clients", { action: "create", name });

      // auto attach l’admin courant au client créé
      if (out?.client?.id && me?.user_id) {
        await supabase.from("client_users").insert({ client_id: out.client.id, user_id: me.user_id });
      }

      setCreateClientOpen(false);
      setCreateClientName("");
      await refreshAll();

      setSelectedClientId(out?.client?.id || "");
      setMsg("Client créé.");
      setTimeout(() => setMsg(""), 2500);
    } catch (e) {
      setMsg(e?.message || "Création client impossible.");
    } finally {
      setSaving(false);
    }
  }

  async function createUser() {
    const email = createUserEmail.trim().toLowerCase();
    const password = createUserPassword;
    const role = createUserRole;
    const clientId = selectedClientId;

    if (!clientId) {
      setMsg("Sélectionnez un client avant de créer un utilisateur.");
      return;
    }

    try {
      setSaving(true);
      setMsg("");

      const out = await adminPost("/api/admin/users", {
        action: "create",
        email,
        password,
        role,
        clientId,
      });

      setCreateUserOpen(false);
      setCreateUserEmail("");
      setCreateUserPassword("");
      setCreateUserRole("user");

      await refreshAll();
      setSelectedUserId(out?.userId || "");

      setMsg("Utilisateur créé.");
      setTimeout(() => setMsg(""), 2500);
    } catch (e) {
      setMsg(e?.message || "Création utilisateur impossible.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteClient(clientId) {
    if (!clientId) return;

    const c = clientById.get(clientId);
    const label = c ? clientLabel(c) : clientId;

    const ok = window.confirm(
      `Supprimer le client "${label}" ?\n\nCela supprime le client et la liaison client_users.\nLes comptes utilisateurs ne seront PAS supprimés.`
    );
    if (!ok) return;

    try {
      setSaving(true);
      setMsg("");
      await adminPost("/api/admin/clients", { action: "delete", clientId });

      // state local rapide
      setClients((prev) => prev.filter((x) => x.id !== clientId));
      setClientUsers((prev) => prev.filter((x) => x.client_id !== clientId));

      if (selectedClientId === clientId) {
        setSelectedClientId("");
        setSelectedUserId("");
      }

      setMsg("Client supprimé.");
      setTimeout(() => setMsg(""), 2500);
    } catch (e) {
      setMsg(e?.message || "Suppression client impossible.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteUser(userId) {
    if (!userId) return;

    const p = profileByUserId.get(userId);
    const label = safeStr(p?.email) || userId;

    const ok = window.confirm(
      `Supprimer l’utilisateur "${label}" ?\n\nCela supprime :\n- conversations + messages\n- assignations agents\n- configs prompt/données\n- profil\n- compte Auth (connexion)\n\nAction irréversible.`
    );
    if (!ok) return;

    try {
      setSaving(true);
      setMsg("");
      const out = await adminPost("/api/admin/users", { action: "delete", userId });

      // state local rapide
      setClientUsers((prev) => prev.filter((x) => x.user_id !== userId));
      setUserAgents((prev) => prev.filter((x) => x.user_id !== userId));
      setProfiles((prev) => prev.filter((x) => x.user_id !== userId));

      if (selectedUserId === userId) setSelectedUserId("");

      setMsg(out?.warn ? `Utilisateur supprimé. (Info: ${out.warn})` : "Utilisateur supprimé.");
      setTimeout(() => setMsg(""), 3500);
    } catch (e) {
      setMsg(e?.message || "Suppression utilisateur impossible.");
    } finally {
      setSaving(false);
    }
  }

  // -------- Conversations modal --------
  async function openConversations() {
    if (!selectedUserId) return;
    setConvErr("");
    setConvOpen(true);
    setConvLoading(true);
    setConvList([]);

    try {
      const out = await adminPost("/api/admin/conversations", {
        action: "list",
        userId: selectedUserId,
        limit: 100,
      });
      setConvList(out?.conversations || []);
    } catch (e) {
      setConvErr(e?.message || "Impossible de charger les conversations.");
    } finally {
      setConvLoading(false);
    }
  }

  function closeConversations() {
    setConvOpen(false);
    setConvErr("");
    setConvList([]);
  }

  async function deleteOneConversation(conversationId) {
    const ok = window.confirm("Supprimer cette conversation ? (messages inclus)");
    if (!ok) return;

    try {
      setConvLoading(true);
      setConvErr("");
      await adminPost("/api/admin/conversations", { action: "delete", conversationId });
      setConvList((prev) => prev.filter((c) => c.id !== conversationId));
    } catch (e) {
      setConvErr(e?.message || "Suppression conversation impossible.");
    } finally {
      setConvLoading(false);
    }
  }

  async function deleteAllConversations() {
    const ok = window.confirm("Supprimer TOUTES les conversations de cet utilisateur ? (irréversible)");
    if (!ok) return;

    try {
      setConvLoading(true);
      setConvErr("");
      await adminPost("/api/admin/conversations", { action: "deleteAll", userId: selectedUserId });
      setConvList([]);
    } catch (e) {
      setConvErr(e?.message || "Suppression globale impossible.");
    } finally {
      setConvLoading(false);
    }
  }

  // -------- RENDER --------
  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <div style={styles.h1}>Backoffice</div>
          <div style={styles.p}>Chargement…</div>
        </div>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main style={styles.page}>
        <div style={styles.card}>
          <div style={styles.h1}>Backoffice</div>
          <div style={styles.alert}>{msg || "Accès refusé."}</div>
          <button style={styles.btnGhost} onClick={() => (window.location.href = "/agents")}>
            Retour aux agents
          </button>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <header style={styles.topbar}>
        <div style={styles.brandWrap}>
          <img src="/images/logolong.png" alt="Evidenc’IA" style={styles.brandLogo} />
          <div style={styles.brandText}>Console administrateur</div>
        </div>

        <div style={styles.topRight}>
          <span style={styles.chip}>{me?.email || "admin"}</span>
          <button style={styles.btnGhost} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </header>

      <section style={styles.layout}>
        {/* CLIENTS + USERS */}
        <aside style={styles.panel}>
          <div style={styles.panelHeader}>
            <div style={{ display: "grid", gap: 10 }}>
              <div style={styles.panelTitle}>Clients</div>

              <div style={styles.row}>
                <button
                  type="button"
                  style={styles.btnPrimary}
                  onClick={() => {
                    setCreateClientName("");
                    setCreateClientOpen(true);
                  }}
                >
                  + Client
                </button>

                <button
                  type="button"
                  style={styles.btnGhost}
                  onClick={() => {
                    if (!selectedClientId) {
                      setMsg("Sélectionnez un client avant de créer un utilisateur.");
                      return;
                    }
                    setCreateUserEmail("");
                    setCreateUserPassword("");
                    setCreateUserRole("user");
                    setCreateUserOpen(true);
                  }}
                >
                  + Utilisateur
                </button>
              </div>
            </div>

            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Rechercher client / email / id…"
              style={styles.search}
            />
          </div>

          <div style={styles.list}>
            {clientTree.length === 0 ? (
              <div style={styles.emptyBox}>
                Aucun client / utilisateur à afficher.
                <div style={{ marginTop: 8, opacity: 0.8 }}>
                  Vérifie que les tables <b>clients</b> et <b>client_users</b> ont des données.
                </div>
              </div>
            ) : (
              clientTree.map((c) => {
                const activeClient = c.id === selectedClientId;
                return (
                  <div
                    key={c.id}
                    style={{
                      ...styles.clientBlock,
                      ...(activeClient ? styles.clientBlockActive : null),
                    }}
                  >
                    <div style={styles.clientHeaderRow}>
                      <button
                        onClick={() => setSelectedClientId(c.id)}
                        style={styles.clientHeaderBtn}
                        title={c.label}
                        type="button"
                      >
                        <div style={styles.clientName}>{c.label}</div>
                        <div style={styles.clientCount}>{(c.users || []).length} user(s)</div>
                      </button>

                      <button
                        type="button"
                        style={styles.dangerBtn}
                        onClick={() => deleteClient(c.id)}
                        title="Supprimer le client"
                      >
                        Supprimer
                      </button>
                    </div>

                    <div style={styles.clientUsers}>
                      {(c.users || []).length === 0 ? (
                        <div style={styles.miniEmpty}>Aucun utilisateur rattaché.</div>
                      ) : (
                        c.users.map((u) => {
                          const activeUser = u.user_id === selectedUserId;
                          return (
                            <div key={u.user_id} style={styles.userRowWrap}>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedClientId(c.id);
                                  setSelectedUserId(u.user_id);
                                }}
                                style={{
                                  ...styles.userRow,
                                  ...(activeUser ? styles.userRowActive : null),
                                }}
                                title={u.email || u.user_id}
                              >
                                <div style={styles.userEmail}>{u.email || "(email non renseigné)"}</div>
                                <div style={styles.userBadge}>{u.role}</div>
                              </button>

                              <button
                                type="button"
                                style={styles.dangerMini}
                                onClick={() => deleteUser(u.user_id)}
                                title="Supprimer l’utilisateur"
                              >
                                ✕
                              </button>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* ASSIGN */}
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            <div>
              <div style={styles.panelTitle}>Assignation agents</div>
              <div style={styles.sub}>
                <div>
                  <b>Client :</b> {selectedClient ? clientLabel(selectedClient) : "-"}
                </div>
                <div>
                  <b>Utilisateur :</b> {selectedUser ? selectedUser.email || selectedUser.user_id : "-"}
                </div>
                <div>
                  <b>user_id :</b> {selectedUser ? selectedUser.user_id : "-"}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button
                type="button"
                style={styles.btnGhost}
                onClick={openConversations}
                disabled={!selectedUserId}
                title="Gérer / supprimer les conversations"
              >
                Conversations
              </button>

              {saving ? <div style={styles.saving}>Enregistrement…</div> : null}
            </div>
          </div>

          {msg ? <div style={styles.alert}>{msg}</div> : null}

          <div style={styles.grid}>
            {agents.map((a) => {
              const checked = assignedSet.has(a.id);
              const src = normalizeImgSrc(a.avatar_url) || `/images/${a.slug}.png`;

              return (
                <div
                  key={a.id}
                  style={{ ...styles.agentCard, ...(checked ? styles.agentCardOn : null) }}
                  onClick={() => toggleAgent(a.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") toggleAgent(a.id);
                  }}
                  title={a.slug}
                >
                  <div style={styles.agentTop}>
                    <img
                      src={src}
                      alt={a.name}
                      style={styles.avatar}
                      loading="lazy"
                      onError={(e) => {
                        e.currentTarget.onerror = null;
                        e.currentTarget.src = "/images/logopc.png";
                      }}
                    />
                  </div>

                  <div style={styles.agentMeta}>
                    <div style={styles.agentName}>{a.name}</div>
                    <div style={styles.agentDesc}>{a.description}</div>
                  </div>

                  <div style={styles.actionsRow}>
                    <div style={styles.check}>{checked ? "Assigné" : "Non assigné"}</div>

                    <button
                      type="button"
                      style={styles.cfgBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        openConfig(a);
                      }}
                      disabled={!selectedUserId}
                      title="Configurer prompt, sources et workflow"
                    >
                      Prompt & données
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* MODALE CREATE CLIENT */}
      {createClientOpen ? (
        <div style={styles.modalOverlay} onMouseDown={() => setCreateClientOpen(false)} role="dialog" aria-modal="true">
          <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>Créer un client</div>
              <button type="button" style={styles.btnGhost} onClick={() => setCreateClientOpen(false)}>
                Fermer
              </button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.block}>
                <div style={styles.label}>Nom du client</div>
                <input
                  value={createClientName}
                  onChange={(e) => setCreateClientName(e.target.value)}
                  style={styles.input}
                  placeholder="Ex: Bcontact"
                />
                <div style={styles.hint}>Un client correspond à une entreprise / entité.</div>
              </div>
            </div>

            <div style={styles.modalFooter}>
              <button type="button" style={styles.btnGhost} onClick={() => setCreateClientOpen(false)}>
                Annuler
              </button>
              <button type="button" style={styles.btnPrimary} onClick={createClient} disabled={saving || !createClientName.trim()}>
                {saving ? "Création…" : "Créer"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALE CREATE USER */}
      {createUserOpen ? (
        <div style={styles.modalOverlay} onMouseDown={() => setCreateUserOpen(false)} role="dialog" aria-modal="true">
          <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>Créer un utilisateur</div>
              <button type="button" style={styles.btnGhost} onClick={() => setCreateUserOpen(false)}>
                Fermer
              </button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.block}>
                <div style={styles.label}>Client</div>
                <div style={styles.hint}>
                  {selectedClient ? clientLabel(selectedClient) : "Aucun client sélectionné"}
                </div>
              </div>

              <div style={styles.block}>
                <div style={styles.label}>Email</div>
                <input
                  value={createUserEmail}
                  onChange={(e) => setCreateUserEmail(e.target.value)}
                  style={styles.input}
                  placeholder="utilisateur@domaine.fr"
                />
              </div>

              <div style={styles.block}>
                <div style={styles.label}>Mot de passe</div>
                <input
                  value={createUserPassword}
                  onChange={(e) => setCreateUserPassword(e.target.value)}
                  style={styles.input}
                  type="password"
                  placeholder="Minimum 6 caractères"
                />
              </div>

              <div style={styles.block}>
                <div style={styles.label}>Rôle</div>
                <select value={createUserRole} onChange={(e) => setCreateUserRole(e.target.value)} style={styles.select}>
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
              </div>
            </div>

            <div style={styles.modalFooter}>
              <button type="button" style={styles.btnGhost} onClick={() => setCreateUserOpen(false)}>
                Annuler
              </button>
              <button
                type="button"
                style={styles.btnPrimary}
                onClick={createUser}
                disabled={saving || !createUserEmail.trim() || !createUserPassword}
              >
                {saving ? "Création…" : "Créer"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALE CONVERSATIONS */}
      {convOpen ? (
        <div style={styles.modalOverlay} onMouseDown={closeConversations} role="dialog" aria-modal="true">
          <div style={styles.modalWide} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>Conversations — {selectedUser?.email || selectedUserId}</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button type="button" style={styles.dangerBtn} onClick={deleteAllConversations} disabled={convLoading || !selectedUserId}>
                  Tout supprimer
                </button>
                <button type="button" style={styles.btnGhost} onClick={closeConversations}>
                  Fermer
                </button>
              </div>
            </div>

            <div style={styles.modalBody}>
              {convErr ? <div style={styles.alert}>{convErr}</div> : null}
              {convLoading ? (
                <div style={styles.p}>Chargement…</div>
              ) : convList.length === 0 ? (
                <div style={styles.emptyBox}>Aucune conversation.</div>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {convList.map((c) => (
                    <div key={c.id} style={styles.convRow}>
                      <div style={{ minWidth: 0 }}>
                        <div style={styles.convTitle}>{safeStr(c.title) || "Conversation"}</div>
                        <div style={styles.convMeta}>
                          id: {c.id}{" "}
                          {c.agent_slug ? `• agent: ${c.agent_slug}` : ""}{" "}
                          {c.updated_at ? `• maj: ${new Date(c.updated_at).toLocaleString("fr-FR")}` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        style={styles.dangerBtn}
                        onClick={() => deleteOneConversation(c.id)}
                        disabled={convLoading}
                      >
                        Supprimer
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={styles.modalFooter}>
              <button type="button" style={styles.btnGhost} onClick={closeConversations}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* MODALE PROMPT / DATA */}
      {cfgOpen ? (
        <div style={styles.modalOverlay} onMouseDown={closeConfig} role="dialog" aria-modal="true">
          <div style={styles.modalWide} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>{cfgAgent?.name || "Agent"} — configuration utilisateur</div>
              <button type="button" style={styles.btnGhost} onClick={closeConfig}>
                Fermer
              </button>
            </div>

            <div style={styles.tabs}>
              <button
                type="button"
                onClick={() => setCfgTab("prompt")}
                style={{ ...styles.tab, ...(cfgTab === "prompt" ? styles.tabOn : null) }}
              >
                Prompt
              </button>
              <button
                type="button"
                onClick={() => setCfgTab("sources")}
                style={{ ...styles.tab, ...(cfgTab === "sources" ? styles.tabOn : null) }}
              >
                Données
              </button>
              <button
                type="button"
                onClick={() => setCfgTab("workflow")}
                style={{ ...styles.tab, ...(cfgTab === "workflow" ? styles.tabOn : null) }}
              >
                Workflow
              </button>
            </div>

            {cfgLoading ? (
              <div style={styles.modalBody}>Chargement…</div>
            ) : (
              <div style={styles.modalBody}>
                {cfgErr ? <div style={styles.alert}>{cfgErr}</div> : null}

                {cfgTab === "prompt" ? (
                  <div style={styles.block}>
                    <div style={styles.label}>Prompt personnalisé (pour cet utilisateur)</div>
                    <textarea
                      value={cfgPrompt}
                      onChange={(e) => setCfgPrompt(e.target.value)}
                      style={styles.textarea}
                      placeholder="Ex: Tu travailles pour la société X. Ton objectif est…"
                    />
                    <div style={styles.hint}>Ce prompt est stocké dans <b>client_agent_configs.system_prompt</b>.</div>
                  </div>
                ) : null}

                {cfgTab === "sources" ? (
                  <div style={styles.block}>
                    <div style={styles.label}>Sources (URL / fichiers)</div>

                    <div style={styles.row}>
                      <input
                        value={cfgUrlDraft}
                        onChange={(e) => setCfgUrlDraft(e.target.value)}
                        placeholder="https://exemple.com/..."
                        style={styles.input}
                      />
                      <button type="button" style={styles.cfgBtn} onClick={addUrlSource}>
                        Ajouter URL
                      </button>
                    </div>

                    <div style={styles.row}>
                      <input
                        type="file"
                        style={styles.file}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) uploadFile(f);
                          e.target.value = "";
                        }}
                      />
                      <div style={styles.hint}>Upload dans le bucket <b>agent_sources</b>.</div>
                    </div>

                    <div style={styles.sourcesList}>
                      {cfgSources.length === 0 ? (
                        <div style={styles.miniEmpty}>Aucune source pour le moment.</div>
                      ) : (
                        cfgSources.map((s, idx) => (
                          <div key={idx} style={styles.sourceItem}>
                            <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                              <div style={styles.sourceType}>{s.type === "url" ? "URL" : "Fichier"}</div>
                              <div style={styles.sourceVal}>
                                {s.type === "url" ? s.value : `${s.name} (${s.path})`}
                              </div>
                            </div>
                            <button type="button" style={styles.btnGhost} onClick={() => removeSource(idx)} title="Supprimer">
                              Supprimer
                            </button>
                          </div>
                        ))
                      )}
                    </div>

                    <div style={styles.hint}>Ces sources sont stockées dans <b>client_agent_configs.context.sources</b>.</div>
                  </div>
                ) : null}

                {cfgTab === "workflow" ? (
                  <div style={styles.block}>
                    <div style={styles.label}>Workflow (n8n / Make)</div>

                    <div style={styles.row}>
                      <select value={cfgWorkflowProvider} onChange={(e) => setCfgWorkflowProvider(e.target.value)} style={styles.select}>
                        <option value="">Aucun</option>
                        <option value="n8n">n8n</option>
                        <option value="make">Make</option>
                      </select>

                      <input
                        value={cfgWorkflowId}
                        onChange={(e) => setCfgWorkflowId(e.target.value)}
                        placeholder="ID / nom / webhook / scénario…"
                        style={styles.input}
                      />
                    </div>

                    <div style={styles.hint}>
                      On stocke uniquement la référence du workflow (pas d’exécution ici) dans{" "}
                      <b>client_agent_configs.context.workflow</b>.
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            <div style={styles.modalFooter}>
              <button type="button" style={styles.btnGhost} onClick={closeConfig}>
                Annuler
              </button>
              <button
                type="button"
                style={styles.btnPrimary}
                onClick={saveConfig}
                disabled={cfgSaving || !selectedUserId || !cfgAgent?.id}
              >
                {cfgSaving ? "Enregistrement…" : "Enregistrer"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "#eef2ff",
    fontFamily: "Segoe UI, Arial, sans-serif",
  },

  topbar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    backdropFilter: "blur(10px)",
  },

  brandWrap: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 },
  brandLogo: { height: 22, width: "auto", display: "block" },
  brandText: { fontWeight: 900, letterSpacing: 0.2, color: "#eef2ff" },

  topRight: { display: "flex", gap: 10, alignItems: "center" },
  chip: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    fontWeight: 900,
    fontSize: 12,
    maxWidth: 260,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },

  btnGhost: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.35)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    fontWeight: 900,
    cursor: "pointer",
    appearance: "none",
    WebkitAppearance: "none",
  },

  btnPrimary: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,140,40,.30)",
    background: "rgba(255,140,40,.18)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    fontWeight: 900,
    cursor: "pointer",
    appearance: "none",
    WebkitAppearance: "none",
  },

  dangerBtn: {
    padding: "10px 14px",
    borderRadius: 999,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.12)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    fontWeight: 900,
    cursor: "pointer",
    appearance: "none",
    WebkitAppearance: "none",
    whiteSpace: "nowrap",
  },

  dangerMini: {
    width: 34,
    height: 34,
    borderRadius: 12,
    border: "1px solid rgba(255,80,80,.35)",
    background: "rgba(255,80,80,.12)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    fontWeight: 900,
    cursor: "pointer",
    display: "grid",
    placeItems: "center",
  },

  layout: {
    display: "grid",
    gridTemplateColumns: "420px 1fr",
    gap: 14,
    padding: 14,
  },

  panel: {
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
    backdropFilter: "blur(14px)",
    overflow: "hidden",
    minHeight: "calc(100vh - 90px)",
    display: "flex",
    flexDirection: "column",
  },

  panelHeader: {
    padding: 14,
    borderBottom: "1px solid rgba(255,255,255,.08)",
    background: "rgba(0,0,0,.18)",
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
  },

  panelTitle: { fontWeight: 900, fontSize: 13 },

  sub: {
    marginTop: 6,
    opacity: 0.8,
    fontWeight: 700,
    fontSize: 12,
    lineHeight: 1.4,
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },

  row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },

  search: {
    width: 230,
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 12,
  },

  list: { padding: 10, overflowY: "auto", display: "grid", gap: 10 },

  emptyBox: {
    padding: 14,
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    fontWeight: 800,
    fontSize: 12,
    opacity: 0.85,
    lineHeight: 1.45,
  },

  clientBlock: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    overflow: "hidden",
  },

  clientBlockActive: {
    border: "1px solid rgba(255,140,40,.18)",
    background: "linear-gradient(135deg, rgba(255,140,40,.10), rgba(80,120,255,.08))",
  },

  clientHeaderRow: {
    display: "flex",
    alignItems: "stretch",
    justifyContent: "space-between",
    gap: 10,
    padding: 10,
    background: "rgba(0,0,0,.20)",
  },

  clientHeaderBtn: {
    flex: 1,
    textAlign: "left",
    padding: 12,
    border: "none",
    cursor: "pointer",
    background: "rgba(0,0,0,.00)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
    borderRadius: 14,
  },

  clientName: {
    fontWeight: 900,
    fontSize: 13,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },

  clientCount: {
    fontWeight: 900,
    fontSize: 11,
    opacity: 0.7,
    whiteSpace: "nowrap",
  },

  clientUsers: {
    padding: 10,
    display: "grid",
    gap: 8,
    background: "rgba(0,0,0,.12)",
  },

  miniEmpty: {
    padding: 10,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.18)",
    fontWeight: 800,
    fontSize: 12,
    opacity: 0.8,
  },

  userRowWrap: { display: "grid", gridTemplateColumns: "1fr 34px", gap: 8, alignItems: "center" },

  userRow: {
    width: "100%",
    textAlign: "left",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    cursor: "pointer",
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
  },

  userRowActive: {
    border: "1px solid rgba(255,140,40,.20)",
    background: "rgba(255,140,40,.08)",
  },

  userEmail: {
    fontWeight: 900,
    fontSize: 12,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },

  userBadge: {
    fontSize: 11,
    fontWeight: 900,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.06)",
    whiteSpace: "nowrap",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },

  grid: {
    padding: 14,
    overflowY: "auto",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 14,
  },

  agentCard: {
    width: "100%",
    padding: 14,
    borderRadius: 20,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.28)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    cursor: "pointer",
    display: "grid",
    gap: 10,
    userSelect: "none",
  },

  agentCardOn: {
    border: "1px solid rgba(255,140,40,.25)",
    background: "linear-gradient(135deg, rgba(255,140,40,.14), rgba(80,120,255,.10))",
  },

  agentTop: { display: "flex", justifyContent: "center", alignItems: "center", paddingTop: 6 },

  avatar: { width: 74, height: 74, borderRadius: "50%", objectFit: "cover", objectPosition: "center 5%", display: "block" },

  agentMeta: { display: "grid", gap: 4, justifyItems: "center", textAlign: "center", padding: "0 6px" },
  agentName: { fontWeight: 900, fontSize: 14 },
  agentDesc: { fontWeight: 700, fontSize: 12, opacity: 0.8 },

  actionsRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginTop: 2 },

  check: {
    fontWeight: 900,
    fontSize: 12,
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    whiteSpace: "nowrap",
  },

  cfgBtn: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.22)",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
    appearance: "none",
    WebkitAppearance: "none",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },

  alert: {
    margin: 12,
    padding: 12,
    borderRadius: 16,
    background: "rgba(255,140,40,.10)",
    border: "1px solid rgba(255,140,40,.18)",
    fontWeight: 900,
    fontSize: 13,
  },

  saving: { fontWeight: 900, fontSize: 12, opacity: 0.8 },

  card: {
    margin: "60px auto",
    maxWidth: 720,
    padding: 24,
    borderRadius: 22,
    background: "linear-gradient(135deg, rgba(0,0,0,.58), rgba(0,0,0,.36))",
    boxShadow: "0 24px 70px rgba(0,0,0,.45)",
    backdropFilter: "blur(14px)",
  },

  h1: { fontSize: 22, fontWeight: 900 },
  p: { marginTop: 10, opacity: 0.8, fontWeight: 800 },

  // FORM
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 12,
  },

  select: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 12,
  },

  textarea: {
    width: "100%",
    minHeight: 180,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.40)",
    color: "#eef2ff",
    outline: "none",
    fontWeight: 800,
    fontSize: 12,
    resize: "vertical",
  },

  hint: { marginTop: 8, opacity: 0.8, fontWeight: 800, fontSize: 12, lineHeight: 1.4 },

  block: { display: "grid", gap: 10, marginBottom: 14 },

  label: { fontWeight: 900, fontSize: 12 },

  file: { width: "100%" },

  sourcesList: { display: "grid", gap: 10, marginTop: 10 },

  sourceItem: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 10,
    alignItems: "center",
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
  },

  sourceType: { fontWeight: 900, fontSize: 11, opacity: 0.8 },
  sourceVal: { fontWeight: 800, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  // MODAL
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,.62)",
    backdropFilter: "blur(6px)",
    zIndex: 9999,
    display: "grid",
    placeItems: "center",
    padding: 14,
  },

  modal: {
    width: "min(640px, 96vw)",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "linear-gradient(135deg, rgba(0,0,0,.70), rgba(0,0,0,.40))",
    boxShadow: "0 30px 90px rgba(0,0,0,.55)",
    overflow: "hidden",
    color: "#eef2ff",
  },

  modalWide: {
    width: "min(980px, 96vw)",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,.10)",
    background: "linear-gradient(135deg, rgba(0,0,0,.70), rgba(0,0,0,.40))",
    boxShadow: "0 30px 90px rgba(0,0,0,.55)",
    overflow: "hidden",
    color: "#eef2ff",
  },

  modalHeader: {
    padding: 14,
    borderBottom: "1px solid rgba(255,255,255,.08)",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    background: "rgba(0,0,0,.22)",
  },

  modalTitle: { fontWeight: 900, fontSize: 13 },

  modalBody: { padding: 14 },

  modalFooter: {
    padding: 14,
    borderTop: "1px solid rgba(255,255,255,.08)",
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    background: "rgba(0,0,0,.18)",
  },

  tabs: {
    display: "flex",
    gap: 8,
    padding: 12,
    borderBottom: "1px solid rgba(255,255,255,.08)",
    background: "rgba(0,0,0,.16)",
  },

  tab: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.20)",
    fontWeight: 900,
    cursor: "pointer",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },

  tabOn: {
    border: "1px solid rgba(255,140,40,.25)",
    background: "rgba(255,140,40,.10)",
  },

  // Conversations list
  convRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: 12,
    alignItems: "center",
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.10)",
    background: "rgba(0,0,0,.22)",
  },
  convTitle: { fontWeight: 900, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  convMeta: { marginTop: 6, fontWeight: 800, fontSize: 12, opacity: 0.75, wordBreak: "break-word" },
};
