// pages/admin/index.js
import { useEffect, useMemo, useState } from "react";
import { supabase } from "../../lib/supabaseClient";

function safeStr(v) {
  return (v ?? "").toString();
}

export default function Admin() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);

  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");

  const [users, setUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedUserEmail, setSelectedUserEmail] = useState("");

  const [agents, setAgents] = useState([]);
  const [assignedAgentIds, setAssignedAgentIds] = useState(new Set());

  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgAgent, setCfgAgent] = useState(null);
  const [cfgPrompt, setCfgPrompt] = useState("");
  const [cfgSources, setCfgSources] = useState([]); // [{type:'url'|'file', ...}]
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgMsg, setCfgMsg] = useState("");

  const [err, setErr] = useState("");

  async function getToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr("");

      const { data: sess } = await supabase.auth.getSession();
      const user = sess?.session?.user;
      if (!user) {
        window.location.href = "/login";
        return;
      }
      setMe(user);

      const { data: prof, error: profErr } = await supabase
        .from("profiles")
        .select("role, email")
        .eq("user_id", user.id)
        .maybeSingle();

      if (profErr) {
        setErr("Erreur profil admin.");
        setLoading(false);
        return;
      }

      const okAdmin = prof?.role === "admin";
      setIsAdmin(okAdmin);

      if (!okAdmin) {
        setErr("Accès refusé (admin uniquement).");
        setLoading(false);
        return;
      }

      // load clients
      const { data: cData, error: cErr } = await supabase
        .from("clients")
        .select("id, name, created_at")
        .order("created_at", { ascending: false });

      if (cErr) {
        setErr("Erreur chargement clients.");
        setLoading(false);
        return;
      }

      setClients(cData || []);
      const first = cData?.[0];
      setClientId(first?.id || "");
      setClientName(first?.name || "");

      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!clientId) return;
    (async () => {
      setErr("");

      // users by client
      const { data: cu, error: cuErr } = await supabase
        .from("client_users")
        .select("id, user_id, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });

      if (cuErr) {
        setErr("Erreur chargement users du client.");
        setUsers([]);
        return;
      }

      const userIds = (cu || []).map((r) => r.user_id).filter(Boolean);

      let profiles = [];
      if (userIds.length) {
        const { data: pData } = await supabase
          .from("profiles")
          .select("user_id, email, role")
          .in("user_id", userIds);
        profiles = pData || [];
      }

      const merged = (cu || []).map((r) => {
        const p = profiles.find((x) => x.user_id === r.user_id);
        return { ...r, email: p?.email || "", role: p?.role || "" };
      });

      setUsers(merged);

      const firstU = merged?.[0];
      setSelectedUserId(firstU?.user_id || "");
      setSelectedUserEmail(firstU?.email || "");
    })();
  }, [clientId]);

  useEffect(() => {
    (async () => {
      // agents
      const { data: aData, error: aErr } = await supabase
        .from("agents")
        .select("id, slug, name, description, avatar_url")
        .order("name", { ascending: true });

      if (aErr) {
        setErr("Erreur chargement agents.");
        setAgents([]);
        return;
      }
      setAgents(aData || []);
    })();
  }, []);

  useEffect(() => {
    if (!selectedUserId) return;
    (async () => {
      // assigned agents
      const { data: ua, error: uaErr } = await supabase
        .from("user_agents")
        .select("agent_id")
        .eq("user_id", selectedUserId);

      if (uaErr) {
        setAssignedAgentIds(new Set());
        return;
      }
      setAssignedAgentIds(new Set((ua || []).map((x) => x.agent_id)));
    })();
  }, [selectedUserId]);

  const selectedUser = useMemo(() => {
    if (!selectedUserId) return null;
    return (users || []).find((u) => u.user_id === selectedUserId) || null;
  }, [users, selectedUserId]);

  async function toggleAssign(agent) {
    if (!selectedUserId || !agent?.id) return;
    setErr("");

    const already = assignedAgentIds.has(agent.id);

    if (already) {
      const { error } = await supabase
        .from("user_agents")
        .delete()
        .eq("user_id", selectedUserId)
        .eq("agent_id", agent.id);

      if (error) {
        setErr("Impossible de retirer l’agent.");
        return;
      }

      const next = new Set(assignedAgentIds);
      next.delete(agent.id);
      setAssignedAgentIds(next);
      return;
    }

    const { error } = await supabase.from("user_agents").insert({
      user_id: selectedUserId,
      agent_id: agent.id,
    });

    if (error) {
      setErr("Impossible d’assigner l’agent.");
      return;
    }

    const next = new Set(assignedAgentIds);
    next.add(agent.id);
    setAssignedAgentIds(next);
  }

  function openCfg(agent) {
    setCfgMsg("");
    setCfgAgent(agent);
    setCfgPrompt("");
    setCfgSources([]);
    setCfgOpen(true);

    (async () => {
      if (!selectedUserId || !agent?.id) return;

      const { data } = await supabase
        .from("client_agent_configs")
        .select("system_prompt, context")
        .eq("user_id", selectedUserId)
        .eq("agent_id", agent.id)
        .maybeSingle();

      const sp = safeStr(data?.system_prompt).trim();
      const ctx = data?.context && typeof data.context === "object" ? data.context : {};
      const sources = Array.isArray(ctx?.sources) ? ctx.sources : [];

      setCfgPrompt(sp);
      setCfgSources(sources);
    })();
  }

  async function saveCfg() {
    if (!selectedUserId || !cfgAgent?.id) return;
    setCfgSaving(true);
    setCfgMsg("");

    const nextCtx = { sources: Array.isArray(cfgSources) ? cfgSources : [] };

    const { error } = await supabase.from("client_agent_configs").upsert(
      {
        user_id: selectedUserId,
        agent_id: cfgAgent.id,
        system_prompt: cfgPrompt,
        context: nextCtx,
      },
      { onConflict: "user_id,agent_id" }
    );

    setCfgSaving(false);

    if (error) {
      setCfgMsg("Erreur sauvegarde.");
      return;
    }

    setCfgMsg("Sauvegardé.");
  }

  async function deleteCfg() {
    if (!selectedUserId || !cfgAgent?.id) return;

    setCfgSaving(true);
    setCfgMsg("");

    const { error } = await supabase
      .from("client_agent_configs")
      .delete()
      .eq("user_id", selectedUserId)
      .eq("agent_id", cfgAgent.id);

    setCfgSaving(false);

    if (error) {
      setCfgMsg("Erreur suppression config.");
      return;
    }

    setCfgPrompt("");
    setCfgSources([]);
    setCfgMsg("Config supprimée.");
  }

  async function uploadFile(file) {
    if (!file || !selectedUserId || !cfgAgent?.slug) return;

    setCfgMsg("");

    const ext = safeStr(file.name).split(".").pop()?.toLowerCase() || "bin";
    const safeName = safeStr(file.name).replace(/[^\w.\-()+\s]/g, "_");
    const path = `${selectedUserId}/${cfgAgent.slug}/${Date.now()}_${safeName}`;

    const { error } = await supabase.storage
      .from("agent_sources")
      .upload(path, file, { upsert: true, contentType: file.type || "application/octet-stream" });

    if (error) {
      setCfgMsg("Upload impossible.");
      return;
    }

    const entry = {
      type: "file",
      bucket: "agent_sources",
      path,
      name: safeName,
      mime: file.type || "",
      size: file.size || 0,
      created_at: new Date().toISOString(),
    };

    setCfgSources((prev) => [entry, ...(prev || [])]);
    setCfgMsg("Fichier uploadé (pense à sauvegarder).");
  }

  function addUrlSource(url) {
    const u = safeStr(url).trim();
    if (!u) return;
    const entry = { type: "url", url: u, created_at: new Date().toISOString() };
    setCfgSources((prev) => [entry, ...(prev || [])]);
  }

  function removeSource(idx) {
    setCfgSources((prev) => (prev || []).filter((_, i) => i !== idx));
  }

  async function logout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  if (loading) {
    return (
      <main style={styles.page}>
        <div style={styles.center}>Chargement…</div>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main style={styles.page}>
        <div style={styles.center}>{err || "Accès refusé"}</div>
      </main>
    );
  }

  return (
    <main style={styles.page}>
      <header style={styles.topbar}>
        <div style={styles.topLeft}>
          <div style={styles.brand}>Evidenc’IA — Admin</div>
        </div>
        <div style={styles.topCenter} />
        <div style={styles.topRight}>
          <div style={styles.userLabel} title={safeStr(me?.email)}>
            {safeStr(me?.email)}
          </div>
          <button style={styles.btn} onClick={logout}>
            Déconnexion
          </button>
        </div>
      </header>

      <div style={styles.shell}>
        <section style={styles.panel}>
          <div style={styles.panelTitle}>Clients</div>
          <select
            style={styles.select}
            value={clientId}
            onChange={(e) => {
              const id = e.target.value;
              setClientId(id);
              const c = (clients || []).find((x) => x.id === id);
              setClientName(c?.name || "");
            }}
          >
            {(clients || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <div style={{ height: 10 }} />

          <div style={styles.panelTitle}>Utilisateurs</div>
          <div style={styles.list}>
            {(users || []).map((u) => (
              <button
                key={u.user_id}
                style={{
                  ...styles.listItem,
                  ...(selectedUserId === u.user_id ? styles.listItemActive : {}),
                }}
                onClick={() => {
                  setSelectedUserId(u.user_id);
                  setSelectedUserEmail(u.email || "");
                }}
              >
                <div style={styles.liTitle}>{u.email || u.user_id}</div>
                <div style={styles.liMeta}>{u.role || ""}</div>
              </button>
            ))}
          </div>
        </section>

        <section style={styles.panel}>
          <div style={styles.panelTitle}>Agents</div>
          <div style={styles.grid}>
            {(agents || []).map((a) => {
              const assigned = assignedAgentIds.has(a.id);
              return (
                <div key={a.id} style={styles.card}>
                  <div style={styles.cardTop}>
                    {a.avatar_url ? (
                      <img src={a.avatar_url} alt={a.name} style={styles.avatar} />
                    ) : (
                      <div style={styles.avatarFallback} />
                    )}
                    <div style={{ display: "grid", gap: 4 }}>
                      <div style={styles.cardTitle}>{a.name || a.slug}</div>
                      <div style={styles.cardDesc}>{a.description || ""}</div>
                    </div>
                  </div>

                  <div style={styles.cardActions}>
                    <button
                      style={{
                        ...styles.btn,
                        ...(assigned ? styles.btnOn : {}),
                      }}
                      onClick={() => toggleAssign(a)}
                    >
                      {assigned ? "Assigné" : "Assigner"}
                    </button>

                    <button style={styles.btnGhost} onClick={() => openCfg(a)} disabled={!selectedUserId}>
                      Prompt & Données
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {err ? <div style={styles.err}>{err}</div> : null}
        </section>
      </div>

      {cfgOpen && cfgAgent ? (
        <div style={styles.modalOverlay} onMouseDown={() => setCfgOpen(false)}>
          <div style={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
            <div style={styles.modalTop}>
              <div style={styles.modalTitle}>
                Prompt & Données — <span style={{ opacity: 0.8 }}>{cfgAgent.name || cfgAgent.slug}</span>
              </div>
              <button style={styles.closeBtn} onClick={() => setCfgOpen(false)}>
                ×
              </button>
            </div>

            <div style={styles.modalBody}>
              <div style={styles.blockTitle}>
                Prompt personnel (user: {selectedUserEmail || selectedUserId || ""})
              </div>
              <textarea
                style={styles.textarea}
                value={cfgPrompt}
                onChange={(e) => setCfgPrompt(e.target.value)}
                placeholder="Prompt perso (par utilisateur et par agent)…"
              />

              <div style={{ height: 12 }} />

              <div style={styles.blockTitle}>Sources</div>

              <div style={styles.row}>
                <input
                  style={styles.input}
                  placeholder="Ajouter une URL…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addUrlSource(e.currentTarget.value);
                      e.currentTarget.value = "";
                    }
                  }}
                />
                <button
                  style={styles.btn}
                  onClick={() => {
                    const el = document.getElementById("adminAddUrl");
                    const v = el?.value || "";
                    addUrlSource(v);
                    if (el) el.value = "";
                  }}
                >
                  Ajouter URL
                </button>
              </div>

              <input id="adminAddUrl" style={{ display: "none" }} />

              <div style={{ height: 10 }} />

              <div style={styles.uploadBox}>
                <div style={styles.uploadTitle}>Uploader un fichier dans le bucket <b>agent_sources</b> (PDF, CSV, Word, Excel, TXT, etc).</div>
                <input
                  type="file"
                  accept=".pdf,.csv,.txt,.md,.json,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) await uploadFile(file);
                  }}
                />
              </div>

              <div style={{ height: 10 }} />

              <div style={styles.sourcesList}>
                {(cfgSources || []).map((s, idx) => (
                  <div key={idx} style={styles.sourceItem}>
                    <div style={{ display: "grid", gap: 2 }}>
                      <div style={styles.sourceTitle}>
                        {safeStr(s.type).toUpperCase()} — {safeStr(s.name || s.title || s.url || s.path)}
                      </div>
                      <div style={styles.sourceMeta}>
                        {s.type === "file" ? `bucket=${s.bucket} path=${s.path}` : ""}
                      </div>
                    </div>
                    <button style={styles.btnDanger} onClick={() => removeSource(idx)}>
                      Retirer
                    </button>
                  </div>
                ))}
              </div>

              {cfgMsg ? <div style={styles.msg}>{cfgMsg}</div> : null}

              <div style={styles.modalActions}>
                <button style={styles.btnGhost} onClick={deleteCfg} disabled={cfgSaving}>
                  Supprimer config
                </button>
                <div style={{ flex: 1 }} />
                <button style={styles.btn} onClick={saveCfg} disabled={cfgSaving}>
                  {cfgSaving ? "Sauvegarde…" : "Sauvegarder"}
                </button>
              </div>

              <div style={styles.note}>
                Note : après upload/URL, clique sur <b>Sauvegarder</b> pour que l’API chat puisse charger ces sources.
              </div>
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
    background: "#0b0b0f",
    color: "#fff",
  },
  topbar: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
    alignItems: "center",
    padding: "14px 18px",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.28)",
    backdropFilter: "blur(10px)",
    position: "sticky",
    top: 0,
    zIndex: 5,
  },
  topLeft: { display: "flex", gap: 10, alignItems: "center" },
  topCenter: {},
  topRight: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 12 },
  brand: { fontWeight: 900 },
  userLabel: {
    fontSize: 12,
    fontWeight: 800,
    color: "rgba(238,242,255,0.78)",
    maxWidth: 280,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  shell: {
    display: "grid",
    gridTemplateColumns: "320px 1fr",
    gap: 14,
    padding: 14,
  },
  panel: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.28)",
    backdropFilter: "blur(10px)",
    padding: 14,
    minHeight: 200,
  },
  panelTitle: { fontWeight: 900, marginBottom: 10, opacity: 0.95 },
  select: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.35)",
    color: "#fff",
    outline: "none",
  },
  list: { display: "grid", gap: 10 },
  listItem: {
    textAlign: "left",
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.26)",
    color: "#fff",
    padding: "12px",
    cursor: "pointer",
  },
  listItemActive: {
    border: "1px solid rgba(255,140,0,0.42)",
    background: "rgba(255,140,0,0.08)",
  },
  liTitle: { fontSize: 12, fontWeight: 900, marginBottom: 6, wordBreak: "break-word" },
  liMeta: { fontSize: 11, fontWeight: 700, color: "rgba(238,242,255,0.60)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12 },
  card: {
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.20)",
    padding: 14,
    display: "grid",
    gap: 12,
  },
  cardTop: { display: "flex", gap: 12, alignItems: "center" },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    objectFit: "cover",
    border: "2px solid rgba(255,255,255,0.25)",
  },
  avatarFallback: {
    width: 56,
    height: 56,
    borderRadius: "50%",
    border: "2px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.06)",
  },
  cardTitle: { fontWeight: 900 },
  cardDesc: { fontSize: 12, fontWeight: 700, color: "rgba(238,242,255,0.70)", lineHeight: 1.35 },
  cardActions: { display: "flex", gap: 10, alignItems: "center" },
  btn: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnOn: {
    border: "1px solid rgba(255,140,0,0.35)",
    background: "rgba(255,140,0,0.18)",
  },
  btnGhost: {
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.20)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
  },
  btnDanger: {
    padding: "8px 10px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,0,0,0.10)",
    color: "rgba(255, 90, 90, 0.95)",
    fontWeight: 900,
    cursor: "pointer",
  },
  err: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,0,0,0.08)",
    color: "rgba(255,170,170,0.95)",
    fontWeight: 900,
  },
  center: { padding: 30, fontWeight: 900 },

  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.55)",
    display: "grid",
    placeItems: "center",
    zIndex: 50,
    padding: 14,
  },
  modal: {
    width: "min(920px, 100%)",
    maxHeight: "92vh",
    overflow: "hidden",
    borderRadius: 18,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.55)",
    backdropFilter: "blur(10px)",
    display: "flex",
    flexDirection: "column",
  },
  modalTop: {
    padding: 14,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: "1px solid rgba(255,255,255,0.10)",
  },
  modalTitle: { fontWeight: 900 },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.06)",
    color: "#fff",
    fontWeight: 900,
    cursor: "pointer",
    fontSize: 18,
    lineHeight: "18px",
  },
  modalBody: {
    padding: 14,
    overflowY: "auto",
  },
  blockTitle: { fontWeight: 900, marginBottom: 8, color: "rgba(255,255,255,0.92)" },
  textarea: {
    width: "100%",
    minHeight: 150,
    borderRadius: 12,
    padding: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.35)",
    color: "#fff",
    outline: "none",
    resize: "vertical",
    fontWeight: 700,
  },
  row: { display: "flex", gap: 10, alignItems: "center" },
  input: {
    flex: 1,
    borderRadius: 12,
    padding: "10px 12px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.35)",
    color: "#fff",
    outline: "none",
    fontWeight: 700,
  },
  uploadBox: {
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(255,255,255,0.04)",
    padding: 12,
    display: "grid",
    gap: 8,
  },
  uploadTitle: { fontSize: 12, fontWeight: 800, color: "rgba(238,242,255,0.78)" },
  sourcesList: { display: "grid", gap: 10 },
  sourceItem: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.10)",
    background: "rgba(0,0,0,0.26)",
    padding: 12,
  },
  sourceTitle: { fontWeight: 900, fontSize: 12, wordBreak: "break-word" },
  sourceMeta: { fontSize: 11, fontWeight: 700, color: "rgba(238,242,255,0.60)" },
  msg: { marginTop: 10, fontWeight: 900, opacity: 0.9 },
  modalActions: { marginTop: 12, display: "flex", alignItems: "center", gap: 10 },
  note: { marginTop: 10, fontSize: 12, color: "rgba(238,242,255,0.65)", lineHeight: 1.35 },
};
