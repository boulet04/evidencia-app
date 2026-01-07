// pages/chat/[agentSlug].js
import { useEffect, useMemo, useRef, useState } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import { supabase } from "../../lib/supabaseClient";

function safeStr(v) {
  return (v ?? "").toString();
}

function fmtDate(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function trimTitle(s) {
  const t = safeStr(s).trim().replace(/\s+/g, " ");
  if (!t) return "Nouvelle conversation";
  return t.length > 42 ? t.slice(0, 42) + "…" : t;
}

export default function ChatPage() {
  const router = useRouter();
  const agentSlug = safeStr(router.query.agentSlug).trim().toLowerCase();

  const [booting, setBooting] = useState(true);
  const [fatal, setFatal] = useState("");
  const [sending, setSending] = useState(false);

  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);

  const [agent, setAgent] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [activeConvId, setActiveConvId] = useState("");
  const [messages, setMessages] = useState([]);

  const [text, setText] = useState("");

  // Mobile UI
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const listRef = useRef(null);
  const inputRef = useRef(null);

  const isAdmin = useMemo(() => safeStr(profile?.role).toLowerCase() === "admin", [profile?.role]);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  async function handleLogout() {
    try {
      setMenuOpen(false);
      const { error } = await supabase.auth.signOut();
      if (error) return alert(`Erreur déconnexion : ${error.message || String(error)}`);
      router.push("/login");
    } catch (e) {
      alert(`Erreur déconnexion : ${safeStr(e?.message || e)}`);
    }
  }

  async function goAdmin() {
    setMenuOpen(false);
    router.push("/admin");
  }

  async function refreshConversations(userId) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, created_at, agent_slug, title, archived")
      .eq("user_id", userId)
      .eq("agent_slug", agentSlug)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  async function refreshMessages(convId) {
    if (!convId) return [];
    const { data, error } = await supabase
      .from("messages")
      .select("id, conversation_id, role, content, created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async function ensureConversation(userId) {
    // si activeConvId existe et appartient à la liste, on garde
    if (activeConvId) return activeConvId;

    // sinon on prend la plus récente si existante
    const list = await refreshConversations(userId);
    setConversations(list);
    if (list.length) {
      setActiveConvId(list[0].id);
      return list[0].id;
    }

    // sinon on crée une nouvelle conversation
    const { data: created, error: cErr } = await supabase
      .from("conversations")
      .insert([
        {
          user_id: userId,
          agent_slug: agentSlug,
          title: "Nouvelle conversation",
          archived: false,
        },
      ])
      .select("id")
      .maybeSingle();

    if (cErr) throw cErr;
    const newId = created?.id || "";
    setActiveConvId(newId);

    const newList = await refreshConversations(userId);
    setConversations(newList);

    return newId;
  }

  async function createNewConversation() {
    try {
      setDrawerOpen(false);
      const token = await getAccessToken();
      if (!token) return router.push("/login");

      const { data: uData, error: uErr } = await supabase.auth.getUser(token);
      if (uErr || !uData?.user?.id) return router.push("/login");

      const userId = uData.user.id;

      const { data: created, error: cErr } = await supabase
        .from("conversations")
        .insert([
          {
            user_id: userId,
            agent_slug: agentSlug,
            title: "Nouvelle conversation",
            archived: false,
          },
        ])
        .select("id")
        .maybeSingle();

      if (cErr) throw cErr;

      const id = created?.id || "";
      setActiveConvId(id);
      setMessages([]);

      const newList = await refreshConversations(userId);
      setConversations(newList);

      setTimeout(() => inputRef.current?.focus?.(), 50);
    } catch (e) {
      alert(`Erreur création conversation : ${safeStr(e?.message || e)}`);
    }
  }

  async function openConversation(convId) {
    try {
      setDrawerOpen(false);
      setActiveConvId(convId);
      const msgs = await refreshMessages(convId);
      setMessages(msgs);
      setTimeout(() => scrollToBottom(), 50);
    } catch (e) {
      alert(`Erreur chargement conversation : ${safeStr(e?.message || e)}`);
    }
  }

  function scrollToBottom() {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  async function sendMessage() {
    const content = safeStr(text).trim();
    if (!content) return;

    try {
      setSending(true);
      setFatal("");

      const token = await getAccessToken();
      if (!token) return router.push("/login");

      const { data: uData, error: uErr } = await supabase.auth.getUser(token);
      if (uErr || !uData?.user?.id) return router.push("/login");
      const userId = uData.user.id;

      const convId = await ensureConversation(userId);

      // 1) écrit le message user en DB
      const { error: insUserErr } = await supabase.from("messages").insert([
        { conversation_id: convId, role: "user", content },
      ]);
      if (insUserErr) throw insUserErr;

      setText("");

      // refresh local rapide
      const localMsgs = await refreshMessages(convId);
      setMessages(localMsgs);
      setTimeout(() => scrollToBottom(), 20);

      // 2) appelle l'API chat
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: content, agentSlug }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const detail = data?.detail || data?.error || `HTTP ${res.status}`;
        throw new Error(detail);
      }

      const reply = safeStr(data?.reply || data?.answer || data?.content).trim();
      if (!reply) throw new Error("Réponse vide.");

      // 3) écrit la réponse assistant en DB
      const { error: insAsstErr } = await supabase.from("messages").insert([
        { conversation_id: convId, role: "assistant", content: reply },
      ]);
      if (insAsstErr) throw insAsstErr;

      // 4) titre auto si c'est la première interaction
      const conv = conversations.find((c) => c.id === convId);
      if (conv && (safeStr(conv.title).trim() === "" || safeStr(conv.title).includes("Nouvelle conversation"))) {
        const newTitle = trimTitle(content);
        await supabase.from("conversations").update({ title: newTitle }).eq("id", convId);
      }

      // 5) refresh liste + msgs
      const newList = await refreshConversations(userId);
      setConversations(newList);

      const finalMsgs = await refreshMessages(convId);
      setMessages(finalMsgs);
      setTimeout(() => scrollToBottom(), 40);
    } catch (e) {
      setFatal(safeStr(e?.message || e));
      setTimeout(() => scrollToBottom(), 20);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus?.(), 50);
    }
  }

  useEffect(() => {
    let alive = true;

    async function boot() {
      try {
        setBooting(true);
        setFatal("");

        if (!agentSlug) return;

        // session
        const { data: sess } = await supabase.auth.getSession();
        const access = sess?.session?.access_token || "";
        if (!access) {
          router.push("/login");
          return;
        }

        const { data: uData, error: uErr } = await supabase.auth.getUser(access);
        if (uErr || !uData?.user) {
          router.push("/login");
          return;
        }

        if (!alive) return;
        setUser(uData.user);

        // profile (role admin)
        const { data: pData } = await supabase
          .from("profiles")
          .select("user_id, role, email")
          .eq("user_id", uData.user.id)
          .maybeSingle();

        if (!alive) return;
        setProfile(pData || null);

        // agent meta
        const { data: aData, error: aErr } = await supabase
          .from("agents")
          .select("id, slug, name, description, avatar_url")
          .eq("slug", agentSlug)
          .maybeSingle();

        if (aErr) throw aErr;
        if (!alive) return;
        setAgent(aData || { slug: agentSlug, name: agentSlug, description: "" });

        // conversations + messages
        const list = await refreshConversations(uData.user.id);
        if (!alive) return;
        setConversations(list);

        const firstId = list?.[0]?.id || "";
        if (firstId) {
          setActiveConvId(firstId);
          const msgs = await refreshMessages(firstId);
          if (!alive) return;
          setMessages(msgs);
          setTimeout(() => scrollToBottom(), 80);
        } else {
          setActiveConvId("");
          setMessages([]);
        }

        setBooting(false);
      } catch (e) {
        if (!alive) return;
        setFatal(safeStr(e?.message || e));
        setBooting(false);
      }
    }

    boot();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSlug]);

  const activeTitle = useMemo(() => {
    const conv = conversations.find((c) => c.id === activeConvId);
    return trimTitle(conv?.title || "Nouvelle conversation");
  }, [conversations, activeConvId]);

  return (
    <>
      <Head>
        <title>{agent?.name ? `${agent.name} — Evidenc’IA` : "Evidenc’IA"}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      </Head>

      <main className="page">
        {/* TOP BAR */}
        <header className="topbar">
          <div className="topbarLeft">
            <button className="btn btnGhost" onClick={() => router.back()} aria-label="Retour">
              ← Retour
            </button>

            <div className="agentChip">
              <div className="agentAvatar">
                {agent?.avatar_url ? <img src={agent.avatar_url} alt={agent.name || "Agent"} /> : null}
              </div>
              <div className="agentMeta">
                <div className="agentName">{safeStr(agent?.name || "Agent")}</div>
                <div className="agentDesc">{safeStr(agent?.description || agent?.slug || "")}</div>
              </div>
            </div>

            <img className="brandLogo" src="/images/logolong.png" alt="Evidenc’IA" draggable={false} />
          </div>

          {/* Desktop actions */}
          <div className="topbarRight desktopOnly">
            {isAdmin ? (
              <button className="btn btnGhost" onClick={goAdmin}>
                Console admin
              </button>
            ) : null}
            <button className="btn btnDanger" onClick={handleLogout}>
              Déconnexion
            </button>
          </div>

          {/* Mobile menu */}
          <div className="topbarRight mobileOnly">
            <button className="btn btnGhost" onClick={() => setDrawerOpen(true)}>
              Historique
            </button>

            <button className="btn btnGhost" onClick={() => setMenuOpen((v) => !v)} aria-label="Menu">
              ☰
            </button>

            {menuOpen ? (
              <div className="menu" onClick={() => setMenuOpen(false)}>
                <div className="menuPanel" onClick={(e) => e.stopPropagation()}>
                  {isAdmin ? (
                    <button className="menuItem" onClick={goAdmin}>
                      Console admin
                    </button>
                  ) : null}
                  <button className="menuItem menuItemDanger" onClick={handleLogout}>
                    Déconnexion
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </header>

        {/* LAYOUT */}
        <div className="layout">
          {/* SIDEBAR (desktop) */}
          <aside className="sidebar desktopOnly">
            <div className="sidebarHeader">
              <div className="sidebarTitle">Historique</div>
              <button className="btn btnLight" onClick={createNewConversation}>
                + Nouvelle
              </button>
            </div>

            <div className="convList">
              {conversations.length === 0 ? (
                <div className="muted">Aucune conversation.</div>
              ) : (
                conversations.map((c) => {
                  const active = c.id === activeConvId;
                  return (
                    <button
                      key={c.id}
                      className={`convItem ${active ? "active" : ""}`}
                      onClick={() => openConversation(c.id)}
                      title={safeStr(c.title || "")}
                    >
                      <div className="convTitle">{trimTitle(c.title)}</div>
                      <div className="convSub">{fmtDate(c.created_at)}</div>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* DRAWER (mobile) */}
          {drawerOpen ? (
            <div className="drawer" onClick={() => setDrawerOpen(false)}>
              <div className="drawerPanel" onClick={(e) => e.stopPropagation()}>
                <div className="drawerHeader">
                  <div className="sidebarTitle">Historique</div>
                  <div className="drawerActions">
                    <button className="btn btnLight" onClick={createNewConversation}>
                      + Nouvelle
                    </button>
                    <button className="btn btnGhost" onClick={() => setDrawerOpen(false)}>
                      Fermer
                    </button>
                  </div>
                </div>

                <div className="convList">
                  {conversations.length === 0 ? (
                    <div className="muted">Aucune conversation.</div>
                  ) : (
                    conversations.map((c) => {
                      const active = c.id === activeConvId;
                      return (
                        <button
                          key={c.id}
                          className={`convItem ${active ? "active" : ""}`}
                          onClick={() => openConversation(c.id)}
                          title={safeStr(c.title || "")}
                        >
                          <div className="convTitle">{trimTitle(c.title)}</div>
                          <div className="convSub">{fmtDate(c.created_at)}</div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {/* CHAT */}
          <section className="chat">
            <div className="chatHeader">
              <div className="chatTitle">{activeTitle}</div>
              <div className="chatSub">
                {user?.email ? <span>{user.email}</span> : null}
                {fatal ? <span className="err"> • {fatal}</span> : null}
              </div>
            </div>

            <div className="msgList" ref={listRef}>
              {booting ? (
                <div className="muted">Chargement…</div>
              ) : messages.length === 0 ? (
                <div className="muted">Aucun message. Écris ton premier message ci-dessous.</div>
              ) : (
                messages.map((m) => (
                  <div key={m.id} className={`msgRow ${m.role === "user" ? "user" : "assistant"}`}>
                    <div className="msgBubble">
                      {/* IMPORTANT: pre-wrap => paragraphes + retours à la ligne visibles */}
                      <div className="msgText">{safeStr(m.content)}</div>
                      <div className="msgMeta">{fmtDate(m.created_at)}</div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="composer">
              <textarea
                ref={inputRef}
                className="input"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Écrire un message…"
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (!sending) sendMessage();
                  }
                }}
              />

              <button className="btn btnPrimary" onClick={sendMessage} disabled={sending}>
                {sending ? "Envoi…" : "Envoyer"}
              </button>
            </div>
          </section>
        </div>
      </main>

      <style jsx>{`
        :global(html, body) {
          height: 100%;
          margin: 0;
          padding: 0;
          background: #05060a;
        }
        .page {
          height: 100dvh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          background: radial-gradient(1200px 600px at 50% 0%, rgba(255, 140, 40, 0.08), transparent 60%),
            linear-gradient(135deg, #05060a, #0a0d16);
          color: rgba(238, 242, 255, 0.92);
          font-family: "Segoe UI", Arial, sans-serif;
        }

        /* TOP BAR */
        .topbar {
          position: sticky;
          top: 0;
          z-index: 100;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          background: linear-gradient(180deg, rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0.35));
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(10px);
          gap: 10px;
        }
        .topbarLeft {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .topbarRight {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .agentChip {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
          padding: 6px 10px;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.05);
        }
        .agentAvatar {
          width: 44px;
          height: 44px;
          border-radius: 999px;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.06);
          flex: 0 0 auto;
        }
        .agentAvatar img {
          width: 100%;
          height: 100%;
          display: block;
          object-fit: cover;
          object-position: center 18%;
        }
        .agentMeta {
          min-width: 0;
        }
        .agentName {
          font-weight: 900;
          font-size: 14px;
          line-height: 1.1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 220px;
        }
        .agentDesc {
          font-weight: 800;
          opacity: 0.75;
          font-size: 12px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 220px;
        }
        .brandLogo {
          height: 32px;
          width: auto;
          object-fit: contain;
          filter: drop-shadow(0 8px 18px rgba(0, 0, 0, 0.45));
        }

        /* LAYOUT */
        .layout {
          flex: 1 1 auto;
          display: grid;
          grid-template-columns: 360px 1fr;
          gap: 12px;
          padding: 12px;
          overflow: hidden;
          min-height: 0;
        }

        .sidebar {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 18px;
          background: rgba(0, 0, 0, 0.35);
          backdrop-filter: blur(10px);
          box-shadow: 0 18px 45px rgba(0, 0, 0, 0.55);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .sidebarHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.20);
        }
        .sidebarTitle {
          font-weight: 900;
          font-size: 16px;
        }

        .convList {
          padding: 10px;
          display: grid;
          gap: 10px;
          overflow: auto;
          min-height: 0;
        }
        .convItem {
          text-align: left;
          border-radius: 16px;
          padding: 12px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.04);
          color: rgba(238, 242, 255, 0.92);
          cursor: pointer;
        }
        .convItem.active {
          border-color: rgba(255, 140, 40, 0.35);
          background: rgba(255, 140, 40, 0.10);
        }
        .convTitle {
          font-weight: 900;
          font-size: 14px;
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .convSub {
          font-weight: 800;
          font-size: 12px;
          opacity: 0.75;
        }

        .chat {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 18px;
          background: rgba(0, 0, 0, 0.35);
          backdrop-filter: blur(10px);
          box-shadow: 0 18px 45px rgba(0, 0, 0, 0.55);
          overflow: hidden;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }

        .chatHeader {
          padding: 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.20);
        }
        .chatTitle {
          font-weight: 900;
          font-size: 16px;
          margin-bottom: 4px;
        }
        .chatSub {
          font-weight: 800;
          font-size: 12px;
          opacity: 0.75;
        }
        .err {
          color: rgba(255, 130, 130, 0.95);
          opacity: 1;
          font-weight: 900;
        }

        .msgList {
          flex: 1 1 auto;
          overflow: auto;
          padding: 12px;
          display: grid;
          gap: 10px;
          min-height: 0;
        }
        .msgRow {
          display: flex;
        }
        .msgRow.user {
          justify-content: flex-end;
        }
        .msgRow.assistant {
          justify-content: flex-start;
        }
        .msgBubble {
          max-width: min(760px, 92%);
          border-radius: 18px;
          padding: 10px 12px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.04);
          box-shadow: 0 14px 34px rgba(0, 0, 0, 0.35);
        }
        .msgRow.user .msgBubble {
          border-color: rgba(80, 120, 255, 0.25);
          background: rgba(80, 120, 255, 0.10);
        }
        .msgText {
          font-weight: 750;
          font-size: 14px;
          line-height: 1.45;
          white-space: pre-wrap; /* <-- lisibilité: paragraphes + retours ligne */
          word-break: break-word;
        }
        .msgMeta {
          margin-top: 6px;
          font-size: 11px;
          font-weight: 800;
          opacity: 0.65;
        }

        .composer {
          padding: 12px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(0, 0, 0, 0.20);
          display: grid;
          grid-template-columns: 1fr 130px;
          gap: 10px;
          align-items: end;
        }
        .input {
          width: 100%;
          resize: none;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(238, 242, 255, 0.92);
          padding: 10px 12px;
          outline: none;
          font-weight: 800;
          font-size: 14px;
        }

        /* Buttons */
        .btn {
          border-radius: 999px;
          padding: 9px 12px;
          border: 1px solid rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.08);
          color: rgba(255, 255, 255, 0.92);
          font-weight: 900;
          cursor: pointer;
          white-space: nowrap;
        }
        .btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }
        .btnGhost {
          background: rgba(0, 0, 0, 0.22);
        }
        .btnLight {
          background: rgba(255, 255, 255, 0.10);
        }
        .btnPrimary {
          background: rgba(255, 140, 40, 0.16);
          border-color: rgba(255, 140, 40, 0.32);
        }
        .btnDanger {
          background: rgba(255, 0, 0, 0.12);
          border-color: rgba(255, 120, 120, 0.22);
        }

        .muted {
          opacity: 0.75;
          font-weight: 800;
          font-size: 13px;
        }

        /* Mobile drawer */
        .drawer {
          position: fixed;
          inset: 0;
          z-index: 200;
          background: rgba(0, 0, 0, 0.60);
          display: flex;
          align-items: stretch;
          justify-content: flex-start;
        }
        .drawerPanel {
          width: min(420px, 88vw);
          height: 100%;
          background: rgba(0, 0, 0, 0.85);
          border-right: 1px solid rgba(255, 255, 255, 0.12);
          backdrop-filter: blur(12px);
          display: flex;
          flex-direction: column;
          padding: 10px;
        }
        .drawerHeader {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 8px 4px 10px 4px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .drawerActions {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        /* Mobile menu */
        .menu {
          position: fixed;
          inset: 0;
          z-index: 210;
          background: rgba(0, 0, 0, 0.35);
        }
        .menuPanel {
          position: absolute;
          top: 64px;
          right: 10px;
          width: 210px;
          border-radius: 16px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(0, 0, 0, 0.88);
          backdrop-filter: blur(12px);
          padding: 8px;
          display: grid;
          gap: 8px;
          box-shadow: 0 18px 55px rgba(0, 0, 0, 0.55);
        }
        .menuItem {
          width: 100%;
          text-align: left;
          padding: 10px 12px;
          border-radius: 14px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(255, 255, 255, 0.06);
          color: rgba(255, 255, 255, 0.92);
          font-weight: 900;
          cursor: pointer;
        }
        .menuItemDanger {
          border-color: rgba(255, 120, 120, 0.22);
          background: rgba(255, 0, 0, 0.12);
        }

        /* Responsive */
        .mobileOnly {
          display: none;
        }
        .desktopOnly {
          display: flex;
        }

        @media (max-width: 980px) {
          .layout {
            grid-template-columns: 320px 1fr;
          }
          .agentName,
          .agentDesc {
            max-width: 160px;
          }
        }

        @media (max-width: 760px) {
          .desktopOnly {
            display: none;
          }
          .mobileOnly {
            display: flex;
          }
          .layout {
            grid-template-columns: 1fr;
            padding: 10px;
          }
          .brandLogo {
            display: none;
          }
          .agentName,
          .agentDesc {
            max-width: 160px;
          }
          .composer {
            grid-template-columns: 1fr 110px;
          }
        }

        @media (max-width: 420px) {
          .agentChip {
            padding: 6px 8px;
          }
          .agentName,
          .agentDesc {
            max-width: 130px;
          }
          .composer {
            grid-template-columns: 1fr 96px;
          }
        }
      `}</style>
    </>
  );
}
