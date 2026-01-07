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

  // Modal prompt
  const [modalOpen, setModalOpen] = useState(false);
  const [modalAgent, setModalAgent] = useState(null);
  const [modalSystemPrompt, setModalSystemPrompt] = useState("");
  const [modalContextJson, setModalContextJson] = useState("{}");

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function refreshAll() {
    setLoading(true);
    setMsg("");

    const [
      cRes,
      cuRes,
      pRes,
      aRes,
      uaRes,
      cfgRes,
    ] = await Promise.all([
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

  const filteredClients = useMemo(() => {
    const qq = (q || "").trim().toLowerCase();
    if (!qq) return clients;
    return clients.filter((c) => (c?.name || "").toLowerCase().includes(qq));
  }, [clients, q]);

  const usersForSelectedClient = useMemo(() => {
    if (!selectedClientId) return [];
    const links = clientUsers.filter((x) => x.client_id === selectedClientId);

    return links.map((l) => {
      const p = profiles.find((pp) => pp.user_id === l.user_id);
      return {
        user_id: l.user_id,
        email: p?.email || "(email non renseigné)",
        role: p?.role || "",
      };
    });
  }, [selectedClientId, clientUsers, profiles]);

  // Si on change de client, on auto-sélectionne le 1er user (si dispo)
  useEffect(() => {
    if (!selectedClientId) {
      setSelectedUserId("");
      return;
    }
    // Si l'utilisateur sélectionné n'appartient plus au client -> reset puis auto-pick
    const stillOk = usersForSelectedClient.some((u) => u.user_id === selectedUserId);
    if (!stillOk) {
      const first = usersForSelectedClient[0]?.user_id || "";
      setSelectedUserId(first);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClientId, usersForSelectedClient.length]);

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
    setModalAgent(agent);
    setModalSystemPrompt(cfg?.system_prompt || "");
    setModalContextJson(JSON.stringify(cfg?.context || {}, null, 2));
    setModalOpen(true);
  }

  async function savePromptModal() {
    const token = await getAccessToken();
    if (!token) return alert("Non authentifié.");
    if (!selectedUserId || !modalAgent) return;

    const res = await fetch("/api/admin/save-agent-config", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId: selectedUserId,
        agentId: modalAgent.id,
        systemPrompt: modalSystemPrompt,
        contextJson: modalContextJson,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) return alert(`Erreur (${res.status}) : ${data?.error || "?"}`);

    setModalOpen(false);
    setModalAgent(null);
    await refreshAll();
  }

  async function deleteAgentConversations(agentSlug, agentName) {
    if (!selectedUserId) return alert("Sélectionnez un utilisateur.");
    const ok = window.confirm(
      `Supprimer toutes les conversations de l'agent "${agentName}" pour cet utilisateur ?`
    );
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
        <div style={styles.brand}>Evidenc’IA</div>
        <div style={styles.title}>Console administrateur</div>
      </div>

      <div style={styles.wrap}>
        {/* Colonne gauche */}
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
              <div style={{ display: "grid", gap: 10 }}>
                {filteredClients.map((c) => {
                  const count = clientUsers.filter((x) => x.client_id === c.id).length;
                  const active = c.id === selectedClientId;
                  return (
                    <div
                      key={c.id}
                      style={{ ...styles.clientCard, ...(active ? styles.clientCardActive : {}) }}
                      onClick={() => {
                        setSelectedClientId(c.id);
                        // on reset, le useEffect auto-pick fera le reste
                        setSelectedUserId("");
                      }}
                    >
                      <div style={styles.clientName}>{c.name}</div>
                      <div style={styles.small}>{count} user(s)</div>
                    </div>
                  );
                })}
                {!filteredClients.length && <div style={styles.muted}>Aucun client.</div>}
              </div>
            )}
          </div>

          <div style={{ height: 12 }} />

          <div style={styles.box}>
            <div style={styles.boxTitle}>Utilisateurs du client</div>
            {!selectedClientId ? (
              <div style={styles.muted}>Sélectionnez un client.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {usersForSelectedClient.map((u) => {
                  const active = u.user_id === selectedUserId;
                  return (
                    <div
                      key={u.user_id}
                      style={{ ...styles.userPick, ...(active ? styles.userPickActive : {}) }}
                      onClick={() => setSelectedUserId(u.user_id)}
                    >
                      <div style={{ fontWeight: 900 }}>{u.email}</div>
                      <div style={styles.small}>
                        {u.role ? `role: ${u.role}` : "role: (vide)"} — id:{" "}
                        <span style={{ fontFamily: "monospace" }}>{u.user_id}</span>
                      </div>
                    </div>
                  );
                })}
                {usersForSelectedClient.length === 0 && (
                  <div style={styles.muted}>Aucun utilisateur lié.</div>
                )}
              </div>
            )}
          </div>
        </aside>

        {/* Zone principale */}
        <section style={styles.right}>
          <div style={styles.box}>
            <div style={styles.boxTitle}>
              {selectedClientId
                ? selectedUserId
                  ? "Assignation agents"
                  : "Sélectionnez un utilisateur"
                : "Sélectionnez un client"}
            </div>

            {/* Diagnostic rapide (utile tant que vous êtes en mise au point) */}
            <div style={styles.diag}>
              <div><b>Client sélectionné</b>: {selectedClientId ? "oui" : "non"}</div>
              <div><b>User sélectionné</b>: {selectedUserId ? "oui" : "non"}</div>
              <div><b>Agents chargés</b>: {agents.length}</div>
              <div><b>Liaisons user_agents</b>: {userAgents.length}</div>
              <div><b>Configs prompt</b>: {agentConfigs.length}</div>
            </div>

            {!selectedUserId ? (
              <div style={styles.muted}>
                Choisissez un client puis un utilisateur pour gérer les agents, le prompt et les conversations.
              </div>
            ) : agents.length === 0 ? (
              <div style={styles.alert}>
                Aucun agent n’a été chargé depuis la table <b>agents</b>.
                <div style={styles.small}>
                  Cela arrive si la table est vide OU si une policy RLS bloque la lecture côté client.
                </div>
              </div>
            ) : (
              <div style={styles.grid}>
                {agents.map((a) => {
                  const assigned = isAssigned(a.id);
                  const cfg = getConfig(a.id);
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
                            {assigned ? "Assigné" : "Non assigné"} • Prompt:{" "}
                            {hasPrompt ? "personnalisé" : "défaut / vide"}
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

                        <button
                          style={styles.btnDangerGhost}
                          onClick={() => deleteAgentConversations(a.slug, a.name)}
                        >
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

      {/* Modal Prompt */}
      {modalOpen && modalAgent && (
        <div style={styles.modalOverlay} onClick={() => setModalOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div style={styles.modalTitle}>Prompt & données — {modalAgent.name}</div>

            <div style={styles.modalLabel}>System prompt</div>
            <textarea
              value={modalSystemPrompt}
              onChange={(e) => setModalSystemPrompt(e.target.value)}
              style={styles.textarea}
              placeholder="Entrez ici le system prompt personnalisé…"
            />

            <div style={styles.modalLabel}>Context (JSON)</div>
            <textarea
              value={modalContextJson}
              onChange={(e) => setModalContextJson(e.target.value)}
              style={styles.textarea}
              placeholder='{"exemple":"valeur"}'
            />

            <div style={styles.modalActions}>
              <button style={styles.btnGhost} onClick={() => setModalOpen(false)}>
                Annuler
              </button>
              <button style={styles.btnAssign} onClick={savePromptModal}>
                Enregistrer
              </button>
            </div>

            <div style={styles.small}>Le JSON doit être valide.</div>
          </div>
        </div>
      )}
    </main>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg,#05060a,#0a0d16)",
    color: "rgba(238,242,255,.92)",
  fontFamily: "Segoe UI, Arial, sans-serif",
  },
  header: { display: "flex", gap: 12, padding: "18px 18px 0", alignItems: "baseline" },
  brand: { fontWeight: 900, fontSize: 18 },
  title: { opacity: 0.85, fontWeight: 800 },
  wrap: { display: "grid", gridTemplateColumns: "380px 1fr", gap: 16, padding: 18 },
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
  clientCard: {
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.03)",
    cursor: "pointer",
  },
  clientCardActive: { borderColor: "rgba(255,140,40,.35)", background: "rgba(255,140,40,.08)" },
  clientName: { fontWeight: 900 },
  userPick: {
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,.12)",
    background: "rgba(255,255,255,.03)",
    cursor: "pointer",
  },
  userPickActive: { borderColor: "rgba(80,120,255,.35)", background: "rgba(80,120,255,.08)" },
  small: { fontSize: 12, opacity: 0.75, fontWeight: 800 },
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
  avatarWrap: { width: 54, height: 54, borderRadius: 16, overflow: "hidden", border: "1px solid rgba(255,255,255,.12)" },
  avatar: { width: "100%", height: "100%", objectFit: "cover" },
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
    width: "min(900px, 95vw)",
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
};
