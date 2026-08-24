"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-ai-work-api`;

type WorkEvent = {
  id: number;
  event_type: string;
  actor_person: string | null;
  previous_status: string | null;
  new_status: string | null;
  detail: string | null;
  occurred_at: string;
};
type WorkItem = {
  id: string;
  native_id: string;
  source: "CENTRAL" | "CLICKUP" | "CLICKUP_IMPORT";
  client_id: string;
  display_name: string;
  status: string;
  priority: string;
  title: string;
  description: string | null;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  resolution: string | null;
  created_at: string | null;
  updated_at: string | null;
  clickup_url: string | null;
  events: WorkEvent[];
};
type Client = { id: string; display_name: string; lifecycle: string; n8n_verified: boolean };
type Payload = {
  clients: Client[];
  items: WorkItem[];
  summary: { total: number; open: number; in_progress: number; waiting: number; overdue: number; completed: number };
  generated_at: string;
};

const COLUMNS = [
  { key: "OPEN", label: "Backlog" },
  { key: "IN_PROGRESS", label: "Em andamento" },
  { key: "WAITING", label: "Aguardando" },
  { key: "COMPLETED", label: "Concluídas" },
] as const;
const PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
const PRIORITY_LABEL: Record<string, string> = { CRITICAL: "Crítica", HIGH: "Alta", MEDIUM: "Média", LOW: "Baixa" };
const STATUS_LABEL: Record<string, string> = { OPEN: "Backlog", IN_PROGRESS: "Em andamento", WAITING: "Aguardando", SNOOZED: "Adiada", COMPLETED: "Concluída", DISMISSED: "Descartada" };

