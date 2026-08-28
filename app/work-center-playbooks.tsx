"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const WORK_API = `${SUPABASE_URL}/functions/v1/agency-ops-work-center-api`;

type Tab = "projects" | "templates" | "notes";
type AnyRow = Record<string, any>;
type TemplateItemDraft = {
  key: string;
  title: string;
  assignee_mode: "NONE" | "PROJECT_OWNER" | "CLIENT_GT" | "CLIENT_CS" | "CLIENT_DESIGNER";
  required: boolean;
};

const palette = {
  bg: "var(--panel,#10141d)",
  bg2: "var(--surface,#151a24)",
  border: "var(--border,#2a3040)",
  text: "var(--text,#f4f7fb)",
  muted: "var(--muted,#98a2b3)",
  accent: "#7c5cff",
  green: "#16a36a",
  yellow: "#d69e2e",
  red: "#e05252",
};

const S: Record<string, React.CSSProperties> = {
  headerButtons: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" },
  button: { border: `1px solid ${palette.border}`, borderRadius: 9, padding: "9px 12px", background: palette.bg2, color: palette.text, cursor: "pointer", fontWeight: 700, fontSize: 12 },
  primary: { border: 0, borderRadius: 9, padding: "9px 13px", background: palette.accent, color: "white", cursor: "pointer", fontWeight: 800, fontSize: 12 },
  overlay: { position: "fixed", inset: 0, zIndex: 12000, background: "rgba(3,6,12,.72)", backdropFilter: "blur(3px)", display: "grid", placeItems: "center", padding: 18 },
  modal: { width: "min(1120px,96vw)", maxHeight: "92vh", overflow: "hidden", borderRadius: 16, border: `1px solid ${palette.border}`, background: palette.bg, color: palette.text, boxShadow: "0 30px 100px rgba(0,0,0,.55)", display: "flex", flexDirection: "column" },
  modalHead: { padding: "17px 18px 12px", borderBottom: `1px solid ${palette.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 },
  tabs: { display: "flex", gap: 6, padding: "10px 18px", borderBottom: `1px solid ${palette.border}`, overflowX: "auto" },
  body: { overflow: "auto", padding: 18 },
  card: { border: `1px solid ${palette.border}`, borderRadius: 12, padding: 14, background: palette.bg2 },
  input: { width: "100%", boxSizing: "border-box", border: `1px solid ${palette.border}`, borderRadius: 9, padding: "10px 11px", background: "rgba(4,8,15,.36)", color: palette.text, outline: "none" },
  label: { display: "grid", gap: 6, fontSize: 12, fontWeight: 700, color: palette.muted },
  grid2: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 10 },
};

function pct(project: AnyRow) {
  return Math.max(0, Math.min(100, Number(project?.progress?.pct || 0)));
}
function humanStatus(value: unknown) {
  const s = String(value || "").toUpperCase();
  const map: Record<string, string> = { OPEN: "Aberto", IN_PROGRESS: "Em andamento", WAITING: "Aguardando", COMPLETED: "Concluído", ARCHIVED: "Arquivado", CANCELLED: "Cancelado", PUBLISHED: "Publicado", DRAFT: "Rascunho" };
  return map[s] || s.replaceAll("_", " ");
}
function priorityLabel(value: unknown) {
  const s = String(value || "MEDIUM").toUpperCase();
  return ({ CRITICAL: "Crítica", HIGH: "Alta", MEDIUM: "Média", LOW: "Baixa" } as Record<string,string>)[s] || s;
}
function shortDate(value: unknown) {
  if (!value) return "—";
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "America/Sao_Paulo" }).format(d);
}

async function workFetch(token: string, resource: string, init?: RequestInit) {
  const response = await fetch(`${WORK_API}${resource ? `?${resource}` : ""}`, {
    ...init,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(json?.detail || json?.error || "Falha na Central de Trabalho.");
  return json || {};
}

function SmallChip({ children, tone = "" }: { children: React.ReactNode; tone?: string }) {
  const background = tone === "green" ? "rgba(22,163,106,.14)" : tone === "yellow" ? "rgba(214,158,46,.14)" : tone === "red" ? "rgba(224,82,82,.14)" : "rgba(124,92,255,.12)";
  const color = tone === "green" ? "#55d69b" : tone === "yellow" ? "#efc66f" : tone === "red" ? "#ff8a8a" : "#b7a8ff";
  return <span style={{ padding: "4px 7px", borderRadius: 999, background, color, fontSize: 10.5, fontWeight: 800, whiteSpace: "nowrap" }}>{children}</span>;
}

function ApplyTemplate({ token, template, clients, close, done }: { token: string; template: AnyRow; clients: AnyRow[]; close: () => void; done: () => void }) {
  const [clientId, setClientId] = useState("");
  const [name, setName] = useState("");
  const [startAt, setStartAt] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const client = clients.find((c) => String(c.id || c.client_id) === clientId);
  useEffect(() => { if (client) setName(`${client.display_name} — ${template.name}`); }, [clientId]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId) return setError("Selecione um cliente.");
    setBusy(true); setError("");
    try {
      await workFetch(token, "", { method: "POST", body: JSON.stringify({ action: "template-instantiate", template_id: template.id, client_id: clientId, project_name: name || undefined, start_at: `${startAt}T09:00:00-03:00` }) });
      done(); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao aplicar modelo."); }
    finally { setBusy(false); }
  }
  return <div style={{ ...S.card, marginTop: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 10 }}><div><b>Aplicar “{template.name}”</b><div style={{ color: palette.muted, fontSize: 11, marginTop: 3 }}>{template.item_count} etapas · versão {template.current_version}</div></div><button style={S.button} type="button" onClick={close}>Fechar</button></div>
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      <div style={S.grid2}>
        <label style={S.label}>Cliente<select style={S.input} value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Selecione…</option>{clients.map((c) => <option key={c.id || c.client_id} value={c.id || c.client_id}>{c.display_name}</option>)}</select></label>
        <label style={S.label}>Início<input style={S.input} type="date" value={startAt} onChange={(e) => setStartAt(e.target.value)} /></label>
      </div>
      <label style={S.label}>Nome do projeto<input style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Cliente — Nome do projeto" /></label>
      {error && <div style={{ color: "#ff8a8a", fontSize: 12 }}>{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}><button style={S.primary} disabled={busy}>{busy ? "Criando projeto…" : `Criar ${template.item_count} etapas`}</button></div>
    </form>
  </div>;
}

function TemplateBuilder({ token, close, done }: { token: string; close: () => void; done: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("ROLE");
  const [items, setItems] = useState<TemplateItemDraft[]>([
    { key: crypto.randomUUID(), title: "", assignee_mode: "PROJECT_OWNER", required: true },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const update = (key: string, patch: Partial<TemplateItemDraft>) => setItems((current) => current.map((i) => i.key === key ? { ...i, ...patch } : i));
  const add = () => setItems((current) => [...current, { key: crypto.randomUUID(), title: "", assignee_mode: "NONE", required: true }]);
  const remove = (key: string) => setItems((current) => current.length <= 1 ? current : current.filter((i) => i.key !== key));
  const move = (index: number, by: number) => setItems((current) => { const next = [...current]; const target = index + by; if (target < 0 || target >= next.length) return current; [next[index], next[target]] = [next[target], next[index]]; return next; });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const validItems = items.filter((i) => i.title.trim());
    if (!name.trim()) return setError("Dê um nome ao modelo.");
    if (!validItems.length) return setError("Adicione pelo menos uma etapa.");
    setBusy(true); setError("");
    try {
      await workFetch(token, "", { method: "POST", body: JSON.stringify({
        action: "template-create", name: name.trim(), description: description.trim(), kind: "PLAYBOOK", visibility,
        items: validItems.map((i, index) => ({ item_key: `ETAPA_${String(index + 1).padStart(3, "0")}`, sort_order: (index + 1) * 10, title_template: i.title.trim(), assignee_mode: i.assignee_mode, required: i.required })),
      }) });
      done(); close();
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao criar modelo."); }
    finally { setBusy(false); }
  }
  const assigneeOptions = [
    ["PROJECT_OWNER", "Dono do projeto"], ["NONE", "Sem responsável"], ["CLIENT_GT", "GT do cliente"], ["CLIENT_CS", "CS do cliente"], ["CLIENT_DESIGNER", "Designer do cliente"],
  ];
  return <form onSubmit={submit} style={{ display: "grid", gap: 12 }}>
    <div style={S.grid2}>
      <label style={S.label}>Nome do modelo<input style={S.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Implantação Agente IA" autoFocus /></label>
      <label style={S.label}>Quem pode usar<select style={S.input} value={visibility} onChange={(e) => setVisibility(e.target.value)}><option value="ROLE">Minha área</option><option value="PRIVATE">Só eu</option><option value="AGENCY">Agência inteira (gestão aprova)</option></select></label>
    </div>
    <label style={S.label}>Descrição<textarea style={{ ...S.input, minHeight: 70, resize: "vertical" }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Quando esse modelo deve ser usado" /></label>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}><div><b>Etapas do modelo</b><div style={{ color: palette.muted, fontSize: 11, marginTop: 3 }}>Arraste pela ordem usando ↑ ↓. Depois você aplica a lista inteira em qualquer cliente.</div></div><button type="button" style={S.button} onClick={add}>+ Adicionar etapa</button></div>
    <div style={{ display: "grid", gap: 7 }}>
      {items.map((item, index) => <div key={item.key} style={{ ...S.card, padding: 10, display: "grid", gridTemplateColumns: "42px minmax(220px,1fr) minmax(160px,.45fr) 105px 80px", gap: 8, alignItems: "center" }}>
        <b style={{ color: palette.muted, textAlign: "center" }}>{index + 1}</b>
        <input style={S.input} value={item.title} onChange={(e) => update(item.key, { title: e.target.value })} placeholder="Nome da etapa" />
        <select style={S.input} value={item.assignee_mode} onChange={(e) => update(item.key, { assignee_mode: e.target.value as TemplateItemDraft["assignee_mode"] })}>{assigneeOptions.map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select>
        <label style={{ display: "flex", gap: 6, alignItems: "center", color: palette.muted, fontSize: 11 }}><input type="checkbox" checked={item.required} onChange={(e) => update(item.key, { required: e.target.checked })} />Obrigatória</label>
        <div style={{ display: "flex", gap: 4 }}><button type="button" style={{ ...S.button, padding: "6px 8px" }} onClick={() => move(index, -1)}>↑</button><button type="button" style={{ ...S.button, padding: "6px 8px" }} onClick={() => move(index, 1)}>↓</button><button type="button" style={{ ...S.button, padding: "6px 8px", color: "#ff8a8a" }} onClick={() => remove(item.key)}>×</button></div>
      </div>)}
    </div>
    {error && <div style={{ color: "#ff8a8a", fontSize: 12 }}>{error}</div>}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><button type="button" style={S.button} onClick={close}>Cancelar</button><button style={S.primary} disabled={busy}>{busy ? "Salvando…" : "Salvar modelo"}</button></div>
  </form>;
}

function ProjectsTab({ token, projects, reload }: { token: string; projects: AnyRow[]; reload: () => void }) {
  const [expanded, setExpanded] = useState("");
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  async function saveAsTemplate(project: AnyRow) {
    const name = window.prompt("Nome do novo modelo", project.name);
    if (!name) return;
    setSaving(project.id); setError("");
    try { await workFetch(token, "", { method: "POST", body: JSON.stringify({ action: "save-project-as-template", project_id: project.id, name, visibility: "ROLE" }) }); reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar como modelo."); }
    finally { setSaving(""); }
  }
  return <div style={{ display: "grid", gap: 10 }}>
    {error && <div style={{ color: "#ff8a8a", fontSize: 12 }}>{error}</div>}
    {projects.map((p) => { const open = expanded === p.id; return <article style={S.card} key={p.id}>
      <button type="button" onClick={() => setExpanded(open ? "" : p.id)} style={{ width: "100%", display: "grid", gridTemplateColumns: "minmax(220px,1fr) 130px 130px 100px", gap: 12, alignItems: "center", border: 0, background: "transparent", color: palette.text, cursor: "pointer", textAlign: "left" }}>
        <span><b style={{ display: "block" }}>{p.name}</b><small style={{ color: palette.muted }}>{p.clients?.display_name || "Projeto interno"} · {p.owner_person || p.owner_role || "Sem responsável"}</small></span>
        <span><b>{p.progress?.completed || 0}/{p.progress?.total || 0}</b><small style={{ display: "block", color: palette.muted }}>etapas</small></span>
        <span><div style={{ height: 7, background: "rgba(255,255,255,.08)", borderRadius: 999, overflow: "hidden" }}><i style={{ display: "block", height: "100%", width: `${pct(p)}%`, background: pct(p) === 100 ? palette.green : palette.accent }} /></div><small style={{ color: palette.muted }}>{pct(p)}% concluído</small></span>
        <SmallChip tone={p.status === "COMPLETED" ? "green" : p.status === "WAITING" ? "yellow" : ""}>{humanStatus(p.status)}</SmallChip>
      </button>
      {open && <div style={{ borderTop: `1px solid ${palette.border}`, marginTop: 12, paddingTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 10 }}><div style={{ color: palette.muted, fontSize: 11 }}>Criado {shortDate(p.created_at)}{p.template_version_id ? " · a partir de modelo" : ""}</div><button style={S.button} disabled={saving === p.id} onClick={() => saveAsTemplate(p)}>{saving === p.id ? "Salvando…" : "Salvar projeto como modelo"}</button></div>
        <div style={{ display: "grid", gap: 5 }}>{(p.items || []).map((item: AnyRow, index: number) => <div key={item.id} style={{ display: "grid", gridTemplateColumns: "32px minmax(220px,1fr) 150px 100px", alignItems: "center", gap: 8, padding: "8px 6px", borderBottom: `1px solid ${palette.border}` }}><span style={{ color: palette.muted, fontSize: 11 }}>{index + 1}</span><span><b style={{ fontSize: 12 }}>{item.title}</b>{item.parent_id && <small style={{ color: palette.muted, display: "block" }}>subtarefa</small>}</span><small style={{ color: palette.muted }}>{item.target_person || item.target_role || "Sem responsável"}</small><SmallChip tone={item.status === "COMPLETED" ? "green" : item.status === "WAITING" ? "yellow" : ""}>{humanStatus(item.status)}</SmallChip></div>)}</div>
      </div>}
    </article>; })}
    {!projects.length && <div style={{ ...S.card, color: palette.muted, textAlign: "center", padding: 30 }}>Nenhum projeto criado ainda. Aplique um modelo para começar.</div>}
  </div>;
}

function TemplatesTab({ token, templates, clients, reload }: { token: string; templates: AnyRow[]; clients: AnyRow[]; reload: () => void }) {
  const [applying, setApplying] = useState<AnyRow | null>(null);
  const [builder, setBuilder] = useState(false);
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center", marginBottom: 12 }}><div><b>Biblioteca de modelos</b><div style={{ color: palette.muted, fontSize: 11, marginTop: 3 }}>Crie uma vez e replique a lista inteira em cada cliente.</div></div><button style={S.primary} onClick={() => setBuilder(true)}>+ Criar modelo</button></div>
    {builder && <div style={{ ...S.card, marginBottom: 12 }}><TemplateBuilder token={token} close={() => setBuilder(false)} done={reload} /></div>}
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 10 }}>
      {templates.map((t) => <article style={S.card} key={t.id}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}><div><SmallChip>{t.area || t.owner_role || "Geral"}</SmallChip><h3 style={{ margin: "9px 0 4px", fontSize: 16 }}>{t.name}</h3><p style={{ margin: 0, color: palette.muted, fontSize: 11.5, lineHeight: 1.45 }}>{t.description || "Modelo reutilizável de trabalho."}</p></div><SmallChip tone="green">v{t.current_version}</SmallChip></div>
        <div style={{ display: "flex", gap: 12, marginTop: 13, color: palette.muted, fontSize: 11 }}><span><b style={{ color: palette.text }}>{t.item_count || 0}</b> etapas</span><span>{t.visibility === "PRIVATE" ? "Só você" : t.visibility === "ROLE" ? "Sua área" : "Agência"}</span></div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}><button style={S.primary} onClick={() => setApplying(applying?.id === t.id ? null : t)}>Aplicar em cliente</button></div>
        {applying?.id === t.id && <ApplyTemplate token={token} template={t} clients={clients} close={() => setApplying(null)} done={reload} />}
      </article>)}
      {!templates.length && <div style={{ ...S.card, color: palette.muted }}>Nenhum modelo disponível para seu perfil.</div>}
    </div>
  </div>;
}

function NotesTab({ token, clients }: { token: string; clients: AnyRow[] }) {
  const [clientId, setClientId] = useState("");
  const [notes, setNotes] = useState<AnyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [type, setType] = useState("GENERAL");
  const [importance, setImportance] = useState("NORMAL");
  const [pinned, setPinned] = useState(false);
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    if (!clientId) { setNotes([]); return; }
    setLoading(true); setError("");
    try { const data = await workFetch(token, `resource=notes&client_id=${encodeURIComponent(clientId)}`); setNotes(data.notes || []); }
    catch (e) { setError(e instanceof Error ? e.message : "Falha ao carregar anotações."); }
    finally { setLoading(false); }
  }, [token, clientId]);
  useEffect(() => { load(); }, [load]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId || !body.trim()) return setError("Selecione o cliente e escreva a anotação.");
    setBusy(true); setError("");
    try {
      await workFetch(token, "", { method: "POST", body: JSON.stringify({ action: "note-create", client_id: clientId, title: title.trim(), body: body.trim(), note_type: type, importance, is_pinned: pinned, use_as_ai_context: ai, sensitivity: "NORMAL" }) });
      setTitle(""); setBody(""); setPinned(false); setAi(false); setImportance("NORMAL"); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao salvar anotação."); }
    finally { setBusy(false); }
  }
  const selected = clients.find((c) => String(c.id || c.client_id) === clientId);
  return <div style={{ display: "grid", gap: 12 }}>
    <div style={S.card}><label style={S.label}>Cliente<select style={S.input} value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">Selecione a pasta do cliente…</option>{clients.map((c) => <option key={c.id || c.client_id} value={c.id || c.client_id}>{c.display_name}</option>)}</select></label></div>
    {clientId && <div style={{ display: "grid", gridTemplateColumns: "minmax(300px,.72fr) minmax(360px,1.28fr)", gap: 12, alignItems: "start" }}>
      <form onSubmit={create} style={{ ...S.card, display: "grid", gap: 9, position: "sticky", top: 0 }}>
        <div><b>Nova anotação</b><div style={{ color: palette.muted, fontSize: 11, marginTop: 3 }}>{selected?.display_name}</div></div>
        <label style={S.label}>Título<input style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Preferência de atendimento" /></label>
        <label style={S.label}>Anotação<textarea style={{ ...S.input, minHeight: 120, resize: "vertical" }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Particularidade importante desse cliente…" /></label>
        <div style={S.grid2}><label style={S.label}>Tipo<select style={S.input} value={type} onChange={(e) => setType(e.target.value)}><option value="GENERAL">Geral</option><option value="PREFERENCE">Preferência</option><option value="WARNING">Atenção</option><option value="PROCESS">Processo</option><option value="CONTEXT">Contexto</option><option value="ACCESS">Acesso/instrução</option></select></label><label style={S.label}>Importância<select style={S.input} value={importance} onChange={(e) => setImportance(e.target.value)}><option value="NORMAL">Normal</option><option value="IMPORTANT">Importante</option><option value="CRITICAL">Crítica</option></select></label></div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", color: palette.muted, fontSize: 11 }}><input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />Fixar no topo</label>
        <label style={{ display: "flex", gap: 8, alignItems: "center", color: palette.muted, fontSize: 11 }}><input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />Usar como contexto operacional da IA</label>
        {ai && <small style={{ color: "#b7a8ff", lineHeight: 1.4 }}>Essa nota passa a fazer parte do contexto verificado do Task Engine para esse cliente.</small>}
        {error && <div style={{ color: "#ff8a8a", fontSize: 12 }}>{error}</div>}
        <button style={S.primary} disabled={busy}>{busy ? "Salvando…" : "Salvar anotação"}</button>
      </form>
      <div style={{ display: "grid", gap: 8 }}>
        {loading && <div style={{ ...S.card, color: palette.muted }}>Carregando anotações…</div>}
        {!loading && notes.map((n) => <article style={{ ...S.card, borderColor: n.importance === "CRITICAL" ? "rgba(224,82,82,.55)" : n.importance === "IMPORTANT" ? "rgba(214,158,46,.55)" : palette.border }} key={n.id}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>{n.is_pinned && <SmallChip tone="yellow">FIXADA</SmallChip>}<SmallChip>{n.note_type}</SmallChip>{n.use_as_ai_context && <SmallChip>CONTEXTO IA</SmallChip>}</div><small style={{ color: palette.muted }}>{shortDate(n.updated_at)}</small></div>
          {n.title && <h4 style={{ margin: "10px 0 5px" }}>{n.title}</h4>}<p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{n.body}</p><small style={{ color: palette.muted, display: "block", marginTop: 9 }}>{n.created_by_person || "Equipe"}</small>
        </article>)}
        {!loading && !notes.length && <div style={{ ...S.card, color: palette.muted, textAlign: "center", padding: 28 }}>Nenhuma anotação nessa pasta ainda.</div>}
      </div>
    </div>}
  </div>;
}

function Manager({ token, initialTab, close }: { token: string; initialTab: Tab; close: () => void }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [templates, setTemplates] = useState<AnyRow[]>([]);
  const [projects, setProjects] = useState<AnyRow[]>([]);
  const [clients, setClients] = useState<AnyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [t, p, c] = await Promise.all([workFetch(token, "resource=templates"), workFetch(token, "resource=projects"), workFetch(token, "resource=clients")]);
      setTemplates(t.templates || []); setProjects(p.projects || []); setClients(c.clients || []);
    } catch (e) { setError(e instanceof Error ? e.message : "Falha ao carregar projetos e modelos."); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { reload(); }, [reload]);
  return <div style={S.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <section style={S.modal} role="dialog" aria-modal="true" aria-label="Projetos, modelos e anotações">
      <header style={S.modalHead}><div><small style={{ color: palette.muted, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em" }}>Central de Trabalho</small><h2 style={{ margin: "3px 0 0", fontSize: 20 }}>Projetos, modelos e memória do cliente</h2></div><button type="button" style={{ ...S.button, fontSize: 18, padding: "5px 10px" }} onClick={close}>×</button></header>
      <nav style={S.tabs}>{([['projects','Projetos'],['templates','Modelos'],['notes','Anotações por cliente']] as [Tab,string][]).map(([key,label]) => <button key={key} style={{ ...S.button, background: tab === key ? "rgba(124,92,255,.18)" : palette.bg2, borderColor: tab === key ? palette.accent : palette.border }} onClick={() => setTab(key)}>{label}{key === "projects" ? ` · ${projects.length}` : key === "templates" ? ` · ${templates.length}` : ""}</button>)}</nav>
      <div style={S.body}>{error && <div style={{ ...S.card, color: "#ff8a8a", marginBottom: 10 }}>{error}</div>}{loading ? <div style={{ ...S.card, color: palette.muted, textAlign: "center", padding: 32 }}>Carregando…</div> : tab === "projects" ? <ProjectsTab token={token} projects={projects} reload={reload} /> : tab === "templates" ? <TemplatesTab token={token} templates={templates} clients={clients} reload={reload} /> : <NotesTab token={token} clients={clients} />}</div>
    </section>
  </div>;
}

export default function WorkCenterPlaybooks() {
  const [token, setToken] = useState("");
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState<Tab | null>(null);
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) setToken(data.session?.access_token || ""); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => { if (active) setToken(session?.access_token || ""); });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    const find = () => setHeader(document.querySelector<HTMLElement>(".work-center .workspace-head"));
    find();
    const observer = new MutationObserver(find);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const buttons = useMemo(() => header && token ? createPortal(<div style={S.headerButtons}>
    <button type="button" style={S.button} onClick={() => setOpen("projects")}>Projetos</button>
    <button type="button" style={S.button} onClick={() => setOpen("templates")}>Modelos</button>
    <button type="button" style={S.button} onClick={() => setOpen("notes")}>Anotações</button>
  </div>, header) : null, [header, token]);
  return <>{buttons}{open && token && createPortal(<Manager token={token} initialTab={open} close={() => setOpen(null)} />, document.body)}</>;
}
