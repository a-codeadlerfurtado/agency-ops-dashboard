"use client";

import { useEffect, useRef } from "react";
import { createClient } from "@supabase/supabase-js";

export const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
export const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-dashboard-api`;
export const CONTRACTS_API = `${SUPABASE_URL}/functions/v1/agency-ops-contracts-api`;
export const CLICKUP_API_URL = `${SUPABASE_URL}/functions/v1/clickup-sync-api`;
export const CS_CLIENTS_API = `${SUPABASE_URL}/functions/v1/agency-ops-cs-clients-api`;
export const WORK_ITEM_CREATE_API = `${SUPABASE_URL}/functions/v1/agency-ops-work-item-create-api`;
export const AI_API_BASE = "/api/ai";
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// O dashboard aceita a mesma conta em mais de um computador. Logout sem escopo
// encerra somente esta sessao/browser, sem revogar as demais sessoes da conta.
const rawSignOut = supabase.auth.signOut.bind(supabase.auth);
supabase.auth.signOut = ((options?: Parameters<typeof rawSignOut>[0]) => rawSignOut(options ?? { scope: "local" })) as typeof supabase.auth.signOut;

export type Row = Record<string, any>;
export type TeamMember = {
  person: string;
  role: "GT" | "CS" | "DESIGN" | "AI" | "MGMT" | "UNASSIGNED" | "FORMER";
  in_roster: boolean;
  is_former: boolean;
  former_reason: string | null;
  clickup_user: string | null;
  carteira: string | null;
  missing_clickup_link: boolean;
  clients_active: number;
  clients_onboarding: number;
  tasks_done: number;
  tasks_open: number;
  tasks_overdue: number;
  tasks_done_30d: number;
  clients_touched: number;
  tasks_created_total: number;
  tasks_created_30d: number;
  portfolio: Array<{
    client_id: string;
    display_name: string;
    priority: "ATTENTION" | "FOLLOW_UP" | "OK" | "DATA_INCOMPLETE" | "UNDETERMINED" | null;
    lifecycle: "ACTIVE" | "ONBOARDING";
    next_step: string | null;
  }>;
};

export type HomeData = {
  kpis: Row;
  clients: Row[];
  alerts: Row[];
  commitments?: Row[];
  conversations?: Row[];
  media: Row;
  health: Row;
  operations?: Row;
  clickup?: Row;
  campaigns?: Row[];
  notifications?: Row[];
  preclients?: Row[];
  won_events?: Row[];
  audit_runs?: Row[];
  audit_issues?: Row[];
  preferences?: Row;
  integration_health?: Row[];
  team?: TeamMember[];
  unassigned_clients?: Row[];
  portfolio?: Row | null;
  wallets?: Row[];
  adjustments?: Row[];
  stage_labels?: Record<string, string>;
  profile?: Row;
  access_requests_pending?: Row[];
  generated_at: string;
};

export type View = "overview" | "focus" | "work" | "clients" | "health" | "onboarding" | "campaigns" | "contracts" | "preclients" | "conversations" | "team" | "diary" | "clickup" | "evidence" | "audit" | "alerts" | "opsperf" | "creative";

export const pt: Record<string,string> = { ATTENTION:"Atenção",FOLLOW_UP:"Acompanhamento",UNDETERMINED:"Indeterminado",DATA_INCOMPLETE:"Dados incompletos",OK:"OK",ACTIVE:"Ativo",ONBOARDING:"Onboarding",CHURNED:"Churned",COMPLETE:"Completa",PARTIAL:"Parcial",INCOMPLETE:"Incompleta",SUCCESS:"Sucesso",ERROR:"Erro",RUNNING:"Em execução",OPEN:"Aberto",IN_PROGRESS:"Em andamento",WAITING:"Aguardando",SNOOZED:"Adiado",COMPLETED:"Concluído",DISMISSED:"Descartado",ABORTED:"Encerrado",CRITICAL:"Crítico",HIGH:"Alto",MEDIUM:"Médio",LOW:"Baixo",CONNECTED:"Conectado",CONECTADO:"Conectado",ESCALATION:"Escalonamento",CREATIVE_REQUEST:"Solicitação criativa",TECHNICAL:"Problema técnico",CLIENT_FOLLOWUP:"Acompanhamento",CLICKUP:"ClickUp",FINANCE:"Financeiro",GENERAL:"Geral" };

export const priorityRank: Record<string, number> = {
  ATTENTION: 0,
  FOLLOW_UP: 1,
  UNDETERMINED: 2,
  DATA_INCOMPLETE: 3,
  OK: 4,
};

export function formatNumber(value: unknown, digits = 1) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(value || 0));
}

export function formatMoney(value: unknown) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export function BrandMark() {
  return <svg viewBox="0 0 276 390" role="img" aria-label="Leonardo Imobi" fill="none">
    <rect x="6.5" y="6.5" width="263" height="252" stroke="currentColor" strokeWidth="13" />
    <rect x="0" y="252" width="13" height="138" fill="currentColor" />
    <polygon points="68,223 276,247 276,253 68,253" fill="currentColor" />
    <polygon points="0,377 208,343 208,390 0,390" fill="currentColor" />
  </svg>;
}

export function formatDay(value: unknown) {
  if (!value) return "—";
  const raw = String(value).slice(0, 10);
  const [y, m, d] = raw.split("-").map(Number);
  if (!y || !m || !d) return raw;
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(y, m - 1, d));
}

export function formatDate(value: unknown) {
  if (!value) return "sem registro";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(value)));
}

export function relativeDate(value: unknown) {
  if (!value) return "sem prazo";
  const days = Math.ceil((new Date(String(value)).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d atrasado`;
  if (days === 0) return "vence hoje";
  return `em ${days}d`;
}

