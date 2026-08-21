"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Chip, SUPABASE_ANON_KEY, SUPABASE_URL, formatDate, text } from "../shared";
import type { Row } from "../shared";

const DIARY_API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-diary-api`;

const ORIGINS = [
  ["CLIENT", "Cliente"], ["CS", "CS"], ["GT", "Gestor de Tráfego"], ["DESIGN", "Designer"],
  ["OPS", "Operações"], ["COMMERCIAL", "Comercial"], ["INTERNAL_AUDIT", "Auditoria interna"], ["OTHER", "Outro"],
] as const;
const AREAS = [
  ["DESIGN", "Design"], ["TRAFFIC", "Tráfego"], ["CS", "CS"], ["OPS", "Operações"],
  ["COMMERCIAL", "Comercial"], ["DEVELOPMENT", "Desenvolvimento"], ["CLIENT", "Cliente"], ["EXTERNAL", "Externo"],
] as const;
const STATUSES = [["OPEN", "Aberto"], ["IN_PROGRESS", "Em correção"], ["RESOLVED", "Resolvido"], ["DISCARDED", "Descartado"]] as const;
const SEVERITIES = [["", "Não informar"], ["LOW", "Baixo"], ["MEDIUM", "Médio"], ["HIGH", "Alto"], ["CRITICAL", "Crítico"]] as const;

function labelOf(options: readonly (readonly [string, string])[], value: unknown, fallback = "Não identificado") {
  return options.find(([key]) => key === String(value ?? ""))?.[1] ?? fallback;
}
function opsDateTimeInput(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function toOpsTimestamp(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return "";
  return `${value}:00-03:00`;
}
async function diaryRequest(view: string, token: string, options?: { method?: "GET" | "POST"; params?: Record<string, string>; body?: Row }) {
  const url = new URL(DIARY_API_URL);
  url.searchParams.set("view", view);
  for (const [key, value] of Object.entries(options?.params ?? {})) if (value) url.searchParams.set(key, value);
  const response = await fetch(url.toString(), {
    method: options?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
      ...(options?.method === "POST" ? { "content-type": "application/json" } : {}),
    },
    body: options?.method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || payload.error || `Falha no Diário (${response.status})`);
  return payload;
}

export function DiaryCenter({ clients: fallbackClients, profile, token, reload }: { clients: Row[]; adjustments: Row[]; taskLog: Row; profile: Row; token: string; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<"ajustes" | "tasklog">("ajustes");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [data, setData] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [filters, setFilters] = useState({ author_user_id: "", client_id: "", category_code: "", subcategory_code: "", responsible_area: "", status: "", since: "", until: "" });

  const refresh = useCallback(async () => {
    setLoading(true); setLoadError("");
    try {
      const params: Record<string, string> = { scope };
      if (scope === "all") Object.assign(params, Object.fromEntries(Object.entries(filters).filter(([, value]) => value)));
      setData(await diaryRequest("data", token, { params }));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Falha ao carregar o Diário");
    } finally { setLoading(false); }
  }, [token, scope, filters]);

  useEffect(() => { refresh(); }, [refresh]);
  const canViewAll = Boolean(data?.can_view_all);
  useEffect(() => { if (!canViewAll && scope === "all") setScope("mine"); }, [canViewAll, scope]);

  const clients: Row[] = data?.clients?.length ? data.clients : fallbackClients;
  const categories: Row[] = data?.categories || [];
  const subcategories: Row[] = data?.subcategories || [];
  const staff: Row[] = data?.staff || [];
  const adjustments: Row[] = data?.adjustments || [];
  const taskRows: Row[] = data?.task_log || [];
  const counts = data?.counts || { adjustments: adjustments.length, tasks: taskRows.length };

  const [adjClient, setAdjClient] = useState("");
  const [adjOccurredAt, setAdjOccurredAt] = useState(() => opsDateTimeInput());
  const [adjCategory, setAdjCategory] = useState("");
  const [adjSubcategory, setAdjSubcategory] = useState("");
  const [adjOrigin, setAdjOrigin] = useState("");
  const [adjDescription, setAdjDescription] = useState("");
  const [adjReason, setAdjReason] = useState("");
  const [adjArea, setAdjArea] = useState("");
  const [adjStatus, setAdjStatus] = useState("OPEN");
  const [adjSeverity, setAdjSeverity] = useState("");
  const [adjRecurrent, setAdjRecurrent] = useState(false);
  const [adjResolution, setAdjResolution] = useState("");
  const [adjSaving, setAdjSaving] = useState(false);
  const [adjError, setAdjError] = useState("");
  const formSubcategories = useMemo(() => subcategories.filter((item) => item.category_code === adjCategory), [subcategories, adjCategory]);
  const filterSubcategories = useMemo(() => subcategories.filter((item) => !filters.category_code || item.category_code === filters.category_code), [subcategories, filters.category_code]);

  async function submitAdjustment() {
    setAdjError("");
    if (!adjClient || !adjOccurredAt || !adjCategory || !adjSubcategory || !adjOrigin || !adjDescription.trim() || !adjReason.trim()) {
      setAdjError("Preencha cliente, data do ajuste, categoria, motivo, origem, o que foi ajustado e por que o ajuste aconteceu."); return;
    }
    if (adjStatus === "RESOLVED" && !adjResolution.trim()) { setAdjError("Ao registrar como resolvido, descreva a solução aplicada."); return; }
    setAdjSaving(true);
    try {
      await diaryRequest("adjustment-create", token, { method: "POST", body: {
        client_id: adjClient, occurred_at: toOpsTimestamp(adjOccurredAt), category_code: adjCategory, subcategory_code: adjSubcategory,
        request_origin: adjOrigin, description: adjDescription.trim(), reason: adjReason.trim(), responsible_area: adjArea || null,
        status: adjStatus, severity: adjSeverity || null, is_recurrent: adjRecurrent, resolution: adjResolution.trim() || null,
      } });
      setAdjClient(""); setAdjOccurredAt(opsDateTimeInput()); setAdjCategory(""); setAdjSubcategory(""); setAdjOrigin("");
      setAdjDescription(""); setAdjReason(""); setAdjArea(""); setAdjStatus("OPEN"); setAdjSeverity(""); setAdjRecurrent(false); setAdjResolution("");
      await refresh(); await reload();
    } catch (error) { setAdjError(error instanceof Error ? error.message : "Falha ao registrar ajuste"); }
    finally { setAdjSaving(false); }
  }

  const [editId, setEditId] = useState<number | null>(null);
  const [editStatus, setEditStatus] = useState("OPEN");
  const [editResolution, setEditResolution] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  async function updateAdjustment() {
    if (!editId) return;
    setEditBusy(true); setAdjError("");
    try {
      await diaryRequest("adjustment-update", token, { method: "POST", body: { id: editId, status: editStatus, resolution: editResolution.trim() || null } });
      setEditId(null); setEditResolution(""); await refresh();
    } catch (error) { setAdjError(error instanceof Error ? error.message : "Falha ao atualizar ajuste"); }
    finally { setEditBusy(false); }
  }

  const role = String(profile?.role || "").toUpperCase();
  const taskCategories: Record<string, string[]> = {
    GT: ["Campanha nova subida", "Otimização de campanha", "Ajuste de orçamento", "Análise de métricas", "Reunião com cliente", "Outro"],
    CS: ["Atendimento ao cliente", "Onboarding", "Reunião com cliente", "Resolução de pendência", "Relatório de resultados", "Outro"],
    DESIGN: ["Criativo novo", "Revisão de arte", "Edição de vídeo", "Banco de imagens", "Reunião de briefing", "Outro"],
    AI: ["Automação criada", "Otimização de prompt/IA", "Integração de sistema", "Análise de dados", "Reunião", "Outro"],
    MGMT: ["Reunião de gestão", "Planejamento estratégico", "Revisão de equipe", "Financeiro", "Reunião com cliente", "Outro"],
  };
  const taskOptions = taskCategories[role] || ["Execução", "Reunião", "Criativo", "Atendimento", "Outro"];
  const [taskCategory, setTaskCategory] = useState(taskOptions[0]);
  const [taskName, setTaskName] = useState("");
  const [taskDate, setTaskDate] = useState(() => opsDateTimeInput().slice(0, 10));
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskError, setTaskError] = useState("");
  async function submitTask() {
    if (!taskName.trim()) { setTaskError("Descreva a tarefa executada."); return; }
    setTaskSaving(true); setTaskError("");
    try {
      await diaryRequest("tasklog-create", token, { method: "POST", body: { category: taskCategory, task_name: taskName.trim(), task_date: taskDate } });
      setTaskName(""); await refresh(); await reload();
    } catch (error) { setTaskError(error instanceof Error ? error.message : "Falha ao registrar tarefa"); }
    finally { setTaskSaving(false); }
  }

  const updateFilter = (key: keyof typeof filters, value: string) => setFilters((current) => ({ ...current, [key]: value, ...(key === "category_code" ? { subcategory_code: "" } : {}) }));
  const helpText = "Use este espaço para registrar ajustes, correções ou retrabalhos que precisaram ser feitos para um cliente. Informe o que precisou ser corrigido e, principalmente, por que o ajuste aconteceu. Não use para atividades normais do dia a dia — para isso utilize o TaskLog. Correto: cliente pediu para trocar a imagem porque foi utilizado um render antigo. Não usar para: hoje alterei o criativo do cliente.";

  return <section className="workspace">
    <div className="workspace-head">
      <div><h2>Diário</h2><p>Histórico pessoal de ajustes e atividades, com autoria registrada pela sessão autenticada.</p></div>
      <span className="counter">{counts.adjustments ?? adjustments.length} ajustes · {counts.tasks ?? taskRows.length} tarefas</span>
    </div>

    <div className="filter-tabs">
      <button type="button" className={tab === "ajustes" ? "active" : ""} onClick={() => setTab("ajustes")}>Diário de Ajustes</button>
      <button type="button" className={tab === "tasklog" ? "active" : ""} onClick={() => setTab("tasklog")}>TaskLog</button>
    </div>

    {canViewAll && <div className="filter-tabs" style={{ marginTop: 10 }} aria-label="Escopo do Diário">
      <button type="button" className={scope === "mine" ? "active" : ""} onClick={() => setScope("mine")}>Meus registros</button>
      <button type="button" className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>Todos os registros</button>
    </div>}

    {scope === "all" && canViewAll && <section className="card section" style={{ marginTop: 12 }}>
      <div className="section-title">Filtros administrativos</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <select className="control" value={filters.author_user_id} onChange={(e) => updateFilter("author_user_id", e.target.value)}><option value="">Todos os colaboradores</option>{staff.map((item) => <option key={item.user_id} value={item.user_id}>{item.person}</option>)}<option value="UNKNOWN">Autor não identificado</option></select>
        <input className="control" type="date" value={filters.since} onChange={(e) => updateFilter("since", e.target.value)} title="Período: início" />
        <input className="control" type="date" value={filters.until} onChange={(e) => updateFilter("until", e.target.value)} title="Período: fim" />
        {tab === "ajustes" && <>
          <select className="control" value={filters.client_id} onChange={(e) => updateFilter("client_id", e.target.value)}><option value="">Todos os clientes</option>{clients.map((item) => <option key={item.client_id} value={item.client_id}>{item.display_name}</option>)}</select>
          <select className="control" value={filters.category_code} onChange={(e) => updateFilter("category_code", e.target.value)}><option value="">Todas as categorias</option>{categories.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select>
          <select className="control" value={filters.subcategory_code} onChange={(e) => updateFilter("subcategory_code", e.target.value)}><option value="">Todos os motivos</option>{filterSubcategories.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select>
          <select className="control" value={filters.responsible_area} onChange={(e) => updateFilter("responsible_area", e.target.value)}><option value="">Todas as áreas</option>{AREAS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
          <select className="control" value={filters.status} onChange={(e) => updateFilter("status", e.target.value)}><option value="">Todos os status</option>{STATUSES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}<option value="LEGACY_UNKNOWN">Legado — não identificado</option></select>
        </>}
        <button type="button" className="link-btn" onClick={() => setFilters({ author_user_id: "", client_id: "", category_code: "", subcategory_code: "", responsible_area: "", status: "", since: "", until: "" })}>Limpar filtros</button>
      </div>
    </section>}

    {loadError && <div className="error-box" style={{ marginTop: 12 }}>{loadError}</div>}
    {loading && <div className="empty">Carregando registros…</div>}

    {tab === "ajustes" && <>
      <section className="card section" style={{ marginTop: 16 }}>
        <div className="section-title" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>Novo ajuste</span>
          <button type="button" className="link-btn" aria-label="Como usar Novo ajuste" aria-expanded={helpOpen} title={helpText} onClick={() => setHelpOpen((value) => !value)} style={{ padding: "0 5px", minWidth: 24 }}>?</button>
        </div>
        {helpOpen && <div className="connection-note" style={{ marginBottom: 12 }}><b>Como usar o Diário de Ajustes</b><p>Registre correções, solicitações de alteração e retrabalhos. Informe o que precisou ser corrigido e por que aconteceu. Atividades normais pertencem ao TaskLog.</p><small><b>Correto:</b> Cliente pediu para trocar a imagem porque foi utilizado um render antigo.<br/><b>Não usar para:</b> Hoje alterei o criativo do cliente.</small></div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
          <label>Cliente *<select className="control" required value={adjClient} onChange={(e) => setAdjClient(e.target.value)}><option value="">Selecione o cliente…</option>{clients.map((item) => <option key={item.client_id} value={item.client_id}>{item.display_name}</option>)}</select></label>
          <label>Data do ajuste *<input className="control" type="datetime-local" required value={adjOccurredAt} onChange={(e) => setAdjOccurredAt(e.target.value)} /></label>
          <label>Categoria *<select className="control" required value={adjCategory} onChange={(e) => { setAdjCategory(e.target.value); setAdjSubcategory(""); }}><option value="">Selecione…</option>{categories.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
          <label>Motivo *<select className="control" required value={adjSubcategory} onChange={(e) => setAdjSubcategory(e.target.value)} disabled={!adjCategory}><option value="">Selecione…</option>{formSubcategories.map((item) => <option key={item.code} value={item.code}>{item.label}</option>)}</select></label>
          <label>Origem da solicitação *<select className="control" required value={adjOrigin} onChange={(e) => setAdjOrigin(e.target.value)}><option value="">Selecione…</option>{ORIGINS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        </div>
        <label style={{ display: "block", marginTop: 10 }}>O que precisou ser ajustado *<textarea className="control" style={{ width: "100%", minHeight: 72 }} value={adjDescription} onChange={(e) => setAdjDescription(e.target.value)} placeholder="Ex.: Foi necessário trocar a imagem principal do criativo." /></label>
        <label style={{ display: "block", marginTop: 10 }}>Por que precisou ser ajustado *<textarea className="control" style={{ width: "100%", minHeight: 72 }} value={adjReason} onChange={(e) => setAdjReason(e.target.value)} placeholder="Ex.: O render utilizado era antigo e não correspondia ao material oficial." /></label>
        <details style={{ marginTop: 10 }}><summary>Mais detalhes</summary><div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 10, marginTop: 10 }}>
          <label>Área relacionada<select className="control" value={adjArea} onChange={(e) => setAdjArea(e.target.value)}><option value="">Não informar</option>{AREAS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>Status<select className="control" value={adjStatus} onChange={(e) => setAdjStatus(e.target.value)}>{STATUSES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label>Gravidade<select className="control" value={adjSeverity} onChange={(e) => setAdjSeverity(e.target.value)}>{SEVERITIES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
          <label style={{ alignSelf: "end" }}><input type="checkbox" checked={adjRecurrent} onChange={(e) => setAdjRecurrent(e.target.checked)} /> Problema reincidente</label>
        </div>{adjStatus === "RESOLVED" && <label style={{ display: "block", marginTop: 10 }}>Solução aplicada *<textarea className="control" style={{ width: "100%", minHeight: 64 }} value={adjResolution} onChange={(e) => setAdjResolution(e.target.value)} placeholder="Ex.: Render substituído pelo material oficial atualizado." /></label>}</details>
        {adjError && <div className="error-box" style={{ marginTop: 8 }}>{adjError}</div>}
        <button type="button" className="primary" style={{ marginTop: 10 }} disabled={adjSaving} onClick={submitAdjustment}>{adjSaving ? "Salvando…" : "Registrar ajuste"}</button>
      </section>

      <section className="card section" style={{ marginTop: 16 }}>
        <div className="section-title">{scope === "all" ? "Registros da equipe" : "Meus últimos ajustes"}</div>
        {adjustments.map((entry) => {
          const legacy = entry.status === "LEGACY_UNKNOWN";
          const statusLabel = legacy ? "Legado — status não identificado" : labelOf(STATUSES, entry.status);
          return <div className="productivity-row" key={entry.id} style={{ alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <b>{text(entry.client_display_name || "Cliente não identificado")}</b>
              <small>{text(entry.category_label || "Categoria não identificada")} · {text(entry.subcategory_label || (legacy ? "Motivo não estruturado no registro legado" : "Motivo não identificado"))}</small>
              <p style={{ margin: "6px 0 0" }}><b>O que:</b> {text(entry.description)}</p>
              <p style={{ margin: "4px 0 0" }}><b>Por quê:</b> {entry.reason ? text(entry.reason) : "Não identificado no registro legado."}</p>
              {entry.resolution && <p style={{ margin: "4px 0 0" }}><b>Solução:</b> {text(entry.resolution)}</p>}
              <small style={{ display: "block", marginTop: 6 }}>Registrado por {text(entry.author_name || "Autor não identificado")} · ajuste em {formatDate(entry.occurred_at)}{entry.created_at ? ` · registrado em ${formatDate(entry.created_at)}` : " · data de registro indisponível (legado)"}</small>
              <small>{entry.request_origin ? `Origem: ${labelOf(ORIGINS, entry.request_origin)}` : "Origem não identificada (legado)"}{entry.responsible_area ? ` · Área: ${labelOf(AREAS, entry.responsible_area)}` : ""}</small>
              {editId === Number(entry.id) && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                <select className="control" value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>{STATUSES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
                <input className="control" value={editResolution} onChange={(e) => setEditResolution(e.target.value)} placeholder="Solução aplicada (se houver)" style={{ minWidth: 280 }} />
                <button type="button" className="primary" disabled={editBusy} onClick={updateAdjustment}>Salvar</button>
                <button type="button" className="link-btn" onClick={() => setEditId(null)}>Cancelar</button>
              </div>}
            </div>
            <div style={{ textAlign: "right" }}><strong>{statusLabel}</strong><small style={{ display: "block" }}>{entry.severity ? labelOf(SEVERITIES, entry.severity) : ""}</small>{editId !== Number(entry.id) && !legacy && <button type="button" className="link-btn" onClick={() => { setEditId(Number(entry.id)); setEditStatus(entry.status || "OPEN"); setEditResolution(entry.resolution || ""); }}>Atualizar status</button>}</div>
          </div>;
        })}
        {!loading && !adjustments.length && <div className="empty">Nenhum ajuste neste escopo.</div>}
      </section>
    </>}

    {tab === "tasklog" && <>
      <section className="card section" style={{ marginTop: 16 }}>
        <div className="section-title">Nova tarefa</div>
        <p className="small">Use o TaskLog para atividades normais executadas no dia a dia. Correções, erros e retrabalhos pertencem ao Diário de Ajustes.</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}><select className="control" value={taskCategory} onChange={(e) => setTaskCategory(e.target.value)}>{taskOptions.map((option) => <option key={option} value={option}>{option}</option>)}</select><input className="control" type="date" value={taskDate} onChange={(e) => setTaskDate(e.target.value)} /></div>
        <input className="control" style={{ width: "100%", marginTop: 10 }} value={taskName} onChange={(e) => setTaskName(e.target.value)} placeholder="Ex.: Publiquei a campanha do cliente no Meta Ads." />
        {taskError && <div className="error-box" style={{ marginTop: 8 }}>{taskError}</div>}
        <button type="button" className="primary" style={{ marginTop: 10 }} disabled={taskSaving} onClick={submitTask}>{taskSaving ? "Salvando…" : "Registrar tarefa"}</button>
      </section>
      <section className="card section" style={{ marginTop: 16 }}><div className="section-title">{scope === "all" ? "TaskLog da equipe" : "Meu TaskLog"}</div>{taskRows.map((entry) => <div className="productivity-row" key={entry.id}><div><b>{text(entry.task_name)}</b><small>{text(entry.category)} · {text(entry.collaborator_name)}</small></div><strong>{formatDate(entry.task_date)}</strong></div>)}{!loading && !taskRows.length && <div className="empty">Nenhuma tarefa neste escopo.</div>}</section>
    </>}
  </section>;
}
