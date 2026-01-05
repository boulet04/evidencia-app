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

  // Prompt & data modal state
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

  const isAdmin = useMemo(() => me?.role === "admin", [me]);

  function clientLabel(c) {
    const v =
      (c?.name || c?.customer_name || c?.company_name || c?.title || "").trim();
    return v || "Client";
  }

  function safeStr(v) {
    return (v || "").toString();
  }

  function normalizeImgSrc(src) {
    const s = safeStr(src).trim();
    if (!s) return "";
    if (s.startsWith("http://") || s.startsWith("https://")) return s;
    if (s.startsWith("/")) return s;
    return "/" + s;
  }

  function isAdminUser() {
    return !!me && me.role === "admin";
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
        role: safeStr(p?.role) || "user",
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
      role: safeStr(p?.role) || "user",
    };
  }, [profileByUserId, selectedUserId]);

  const assignedSet = useMemo(() => {
    const set = new Set();
    for (const row of userAgents) {
      if (row.user_id === selectedUserId) set.add(row.agent_id);
    }
    return set;
  }, [userAgents, selectedUserId]);

  useEffect(() => {
    let mounted = true;

    async function boot() {
      setMsg("");
      setLoading(true);

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        window.location.href = "/login";
        return;
      }

      // 1) Lire profil connecté
      const { data: myP1, error: myE1 } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", session.user.id)
        .maybeSingle();

      let myProfile = myP1;

      // 1bis) si absent, créer profil
      if (!myE1 && !myProfile) {
        const newRow = {
          user_id: session.user.id,
          email: session.user.email,
          role: "user",
        };

        const newId =
          typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : null;

        if (newId) newRow.id = newId;

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
        setMsg(
          myE1
            ? `Lecture du profil impossible : ${myE1.message}`
            : "Profil introuvable (table profiles)."
        );
        return;
      }

      const myProfileSafe = {
        ...myProfile,
        email: myProfile.email || session.user.email || null,
      };
      setMe(myProfileSafe);

      if (myProfileSafe.role !== "admin") {
        setLoading(false);
        setMsg("Accès refusé : vous n’êtes pas admin.");
        return;
      }

      // 2) Charger données
      const [cRes, cuRes, pRes, aRes, uaRes] = await Promise.all([
        supabase.from("clients").select("*"),
        supabase.from("client_users").select("client_id, user_id"),
        supabase.from("profiles").select("user_id, email, role"),
        supabase.from("agents").select("id, slug, name, description, avatar_url"),
        supabase
          .from("user_agents")
          .select("user_id, agent_id, created_at")
          .order("created_at", { ascending: false }),
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

      // 3) Sélections par défaut
      let defaultClientId = "";
      let defaultUserId = "";

      const firstWithUser = clientsSafe.find((c) =>
        clientUsersSafe.some((x) => x.client_id === c.id)
      );
      defaultClientId = firstWithUser?.id || clientsSafe[0]?.id || "";

      if (defaultClientId) {
        defaultUserId =
          clientUsersSafe.find((x) => x.client_id === defaultClientId)?.user_id ||
          "";
      }

      setSelectedClientId(defaultClientId);
      setSelectedUserId(defaultUserId);

      setLoading(false);
    }

    boot();
    return () => {
      mounted = false;
    };
  }, []);

  // Quand on change de client => sélectionner le premier user du client
  useEffect(() => {
    if (!selectedClientId) return;
    const firstUserId =
      clientUsers.find((x) => x.client_id === selectedClientId)?.user_id || "";
    setSelectedUserId(firstUserId);
  }, [selectedClientId, clientUsers]);

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  async function toggleAgent(agentId) {
    if (!selectedUserId || !agentId) return;
    if (!isAdminUser()) return;

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

        setUserAgents((prev) =>
          prev.filter((r) => !(r.user_id === selectedUserId && r.agent_id === agentId))
        );
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

    setCfgSources((prev) => [
      { type: "url", value: url, created_at: new Date().toISOString() },
      ...prev,
    ]);
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

      const { error } = await supabase.storage
        .from(bucket)
        .upload(path, file, { upsert: true });

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
        workflow: {
          provider: cfgWorkflowProvider || "",
          id: cfgWorkflowId || "",
        },
        sources: cfgSources,
      };

      // upsert via contrainte unique (user_id, agent_id)
      const { error } = await supabase
        .from("client_agent_configs")
        .upsert(
          {
            user_id: selectedUserId,
            agent_id: cfgAgent.id,
            system_prompt: cfgPrompt || "",
            context,
          },
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
          <button
            style={styles.btnGhost}
            onClick={() => (window.location.href = "/agents")}
          >
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
            <div style={styles.panelTitle}>Clients</div>
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
                    <button
                      onClick={() => setSelectedClientId(c.id)}
                      style={styles.clientHeaderBtn}
                      title={c.label}
                      type="button"
                    >
                      <div style={styles.clientName}>{c.label}</div>
                      <div style={styles.clientCount}>{(c.users || []).length} user(s)</div>
                    </button>

                    <div style={styles.clientUsers}>
                      {(c.users || []).length === 0 ? (
                        <div style={styles.miniEmpty}>Aucun utilisateur rattaché.</div>
                      ) : (
                        c.users.map((u) => {
                          const activeUser = u.user_id === selectedUserId;
                          return (
                            <button
                              key={u.user_id}
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
                  <b>Utilisateur :</b>{" "}
                  {selectedUser ? selectedUser.email || selectedUser.user_id : "-"}
                </div>
                <div>
                  <b>user_id :</b> {selectedUser ? selectedUser.user_id : "-"}
                </div>
              </div>
            </div>

            {saving ? <div style={styles.saving}>Enregistrement…</div> : null}
          </div>

          {msg ? <div style={styles.alert}>{msg}</div> : null}

          <div style={styles.grid}>
            {agents.map((a) => {
              const checked = assignedSet.has(a.id);
              const src = normalizeImgSrc(a.avatar_url) || `/images/${a.slug}.png`;

              return (
                <div
                  key={a.id}
                  style={{
                    ...styles.agentCard,
                    ...(checked ? styles.agentCardOn : null),
                  }}
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

                  {/* ✅ CORRECTION: affichage nom + description */}
                  <div style={styles.agentMeta}>
                    <div style={styles.agentName}>{a.name}</div>
                    <div style={styles.agentDesc}>{a.description}</div>
                  </div>

                  <div style={styles.actionsRow}>
                    <div style={styles.check}>{checked ? "Assigné" : "Non assigné"}</div>

                    {/* bouton prompt/données sans déclencher toggle */}
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

      {/* MODALE */}
      {cfgOpen ? (
        <div style={styles.modalOverlay} onMouseDown={closeConfig} role="dialog" aria-modal="true">
          <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <div style={styles.modalTitle}>
                {cfgAgent?.name || "Agent"} — configuration utilisateur
              </div>
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
                    <div style={styles.hint}>
                      Ce prompt est stocké dans <b>client_agent_configs.system_prompt</b>.
                    </div>
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
                      <div style={styles.hint}>
                        Upload dans le bucket <b>agent_sources</b>.
                      </div>
                    </div>

                    <div style={styles.sourcesList}>
                      {cfgSources.length === 0 ? (
                        <div style={styles.miniEmpty}>Aucune source pour le moment.</div>
                      ) : (
                        cfgSources.map((s, idx) => (
                          <div key={idx} style={styles.sourceItem}>
                            <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                              <div style={styles.sourceType}>
                                {s.type === "url" ? "URL" : "Fichier"}
                              </div>
                              <div style={styles.sourceVal}>
                                {s.type === "url"
                                  ? s.value
                                  : `${s.name} (${s.path})`}
                              </div>
                            </div>
                            <button
                              type="button"
                              style={styles.btnGhost}
                              onClick={() => removeSource(idx)}
                              title="Supprimer"
                            >
                              Supprimer
                            </button>
                          </div>
                        ))
                      )}
                    </div>

                    <div style={styles.hint}>
                      Ces sources sont stockées dans <b>client_agent_configs.context.sources</b>.
                    </div>
                  </div>
                ) : null}

                {cfgTab === "workflow" ? (
                  <div style={styles.block}>
                    <div style={styles.label}>Workflow (n8n / Make)</div>

                    <div style={styles.row}>
                      <select
                        value={cfgWorkflowProvider}
                        onChange={(e) => setCfgWorkflowProvider(e.target.value)}
                        style={styles.select}
                      >
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
                      Le déclenchement réel se fera plus tard via ton backend / n8n / Make.
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
    background:
      "linear-gradient(135deg, rgba(255,140,40,.10), rgba(80,120,255,.08))",
  },

  clientHeaderBtn: {
    width: "100%",
    textAlign: "left",
    padding: 12,
    border: "none",
    cursor: "pointer",
    background: "rgba(0,0,0,.20)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    alignItems: "center",
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
    background:
      "linear-gradient(135deg, rgba(255,140,40,.14), rgba(80,120,255,.10))",
  },

  agentTop: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 6,
  },

  avatar: {
    width: 74,
    height: 74,
    borderRadius: "50%",
    objectFit: "cover",
    objectPosition: "center 5%",
    display: "block",
  },

  // ✅ NOMS + DESC
  agentMeta: {
    display: "grid",
    gap: 4,
    justifyItems: "center",
    textAlign: "center",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    padding: "0 6px",
  },
  agentName: {
    fontWeight: 900,
    fontSize: 14,
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },
  agentDesc: {
    fontWeight: 700,
    fontSize: 12,
    opacity: 0.8,
    color: "inherit",
    WebkitTextFillColor: "currentColor",
  },

  actionsRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    marginTop: 2,
  },

  check: {
    fontWeight: 900,
    fontSize: 12,
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(0,0,0,.35)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    whiteSpace: "nowrap",
  },

  cfgBtn: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,.14)",
    background: "rgba(0,0,0,.22)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
    appearance: "none",
    WebkitAppearance: "none",
  },

  alert: {
    margin: 12,
    padding: 12,
    borderRadius: 16,
    background: "rgba(255,140,40,.10)",
    border: "1px solid rgba(255,140,40,.18)",
    color: "inherit",
    WebkitTextFillColor: "currentColor",
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
    width: "min(920px, 96vw)",
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
    color: "inherit",
    WebkitTextFillColor: "currentColor",
    fontWeight: 900,
    cursor: "pointer",
  },
};

