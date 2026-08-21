"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { AI_API_BASE, BrandMark, supabase } from "../shared";
import { TabHelp } from "../tab-help";
import "./ai.css";

type Conversation = {
  id: string;
  title: string;
  client_id: string | null;
  provider: string;
  model: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  last_message_at: string;
};

type Message = {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  provider?: string | null;
  model?: string | null;
  source?: string | null;
  latency_ms?: number | null;
  created_at: string;
};

type Client = {
  client_id: string;
  display_name: string;
  lifecycle: string;
  gt_owner?: string | null;
  cs_owner?: string | null;
  designer_owner?: string | null;
};

type Profile = { userId: string; person: string | null; role: string | null; accessLevel: string };

async function callAI(session: Session, path: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${AI_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.ok) throw new Error(result?.error || `Falha HTTP ${response.status}`);
  return result;
}

function timeLabel(value: string) {
  if (!value) return "";
  const date = new Date(value);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const delta = Math.round((today - day) / 86_400_000);
  if (delta === 0) return "Hoje";
  if (delta === 1) return "Ontem";
  if (delta < 7) return "Últimos 7 dias";
  if (delta < 30) return "Últimos 30 dias";
  return "Anteriores";
}

function initials(value: string | null | undefined) {
  return String(value || "IA").split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
}

