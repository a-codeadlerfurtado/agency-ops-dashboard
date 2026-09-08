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
