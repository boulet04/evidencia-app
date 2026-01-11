import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

function capitalize(s) {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function guessFirstNameFromEmail(email) {
  if (!email) return "";
  const local = email.split("@")[0] || "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length === 0) return "";
  const cand = parts[0].length <= 2 && parts[1] ? parts[1] : parts[0];
  return capitalize(cand);
}

function extractFirstNameFromUser(user) {
  const md = user?.user_metadata || {};
  const direct =
    md.first_name ||
    md.prenom ||
    md.firstname ||
    md.given_name ||
    md.name ||
    md.full_name ||
    md.fullName;

  if (typeof direct === "string" && direct.trim()) {
    return capitalize(direct.trim().split(/\s+/)[0]);
  }
  return guessFirstNameFromEmail(user?.email || "");
}

// ---- NEW: extraction prénom depuis system_prompt ("tu travailles pour X")
function extractWorksForName(promptText) {
  const t = (promptText || "").toString();
  if (!t.trim()) return "";

  // On capte "tu travailles pour ..." jusqu’à fin de ligne / ponctuation
  // Ex: "Tu travailles pour Jean Baptiste." => "Jean Baptiste"
  const m = t.match(/tu\s+travailles\s+pour\s+([^\n\r,.!?]+)/i);
  if (!m || !m[1]) return "";

  const name = m[1].trim();
  if (!name) return "";

  // On normalise: capitalise chaque mot
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => capitalize(w.toLowerCase()))
    .join(" ");
}

// --- stopwords titre conversation
const TITLE_STOPWORDS = new Set([
  "bonjour",
  "salut",
  "hello",
  "hey",
  "coucou",
  "bonsoir",
  "yo",
  "bjr",
  "slt",
]);

