"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  Chip,
  api,
  apiPost,
  daysSince,
  formatDate,
  formatMoney,
  formatNumber,
  healthScore,
  relativeDate,
  supabase,
  text,
} from "./shared";
import type { HomeData, Row } from "./shared";

const INTEGRATION_HEALTH_URL = `${SUPABASE_URL}/functions/v1/agency-ops-integration-health`;

const VIEW_LABELS: Record<string, string> = {
  overview: "Visão geral",
  focus: "Foco do dia",
  work: "Central de Trabalho",
  clients: "Clientes",
  creative: "Central Criativa",
  health: "Saúde",
  onboarding: "Onboarding",
  campaigns: "Campanhas",
  preclients: "Pré-clientes",
  conversations: "Conversas",
  team: "Equipe",
  diary: "Diário",
  clickup: "ClickUp",
  evidence: "Evidências",
  audit: "Auditoria",
  alerts: "Alertas",
  opsperf: "Desempenho OP",
  contracts: "Contratos",
};

const LABEL_TO_VIEW = Object.fromEntries(Object.entries(VIEW_LABELS).map(([key, value]) => [value, key]));
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

type Integration = {
  source_key: string;
  source_label: string;
  status: "OK" | "DELAY" | "FAIL";
  last_event_at: string | null;
  lag_minutes?: number | string | null;
  detail?: string;
};

type IntegrationPayload = {
  integrations?: Integration[];
  generated_at?: string;
};

type SearchItem = {
  key: string;
  kind: string;
  label: string;
  detail: string;
  clientId?: string | null;
  url?: string | null;
  view?: string | null;
  chip?: string | null;
};

type CockpitItem = {
  key: string;
  title: string;
  detail: string;
  chip: string;
  clientId?: string | null;
  view?: string | null;
  ageHours?: number | null;
};

function hoursSince(value: unknown) {
  if (!value) return null;
  const ms = Date.now() - new Date(String(value)).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, ms / 3600000);
}

