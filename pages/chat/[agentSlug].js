import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""
);

function formatTitleFallback(agentName) {
  if (!agentName) return "Nouvelle conversation";
  return `Discussion avec ${agentName}`;
}

function defaultWelcome(agentName) {
  // Tu peux ajuster le wording ici si tu veux une variante par agent
  return `Bonjour Simon,\n\nComment puis-je vous aider aujourd'hui ?`;
}

export default function AgentChatPage() {
  const router = useRouter();
  const agentSlug = (router.query?.agentSlug || "").toString();

  const messagesEndRef = useRef(null);

  // --- Micro (dictée vocale) ---
  const inputRef = useRef(null);
  const recognitionRef = useRef(null);
  const [speechSupported, setSpeechSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    setSpeechSupported(true);

    const rec = new SR();
    rec.lang = "fr-FR";
    rec.continuous = false;
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      try {
        const t = e?.results?.[0]?.[0]?.transcript || "";
        const chunk = String(t || "").trim();
        if (!chunk) return;
        setInput((prev) => (prev ? `${prev} ${chunk}` : chunk));
        setTimeout(() => inputRef.current?.focus?.(), 0);
      } catch (_) {}
    };

    rec.onend = () => setIsRecording(false);
    rec.onerror = () => setIsRecording(false);

    recognitionRef.current = rec;

    return () => {
      try {
        rec.abort();
      } catch (_) {}
      recognitionRef.current = null;
    };
  }, []);

  function toggleDictation() {
    if (!speechSupported) {
      alert("Dictée vocale non supportée sur ce navigateur.");
      return;
    }
    if (!recognitionRef.current) return;

    if (isRecording) {
      try {
        recognitionRef.current.stop();
      } catch (_) {}
      setIsRecording(false);
      return;
    }

    try {
      recognitionRef.current.start();
      setIsRecording(true);
    } catch (_) {
      setIsRecording(false);
    }
  }

  // Focus input dès qu'une conversation est ouverte/sélectionnée
  useEffect(() => {
    if (!selectedConversationId) return;
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }, [selectedConversationId]);

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

  const selectedConversation = useMemo(() => {
    return conversations.find((c) => c.id === selectedConversationId) || null;
  }, [conversations, selectedConversationId]);

  // Auth session
  useEffect(() => {
    let active = true;

    async function loadSession() {
      const { data } = await supabase.auth.getSession();
      if (!active) return;
      setSession(data?.session || null);
      setUser(data?.session?.user || null);
    }

    loadSession();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setUser(s?.user || null);
    });

    return () => {
      active = false;
      sub?.subscription?.unsubscribe?.();
    };
  }, []);

  // Load agent meta by slug
  useEffect(() => {
    if (!agentSlug) return;
    let active = true;

    async function loadAgent() {
      const { data, error } = await supabase
        .from("agents")
        .select("id,slug,name,avatar_url,default_system_prompt")
        .eq("slug", agentSlug)
        .maybeSingle();

      if (!active) return;
      if (error) {
        console.error("loadAgent error:", error);
        setAgent(null);
        return;
      }
      setAgent(data || null);
    }

    loadAgent();
    return () => {
      active = false;
    };
  }, [agentSlug]);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || "";
  }

  // Load conversations
  useEffect(() => {
    if (!user || !agentSlug) return;
    let active = true;

    async function loadConvs() {
      setLoadingConvs(true);
      try {
        const { data, error } = await supabase
          .from("conversations")
          .select("id,title,created_at,agent_slug")
          .eq("user_id", user.id)
          .eq("agent_slug", agentSlug)
          .order("created_at", { ascending: false });

        if (!active) return;
        if (error) throw error;

        const convs = data || [];
        setConversations(convs);

        // Select first or create one if none
        if (convs.length > 0) {
          setSelectedConversationId(convs[0].id);
        } else {
          // Auto create on first load
          await createConversation();
        }
      } catch (e) {
        console.error("loadConvs error:", e);
      } finally {
        if (active) setLoadingConvs(false);
      }
    }

    loadConvs();

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, agentSlug]);

  async function createConversation() {
    if (!user || !agentSlug) return;
    setCreatingConv(true);
    try {
      const title = formatTitleFallback(agent?.name);

      const { data, error } = await supabase
        .from("conversations")
        .insert({
          user_id: user.id,
          agent_slug: agentSlug,
          title,
          archived: false,
        })
        .select("id,title,created_at,agent_slug")
        .single();

      if (error) throw error;

      const conv = data;
      setConversations((prev) => [conv, ...prev]);
      setSelectedConversationId(conv.id);

      // Seed welcome message (local only)
      const welcome = defaultWelcome(agent?.name);
      setMessages([
        { id: `local-welcome-${conv.id}`, role: "assistant", content: welcome, created_at: new Date().toISOString() },
      ]);
      set_toggleScroll();
    } catch (e) {
      console.error("createConversation error:", e);
    } finally {
      setCreatingConv(false);
    }
  }

  function set_toggleScroll() {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
    }, 50);
  }

  // Load messages for selected conversation
  useEffect(() => {
    if (!selectedConversationId || !user) return;
    let active = true;

    async function loadMsgs() {
      setLoadingMsgs(true);
      try {
        const { data, error } = await supabase
          .from("messages")
          .select("id,role,content,created_at")
          .eq("conversation_id", selectedConversationId)
          .order("created_at", { ascending: true });

        if (!active) return;
        if (error) throw error;

        const rows = data || [];

        // If none, show welcome
        if (rows.length === 0) {
          const welcome = defaultWelcome(agent?.name);
          setMessages([
            {
              id: `local-welcome-${selectedConversationId}`,
              role: "assistant",
              content: welcome,
              created_at: new Date().toISOString(),
            },
          ]);
        } else {
          setMessages(rows);
        }

        set_toggleScroll();
      } catch (e) {
        console.error("loadMsgs error:", e);
      } finally {
        if (active) setLoadingMsgs(false);
      }
    }

    loadMsgs();
    return () => {
      active = false;
    };
  }, [selectedConversationId, user?.id, agent?.name]);

  async function handleSelectConversation(id) {
    setSelectedConversationId(id);
  }

  async function handleSend() {
    if (!selectedConversationId) return;
    const content = input.trim();
    if (!content) return;

    try {
      setSending(true);
      setInput("");
      setTimeout(() => inputRef.current?.focus?.(), 0);

      // Insert user message
      const { data: userMsg, error: userMsgErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: selectedConversationId,
          role: "user",
          content,
        })
        .select("id,role,content,created_at")
        .single();

      if (userMsgErr) throw userMsgErr;

      setMessages((prev) => [...prev, userMsg]);
      set_toggleScroll();

      const accessToken = await getAccessToken();

      const resp = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          conversation_id: selectedConversationId,
          agent_slug: agentSlug,
          message: content,
        }),
      });

      if (!resp.ok) {
        const j = await resp.json().catch(() => null);
        throw new Error(j?.error || "Erreur interne API");
      }

      const j = await resp.json();
      const reply = (j?.reply || "").toString();

      // Insert assistant message
      const { data: asstMsg, error: asstMsgErr } = await supabase
        .from("messages")
        .insert({
          conversation_id: selectedConversationId,
          role: "assistant",
          content: reply,
        })
        .select("id,role,content,created_at")
        .single();

      if (asstMsgErr) throw asstMsgErr;

      setMessages((prev) => [...prev, asstMsg]);
      set_toggleScroll();
      setTimeout(() => inputRef.current?.focus?.(), 0);
    } catch (e) {
      console.error("send error:", e);
      alert(e?.message || "Erreur interne API");
      setTimeout(() => inputRef.current?.focus?.(), 0);
    } finally {
      setSending(false);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (!agentSlug) {
    return (
      <div style={{ color: "#fff", padding: 20 }}>
        Chargement…
      </div>
    );
  }

  return (
    <div className="chatShell">
      <div className="sidebar">
        <div className="sidebarTop">
          <button className="btn ghost" onClick={() => router.push("/agents")}>
            ← Retour aux agents
          </button>
          <button className="btn" onClick={createConversation} disabled={creatingConv || loadingConvs}>
            + Nouvelle
          </button>
        </div>

        <div className="sidebarTitle">Historique</div>

        <div className="convList">
          {loadingConvs && <div className="mutedSmall">Chargement…</div>}

          {!loadingConvs && conversations.length === 0 && (
            <div className="mutedSmall">Aucune conversation.</div>
          )}

          {conversations.map((c) => (
            <button
              key={c.id}
              className={`convItem ${c.id === selectedConversationId ? "active" : ""}`}
              onClick={() => handleSelectConversation(c.id)}
            >
              <div className="convTitle">{c.title || "Conversation"}</div>
              <div className="convDate">
                {c.created_at ? new Date(c.created_at).toLocaleString() : ""}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="main">
        <div className="topbar">
          <div className="agentBox">
            <div className="agentAvatar">
              {agent?.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={agent.avatar_url} alt={agent?.name || "Agent"} />
              ) : (
                <div className="agentAvatarFallback">🙂</div>
              )}
            </div>
            <div>
              <div className="agentName">{agent?.name || agentSlug}</div>
              <div className="agentRole">Agent</div>
            </div>
          </div>

          <div className="userBox">
            <div className="userEmail">{user?.email || ""}</div>
            <button className="btn" onClick={handleLogout}>
              Déconnexion
            </button>
          </div>
        </div>

        <div className="chatBody">
          <div className="messages">
            {loadingMsgs ? (
              <div className="mutedSmall">Chargement…</div>
            ) : (
              <>
                {messages.map((m) => (
                  <div key={m.id} className={`msgRow ${m.role === "user" ? "user" : "assistant"}`}>
                    <div className="msgBubble">
                      <div className="msgText">{m.content}</div>
                    </div>
                  </div>
                ))}

                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          <div className="chatInput">
            <input
              className="input"
              ref={inputRef}
              placeholder="Écrire…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              disabled={!selectedConversationId || sending}
            />

            <button
              className={`btn mic ${isRecording ? "recording" : ""}`}
              title={
                speechSupported
                  ? isRecording
                    ? "Arrêter la dictée"
                    : "Dictée vocale"
                  : "Dictée vocale non supportée"
              }
              onClick={toggleDictation}
              disabled={!speechSupported || sending}
            >
              {isRecording ? "⏺" : "🎙"}
            </button>

            <button
              className="btn send"
              onClick={handleSend}
              disabled={!selectedConversationId || sending}
            >
              {sending ? "Envoi..." : "Envoyer"}
            </button>
          </div>

          <div className="chatFooter">
            <div className="mutedSmall">
              {selectedConversation ? `Conversation: ${selectedConversation.title}` : ""}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