export function daysSince(value: unknown) {
  if (!value) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(String(value)).getTime()) / 86_400_000));
}

export function healthScore(client: Row) {
  if (client.health?.score != null) return Math.round(Number(client.health.score));
  let score = 100;
  if (client.priority === "ATTENTION") score -= 42;
  if (client.priority === "FOLLOW_UP") score -= 22;
  if (["DATA_INCOMPLETE", "UNDETERMINED"].includes(client.priority)) score -= 16;
  score -= Math.min(24, Number(client.overdue_commitments || 0) * 8);
  score -= Math.min(18, Number(client.open_complaints || 0) * 9);
  if (client.data_coverage !== "COMPLETE") score -= 10;
  return Math.max(0, score);
}

export function useDialogFocus(close: () => void) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((element) => element.offsetParent !== null);
    focusables()[0]?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.stopPropagation(); close(); return; }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, [close]);
  return ref;
}

export const MARCADOR_INTERNO = /^\s*\[?\s*(sem texto reconhecido|ver raw_json|raw_json|sem conte[uú]do|sem texto|null|undefined)\b/i;
export function text(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  const raw = String(value).trim();
  if (MARCADOR_INTERNO.test(raw)) return "Sem assunto identificado";
  return raw;
}

export function initials(value: unknown) {
  return String(value || "CO").trim().split(/\s+/).map((part) => part[0]).slice(0,2).join("").toUpperCase();
}

// Uma pagina do dashboard monta varios consumidores do mesmo payload home. A camada
// abaixo impede que uma resposta 401 de uma requisicao atrasada derrube uma sessao
// que ja foi renovada por outra requisicao concorrente.
let accessTokenPromise: Promise<string | null> | null = null;
let refreshSessionPromise: Promise<string | null> | null = null;

export class SessionExpiredError extends Error {
  code = "SESSION_EXPIRED";
  constructor() { super("Sessão encerrada. Entre novamente para continuar."); this.name = "SessionExpiredError"; }
}

export function isSessionExpiredError(error: unknown): error is SessionExpiredError {
  return error instanceof SessionExpiredError || (error instanceof Error && (error as any).code === "SESSION_EXPIRED");
}

async function liveAccessToken(): Promise<string | null> {
  if (!accessTokenPromise) {
    accessTokenPromise = supabase.auth.getSession()
      .then(({ data, error }) => error ? null : (data.session?.access_token ?? null))
      .finally(() => { accessTokenPromise = null; });
  }
  return accessTokenPromise;
}

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshSessionPromise) {
    refreshSessionPromise = (async () => {
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session?.access_token) return null;
      return data.session.access_token;
    })().finally(() => { refreshSessionPromise = null; });
  }
  return refreshSessionPromise;
}

function authHeaders(init: RequestInit, token: string) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("apikey", SUPABASE_ANON_KEY);
  return headers;
}

export async function authenticatedFetch(input: RequestInfo | URL, init: RequestInit = {}, tokenHint?: string | null): Promise<Response> {
  const initialToken = tokenHint || await liveAccessToken();
  if (!initialToken) throw new SessionExpiredError();

  const attempted = new Set<string>();
  const request = async (token: string | null): Promise<Response | null> => {
    if (!token || attempted.has(token)) return null;
    attempted.add(token);
    return fetch(input, { ...init, headers: authHeaders(init, token) });
  };

  let lastResponse = await request(initialToken);
  if (lastResponse && lastResponse.status !== 401) return lastResponse;

  // Se outro consumidor ja renovou a sessao enquanto esta requisicao estava no ar,
  // usa o token novo antes de tentar qualquer refresh adicional.
  const liveToken = await liveAccessToken();
  const liveResponse = await request(liveToken);
  if (liveResponse) {
    lastResponse = liveResponse;
    if (liveResponse.status !== 401) return liveResponse;
  }

  const refreshedToken = await refreshAccessToken();
  const refreshedResponse = await request(refreshedToken);
  if (refreshedResponse) {
    lastResponse = refreshedResponse;
    if (refreshedResponse.status !== 401) return refreshedResponse;
  }

  // Uma segunda leitura cobre o caso em que um refresh paralelo terminou depois do
  // nosso refresh. O ponto crucial: um 401 isolado NAO executa signOut automaticamente.
  const finalLiveToken = await liveAccessToken();
  const finalResponse = await request(finalLiveToken);
  if (finalResponse) {
    lastResponse = finalResponse;
    if (finalResponse.status !== 401) return finalResponse;
  }

  if (lastResponse) return lastResponse;
  throw new SessionExpiredError();
}

