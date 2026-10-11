// Regras puras do CPL Guard (sem I/O), testadas em scripts/check-cpl-guard.mjs.

export type Level = "AD" | "ADSET";
export type Action = { action_type: string; value: string | number };
export type Row = Record<string, any>;

export const RULE_PREFIX = "[Imobi Guard]";
export const LEAD_OBJECTIVES = ["OUTCOME_LEADS", "OUTCOME_ENGAGEMENT", "LEAD_GENERATION", "MESSAGES"];
export const LEAD_OPTIMIZATION_GOALS = ["LEAD_GENERATION", "QUALITY_LEAD", "CONVERSATIONS", "OFFSITE_CONVERSIONS"];

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function brl(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "R$ -";
  return "R$ " + v.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Limite de gasto do dia (centavos), nunca abaixo do piso configurado. */
export function thresholdCents(cpl: number, multiplier: number, minBrl: number): number {
  return Math.round(Math.max(cpl * multiplier, minBrl) * 100);
}

export function ruleName(level: Level, multiplier: number, thresholdCentsValue: number): string {
  const what = level === "AD" ? "anuncio" : "conjunto";
  return `${RULE_PREFIX} Pausa ${what} sem lead: gasto hoje acima de ${brl(thresholdCentsValue / 100)} (${multiplier}x CPL ideal)`;
}

/** Regra agendada da Meta: a cada 30 min pausa o anúncio/conjunto de campanha de lead que
 * gastou mais que o limite hoje sem nenhum resultado. Validada em 11/10/2026 (conta I Urbe). */
export function ruleSpec(level: Level, multiplier: number, thresholdCentsValue: number) {
  return {
    name: ruleName(level, multiplier, thresholdCentsValue),
    evaluation_spec: {
      evaluation_type: "SCHEDULE",
      filters: [
        { field: "entity_type", value: level, operator: "EQUAL" },
        { field: "time_preset", value: "TODAY", operator: "EQUAL" },
        { field: "attribution_window", value: "ACCOUNT_DEFAULT", operator: "EQUAL" },
        { field: "campaign.objective", value: LEAD_OBJECTIVES, operator: "IN" },
        { field: "adset.optimization_goal", value: LEAD_OPTIMIZATION_GOALS, operator: "IN" },
        { field: "spent", value: thresholdCentsValue, operator: "GREATER_THAN" },
        { field: "results", value: 1, operator: "LESS_THAN" },
      ],
    },
    execution_spec: { execution_type: "PAUSE" },
    schedule_spec: { schedule_type: "SEMI_HOURLY" },
  };
}

/** Limite atualmente gravado na regra da Meta (centavos) ou null. */
export function currentThreshold(rule: Row | null | undefined): number | null {
  const filters = rule?.evaluation_spec?.filters;
  if (!Array.isArray(filters)) return null;
  const spent = filters.find((f: Row) => f?.field === "spent");
  return spent ? num(spent.value) : null;
}

/** Atualiza só quando o limite muda mais de 5% (evita mexer na regra todo dia). */
export function thresholdChanged(current: number | null, desired: number): boolean {
  if (current === null || current <= 0) return true;
  return Math.abs(current - desired) / current > 0.05;
}

/** Leads ou conversas iniciadas, o que a campanha estiver buscando. */
export function resultCount(actions: Action[] | undefined | null): number {
  const list = Array.isArray(actions) ? actions : [];
  const pick = (types: string[]) => {
    for (const t of types) {
      const hit = list.find((a) => String(a?.action_type || "").toLowerCase() === t);
      if (hit) return num(hit.value) ?? 0;
    }
    return 0;
  };
  const lead = pick(["lead", "onsite_conversion.lead_grouped", "offsite_complete_registration_add_meta_leads"]);
  const msg = pick(["onsite_conversion.messaging_conversation_started_7d", "onsite_conversion.total_messaging_connection"]);
  return Math.max(lead, msg);
}

export function linkClicks(ins: Row | null | undefined): number {
  const direct = num(ins?.inline_link_clicks);
  if (direct !== null) return direct;
  const hit = (ins?.actions || []).find((a: Action) => a.action_type === "link_click");
  return hit ? num(hit.value) ?? 0 : 0;
}

export type Facts = {
  level: Level;
  cpl_alvo: number;
  threshold_brl: number;
  hours_since_created: number | null;
  learning_status: string | null;
  today: Row | null;
  last7: Row | null;
  account7: Row | null;
  rankings: { quality?: string; engagement?: string; conversion?: string };
  ads_in_adset?: number | null;
};

export type Signal = { code: string; text: string };

/** Sinais objetivos do porquê o gasto não virou lead. Ordem = prioridade de leitura. */
export function diagnose(f: Facts): Signal[] {
  const out: Signal[] = [];
  const t = f.today || {};
  const w = f.last7 || {};
  const a = f.account7 || {};
  const impressions = num(t.impressions) ?? 0;
  const ctr = num(t.inline_link_click_ctr);
  const accCtr = num(a.inline_link_click_ctr);
  const cpm = num(t.cpm);
  const accCpm = num(a.cpm);
  const clicks = linkClicks(t);
  const freq7 = num(w.frequency);
  const spend7 = num(w.spend) ?? 0;
  const res7 = resultCount(w.actions);
  const cpl7 = res7 > 0 ? spend7 / res7 : null;
  const accSpend = num(a.spend) ?? 0;
  const accRes = resultCount(a.actions);
  const accCpl = accRes > 0 ? accSpend / accRes : null;

  if (f.hours_since_created !== null && f.hours_since_created < 48) {
    out.push({ code: "NEW", text: `É novo (criado há ${Math.max(1, Math.round(f.hours_since_created))}h) e ainda está em aprendizado.` });
  }
  if (f.learning_status === "FAIL") {
    out.push({ code: "LEARNING_LIMITED", text: "O conjunto está em aprendizado limitado: pouco volume de resultado para a Meta otimizar." });
  } else if (f.learning_status === "LEARNING" && !out.some((s) => s.code === "NEW")) {
    out.push({ code: "LEARNING", text: "O conjunto ainda está em fase de aprendizado." });
  }
  if (impressions > 0 && impressions < 400) {
    out.push({ code: "LOW_DELIVERY", text: `Entregou pouco hoje (${impressions} impressões): leilão caro ou público muito restrito.` });
  }
  if (ctr !== null && accCtr !== null && accCtr > 0 && impressions >= 400 && ctr < accCtr * 0.6) {
    out.push({ code: "LOW_CTR", text: `O criativo não está fazendo a pessoa clicar: CTR de link ${ctr.toFixed(2)}% contra ${accCtr.toFixed(2)}% da conta nos últimos 7 dias.` });
  }
  if (clicks >= 8 || (ctr !== null && accCtr !== null && accCtr > 0 && ctr >= accCtr && clicks >= 4)) {
    out.push({ code: "CLICKS_NO_LEAD", text: `Teve ${clicks} cliques no link e nenhum lead: o problema tende a estar depois do clique (formulário, mensagem do WhatsApp ou página), não no criativo.` });
  }
  if (cpm !== null && accCpm !== null && accCpm > 0 && cpm > accCpm * 1.5) {
    out.push({ code: "HIGH_CPM", text: `CPM alto: ${brl(cpm)} contra ${brl(accCpm)} da conta. Público pequeno, sobreposição ou concorrência no leilão.` });
  }
  if (freq7 !== null && freq7 >= 3) {
    out.push({ code: "FATIGUE", text: `Frequência de ${freq7.toFixed(1)} em 7 dias: o público já viu muito esse anúncio (saturação).` });
  }
  const below = Object.entries(f.rankings || {}).filter(([, v]) => String(v || "").startsWith("BELOW_AVERAGE"));
  if (below.length) {
    const names: Record<string, string> = { quality: "qualidade", engagement: "engajamento", conversion: "conversão" };
    out.push({ code: "LOW_RANKING", text: `A Meta classifica ${below.map(([k]) => names[k] || k).join(" e ")} abaixo da média.` });
  }
  if (res7 >= 3 && cpl7 !== null && cpl7 <= f.cpl_alvo * 1.2) {
    out.push({ code: "WAS_GOOD", text: `Nos últimos 7 dias vinha bem (${res7} leads a ${brl(cpl7)}): pode ser um dia ruim e não um problema estrutural.` });
  } else if (res7 === 0 && spend7 >= f.cpl_alvo * 2) {
    out.push({ code: "NEVER_CONVERTED", text: `Também não gerou lead nos últimos 7 dias (${brl(spend7)} gastos): oferta ou criativo não estão funcionando.` });
  } else if (cpl7 !== null && cpl7 > f.cpl_alvo * 1.5) {
    out.push({ code: "TREND_BAD", text: `Já vinha caro: CPL de ${brl(cpl7)} nos últimos 7 dias, acima do ideal de ${brl(f.cpl_alvo)}.` });
  }
  if (accCpl !== null && accCpl > f.cpl_alvo * 1.5) {
    out.push({ code: "ACCOUNT_BAD", text: `A conta inteira está com CPL de ${brl(accCpl)} em 7 dias: o problema pode ser geral (oferta, região, mercado) e não só deste ${f.level === "AD" ? "anúncio" : "conjunto"}.` });
  }
  if (!out.length) {
    out.push({ code: "NO_CLEAR_SIGNAL", text: "Os números de entrega estão normais; vale conferir se o formulário ou o WhatsApp de destino estão funcionando e recebendo os leads." });
  }
  return out;
}

export function nextStep(signals: Signal[]): string {
  const codes = new Set(signals.map((s) => s.code));
  if (codes.has("CLICKS_NO_LEAD")) return "Testar o caminho do lead (abrir o formulário ou o WhatsApp do anúncio) e ver se está tudo funcionando.";
  if (codes.has("WAS_GOOD")) return "Conferir se houve mudança no dia (orçamento, público, edição) e, se nada mudou, reativar amanhã acompanhando.";
  if (codes.has("NEVER_CONVERTED")) return "Trocar o criativo ou a oferta antes de reativar.";
  if (codes.has("LOW_CTR")) return "Trocar o criativo (gancho e primeira imagem) antes de reativar.";
  if (codes.has("HIGH_CPM") || codes.has("LOW_DELIVERY")) return "Revisar o público e os posicionamentos do conjunto.";
  if (codes.has("FATIGUE")) return "Renovar o criativo ou ampliar o público.";
  if (codes.has("ACCOUNT_BAD")) return "Olhar a conta como um todo (oferta e público) antes de mexer só neste item.";
  if (codes.has("NEW") || codes.has("LEARNING")) return "Avaliar se vale reativar com mais tempo de aprendizado ou trocar o criativo.";
  return "Abrir no Gerenciador e conferir a entrega e o destino do lead.";
}

/** Sem travessão (o usuário não quer) e sem espaços sobrando. */
export function tidy(text: string): string {
  return String(text || "").replace(/\s*[—–]\s*/g, ", ").replace(/[ \t]+\n/g, "\n").trim();
}

export function adsManagerUrl(adAccountId: string, level: Level, entityId: string): string {
  const tab = level === "AD" ? "ads" : "adsets";
  const param = level === "AD" ? "selected_ad_ids" : "selected_adset_ids";
  return `https://adsmanager.facebook.com/adsmanager/manage/${tab}?act=${adAccountId}&${param}=${entityId}`;
}

export type EventView = {
  client_name: string;
  gt_owner: string | null;
  level: Level;
  entity_name: string;
  campaign_name: string | null;
  adset_name: string | null;
  spend_today: number | null;
  threshold_brl: number;
  multiplier: number;
  cpl_alvo: number;
  cpl_origem: string;
  reading: string[];
  next_step: string;
  url: string;
};

const ORIGEM: Record<string, string> = {
  MANUAL: "definido manualmente",
  REGRA_TICKET: "pelo ticket médio",
  HISTORICO_30D: "média dos últimos 30 dias",
};

export function whatsappText(events: EventView[], forManager: boolean): string {
  const first = events[0];
  const lines: string[] = [];
  lines.push(`⛔ *Pausa automática por CPL* | ${first.client_name}`);
  if (forManager) lines.push(`GT: ${first.gt_owner || "sem GT definido"}`);
  for (const e of events) {
    lines.push("");
    const what = e.level === "AD" ? "Anúncio" : "Conjunto";
    lines.push(`*${what}:* ${e.entity_name}`);
    if (e.level === "AD" && e.adset_name) lines.push(`Conjunto: ${e.adset_name}`);
    if (e.campaign_name) lines.push(`Campanha: ${e.campaign_name}`);
    const spent = e.spend_today !== null ? brl(e.spend_today) : `mais de ${brl(e.threshold_brl)}`;
    lines.push(`Gastou ${spent} hoje sem nenhum lead. Limite: ${e.multiplier}x o CPL ideal de ${brl(e.cpl_alvo)} (${ORIGEM[e.cpl_origem] || e.cpl_origem}).`);
    lines.push("");
    lines.push("*Leitura operacional:*");
    for (const r of e.reading) lines.push(`• ${r}`);
    lines.push(`*Primeiro passo:* ${e.next_step}`);
    lines.push(`Abrir no Gerenciador: ${e.url}`);
  }
  return tidy(lines.join("\n"));
}

/** Janela de envio no WhatsApp (horário de Brasília). Fora dela o aviso espera. */
export function inSendWindow(now: Date, startHour = 7, endHour = 22): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }).format(now)) % 24;
  return hour >= startHour && hour < endHour;
}
