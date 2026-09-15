/** Vocabulário operacional PT/EN e variações comuns de voz. */
export type TemaOperacional =
  | "onboarding" | "task" | "clickup" | "webhook" | "leads" | "campaigns"
  | "balance" | "spend" | "briefing" | "creative" | "meeting" | "contract"
  | "alerts" | "whatsapp" | "crm" | "pipeline" | "meta" | "team";

export function normalizarIntent(valor: unknown): string {
  return String(valor ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

type Regra = { tema: TemaOperacional; rx: RegExp; hint: string };

const REGRAS: Regra[] = [
  { tema: "onboarding", rx: /\b(onboarding|onboard|onboardg|onbording|onbordem|ombording|ombordem|borden|boarding|implantacao)\b|\bon\s+(?:board|bord)(?:ing)?\b/, hint: "onboarding = clientes em implantação/entrada" },
  { tema: "task", rx: /\b(tasks?|tarefas?|demandas?|work\s*items?)\b/, hint: "task = tarefa/demanda operacional" },
  { tema: "clickup", rx: /\b(clickup|click\s*up|clicup|clikup|clique\s*up)\b/, hint: "ClickUp = sistema de tarefas da operação" },
  { tema: "webhook", rx: /\b(webhooks?|web\s*hooks?|webrook|web\s*rook)\b/, hint: "webhook = evento HTTP de integração" },
  { tema: "leads", rx: /\b(leads?|contatos?|prospects?)\b/, hint: "lead = lead/contato captado" },
  { tema: "campaigns", rx: /\b(campaigns?|campanhas?|adsets?|ad\s*sets?|anuncios?|ads?)\b/, hint: "campaign/ad = campanha/anúncio de mídia" },
  { tema: "balance", rx: /\b(balance|saldo)\b/, hint: "balance = saldo da conta de mídia quando houver contexto Meta" },
  { tema: "spend", rx: /\b(spend|spent|gasto|gastou|investimento|investiu)\b/, hint: "spend = gasto/investimento de mídia" },
  { tema: "briefing", rx: /\b(briefings?|brief)\b/, hint: "briefing = briefing de produto/persona/material" },
  { tema: "creative", rx: /\b(creative|creatives|criativo|criativos|design|video|videos)\b/, hint: "creative = criativo/material de campanha" },
  { tema: "meeting", rx: /\b(meetings?|reuniao|reunioes|call|calls)\b/, hint: "meeting/call = reunião" },
  { tema: "contract", rx: /\b(contracts?|contratos?|renewal|renovacao)\b/, hint: "contract/renewal = contrato/renovação" },
];REGRAS.push(
  { tema: "alerts", rx: /\b(alerts?|alertas?|warnings?|avisos?)\b/, hint: "alert/warning = alerta operacional" },
  { tema: "whatsapp", rx: /\b(whatsapp|whats|wpp|zap|zapi|z\s*api)\b/, hint: "WhatsApp/Z-API = canal de mensagens da operação" },
  { tema: "crm", rx: /\b(crm|customer\s*relationship)\b/, hint: "CRM = sistema de leads/clientes" },
  { tema: "pipeline", rx: /\b(pipeline|funil|funnel)\b/, hint: "pipeline/funnel = funil/pipeline comercial" },
  { tema: "meta", rx: /\b(meta|facebook|instagram|business\s*manager|bm|ads\s*manager)\b/, hint: "Meta = Meta Ads/Facebook/Instagram quando houver contexto de mídia" },
  { tema: "team", rx: /\b(team|equipe|gts?|cs|designers?|comerciais?|gestores?)\b/, hint: "team = equipe/responsáveis da operação" },
);

export function detectarTemas(mensagem: string): TemaOperacional[] {
  const q = normalizarIntent(mensagem);
  if (!q) return [];
  return REGRAS.filter((r) => r.rx.test(q)).map((r) => r.tema);
}

export function temTemaOperacionalExplicito(mensagem: string): boolean {
  return detectarTemas(mensagem).length > 0;
}

export function detectarConsultaClientesOperacionais(mensagem: string): "count" | "list" | null {
  const q = normalizarIntent(mensagem);
  if (!q || !/\bclientes?\b/.test(q)) return null;
  if (/\b(onboarding|onboard|churn|churned|cancelados?|prospects?|pre clientes?)\b/.test(q)) return null;
  if (/\b(leads?|campanhas?|saldo|balance|cpl|gasto|spend|tasks?|tarefas?|alertas?|contratos?|reunioes?|gt|cs|designer|carteira|atende|responsavel)\b/.test(q)) return null;
  if (/\bclientes?\s+(?:do|da|de|com)\b/.test(q)) return null;
  const lista = /\b(quais|quem|lista|listar|nomes?|todos|todas|mostra|mostrar)\b/.test(q);
  const conta = /\b(quantos?|numero|total|temos|tem|ha|existem)\b/.test(q);
  if (!lista && !conta) return null;
  return lista ? "list" : "count";
}


export type JanelaMidia =
  | { kind: "today"; days: 1; label: "hoje" }
  | { kind: "yesterday"; days: 1; label: "ontem" }
  | { kind: "last_days"; days: number; label: string };

export function detectarJanelaMidia(mensagem: string): JanelaMidia | null {
  const q = normalizarIntent(mensagem);
  if (/\bontem\b/.test(q)) return { kind: "yesterday", days: 1, label: "ontem" };
  if (/\bhoje\b/.test(q)) return { kind: "today", days: 1, label: "hoje" };
  if (/\b(ultima|ultimos?)\s+semana\b/.test(q)) return { kind: "last_days", days: 7, label: "nos últimos 7 dias" };
  const semanas = q.match(/\b(?:nas?\s+)?ultim(?:a|as)\s+(\d{1,2}|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+semanas?\b/);
  if (semanas) {
    const mapa: Record<string, number> = { duas:2,tres:3,quatro:4,cinco:5,seis:6,sete:7,oito:8,nove:9,dez:10,onze:11,doze:12 };
    const qtd = /^\d+$/.test(semanas[1]) ? Number(semanas[1]) : (mapa[semanas[1]] ?? 0);
    const days = qtd * 7;
    if (days >= 7 && days <= 84) return { kind: "last_days", days, label: `nas últimas ${qtd} semanas` };
  }
  const palavras: Record<string, number> = { tres: 3, sete: 7, quatorze: 14, vinte: 20, trinta: 30, noventa: 90 };
  const m = q.match(/\b(?:nos?\s+)?ultim(?:o|os|a|as)\s+(\d{1,3}|tres|sete|quatorze|trinta|noventa)\s+dias?\b/);
  if (!m) return null;
  const days = /^\d+$/.test(m[1]) ? Number(m[1]) : (palavras[m[1]] ?? 0);
  if (!Number.isFinite(days) || days < 2 || days > 90) return null;
  return { kind: "last_days", days, label: `nos últimos ${days} dias` };
}

export function detectarEscopoGlobal(mensagem: string): boolean {
  const q = normalizarIntent(mensagem);
  if (!q) return false;
  return /\b(todos?\s+(?:os\s+)?(?:nossos?\s+)?clientes?|somando\s+(?:todos?|os|as)|no\s+geral|total\s+geral|agencia\s+inteira|carteira\s+inteira)\b/.test(q)
    || /\bquantos?\s+leads?\b[\s\S]{0,80}\b(?:todos?\s+os\s+clientes?|no\s+geral)\b/.test(q);
}

export function contextoDeVocabulario(mensagem: string): string {
  const q = normalizarIntent(mensagem);
  const hints = REGRAS.filter((r) => r.rx.test(q)).map((r) => r.hint);
  if (!hints.length) return "";
  return `\n\nVOCABULÁRIO OPERACIONAL DETECTADO:\n- ${[...new Set(hints)].join("\n- ")}\n` +
    "Se a mensagem introduzir um destes temas, trate-o como tema atual e não herde um assunto anterior incompatível.";
}

export function confirmacaoDeLeitura(mensagem: string): boolean {
  const q = normalizarIntent(mensagem);
  return /^(sim|pode|pode mandar|manda|manda ai|quero|mostra|mostra ai|pode mostrar|pode listar|lista ai|isso)$/.test(q);
}
export type LifecycleJarvis = "ACTIVE" | "ONBOARDING" | "CHURNED" | "PROSPECT";
export type ConsultaLifecycle = { lifecycle: LifecycleJarvis; kind: "count" | "list" };

export function detectarConsultaLifecycle(mensagem: string): ConsultaLifecycle | null {
  const q = normalizarIntent(mensagem);
  if (!q) return null;

  const flags = {
    ACTIVE: /\b(clientes?\s+ativos?|ativos?\s+clientes?)\b/.test(q),
    ONBOARDING: /\b(onboarding|onboard|onboardg|onbording|onbordem|ombording|ombordem|borden|boarding|implantacao)\b|\bon\s+(?:board|bord)(?:ing)?\b/.test(q),
    CHURNED: /\b(churned|churn|cancelados?|encerrados?)\b/.test(q),
    PROSPECT: /\b(prospects?|pre\s*clientes?)\b/.test(q),
  };
  const encontrados = (Object.entries(flags) as Array<[LifecycleJarvis, boolean]>).filter(([, ok]) => ok).map(([k]) => k);
  if (encontrados.length !== 1) return null;
  const lifecycle = encontrados[0];

  // Não rouba perguntas cujo lifecycle é apenas filtro: "campanhas dos clientes ativos",
  // "clientes ativos com Felipe", etc. Essas precisam de outro planner/fonte.
  const outraMetrica = /\b(leads?|campanhas?|campaigns?|saldo|balance|cpl|gasto|gastou|spend|tasks?|tarefas?|alertas?|contratos?|reunioes?)\b/.test(q);
  const carteiraPessoa = /\bcom\s+(?:o|a)\s+(?!clientes?\b)[a-z]{3,}\b/.test(q) || /\bclientes?\s+ativos?\s+(?:do|da|de)\s+[a-z]{3,}\b/.test(q);
  if (outraMetrica || carteiraPessoa) return null;

  const querLista = /\b(quais|quem|lista|listar|nomes?|todos|todas|mostra|mostrar|mande|manda|passe|passa)\b/.test(q);
  const querContagem = /\b(quantos?|quanto|numero|total|temos|ha|existem|tem|estao)\b/.test(q);
  const kind: "count" | "list" = querLista ? "list" : (querContagem || /\bhoje\b/.test(q)) ? "count" : "count";
  return { lifecycle, kind };
}