async function executeApi(view: string, token: string, params: Record<string, string>) {
  const url = new URL(API_URL);
  url.searchParams.set("view", view);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await authenticatedFetch(url, { cache: "no-store" }, token);
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
  const json = await response.json();

  if (view === "home" && json?.profile?.role === "CS") {
    try {
      const clientResponse = await authenticatedFetch(CS_CLIENTS_API, { cache: "no-store" }, token);
      if (clientResponse.ok) {
        const extra = await clientResponse.json();
        if (Array.isArray(extra?.clients)) {
          const currentById = new Map<string, Row>((json.clients || []).map((client: Row) => [String(client.client_id), client] as [string, Row]));
          json.clients = extra.clients.map((client: Row) => ({ ...client, ...(currentById.get(String(client.client_id)) || {}) }));
        }
      }
    } catch {
      // O enriquecimento de CS e complementar e nunca derruba o home.
    }
  }

  if (view === "home" && json?.profile?.role === "GT") {
    const walletIds = new Set((json.clients || []).map((client: Row) => String(client.client_id)).filter(Boolean));
    json.notifications = (json.notifications || []).filter((item: Row) => item?.client_id && walletIds.has(String(item.client_id)));
  }

  return json;
}

export async function api(view: string, token: string, params: Record<string, string> = {}) {
  return executeApi(view, token, params);
}

export async function apiPost(view: string, token: string, body: Row = {}) {
  const endpoint = view === "work-item-create"
    ? WORK_ITEM_CREATE_API
    : `${API_URL}?view=${encodeURIComponent(view)}`;
  const response = await authenticatedFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, token);
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
  return response.json();
}

export async function clickupAction(action: "register" | "sync", _token: string) {
  if (action === "register") {
    const response = await authenticatedFetch(`${CLICKUP_API_URL}?action=register`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || body.error || `ClickUp ${response.status}`);
    return body;
  }
  let pageStart = 0;
  const totals = { tasks_seen: 0, tasks_upserted: 0, tasks_closed: 0 };
  for (let batch = 0; batch < 100; batch++) {
    const response = await authenticatedFetch(`${CLICKUP_API_URL}?action=sync&since_days=180&page_start=${pageStart}&max_pages=5`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || body.error || `ClickUp ${response.status}`);
    totals.tasks_seen += Number(body.tasks_seen || 0);
    totals.tasks_upserted += Number(body.tasks_upserted || 0);
    totals.tasks_closed += Number(body.tasks_closed || 0);
    if (body.next_page == null) return { ...body, ...totals };
    pageStart = Number(body.next_page);
  }
  throw new Error("A importação atingiu o limite de páginas; tente novamente para continuar.");
}

export function Chip({ value }: { value: unknown }) {
  const raw = text(value);
  return <span className={`chip ${raw}`}>{pt[raw] || raw.replaceAll("_", " ")}</span>;
}

export function Metric({ label, value, tone = "", hint = "", loading = false }: { label: string; value: string; tone?: string; hint?: string; loading?: boolean }) {
  return (
    <article className="card metric" aria-busy={loading || undefined}>
      <div className="label">{label}</div>
      {loading
        ? <div className="value"><span className="skeleton skeleton-value" /></div>
        : <div className={`value ${tone}`}>{value}</div>}
      <div className="hint">{loading ? <span className="skeleton skeleton-line" /> : hint}</div>
    </article>
  );
}

const MARCA_RESPONSAVEL = " · Responsável pela task: ";
export function taskCompletion(item: Row) {
  const description = String(item?.description ?? "");
  const cut = description.indexOf(MARCA_RESPONSAVEL);
  if (cut < 0) return null;
  return {
    tarefa: description.slice(0, cut).trim(),
    responsavel: description.slice(cut + MARCA_RESPONSAVEL.length).trim() || null,
    concluidaPor: item?.actor ? String(item.actor) : null,
  };
}