function formatDate(value: string | null | undefined) {
  if (!value) return "Sem prazo";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(date);
}
function localInput(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
function isOverdue(item: WorkItem) {
  return Boolean(item.due_at && !["COMPLETED", "DISMISSED"].includes(item.status) && new Date(item.due_at).getTime() < Date.now());
}

export function AIWorkBoard({ token }: { token: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [clientFilter, setClientFilter] = useState("ALL");
  const [priorityFilter, setPriorityFilter] = useState("ALL");
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [comment, setComment] = useState("");
  const [completion, setCompletion] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ client_id: "", title: "", description: "", priority: "MEDIUM", due_at: "" });

  const request = useCallback(async (body?: Record<string, unknown>) => {
    const response = await fetch(API_URL, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.detail || json.error || `API ${response.status}`);
    return json;
  }, [token]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const next = await request();
      setPayload(next);
      setSelected((current) => current ? (next.items || []).find((item: WorkItem) => item.id === current.id) || current : null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar a Central de Trabalho.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), 20000);
    return () => window.clearInterval(timer);
  }, [load]);

  const items = payload?.items || [];
  const clients = payload?.clients || [];
  const visible = useMemo(() => items.filter((item) => {
    if (clientFilter !== "ALL" && item.client_id !== clientFilter) return false;
    if (priorityFilter !== "ALL" && item.priority !== priorityFilter) return false;
    const needle = search.trim().toLocaleLowerCase("pt-BR");
    return !needle || `${item.display_name} ${item.title} ${item.description || ""}`.toLocaleLowerCase("pt-BR").includes(needle);
  }), [items, clientFilter, priorityFilter, search]);

  function itemsFor(column: string) {
    if (column === "WAITING") return visible.filter((item) => ["WAITING", "SNOOZED"].includes(item.status));
    return visible.filter((item) => item.status === column);
  }

  async function updateItem(item: WorkItem, patch: Record<string, unknown>) {
    setBusy(item.id);
    setError("");
    try {
      await request({ action: "update", id: item.id, ...patch });
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível atualizar a demanda.");
    } finally {
      setBusy("");
    }
  }

  async function move(item: WorkItem, status: string) {
    if (status === "COMPLETED") {
      setSelected(item);
      return;
    }
    if (item.status === status || (status === "WAITING" && ["WAITING", "SNOOZED"].includes(item.status))) return;
    await updateItem(item, { status });
  }

  async function addComment() {
    if (!selected || !comment.trim()) return;
    setBusy(selected.id);
    try {
      const result = await request({ action: "comment", id: selected.id, comment: comment.trim() });
      setComment("");
      await load(true);
      if (result.work_item_id && selected.id.startsWith("clickup:")) {
        const importedId = `work:${result.work_item_id}`;
        const next = (payload?.items || []).find((item) => item.id === importedId);
        if (next) setSelected(next);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível registrar o comentário.");
    } finally {
      setBusy("");
    }
  }

  async function completeSelected() {
    if (!selected || !completion.trim()) return;
    await updateItem(selected, { status: "COMPLETED", resolution: completion.trim() });
    setCompletion("");
  }

  async function createItem(event: React.FormEvent) {
    event.preventDefault();
    if (!form.client_id || !form.title.trim()) return;
    setBusy("create");
    try {
      await request({
        action: "create",
        client_id: form.client_id,
        title: form.title.trim(),
        description: form.description.trim(),
        priority: form.priority,
        due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
      });
      setForm({ client_id: "", title: "", description: "", priority: "MEDIUM", due_at: "" });
      setCreateOpen(false);
      await load(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível criar a demanda.");
    } finally {
      setBusy("");
    }
  }

  const summary = payload?.summary || { total: 0, open: 0, in_progress: 0, waiting: 0, overdue: 0, completed: 0 };

  return <section className="aiw-wrap">
    <div className="aiw-head">
      <div><span className="aih-kicker">CENTRAL DE TRABALHO · IA</span><h2>Quadro do Castro</h2><p>Só entram demandas de clientes com agente n8n nosso validado. Demandas de tráfego, design e CS continuam nas áreas responsáveis.</p></div>
      <div className="aiw-head-actions"><button onClick={() => load()} disabled={loading}>Atualizar</button><button className="aiw-primary" onClick={() => setCreateOpen((open) => !open)}>{createOpen ? "Cancelar" : "+ Nova demanda"}</button></div>
    </div>

    <div className="aiw-kpis">
      <article><small>BACKLOG</small><b>{summary.open}</b></article>
      <article><small>EM ANDAMENTO</small><b>{summary.in_progress}</b></article>
      <article><small>AGUARDANDO</small><b>{summary.waiting}</b></article>
      <article className={summary.overdue ? "bad" : ""}><small>ATRASADAS</small><b>{summary.overdue}</b></article>
    </div>

    {createOpen && <form className="aiw-create" onSubmit={createItem}>
      <div className="aiw-create-grid">
        <label>Cliente IA<select required value={form.client_id} onChange={(event) => setForm((current) => ({ ...current, client_id: event.target.value }))}><option value="">Selecione…</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.display_name}</option>)}</select></label>
        <label>Prioridade<select value={form.priority} onChange={(event) => setForm((current) => ({ ...current, priority: event.target.value }))}>{PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}</select></label>
        <label>Prazo<input type="datetime-local" value={form.due_at} onChange={(event) => setForm((current) => ({ ...current, due_at: event.target.value }))}/></label>
      </div>
      <label>Título<input required value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} placeholder="Ex.: corrigir retorno do agente no WhatsApp"/></label>
      <label>Contexto<textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="O que aconteceu, evidência e resultado esperado"/></label>
      <div className="aiw-create-foot"><span>Responsável: Gabriel Castro · Head de IA</span><button className="aiw-primary" disabled={busy === "create"}>{busy === "create" ? "Criando…" : "Criar demanda"}</button></div>
    </form>}

    {error && <div className="aih-error">{error}</div>}

    <div className="aiw-toolbar">
      <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar demanda ou cliente…"/>
      <select value={clientFilter} onChange={(event) => setClientFilter(event.target.value)}><option value="ALL">Todos os clientes IA</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.display_name}</option>)}</select>
      <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)}><option value="ALL">Todas as prioridades</option>{PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}</select>
      <span>{visible.length} demandas</span>
    </div>

    {loading && !payload ? <div className="aih-empty">Carregando quadro de trabalho…</div> : <div className="aiw-board">
      {COLUMNS.map((column) => {
        const columnItems = itemsFor(column.key);
        return <section className={`aiw-column aiw-column-${column.key.toLowerCase()}`} key={column.key}
          onDragOver={(event) => { if (column.key !== "COMPLETED") event.preventDefault(); }}
          onDrop={(event) => {
            event.preventDefault();
            if (column.key === "COMPLETED") return;
            const id = dragging || event.dataTransfer.getData("text/plain");
            const item = items.find((candidate) => candidate.id === id);
            setDragging(null);
            if (item) move(item, column.key);
          }}>
          <header><b>{column.label}</b><span>{columnItems.length}</span></header>
          <div className="aiw-cards">{columnItems.map((item) => <article
            key={item.id}
            className={`aiw-card${isOverdue(item) ? " overdue" : ""}${busy === item.id ? " busy" : ""}`}
            draggable={column.key !== "COMPLETED" && busy !== item.id}
            onDragStart={(event) => { setDragging(item.id); event.dataTransfer.setData("text/plain", item.id); }}
            onDragEnd={() => setDragging(null)}
            onClick={() => { setSelected(item); setCompletion(""); setComment(""); }}>
            <div className="aiw-card-top"><span className={`aiw-priority p-${item.priority.toLowerCase()}`}>{PRIORITY_LABEL[item.priority] || item.priority}</span><span className="aiw-source">{item.source === "CENTRAL" ? "Central" : "ClickUp"}</span></div>
            <h3>{item.title}</h3>
            <strong>{item.display_name}</strong>
            <div className="aiw-card-foot"><span className={isOverdue(item) ? "late" : ""}>{item.due_at ? formatDate(item.due_at) : "Sem prazo"}</span>{item.events?.filter((event) => event.event_type === "COMMENT").length ? <span>💬 {item.events.filter((event) => event.event_type === "COMMENT").length}</span> : null}</div>
          </article>)}</div>
          {!columnItems.length && <div className="aiw-column-empty">Nenhuma demanda</div>}
        </section>;
      })}
    </div>}

    {selected && <div className="aiw-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <aside className="aiw-drawer">
        <div className="aiw-drawer-head"><div><span>{selected.display_name}</span><h2>{selected.title}</h2></div><button onClick={() => setSelected(null)}>×</button></div>
        <div className="aiw-detail-grid">
          <label>Status<select value={selected.status} disabled={busy === selected.id} onChange={(event) => {
            const status = event.target.value;
            if (status === "COMPLETED") return;
            updateItem(selected, { status });
          }}><option value="OPEN">Backlog</option><option value="IN_PROGRESS">Em andamento</option><option value="WAITING">Aguardando</option><option value="SNOOZED">Adiada</option>{selected.status === "COMPLETED" && <option value="COMPLETED">Concluída</option>}</select></label>
          <label>Prioridade<select value={selected.priority} disabled={busy === selected.id} onChange={(event) => updateItem(selected, { priority: event.target.value })}>{PRIORITIES.map((priority) => <option key={priority} value={priority}>{PRIORITY_LABEL[priority]}</option>)}</select></label>
          <label>Prazo<input type="datetime-local" value={localInput(selected.due_at)} disabled={busy === selected.id} onChange={(event) => updateItem(selected, { due_at: event.target.value ? new Date(event.target.value).toISOString() : null })}/></label>
          <div className="aiw-detail-source"><small>ORIGEM</small><b>{selected.source === "CENTRAL" ? "Central de Trabalho" : "ClickUp → Central IA"}</b></div>
        </div>
        <section className="aiw-detail-section"><h3>Contexto</h3><p>{selected.description || "Sem contexto adicional registrado."}</p>{selected.clickup_url && <a href={selected.clickup_url} target="_blank" rel="noreferrer">Abrir origem no ClickUp ↗</a>}</section>

        {selected.status !== "COMPLETED" && <section className="aiw-detail-section"><h3>Concluir demanda</h3><textarea value={completion} onChange={(event) => setCompletion(event.target.value)} placeholder="Registre o que foi feito / resultado da correção…"/><button className="aiw-success" disabled={busy === selected.id || !completion.trim()} onClick={completeSelected}>Marcar como concluída</button></section>}
        {selected.resolution && <section className="aiw-detail-section aiw-resolution"><h3>Conclusão</h3><p>{selected.resolution}</p></section>}

        <section className="aiw-detail-section"><h3>Comentários e histórico</h3>
          <div className="aiw-comment-box"><textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Adicionar comentário, decisão, retorno do cliente…"/><button disabled={busy === selected.id || !comment.trim()} onClick={addComment}>Comentar</button></div>
          <div className="aiw-events">{selected.events?.map((event) => <article key={event.id}><div><b>{event.actor_person || "Sistema"}</b><span>{formatDate(event.occurred_at)}</span></div><p>{event.event_type === "COMMENT" ? event.detail : event.previous_status && event.new_status && event.previous_status !== event.new_status ? `${STATUS_LABEL[event.previous_status] || event.previous_status} → ${STATUS_LABEL[event.new_status] || event.new_status}${event.detail ? ` · ${event.detail}` : ""}` : event.detail || event.event_type}</p></article>)}{!selected.events?.length && <div className="aiw-no-events">Ainda sem comentários ou alterações registradas.</div>}</div>
        </section>
      </aside>
    </div>}
  </section>;
}