function ageLabel(hours: number | null | undefined) {
  if (hours == null) return "sem data";
  if (hours < 1) return "há menos de 1h";
  if (hours < 24) return `há ${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  return `há ${days} ${days === 1 ? "dia" : "dias"}`;
}

function sameDay(value: unknown) {
  if (!value) return false;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return false;
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  return fmt(date) === fmt(new Date());
}

function usePortalSlot(id: string, selector: string, position: "before" | "after", enabled: boolean) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) {
      document.getElementById(id)?.remove();
      setSlot(null);
      return;
    }
    let active = true;
    const mount = () => {
      if (!active) return;
      const existing = document.getElementById(id) as HTMLElement | null;
      if (existing) { setSlot(existing); return; }
      const anchor = document.querySelector(selector);
      if (!anchor?.parentElement) return;
      const node = document.createElement("div");
      node.id = id;
      node.className = "ops-enhancement-slot";
      if (position === "before") anchor.parentElement.insertBefore(node, anchor);
      else anchor.parentElement.insertBefore(node, anchor.nextSibling);
      setSlot(node);
    };
    mount();
    const observer = new MutationObserver(mount);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(mount, 700);
    return () => {
      active = false;
      observer.disconnect();
      window.clearInterval(timer);
      document.getElementById(id)?.remove();
      setSlot(null);
    };
  }, [id, selector, position, enabled]);
  return slot;
}

function activeViewFromDom() {
  const active = document.querySelector(".side-nav-items button.active") as HTMLButtonElement | null;
  const label = active?.title || active?.textContent?.trim() || "";
  return LABEL_TO_VIEW[label] || "overview";
}

function navigateTo(view: string) {
  const label = VIEW_LABELS[view];
  if (!label) return;
  const buttons = Array.from(document.querySelectorAll(".side-nav-items button")) as HTMLButtonElement[];
  buttons.find((button) => button.title === label || button.textContent?.trim().startsWith(label))?.click();
}

function roleName(role: string) {
  return ({ GT: "Gestor de Tráfego", CS: "Customer Success", DESIGN: "Design", AI: "IA e Automação", MGMT: "Operações" } as Record<string, string>)[role] || "Operação";
}

function roleHeadline(role: string) {
  if (role === "GT") return "Mídia, saldo, performance e carteira primeiro.";
  if (role === "CS") return "Relacionamento, respostas, saúde e onboarding primeiro.";
  if (role === "DESIGN") return "Entregas, ajustes e tarefas de design primeiro.";
  if (role === "AI") return "Integrações, automações e falhas de dados primeiro.";
  return "Risco, gargalo e execução da operação inteira primeiro.";
}

function median(values: number[]) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function campaignSignals(campaigns: Row[]) {
  const cplMedian = median(campaigns.map((row) => Number(row.cpl)).filter((value) => value > 0));
  const signals: Array<Row & { signal: string; severity: string; explanation: string }> = [];
  campaigns.forEach((row) => {
    const spend = Number(row.spend || 0);
    const leads = Number(row.leads || 0);
    const ctr = row.ctr == null ? null : Number(row.ctr);
    const cpl = row.cpl == null ? null : Number(row.cpl);
    if (row.is_stale) signals.push({ ...row, signal: "Dados desatualizados", severity: "HIGH", explanation: "A carga de mídia não está fresca; evite otimização com base nesses números." });
    else if (spend > 0 && leads === 0) signals.push({ ...row, signal: "Investimento sem lead", severity: "CRITICAL", explanation: "Há investimento registrado e nenhum lead na referência atual." });
    else if (ctr != null && ctr < 0.8) signals.push({ ...row, signal: "CTR baixo", severity: "HIGH", explanation: "CTR abaixo de 0,8% na referência atual; vale revisar criativo, oferta e aderência do público." });
    else if (cpl != null && cplMedian != null && cpl > cplMedian * 1.5) signals.push({ ...row, signal: "CPL acima da carteira", severity: "MEDIUM", explanation: `CPL está mais de 50% acima da mediana atual da carteira (${formatMoney(cplMedian)}).` });
    else if (spend === 0) signals.push({ ...row, signal: "Sem entrega registrada", severity: "MEDIUM", explanation: "A referência atual não registra investimento; confirme status e veiculação." });
  });
  return signals.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}

function SidebarEnhancer({ data, work }: { data: HomeData | null; work: Row }) {
  useEffect(() => {
    const apply = () => {
      const container = document.querySelector(".side-nav-items");
      if (!container) return;
      container.querySelectorAll(".ops-nav-group-label").forEach((node) => node.remove());
      container.querySelectorAll(".ops-nav-badge").forEach((node) => node.remove());
      const children = Array.from(container.children) as HTMLElement[];
      const starts: Record<string, string> = {
        "Visão geral": "OPERAÇÃO",
        "Clientes": "CLIENTES",
        "Central Criativa": "MÍDIA",
        "Equipe": "GESTÃO",
        "ClickUp": "SISTEMA",
      };
      children.forEach((child) => {
        const label = child.getAttribute("title") || child.textContent?.trim() || "";
        const group = starts[label];
        if (group) {
          const marker = document.createElement("div");
          marker.className = "ops-nav-group-label";
          marker.textContent = group;
          container.insertBefore(marker, child);
        }
      });
      const counts: Record<string, number> = {
        Alertas: (data?.alerts || []).length,
        Onboarding: (data?.clients || []).filter((client) => client.lifecycle === "ONBOARDING" || client.onboarding_status === "OPEN").length,
        "Central de Trabalho": Number(work?.summary?.open || 0),
      };
      Array.from(container.querySelectorAll("button")).forEach((button) => {
        const element = button as HTMLButtonElement;
        const label = element.title || element.textContent?.trim() || "";
        const count = counts[label] || 0;
        if (!count) return;
        const badge = document.createElement("span");
        badge.className = "ops-nav-badge";
        badge.textContent = String(count > 99 ? "99+" : count);
        element.appendChild(badge);
      });
    };
    apply();
    const observer = new MutationObserver(() => window.requestAnimationFrame(apply));
    const nav = document.querySelector(".side-nav-items");
    if (nav) observer.observe(nav, { childList: true, subtree: false });
    const timer = window.setInterval(apply, 2500);
    return () => { observer.disconnect(); window.clearInterval(timer); };
  }, [data, work]);
  return null;
}

function OperationalCockpit({ data, work, integrations, openClient }: { data: HomeData; work: Row; integrations: Integration[]; openClient: (id: string) => void }) {
  const role = String(data.profile?.role || "MGMT").toUpperCase();
  const clients = data.clients || [];
  const alerts = data.alerts || [];
  const commitments = data.commitments || [];
  const conversations = data.conversations || [];
  const campaigns = data.campaigns || [];
  const signals = campaignSignals(campaigns);
  const now = Date.now();
  const criticalAlerts: CockpitItem[] = alerts.filter((alert) => ["CRITICAL", "HIGH"].includes(String(alert.severity))).map((alert) => ({
    key: `alert-${alert.id}`, title: text(alert.title), detail: text(alert.description), chip: String(alert.severity || "HIGH"), clientId: alert.client_id, view: "alerts", ageHours: hoursSince(alert.first_detected_at || alert.last_detected_at),
  }));
  const overdue: CockpitItem[] = commitments.filter((item) => item.due_at && new Date(item.due_at).getTime() < now).map((item) => ({
    key: `commit-${item.id}`, title: text(item.title || item.description || "Compromisso vencido"), detail: `Prazo vencido · ${text(item.owner || "sem responsável")}`, chip: "ATRASADO", clientId: item.client_id, view: "work", ageHours: hoursSince(item.due_at),
  }));
  const waiting: CockpitItem[] = conversations.filter((row) => row.waiting_for_agency || row.conversation_status === "WAITING_AGENCY").map((row) => ({
    key: `conversation-${row.chat_id}`, title: text(row.open_question || row.last_summary || "Cliente aguardando resposta"), detail: "Cliente esperando a agência", chip: String(row.sla_level || "RESPONDER"), clientId: row.client_id, view: "conversations", ageHours: hoursSince(row.waiting_since || row.last_client_message_at),
  }));
  const mediaItems: CockpitItem[] = signals.slice(0, 10).map((row) => ({
    key: `media-${row.client_id}-${row.account_key}-${row.signal}`, title: `${text(row.display_name || row.account_key)} · ${row.signal}`, detail: row.explanation, chip: row.severity, clientId: row.client_id, view: "campaigns", ageHours: null,
  }));
  let urgent = [...criticalAlerts, ...overdue, ...waiting.filter((item) => (item.ageHours || 0) >= 4), ...mediaItems.filter((item) => item.chip === "CRITICAL")];
  if (role === "GT") urgent = [...mediaItems, ...criticalAlerts, ...overdue, ...waiting].slice(0, 16);
  else if (role === "CS") urgent = [...waiting, ...criticalAlerts, ...overdue, ...mediaItems].slice(0, 16);
  else if (role === "AI") urgent = [...criticalAlerts, ...mediaItems, ...overdue, ...waiting].slice(0, 16);
  else urgent = urgent.sort((a, b) => (SEVERITY_RANK[a.chip] ?? 4) - (SEVERITY_RANK[b.chip] ?? 4)).slice(0, 16);

  const attention = clients.filter((client) => ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(String(client.priority))).slice(0, 14).map((client) => ({
    key: `client-${client.client_id}`, title: text(client.display_name), detail: text(client.next_step || client.current_subject || "Requer acompanhamento"), chip: String(client.priority || "FOLLOW_UP"), clientId: String(client.client_id), ageHours: hoursSince(client.last_activity_at),
  }));
  const todayWork: CockpitItem[] = [
    ...commitments.filter((item) => sameDay(item.due_at)).map((item) => ({ key: `today-commit-${item.id}`, title: text(item.title || item.description), detail: `Compromisso de hoje · ${text(item.owner)}`, chip: "HOJE", clientId: item.client_id, view: "work" })),
    ...((work.items || []) as Row[]).filter((item) => sameDay(item.due_at) && !["COMPLETED", "DISMISSED"].includes(String(item.status))).map((item) => ({ key: `today-work-${item.id}`, title: text(item.title), detail: `${text(item.target_person || item.target_role)} · ${text(item.status)}`, chip: "HOJE", clientId: item.client_id, view: "work" })),
  ];
  const stable = clients.filter((client) => client.priority === "OK").length;
  const integrationProblems = integrations.filter((item) => item.status !== "OK");

  const bucket = (title: string, subtitle: string, items: CockpitItem[], tone: string, empty: string) => (
    <section className={`ops-cockpit-lane ${tone}`}>
      <div className="ops-cockpit-lane-head"><div><b>{title}</b><small>{subtitle}</small></div><strong>{items.length}</strong></div>
      <div className="ops-cockpit-items">
        {items.slice(0, 7).map((item) => <button key={item.key} onClick={() => item.clientId ? openClient(String(item.clientId)) : item.view ? navigateTo(item.view) : undefined}>
          <span><b>{item.title}</b><small>{item.detail}{item.ageHours != null ? ` · ${ageLabel(item.ageHours)}` : ""}</small></span><Chip value={item.chip} />
        </button>)}
        {!items.length && <div className="ops-cockpit-empty">{empty}</div>}
      </div>
    </section>
  );

  return <section className="ops-cockpit card">
    <div className="ops-cockpit-head"><div><span className="eyebrow">Cockpit operacional · {roleName(role)}</span><h2>O que precisa acontecer agora</h2><p>{roleHeadline(role)}</p></div><div className="ops-cockpit-summary"><span><b>{urgent.length}</b> urgentes</span><span><b>{attention.length}</b> atenção</span><span><b>{todayWork.length}</b> hoje</span><span className="ok"><b>{stable}</b> estáveis</span></div></div>
    <div className="ops-cockpit-grid">
      {bucket("URGENTE HOJE", "Risco, atraso ou resposta necessária", urgent, "danger", "Nenhuma urgência detectada.")}
      {bucket("PRECISA DE ATENÇÃO", "Acompanhamentos da carteira", attention, "warn", "Nenhum acompanhamento pendente.")}
      {bucket("OPERAÇÃO HOJE", "Prazos e entregas de hoje", todayWork, "info", "Nenhum prazo registrado para hoje.")}
      <section className="ops-cockpit-lane success"><div className="ops-cockpit-lane-head"><div><b>ESTÁ TUDO BEM</b><small>Operação sem sinal crítico</small></div><strong>{stable}</strong></div><div className="ops-stable"><b>{stable} clientes em estado OK</b><small>{integrationProblems.length ? `${integrationProblems.length} integração(ões) ainda exigem atenção.` : "Fontes monitoradas sem falha crítica detectada."}</small><button onClick={() => navigateTo("clients")}>Abrir carteira</button></div></section>
    </div>
  </section>;
}

function CampaignMonitor({ campaigns, openClient }: { campaigns: Row[]; openClient: (id: string) => void }) {
  const signals = useMemo(() => campaignSignals(campaigns), [campaigns]);
  const critical = signals.filter((row) => row.severity === "CRITICAL").length;
  const high = signals.filter((row) => row.severity === "HIGH").length;
  return <section className="ops-monitor card">
    <div className="ops-monitor-head"><div><span className="eyebrow">Monitor inteligente</span><h3>Anomalias de campanha</h3><p>Leitura automática da referência disponível. Comparações de CPL usam a mediana atual da própria carteira, não uma meta inventada.</p></div><span className="counter">{signals.length} sinais · {critical} críticos · {high} altos</span></div>
    <div className="ops-monitor-list">{signals.slice(0, 12).map((row) => <button key={`${row.client_id}-${row.account_key}-${row.signal}`} onClick={() => row.client_id && openClient(String(row.client_id))}><Chip value={row.severity} /><span><b>{text(row.display_name || row.account_key)} · {row.signal}</b><small>{row.explanation}</small></span><span className="ops-monitor-metrics">{row.cpl != null ? `CPL ${formatMoney(row.cpl)}` : ""}{row.ctr != null ? ` · CTR ${formatNumber(row.ctr)}%` : ""}</span></button>)}{!signals.length && <div className="ops-cockpit-empty">Nenhuma anomalia automática detectada na referência atual.</div>}</div>
  </section>;
}

function SlaWatch({ data, work, mode, openClient }: { data: HomeData; work: Row; mode: "work" | "onboarding"; openClient: (id: string) => void }) {
  const now = Date.now();
  const rows: CockpitItem[] = mode === "work"
    ? ((work.items || []) as Row[]).filter((item) => !["COMPLETED", "DISMISSED"].includes(String(item.status))).map((item) => {
        const due = item.due_at ? new Date(item.due_at).getTime() : null;
        const late = due != null && due < now;
        return { key: `sla-work-${item.id}`, title: text(item.title), detail: `${text(item.target_person || item.target_role)} · ${item.due_at ? `prazo ${formatDate(item.due_at)}` : "sem prazo"}`, chip: late ? "SLA ROMPIDO" : item.due_at ? "NO PRAZO" : "SEM PRAZO", clientId: item.client_id, ageHours: hoursSince(item.created_at) };
      }).sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0)).slice(0, 10)
    : (data.clients || []).filter((client) => client.lifecycle === "ONBOARDING" || client.onboarding_status === "OPEN").map((client) => {
        const inactivity = daysSince(client.last_activity_at);
        return { key: `sla-onboarding-${client.client_id}`, title: text(client.display_name), detail: `${text(client.onboarding_stage || "Onboarding")} · ${text(client.onboarding_next_action || client.next_step)}`, chip: inactivity != null && inactivity > 3 ? "SLA ROMPIDO" : inactivity != null && inactivity >= 2 ? "ATENÇÃO" : "NO PRAZO", clientId: client.client_id, ageHours: inactivity == null ? null : inactivity * 24 };
      }).sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0)).slice(0, 10);
  const broken = rows.filter((row) => row.chip === "SLA ROMPIDO").length;
  return <section className="ops-sla card"><div className="ops-monitor-head"><div><span className="eyebrow">SLA e idade da pendência</span><h3>{mode === "work" ? "Fila por tempo em aberto" : "Onboardings por tempo sem atividade"}</h3></div><span className={`counter${broken ? " danger" : ""}`}>{broken} SLA rompido(s)</span></div><div className="ops-sla-list">{rows.map((row) => <button key={row.key} onClick={() => row.clientId && openClient(String(row.clientId))}><span className={`ops-age ${row.chip === "SLA ROMPIDO" ? "late" : ""}`}>{ageLabel(row.ageHours)}</span><span><b>{row.title}</b><small>{row.detail}</small></span><Chip value={row.chip}/></button>)}{!rows.length && <div className="ops-cockpit-empty">Nenhuma pendência neste escopo.</div>}</div></section>;
}

function incidentKey(alert: Row) {
  const type = String(alert.alert_type || alert.title || "alert").trim().toLowerCase().replace(/\s+/g, "-");
  return `${alert.client_id || "global"}:${type}`;
}

function IncidentCenter({ data, work, token, openClient, reloadWork }: { data: HomeData; work: Row; token: string; openClient: (id: string) => void; reloadWork: () => Promise<void> }) {
  const clients = data.clients || [];
  const clientById = new Map(clients.map((client) => [String(client.client_id), client]));
  const groups = useMemo(() => {
    const map = new Map<string, Row[]>();
    (data.alerts || []).forEach((alert) => map.set(incidentKey(alert), [...(map.get(incidentKey(alert)) || []), alert]));
    return [...map.entries()].map(([key, alerts]) => {
      const sorted = [...alerts].sort((a, b) => (SEVERITY_RANK[String(a.severity)] ?? 9) - (SEVERITY_RANK[String(b.severity)] ?? 9));
      const first = sorted.reduce((best, alert) => !best || new Date(alert.first_detected_at || alert.created_at || 0) < new Date(best.first_detected_at || best.created_at || 0) ? alert : best, null as Row | null) || sorted[0];
      const last = sorted.reduce((best, alert) => !best || new Date(alert.last_detected_at || alert.updated_at || 0) > new Date(best.last_detected_at || best.updated_at || 0) ? alert : best, null as Row | null) || sorted[0];
      return { key, alerts: sorted, head: sorted[0], first, last };
    }).sort((a, b) => (SEVERITY_RANK[String(a.head.severity)] ?? 9) - (SEVERITY_RANK[String(b.head.severity)] ?? 9));
  }, [data.alerts]);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<Record<string, string>>({});
  const workItems: Row[] = work.items || [];

  const relatedWork = (group: { alerts: Row[] }) => workItems.find((item) => {
    const ids = new Set(group.alerts.map((a) => String(a.id)));
    return ids.has(String(item.source_id || "")) || ids.has(String(item.metadata?.alert_id || "")) || (Array.isArray(item.metadata?.alert_ids) && item.metadata.alert_ids.some((id: unknown) => ids.has(String(id))));
  });
  const status = (group: { alerts: Row[] }) => {
    const item = relatedWork(group);
    if (!item) return "NOVO";
    if (["COMPLETED", "DISMISSED"].includes(String(item.status))) return "RESOLVIDO";
    return "EM TRATAMENTO";
  };

  async function ensureWork(group: any, targetRole?: string, targetPerson?: string) {
    const existing = relatedWork(group);
    if (existing) return existing;
    const alert = group.head;
    const client = clientById.get(String(alert.client_id));
    const created = await apiPost("work-item-create", token, {
      client_id: alert.client_id || null,
      type: "ESCALATION",
      priority: ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(String(alert.severity)) ? alert.severity : "MEDIUM",
      title: `Incidente: ${text(alert.title)}`,
      description: `${text(alert.description)}\n\nOcorrências agrupadas: ${group.alerts.length}. Primeiro sinal: ${text(group.first.first_detected_at || group.first.created_at)}.`,
      source: "operational_alert",
      source_id: String(alert.id),
      target_role: targetRole || data.profile?.role || "MGMT",
      target_person: targetPerson || data.profile?.person || null,
      metadata: { alert_id: alert.id, alert_ids: group.alerts.map((item: Row) => item.id), incident_key: group.key, client_name: client?.display_name || null },
    });
    return created.item;
  }

  async function act(group: any, action: "START" | "RESOLVE" | "SNOOZE" | "FALSE" | "CS") {
    setBusy(`${group.key}:${action}`); setMessage((current) => ({ ...current, [group.key]: "" }));
    try {
      const client = clientById.get(String(group.head.client_id));
      const item = await ensureWork(group, action === "CS" ? "CS" : undefined, action === "CS" ? client?.cs_owner : undefined);
      if (action !== "CS") {
        await apiPost("work-item-update", token, {
          id: item.id,
          status: action === "START" ? "IN_PROGRESS" : action === "RESOLVE" ? "COMPLETED" : action === "SNOOZE" ? "SNOOZED" : "DISMISSED",
          resolution: action === "RESOLVE" ? "Incidente resolvido pela Central de Incidentes." : action === "FALSE" ? "Incidente marcado como falso alerta." : action === "SNOOZE" ? "Incidente adiado por 24 horas." : "Tratamento iniciado pela Central de Incidentes.",
          snoozed_until: action === "SNOOZE" ? new Date(Date.now() + 86400000).toISOString() : undefined,
        });
      }
      setMessage((current) => ({ ...current, [group.key]: action === "CS" ? `Delegado para ${client?.cs_owner || "CS"}.` : action === "RESOLVE" ? "Incidente resolvido e registrado." : action === "SNOOZE" ? "Incidente adiado por 24h." : action === "FALSE" ? "Marcado como falso alerta." : "Tratamento iniciado." }));
      await reloadWork();
    } catch (error) {
      setMessage((current) => ({ ...current, [group.key]: error instanceof Error ? error.message : "Não foi possível registrar a ação." }));
    } finally { setBusy(""); }
  }

  return <section className="ops-incidents card"><div className="ops-incidents-head"><div><span className="eyebrow">Incidentes operacionais</span><h2>Alertas agrupados e tratáveis</h2><p>Alertas repetidos do mesmo cliente e tipo viram um único incidente. A ação fica registrada na Central de Trabalho.</p></div><span className="counter">{groups.length} incidentes · {(data.alerts || []).length} sinais</span></div><div className="ops-incident-list">{groups.map((group) => { const alert = group.head; const client = clientById.get(String(alert.client_id)); const currentStatus = status(group); const age = hoursSince(group.first.first_detected_at || group.first.created_at); return <article key={group.key} className="ops-incident"><div className="ops-incident-main"><Chip value={alert.severity}/><span><b>{text(alert.title)}</b><small>{client?.display_name || "Alerta geral"} · {group.alerts.length} ocorrência(s) · aberto {ageLabel(age)} · último sinal {formatDate(group.last.last_detected_at || group.last.updated_at)}</small><p>{text(alert.description)}</p></span><Chip value={currentStatus}/></div><div className="ops-incident-actions">{client && <button onClick={() => openClient(String(client.client_id))}>Abrir cliente</button>}<button disabled={Boolean(busy)} onClick={() => act(group, "START")}>Iniciar tratamento</button><button disabled={Boolean(busy)} onClick={() => act(group, "CS")}>Delegar ao CS</button><button disabled={Boolean(busy)} onClick={() => act(group, "SNOOZE")}>Adiar 24h</button><button className="success" disabled={Boolean(busy)} onClick={() => act(group, "RESOLVE")}>Resolver</button><button className="muted" disabled={Boolean(busy)} onClick={() => act(group, "FALSE")}>Falso alerta</button></div>{message[group.key] && <div className="ops-incident-feedback">{message[group.key]}</div>}</article>; })}{!groups.length && <div className="ops-cockpit-empty">Nenhum incidente aberto.</div>}</div></section>;
}

function IntegrityCenter({ integrations, generatedAt, reload }: { integrations: Integration[]; generatedAt?: string | null; reload: () => Promise<void> }) {
  if (!integrations.length) return null;
  const failures = integrations.filter((item) => item.status === "FAIL").length;
  const delays = integrations.filter((item) => item.status === "DELAY").length;
  return <section className="ops-integrity card"><div className="ops-integrity-head"><div><span className="eyebrow">Integridade dos dados</span><h3>Estado das integrações</h3><p>Antes de confiar em uma métrica, confira quando a fonte falou pela última vez.</p></div><div><Chip value={failures ? "FALHA" : delays ? "ATRASO" : "OK"}/><button onClick={reload}>Atualizar agora</button></div></div><div className="ops-integrity-grid">{integrations.map((item) => <article key={item.source_key}><span className={`ops-integrity-dot ${item.status.toLowerCase()}`}/><div><b>{item.source_label}</b><small>{item.detail || item.status}</small><small>Último sinal: {item.last_event_at ? formatDate(item.last_event_at) : "sem registro"}</small></div><Chip value={item.status}/></article>)}</div>{generatedAt && <div className="ops-integrity-generated">Leitura gerada em {formatDate(generatedAt)}</div>}</section>;
}

function UniversalSearch({ data, close, openClient }: { data: HomeData; close: () => void; openClient: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase("pt-BR");
  const results = useMemo(() => {
    const items: SearchItem[] = [];
    const match = (...values: unknown[]) => values.join(" ").toLocaleLowerCase("pt-BR").includes(needle);
    if (!needle) {
      (data.clients || []).slice(0, 7).forEach((client) => items.push({ key: `c-${client.client_id}`, kind: "CLIENTE", label: text(client.display_name), detail: `${text(client.next_step || client.current_subject)} · CS ${text(client.cs_owner)} · GT ${text(client.gt_owner)}`, clientId: String(client.client_id), chip: client.priority }));
      return items;
    }
    (data.clients || []).filter((row) => match(row.display_name, row.cs_owner, row.gt_owner, row.designer_owner, row.current_subject, row.next_step, row.onboarding_stage)).slice(0, 8).forEach((row) => items.push({ key: `client-${row.client_id}`, kind: "CLIENTE", label: text(row.display_name), detail: `${text(row.current_subject || row.next_step)} · ${text(row.cs_owner)} / ${text(row.gt_owner)}`, clientId: String(row.client_id), chip: row.priority }));
    (data.campaigns || []).filter((row) => match(row.display_name, row.account_key, row.account_name, row.lifecycle)).slice(0, 6).forEach((row) => items.push({ key: `campaign-${row.client_id}-${row.account_key}`, kind: "CAMPANHA", label: text(row.display_name || row.account_name || row.account_key), detail: `${formatMoney(row.spend)} · ${formatNumber(row.leads)} leads · CPL ${row.cpl == null ? "—" : formatMoney(row.cpl)}`, clientId: row.client_id, view: "campaigns", chip: row.is_stale ? "DESATUALIZADO" : "MÍDIA" }));
    (data.alerts || []).filter((row) => match(row.title, row.description, row.alert_type)).slice(0, 6).forEach((row) => items.push({ key: `alert-${row.id}`, kind: "INCIDENTE", label: text(row.title), detail: text(row.description), clientId: row.client_id, view: "alerts", chip: row.severity }));
    (data.conversations || []).filter((row) => match(row.chat_name, row.open_question, row.last_summary, row.last_intent, row.conversation_status)).slice(0, 6).forEach((row) => items.push({ key: `conversation-${row.chat_id}`, kind: "CONVERSA", label: text(row.chat_name || row.open_question || "Conversa"), detail: text(row.open_question || row.last_summary), clientId: row.client_id, view: "conversations", chip: row.sla_level || row.conversation_status }));
    (data.commitments || []).filter((row) => match(row.title, row.description, row.owner, row.status)).slice(0, 6).forEach((row) => items.push({ key: `commitment-${row.id}`, kind: "PENDÊNCIA", label: text(row.title || row.description), detail: `${text(row.owner)} · ${row.due_at ? relativeDate(row.due_at) : "sem prazo"}`, clientId: row.client_id, view: "work", chip: row.status }));
    const tasks: Row[] = [...(data.clickup?.recent_completed || []), ...(data.operations?.personal_focus?.open_tasks || [])];
    tasks.filter((row) => match(row.name, row.list_name, row.status, row.client_display_name)).slice(0, 6).forEach((row) => items.push({ key: `task-${row.task_id}`, kind: "CLICKUP", label: text(row.name), detail: `${text(row.client_display_name || row.list_name)} · ${text(row.status)}`, url: row.url, chip: row.status }));
    (data.preclients || []).filter((row) => match(row.name, row.company, row.stage, row.next_action)).slice(0, 5).forEach((row) => items.push({ key: `pre-${row.id}`, kind: "PRÉ-CLIENTE", label: text(row.company || row.name), detail: `${text(row.stage)} · ${formatMoney(row.estimated_value)}`, view: "preclients", chip: String(row.stage || "CRM").toUpperCase() }));
    Object.entries(VIEW_LABELS).filter(([, label]) => label.toLocaleLowerCase("pt-BR").includes(needle)).forEach(([view, label]) => items.push({ key: `view-${view}`, kind: "NAVEGAÇÃO", label, detail: "Abrir esta área do dashboard", view, chip: "ABRIR" }));
    return items.slice(0, 32);
  }, [data, needle]);
  const open = (item: SearchItem) => {
    if (item.clientId) { openClient(String(item.clientId)); close(); return; }
    if (item.url) { window.open(item.url, "_blank", "noopener,noreferrer"); close(); return; }
    if (item.view) { navigateTo(item.view); close(); }
  };
  return createPortal(<><div className="ops-search-overlay" onClick={close}/><section className="ops-search-modal" role="dialog" aria-modal="true" aria-label="Busca global"><div className="ops-search-input"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Busque cliente, campanha, alerta, conversa, task, pendência ou área…"/><kbd>Esc</kbd></div><div className="ops-search-results">{results.map((item) => <button key={item.key} onClick={() => open(item)}><span className="ops-search-kind">{item.kind}</span><span><b>{item.label}</b><small>{item.detail}</small></span>{item.chip && <Chip value={item.chip}/>}</button>)}{!results.length && <div className="ops-cockpit-empty">Nenhum resultado encontrado.</div>}</div></section></>, document.body);
}

function Client360({ token, clientId, close }: { token: string; clientId: string; close: () => void }) {
  const [detail, setDetail] = useState<Row | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setDetail(null); setError("");
    api("client", token, { id: clientId }).then((payload) => { if (alive) setDetail(payload); }).catch((caught) => { if (alive) setError(caught instanceof Error ? caught.message : "Falha ao carregar cliente"); });
    return () => { alive = false; };
  }, [token, clientId]);
  const client = detail?.client || detail || {};
  const alerts: Row[] = detail?.alerts || [];
  const commitments: Row[] = detail?.commitments || [];
  const conversations: Row[] = detail?.conversations || [];
  const media: Row[] = detail?.media || [];
  const tasks: Row[] = detail?.clickup_tasks || [];
  const history: Row[] = detail?.health_history || [];
  const timeline = useMemo(() => {
    if (!detail) return [];
    return [
      ...(detail.timeline || []).map((row: Row) => ({ at: row.at, kind: text(row.event_type), title: text(row.detail) })),
      ...(detail.lifecycle_events || []).map((row: Row) => ({ at: row.occurred_at, kind: text(row.event_type), title: text(row.detail) })),
      ...alerts.map((row) => ({ at: row.first_detected_at || row.created_at, kind: "Alerta", title: text(row.title) })),
      ...commitments.map((row) => ({ at: row.due_at || row.created_at, kind: "Compromisso", title: text(row.title || row.description) })),
      ...conversations.map((row) => ({ at: row.updated_at || row.last_client_message_at, kind: "Conversa", title: text(row.last_summary || row.open_question) })),
    ].filter((row) => row.at).sort((a, b) => new Date(String(b.at)).getTime() - new Date(String(a.at)).getTime()).slice(0, 18);
  }, [detail, alerts, commitments, conversations]);
  const score = client.client_id ? healthScore(client) : null;
  const pending = commitments.filter((item) => !["DONE", "COMPLETED", "CLOSED"].includes(String(item.status).toUpperCase())).length + alerts.length + tasks.filter((item) => !["complete", "closed", "done"].includes(String(item.status).toLowerCase())).length;
  const latestMedia = media[0];
  const healthDelta = history.length >= 2 ? Number(history[0].score || 0) - Number(history[1].score || 0) : null;
  return createPortal(<><div className="ops-search-overlay" onClick={close}/><aside className="ops-360" role="dialog" aria-modal="true" aria-label="Cliente 360"><div className="ops-360-head"><div><span className="eyebrow">Cliente 360°</span><h2>{text(client.display_name || "Carregando…")}</h2><p>{text(client.current_subject || client.summary_today || "Visão consolidada da operação")}</p></div><button onClick={close}>×</button></div>{error && <div className="error-box">{error}</div>}{!detail && !error && <div className="empty">Buscando cliente 360°…</div>}{detail && <div className="ops-360-body"><div className="ops-360-kpis"><article><small>Saúde</small><b>{score ?? "—"}</b><span>{healthDelta == null ? "sem comparação" : healthDelta > 0 ? `↑ ${formatNumber(healthDelta)} pts` : healthDelta < 0 ? `↓ ${formatNumber(Math.abs(healthDelta))} pts` : "estável"}</span></article><article><small>Pendências</small><b>{pending}</b><span>alertas + compromissos + tasks</span></article><article><small>Tempo de casa</small><b>{client.client_days == null ? "—" : `${formatNumber(client.client_days, 0)}d`}</b><span>{client.entrada ? `desde ${formatDate(client.entrada)}` : "sem data"}</span></article><article><small>Mídia</small><b>{latestMedia?.leads != null ? `${formatNumber(latestMedia.leads)} leads` : "—"}</b><span>{latestMedia?.cpl != null ? `CPL ${formatMoney(latestMedia.cpl)}` : "sem referência"}</span></article></div><div className="ops-360-grid"><section><h3>Agora</h3><p><b>Status:</b> <Chip value={client.lifecycle}/> <Chip value={client.priority}/></p><p><b>Próxima ação:</b> {text(client.next_step)}</p><p><b>Responsável:</b> {text(client.action_owner)}</p><p><b>Prazo:</b> {client.next_step_due ? formatDate(client.next_step_due) : "sem prazo"}</p></section><section><h3>Responsáveis</h3><p>CS: <b>{text(client.cs_owner)}</b></p><p>GT: <b>{text(client.gt_owner)}</b></p><p>Design: <b>{text(client.designer_owner)}</b></p><p>Carteira: <b>{text(client.carteira)}</b></p></section><section><h3>Pendências</h3>{alerts.slice(0, 4).map((row) => <p key={`a-${row.id}`}><Chip value={row.severity}/> {text(row.title)}</p>)}{commitments.slice(0, 4).map((row) => <p key={`c-${row.id}`}><Chip value={row.status}/> {text(row.title || row.description)} · {formatDate(row.due_at)}</p>)}{!alerts.length && !commitments.length && <p className="small">Sem alertas ou compromissos abertos.</p>}</section><section><h3>Onboarding</h3><p><Chip value={client.onboarding_status}/></p><p>{text(client.onboarding_stage)}</p><p>{text(client.onboarding_next_action)}</p><p className="small">{client.last_activity_at ? `Última atividade ${relativeDate(client.last_activity_at)}` : "Sem atividade datada"}</p></section><section className="full"><h3>Linha do tempo</h3><div className="ops-360-timeline">{timeline.map((row, index) => <div key={`${row.kind}-${row.at}-${index}`}><span/><p><small>{formatDate(row.at)} · {row.kind}</small><b>{row.title}</b></p></div>)}{!timeline.length && <p className="small">Sem eventos consolidados.</p>}</div></section><section className="full"><h3>Conversas e mídia recentes</h3><div className="ops-360-columns"><div>{conversations.slice(0, 5).map((row) => <p key={row.chat_id}><Chip value={row.conversation_status}/> {text(row.last_summary || row.open_question || row.chat_id)}</p>)}{!conversations.length && <p className="small">Sem conversa vinculada.</p>}</div><div>{media.slice(0, 5).map((row, index) => <p key={`${row.account_key}-${index}`}><b>{text(row.date || row.latest_date)}</b> · {formatMoney(row.spend)} · {formatNumber(row.leads)} leads · CPL {row.cpl == null ? "—" : formatMoney(row.cpl)}</p>)}{!media.length && <p className="small">Sem mídia vinculada.</p>}</div></div></section></div></div>}</aside></>, document.body);
}

export default function DashboardEnhancements() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<HomeData | null>(null);
  const [work, setWork] = useState<Row>({ items: [], summary: {} });
  const [integration, setIntegration] = useState<IntegrationPayload>({});
  const [view, setView] = useState("overview");
  const [searchOpen, setSearchOpen] = useState(false);
  const [client360, setClient360] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: auth }) => setSession(auth.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const loadWork = useCallback(async () => {
    if (!session?.access_token) return;
    try { setWork(await api("work", session.access_token)); } catch { setWork({ items: [], summary: {} }); }
  }, [session?.access_token]);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    try { setData(await api("home", session.access_token)); } catch { /* a tela principal continua sendo a fonte de erro */ }
    await loadWork();
    try {
      const response = await fetch(INTEGRATION_HEALTH_URL, { headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store" });
      if (response.ok) setIntegration(await response.json());
      else if (response.status === 403) setIntegration({});
    } catch { setIntegration({}); }
  }, [session?.access_token, loadWork]);

  useEffect(() => {
    if (!session?.access_token) { setData(null); return; }
    load();
    const timer = window.setInterval(load, 30_000);
    return () => window.clearInterval(timer);
  }, [session?.access_token, load]);

  useEffect(() => {
    const detect = () => setView(activeViewFromDom());
    detect();
    const observer = new MutationObserver(detect);
    const nav = document.querySelector(".side-nav-items");
    if (nav) observer.observe(nav, { attributes: true, childList: true, subtree: true, attributeFilter: ["class"] });
    document.addEventListener("click", detect, true);
    const timer = window.setInterval(detect, 700);
    return () => { observer.disconnect(); document.removeEventListener("click", detect, true); window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); event.stopImmediatePropagation(); setSearchOpen(true);
      }
      if (event.key === "Escape") { setSearchOpen(false); setClient360(null); }
    };
    const click = (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest?.(".command-trigger");
      if (!target) return;
      event.preventDefault(); event.stopImmediatePropagation(); setSearchOpen(true);
    };
    document.addEventListener("keydown", keyboard, true);
    document.addEventListener("click", click, true);
    return () => { document.removeEventListener("keydown", keyboard, true); document.removeEventListener("click", click, true); };
  }, []);

  const overviewSlot = usePortalSlot("ops-cockpit-slot", ".source-banner", "after", Boolean(data) && view === "overview");
  const campaignSlot = usePortalSlot("ops-campaign-monitor-slot", ".diagnosis", "after", Boolean(data) && view === "campaigns");
  const workSlot = usePortalSlot("ops-work-sla-slot", ".work-filters", "after", Boolean(data) && view === "work");
  const onboardingSlot = usePortalSlot("ops-onboarding-sla-slot", ".funnel", "before", Boolean(data) && view === "onboarding");
  const incidentSlot = usePortalSlot("ops-incidents-slot", ".alert-list.actionable", "before", Boolean(data) && view === "alerts");

  useEffect(() => {
    const old = document.querySelector(".alert-list.actionable") as HTMLElement | null;
    if (old) old.style.display = view === "alerts" && incidentSlot ? "none" : "";
    return () => { if (old) old.style.display = ""; };
  }, [view, incidentSlot]);

  if (!session || !data) return null;
  const integrations = integration.integrations || [];
  const openClient = (id: string) => setClient360(id);

  return <>
    <SidebarEnhancer data={data} work={work}/>
    {overviewSlot && createPortal(<><OperationalCockpit data={data} work={work} integrations={integrations} openClient={openClient}/><IntegrityCenter integrations={integrations} generatedAt={integration.generated_at} reload={load}/></>, overviewSlot)}
    {campaignSlot && createPortal(<CampaignMonitor campaigns={data.campaigns || []} openClient={openClient}/>, campaignSlot)}
    {workSlot && createPortal(<SlaWatch data={data} work={work} mode="work" openClient={openClient}/>, workSlot)}
    {onboardingSlot && createPortal(<SlaWatch data={data} work={work} mode="onboarding" openClient={openClient}/>, onboardingSlot)}
    {incidentSlot && createPortal(<IncidentCenter data={data} work={work} token={session.access_token} openClient={openClient} reloadWork={loadWork}/>, incidentSlot)}
    {searchOpen && <UniversalSearch data={data} close={() => setSearchOpen(false)} openClient={openClient}/>} 
    {client360 && <Client360 token={session.access_token} clientId={client360} close={() => setClient360(null)}/>} 
  </>;
}