function buildConversationTitleFromMessage(text) {
  const raw = (text || "").trim();
  if (!raw) return "Nouvelle conversation";

  const tokens = raw
    .toLowerCase()
    .replace(/[“”"’'.,;:!?()[\]{}<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  while (tokens.length > 0 && TITLE_STOPWORDS.has(tokens[0])) tokens.shift();

  const finalTokens = tokens.length ? tokens : raw.split(/\s+/).filter(Boolean);

  const first5 = finalTokens.slice(0, 5).join(" ");
  const titled = first5 ? first5 : "Nouvelle conversation";
  return titled.charAt(0).toUpperCase() + titled.slice(1);
}

export default function ChatPage() {
  const router = useRouter();

  const agentSlug = useMemo(() => {
    const q = router.query?.agent;
    if (typeof q === "string" && q.trim()) return q.trim();
    return "emma";
  }, [router.query]);

  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);

  const [agent, setAgent] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState(null);

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");

  const [loadingConvs, setLoadingConvs] = useState(false);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [creatingConv, setCreatingConv] = useState(false);
  const [sending, setSending] = useState(false);

  const accessToken = useMemo(() => session?.access_token || null, [session]);

  // Fallback prénom user (si prompt ne contient pas "tu travailles pour ...")
  const fallbackFirstName = useMemo(() => extractFirstNameFromUser(user), [user]);

  // ---- NEW: prénom “cible” issu du prompt (ex: Antoine / Jean Baptiste)
  const [worksForName, setWorksForName] = useState("");

  const messagesEndRef = useRef(null);

  function welcomeText() {
    const name = worksForName || fallbackFirstName || "";
    const agentPart = agent?.name
      ? `je suis ${agent.name}${agent.description ? `, ${agent.description}` : ""}. `
      : "";

    if (name) return `Bonjour ${name}, ${agentPart}Comment puis-je vous aider ?`;
    return agentPart ? `Bonjour, ${agentPart}Comment puis-je vous aider ?` : "Bonjour, comment puis-je vous aider ?";
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null);
      setUser(data.session?.user || null);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession || null);
      setUser(newSession?.user || null);
    });

    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  // Load agent meta
  useEffect(() => {
    if (!agentSlug) return;

    (async () => {
      const { data, error } = await supabase
        .from("agents")
        .select("id,slug,name,description,avatar_url")
        .eq("slug", agentSlug)
        .maybeSingle();

      if (error) {
        console.error("Load agent error:", error.message);
        setAgent(null);
        return;
      }
      setAgent(data || null);
    })();
  }, [agentSlug]);

  // ---- NEW: Charger system_prompt user+agent pour extraire "tu travailles pour X"
  useEffect(() => {
    if (!user?.id) {
      setWorksForName("");
      return;
    }
    if (!agent?.id) {
      setWorksForName("");
      return;
    }

    (async () => {
      const { data, error } = await supabase
        .from("client_agent_configs")
        .select("system_prompt")
        .eq("user_id", user.id)
        .eq("agent_id", agent.id)
        .maybeSingle();

      if (error) {
        console.error("Load client_agent_configs error:", error.message);
        setWorksForName("");
        return;
      }

      const extracted = extractWorksForName(data?.system_prompt || "");
      setWorksForName(extracted || "");
    })();
  }, [user?.id, agent?.id]);

  // Load conversations for this user + agent
  useEffect(() => {
    if (!user?.id) return;
    if (!agentSlug) return;

    (async () => {
      setLoadingConvs(true);
      const { data, error } = await supabase
        .from("conversations")
        .select("id,title,created_at,agent_slug")
        .eq("user_id", user.id)
        .eq("agent_slug", agentSlug)
        .order("created_at", { ascending: false });

      setLoadingConvs(false);

      if (error) {
        console.error("Load conversations error:", error.message);
        setConversations([]);
        return;
      }

      const list = data || [];
      setConversations(list);

      if (!selectedConversationId && list.length > 0) {
        setSelectedConversationId(list[0].id);
      }

      if (list.length === 0) {
        setSelectedConversationId(null);
        setMessages([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, agentSlug]);

  // Load messages
  useEffect(() => {
    if (!selectedConversationId) {
      setMessages([]);
      return;
    }

    (async () => {
      setLoadingMsgs(true);
      const { data, error } = await supabase
        .from("messages")
        .select("id,role,content,created_at")
        .eq("conversation_id", selectedConversationId)
        .order("created_at", { ascending: true });

      setLoadingMsgs(false);

      if (error) {
        console.error("Load messages error:", error.message);
        setMessages([]);
        return;
      }

      setMessages(data || []);
    })();
  }, [selectedConversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loadingMsgs]);

  async function handleNewConversation({ title } = {}) {
    if (!accessToken) {
      alert("Session invalide. Veuillez vous reconnecter.");
      return null;
    }
    if (!agentSlug) return null;

    try {
      setCreatingConv(true);

      const resp = await fetch("/api/conversations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ agent_slug: agentSlug, title: title || null }),
      });

      const data = await resp.json().catch(() => null);
      if (!resp.ok) throw new Error(data?.error || "Create conversation failed");

      const conv = data?.conversation;
      if (!conv?.id) throw new Error("Missing conversation in response");

      setConversations((prev) => [conv, ...prev]);
      setSelectedConversationId(conv.id);
      return conv;
    } catch (e) {
      console.error(e);
      alert("Impossible de créer une nouvelle conversation.");
      return null;
    } finally {
      setCreatingConv(false);
    }
  }

  async function handleDeleteConversation(conversationId) {
    if (!accessToken) {
      alert("Session invalide. Veuillez vous reconnecter.");
      return;
    }

    const ok = confirm("Supprimer cette conversation ? Cette action est irréversible.");
    if (!ok) return;

    try {
      const resp = await fetch(`/api/conversations/${conversationId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!resp.ok && resp.status !== 204) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || "Delete failed");
      }

      setConversations((prev) => prev.filter((c) => c.id !== conversationId));

      if (selectedConversationId === conversationId) {
        const remaining = conversations.filter((c) => c.id !== conversationId);
        setSelectedConversationId(remaining[0]?.id || null);
      }
    } catch (e) {
      console.error(e);
      alert("Impossible de supprimer la conversation.");
    }
  }

  // Dictée vocale (Web Speech API)
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition || null;

    if (!SpeechRecognition) {
      recognitionRef.current = null;
      return;
    }

    const rec = new SpeechRecognition();
    rec.lang = "fr-FR";
    rec.continuous = false;
    rec.interimResults = true;

    rec.onstart = () => setListening(true);
    rec.onend = () => setListening(false);

    rec.onerror = (e) => {
      console.error("SpeechRecognition error:", e);
      setListening(false);
    };

    rec.onresult = (event) => {
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) finalText += res[0]?.transcript || "";
      }
      if (finalText.trim()) {
        setInput((prev) => (prev ? `${prev} ${finalText.trim()}` : finalText.trim()));
      }
    };

    recognitionRef.current = rec;
  }, []);

  function toggleMic() {
    const rec = recognitionRef.current;
    if (!rec) {
      alert("Dictée vocale non supportée sur ce navigateur.");
      return;
    }

    try {
      if (listening) rec.stop();
      else rec.start();
    } catch (e) {
      console.error(e);
    }
  }

  async function handleSend() {
    const content = input.trim();
    if (!content) return;

    try {
      setSending(true);
      setInput("");

      let convId = selectedConversationId;
      if (!convId) {
        const title = buildConversationTitleFromMessage(content);
        const newConv = await handleNewConversation({ title });
        convId = newConv?.id || null;
        if (!convId) throw new Error("Conversation auto-création échouée.");
      }

      const { data: userMsg, error: userMsgErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: convId,
          role: "user",
          content,
        })
        .select("id,role,content,created_at")
        .single();

      if (userMsgErr) throw userMsgErr;
      setMessages((prev) => [...prev, userMsg]);

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          conversation_id: convId,
          agent_slug: agentSlug,
          message: content,
        }),
      });

      if (!resp.ok) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || "Chat API error");
      }

      const data = await resp.json();
      const assistantText = data?.reply || data?.content || "";

      if (assistantText) {
        const { data: asstMsg, error: asstErr } = await supabase
          .from("messages")
          .insert({
            conversation_id: convId,
            role: "assistant",
            content: assistantText,
          })
          .select("id,role,content,created_at")
          .single();

        if (!asstErr && asstMsg) setMessages((prev) => [...prev, asstMsg]);
      }
    } catch (e) {
      console.error(e);
      alert("Erreur lors de l’envoi du message.");
    } finally {
      setSending(false);
    }
  }

  const showWelcomeFallback =
    !loadingMsgs && !selectedConversationId && (messages?.length || 0) === 0;

  return (
    <div className="page">
      <div className="topbar">
        <button className="btn back" onClick={() => router.push("/agents")}>
          ← Retour
        </button>

        <div className="brand">
          <div className="brandTitle">Evidenc’IA</div>
        </div>

        <div className="topbarRight">
          <div className="pill">{user?.email || "—"}</div>
          <button
            className="btn logout"
            onClick={async () => {
              await supabase.auth.signOut();
              router.push("/login");
            }}
          >
            Déconnexion
          </button>
        </div>
      </div>

      <div className="layout">
        <aside className="sidebar">
          <div className="sidebarHeader">
            <div className="sidebarTitle">Historique</div>
            <button className="btn new" onClick={() => handleNewConversation()} disabled={creatingConv}>
              + Nouvelle
            </button>
          </div>

          <div className="sidebarBody">
            {loadingConvs ? (
              <div className="muted">Chargement...</div>
            ) : conversations.length === 0 ? (
              <div className="muted">Aucune conversation.</div>
            ) : (
              <div className="convList">
                {conversations.map((c) => {
                  const active = c.id === selectedConversationId;
                  return (
                    <div
                      key={c.id}
                      className={`convItem ${active ? "active" : ""}`}
                      onClick={() => setSelectedConversationId(c.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="convTitle">{c.title || "Conversation"}</div>

                      <button
                        className="convDelete"
                        title="Supprimer la conversation"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleDeleteConversation(c.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        <main className="main">
          <div className="agentHeader">
            <div className="agentLeft">
              <div className="agentAvatar">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {agent?.avatar_url ? (
                  <img src={agent.avatar_url} alt={agent.name || "Agent"} />
                ) : (
                  <div className="avatarFallback">{(agent?.name || "A").slice(0, 1)}</div>
                )}
              </div>
              <div className="agentMeta">
                <div className="agentName">{agent?.name || "Agent"}</div>
                <div className="agentRole">{agent?.description || ""}</div>
              </div>
            </div>
          </div>

          <div className="chat">
            <div className="chatBody">
              {showWelcomeFallback && (
                <div className="msgRow assistant">
                  <div className="msgBubble">{welcomeText()}</div>
                </div>
              )}

              {!selectedConversationId && (messages?.length || 0) === 0 ? null : loadingMsgs ? (
                <div className="muted">Chargement des messages...</div>
              ) : (
                <>
                  {(messages || []).map((m) => (
                    <div key={m.id} className={`msgRow ${m.role === "user" ? "user" : "assistant"}`}>
                      <div className="msgBubble">{m.content}</div>
                    </div>
                  ))}
                  <div ref={messagesEndRef} />
                </>
              )}
            </div>

            <div className="chatInput">
              <input
                className="input"
                placeholder="Écrire…"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                disabled={sending}
              />

              <button
                className={`btn mic ${listening ? "listening" : ""}`}
                type="button"
                title="Dictée vocale"
                onClick={toggleMic}
                disabled={sending}
              >
                <span className="micIcon" aria-hidden="true">🎤</span>
              </button>

              <button className="btn send" onClick={handleSend} disabled={sending}>
                {sending ? "Envoi..." : "Envoyer"}
              </button>
            </div>

            <div className="chatFooter">
              <div className="mutedSmall">{selectedConversationId ? `Conversation: ${selectedConversationId}` : ""}</div>
            </div>
          </div>
        </main>
      </div>

      <style jsx>{`
        .page { min-height: 100vh; background: #050608; color: #e9eef6; }
        .topbar { height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          background: radial-gradient(1200px 200px at 50% -20%, rgba(255,130,30,0.18), transparent);
        }
        .btn { border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.04);
          color: #e9eef6; padding: 10px 12px; border-radius: 14px; cursor: pointer; font-weight: 600; }
        .btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .btn.logout { border-color: rgba(255,80,80,0.35); }
        .brand { display: flex; align-items: center; justify-content: center; flex: 1; text-align: center; }
        .brandTitle { font-size: 20px; font-weight: 800; letter-spacing: 0.6px; }
        .topbarRight { display: flex; gap: 10px; align-items: center; }
        .pill { border: 1px solid rgba(255,255,255,0.12); padding: 8px 10px; border-radius: 999px; font-size: 12px; opacity: 0.9; }

        .layout { display: grid; grid-template-columns: 340px 1fr; gap: 16px; padding: 16px; }
        .sidebar { border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; background: rgba(255,255,255,0.02); overflow: hidden; min-height: calc(100vh - 96px); }
        .sidebarHeader { display: flex; align-items: center; justify-content: space-between; padding: 14px 14px 10px; border-bottom: 1px solid rgba(255,255,255,0.06); }
        .sidebarTitle { font-size: 16px; font-weight: 800; }
        .sidebarBody { padding: 10px; }
        .muted { color: rgba(233,238,246,0.65); font-size: 14px; padding: 8px; }
        .mutedSmall { color: rgba(233,238,246,0.55); font-size: 12px; }

        .convList { display: flex; flex-direction: column; gap: 10px; }
        .convItem { position: relative; border: 1px solid rgba(255,255,255,0.08); border-radius: 16px; padding: 12px 44px 12px 12px; background: rgba(255,255,255,0.03); cursor: pointer; }
        .convItem.active { border-color: rgba(255,130,30,0.35); background: rgba(255,130,30,0.07); }
        .convTitle { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .convDelete { position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
          width: 30px; height: 30px; border-radius: 12px; border: 1px solid rgba(255,60,60,0.35);
          background: rgba(255,60,60,0.12); color: rgba(255,210,210,0.95);
          font-size: 20px; line-height: 28px; cursor: pointer; }

        .main { border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; background: rgba(255,255,255,0.02);
          min-height: calc(100vh - 96px); display: flex; flex-direction: column; overflow: hidden; }
        .agentHeader { padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.06); }
        .agentLeft { display: flex; gap: 12px; align-items: center; }
        .agentAvatar { width: 44px; height: 44px; border-radius: 16px; overflow: hidden; border: 1px solid rgba(255,255,255,0.1);
          background: rgba(255,255,255,0.04); display: flex; align-items: center; justify-content: center; }
        /* IMPORTANT: ta modif */
        .agentAvatar img { width: 100%; height: 100%; object-fit: cover; object-position: center 20%; }
        .avatarFallback { font-weight: 900; opacity: 0.85; }
        .agentName { font-weight: 900; }
        .agentRole { font-size: 12px; color: rgba(233,238,246,0.65); margin-top: 2px; }

        .chat { display: flex; flex-direction: column; flex: 1; }
        .chatBody { flex: 1; padding: 16px; overflow: auto; }
        .msgRow { display: flex; margin-bottom: 10px; }
        .msgRow.user { justify-content: flex-end; }
        .msgRow.assistant { justify-content: flex-start; }
        .msgBubble { max-width: 820px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03);
          border-radius: 18px; padding: 12px 14px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
        .msgRow.user .msgBubble { border-color: rgba(255,130,30,0.25); background: rgba(255,130,30,0.08); }

        .chatInput { display: flex; gap: 10px; padding: 14px; border-top: 1px solid rgba(255,255,255,0.06); align-items: center; }
        .input { flex: 1; height: 48px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.10);
          background: rgba(0,0,0,0.25); color: #e9eef6; padding: 0 14px; outline: none; }
        .btn.send { border-color: rgba(255,130,30,0.35); background: rgba(255,130,30,0.12); }
        .btn.mic { width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; }
        .btn.mic.listening { border-color: rgba(255,130,30,0.35); background: rgba(255,130,30,0.12); }
        .micIcon { font-size: 18px; line-height: 1; }

        .chatFooter { padding: 10px 14px 14px; }

        @media (max-width: 980px) {
          .layout { grid-template-columns: 1fr; }
          .sidebar { min-height: auto; }
          .main { min-height: 60vh; }
        }
      `}</style>
    </div>
  );
}