export default function AIWorkspace() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [search, setSearch] = useState("");
  const [draftClientId, setDraftClientId] = useState("");
  const [composer, setComposer] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setAuthReady(true); });
    return () => subscription.unsubscribe();
  }, []);

  const loadSidebar = useCallback(async (activeSession: Session) => {
    const [list, clientList] = await Promise.all([
      callAI(activeSession, "/conversations/list"),
      callAI(activeSession, "/clients"),
    ]);
    setConversations(list.conversations || []);
    setClients(clientList.clients || []);
    setProfile(clientList.profile || list.profile || null);
  }, []);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    setError("");
    loadSidebar(session).catch((caught) => setError(caught instanceof Error ? caught.message : "Falha ao carregar a IA")).finally(() => setLoading(false));
  }, [session, loadSidebar]);

  const selected = useMemo(() => conversations.find((item) => item.id === selectedId) || null, [conversations, selectedId]);
  const selectedClient = useMemo(() => clients.find((item) => item.client_id === (selected ? selected.client_id : draftClientId)) || null, [clients, selected, draftClientId]);

  const filteredConversations = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("pt-BR");
    return conversations.filter((item) => !needle || item.title.toLocaleLowerCase("pt-BR").includes(needle));
  }, [conversations, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, Conversation[]>();
    filteredConversations.forEach((item) => {
      const key = timeLabel(item.last_message_at || item.updated_at);
      map.set(key, [...(map.get(key) || []), item]);
    });
    return [...map.entries()];
  }, [filteredConversations]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function openConversation(id: string) {
    if (!session) return;
    setSelectedId(id);
    setMessages([]);
    setError("");
    if (window.innerWidth < 820) setSidebarOpen(false);
    try {
      const result = await callAI(session, "/conversations/get", { conversation_id: id });
      setMessages(result.messages || []);
      const latest = result.conversation as Conversation;
      setConversations((prev) => prev.map((item) => item.id === id ? latest : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao abrir conversa");
    }
  }

  function newConversation() {
    // Volta para o contexto Geral. Sem isso a proxima conversa nasce
    // amarrada ao cliente que estava selecionado na conversa anterior.
    setDraftClientId("");
    setSelectedId(null);
    setMessages([]);
    setComposer("");
    setError("");
    if (window.innerWidth < 820) setSidebarOpen(false);
    window.setTimeout(() => composerRef.current?.focus(), 50);
  }

  async function ensureConversation(): Promise<Conversation | null> {
    if (!session) return null;
    if (selected) return selected;
    const result = await callAI(session, "/conversations/create", { client_id: draftClientId || null });
    const conversation = result.conversation as Conversation;
    setConversations((prev) => [conversation, ...prev]);
    setSelectedId(conversation.id);
    return conversation;
  }

  async function sendMessage() {
    const message = composer.trim();
    if (!session || !message || sending) return;
    setSending(true);
    setError("");
    setComposer("");
    const optimistic: Message = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      content: message,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    try {
      const conversation = await ensureConversation();
      if (!conversation) throw new Error("Não foi possível criar a conversa.");
      const result = await callAI(session, "/chat", { conversation_id: conversation.id, message });
      setMessages((prev) => [...prev.filter((item) => item.id !== optimistic.id), result.user_message, result.assistant_message]);
      const updated = result.conversation as Conversation;
      setConversations((prev) => {
        const without = prev.filter((item) => item.id !== updated.id);
        return [updated, ...without];
      });
    } catch (caught) {
      setMessages((prev) => prev.filter((item) => item.id !== optimistic.id));
      setComposer(message);
      setError(caught instanceof Error ? caught.message : "Falha ao enviar mensagem");
    } finally {
      setSending(false);
      window.setTimeout(() => composerRef.current?.focus(), 20);
    }
  }

  async function changeClient(clientId: string) {
    setDraftClientId(clientId);
    if (!session || !selected) return;
    try {
      const result = await callAI(session, "/conversations/set-client", { conversation_id: selected.id, client_id: clientId || null });
      const updated = result.conversation as Conversation;
      setConversations((prev) => prev.map((item) => item.id === updated.id ? updated : item));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível trocar o cliente");
    }
  }

  async function renameConversation(conversation: Conversation) {
    if (!session) return;
    const title = window.prompt("Nome da conversa", conversation.title)?.trim();
    if (!title || title === conversation.title) return;
    const result = await callAI(session, "/conversations/rename", { conversation_id: conversation.id, title });
    setConversations((prev) => prev.map((item) => item.id === conversation.id ? result.conversation : item));
  }

  async function archiveConversation(conversation: Conversation) {
    if (!session) return;
    await callAI(session, "/conversations/archive", { conversation_id: conversation.id, archived: true });
    setConversations((prev) => prev.filter((item) => item.id !== conversation.id));
    if (selectedId === conversation.id) newConversation();
  }

  async function deleteConversation(conversation: Conversation) {
    if (!session || !window.confirm(`Excluir definitivamente “${conversation.title}”?`)) return;
    await callAI(session, "/conversations/delete", { conversation_id: conversation.id });
    setConversations((prev) => prev.filter((item) => item.id !== conversation.id));
    if (selectedId === conversation.id) newConversation();
  }

  if (!authReady) return <main className="ai-auth"><span className="ai-spinner" /> Validando sua sessão…</main>;
  if (!session) return <main className="ai-auth"><div><h1>Faça login na Central de Operações</h1><p>A IA usa o mesmo perfil e as mesmas permissões do Dashboard.</p><a href="/">Voltar para o login</a></div></main>;
  if (session.user.id !== "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476") return <main className="ai-auth"><div><h1>IA (Beta)</h1><p>Esta função está em desenvolvimento pelo PAI DO OP.</p><a href="/">Voltar para a Central de Operações</a></div></main>;

  return (
    <main className={`ai-shell ${sidebarOpen ? "ai-sidebar-open" : "ai-sidebar-closed"}`}>
      <TabHelp view="ai" profile={{ person: profile?.person, role: profile?.role, access_level: profile?.accessLevel }} />
      <aside className="ai-sidebar">
        <div className="ai-brand-row">
          <a className="ai-brand" href="/" title="Voltar à Central de Operações"><span className="ai-logo"><BrandMark /></span><span><b>Central de Operações</b><small>IA da agência</small></span></a>
          <button className="ai-icon-button ai-mobile-close" onClick={() => setSidebarOpen(false)} aria-label="Fechar menu">×</button>
        </div>

        <button className="ai-new" onClick={newConversation}><span>＋</span> Nova conversa</button>
        <div className="ai-search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar conversas" /></div>

        <nav className="ai-history" aria-label="Histórico de conversas">
          {loading && <div className="ai-sidebar-empty">Carregando histórico…</div>}
          {!loading && !grouped.length && <div className="ai-sidebar-empty">Suas conversas aparecerão aqui.</div>}
          {grouped.map(([label, items]) => <section key={label} className="ai-history-group"><h3>{label}</h3>{items.map((conversation) => (
            <div key={conversation.id} className={`ai-conversation-row ${selectedId === conversation.id ? "active" : ""}`}>
              <button className="ai-conversation-main" onClick={() => openConversation(conversation.id)}><span className="ai-conversation-title">{conversation.title}</span>{conversation.client_id && <small>{clients.find((client) => client.client_id === conversation.client_id)?.display_name || "Cliente"}</small>}</button>
              <details className="ai-conversation-menu"><summary aria-label="Opções">•••</summary><div><button onClick={() => renameConversation(conversation)}>Renomear</button><button onClick={() => archiveConversation(conversation)}>Arquivar</button><button className="danger" onClick={() => deleteConversation(conversation)}>Excluir</button></div></details>
            </div>
          ))}</section>)}
        </nav>

        <div className="ai-profile">
          <span className="ai-avatar">{initials(profile?.person)}</span>
          <span><b>{profile?.person || session.user.email || "Usuário"}</b><small>{profile?.role || "Equipe"} · {profile?.accessLevel || "RESTRICTED"}</small></span>
        </div>
      </aside>

      <section className="ai-main">
        <header className="ai-topbar">
          <div className="ai-topbar-left"><button className="ai-icon-button" onClick={() => setSidebarOpen((value) => !value)} aria-label="Alternar histórico">☰</button><div><b>{selected?.title || "Nova conversa"}</b><small>{selected?.model || "IA da agência"}</small></div></div>
          <div className="ai-context-select"><label>Contexto</label><select value={(selected ? selected.client_id : draftClientId) || ""} onChange={(event) => changeClient(event.target.value)} disabled={sending}><option value="">Geral / sem cliente</option>{clients.map((client) => <option value={client.client_id} key={client.client_id}>{client.display_name} · {client.lifecycle}</option>)}</select></div>
          <a className="ai-back" href="/">Central de Operações ↗</a>
        </header>

        <div className="ai-chat-scroll">
          {!messages.length && !selectedId ? (
            <div className="ai-welcome">
              <div className="ai-welcome-mark">✦</div>
              <h1>Como posso ajudar na operação?</h1>
              <p>A conversa fica salva no seu perfil. Selecione um cliente para carregar contexto operacional automaticamente ou use o modo geral.</p>
              {selectedClient && <div className="ai-context-card"><span>Contexto ativo</span><b>{selectedClient.display_name}</b><small>{selectedClient.lifecycle}{selectedClient.gt_owner ? ` · GT ${selectedClient.gt_owner}` : ""}{selectedClient.cs_owner ? ` · CS ${selectedClient.cs_owner}` : ""}</small></div>}
              <div className="ai-suggestions">
                {["Quem precisa de atenção hoje?", "Analise o cliente selecionado e liste as próximas ações.", "Quais clientes estão travados no onboarding?", "Resuma os principais riscos operacionais de hoje."].map((suggestion) => <button key={suggestion} onClick={() => { setComposer(suggestion); composerRef.current?.focus(); }}>{suggestion}</button>)}
              </div>
            </div>
          ) : (
            <div className="ai-thread">
              {messages.map((message) => <article key={message.id} className={`ai-message ai-message-${message.role}`}>
                <div className="ai-message-avatar">{message.role === "user" ? initials(profile?.person) : "✦"}</div>
                <div className="ai-message-body"><div className="ai-message-meta"><b>{message.role === "user" ? "Você" : "IA"}</b>{message.model && <span>{message.model}</span>}</div><div className="ai-message-content">{message.content}</div>{message.role === "assistant" && (message.source || message.latency_ms) && <small className="ai-message-source">{message.source ? `Fonte: ${message.source}` : ""}{message.latency_ms ? ` · ${(message.latency_ms / 1000).toFixed(1)}s` : ""}</small>}</div>
              </article>)}
              {sending && <article className="ai-message ai-message-assistant"><div className="ai-message-avatar">✦</div><div className="ai-message-body"><div className="ai-message-meta"><b>IA</b></div><div className="ai-thinking"><i /><i /><i /></div></div></article>}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {error && <div className="ai-error">{error}<button onClick={() => setError("")}>×</button></div>}

        <footer className="ai-composer-wrap">
          <div className="ai-composer">
            <textarea ref={composerRef} value={composer} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendMessage(); } }} placeholder={selectedClient ? `Pergunte sobre ${selectedClient.display_name}…` : "Mensagem para a IA da agência…"} rows={1} disabled={sending} />
            <div className="ai-composer-tools"><button className="ai-attach" disabled title="Anexos serão habilitados na próxima etapa">＋</button><span>{selectedClient ? selectedClient.display_name : "Contexto geral"}</span><button className="ai-send" onClick={sendMessage} disabled={sending || !composer.trim()} aria-label="Enviar">↑</button></div>
          </div>
          <small className="ai-disclaimer">A IA pode cometer erros. Dados operacionais importantes devem ser confirmados nas fontes conectadas.</small>
        </footer>
      </section>
    </main>
  );
}
