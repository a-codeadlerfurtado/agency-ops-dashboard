/** Resolucao deterministica de entidades para memoria conversacional da Jarvis. */

export type ClientePermitido = {
  client_id: string;
  display_name: string;
  lifecycle?: string;
  entrada?: string | null;
  saida?: string | null;
  client_days?: number | null;
  gt_owner?: string | null;
  cs_owner?: string | null;
  designer_owner?: string | null;
  priority?: string | null;
  last_activity_at?: string | null;
  open_commitments?: number | null;
  overdue_commitments?: number | null;
  open_complaints?: number | null;
  pending_approvals?: number | null;
  blockers?: number | null;
  alerts_count?: number | null;
  onboarding_status?: string | null;
  onboarding_stage?: string | null;
  onboarding_risk?: string | null;
  onboarding_blocked_by?: string | null;
  onboarding_next_action?: string | null;
  briefing_page_id?: string | null;
  briefing_sync_status?: string | null;
  leads_today?: number | null;
  spend_today?: number | null;
  cpl_today?: number | null;
  today_checked_at?: string | null;
  leads_yesterday?: number | null;
  spend_yesterday?: number | null;
  cpl_yesterday?: number | null;
  yesterday_checked_at?: string | null;
  spend_7d?: number | null;
  media_latest_date?: string | null;
  media_checked_at?: string | null;
  active_campaigns?: number | null;
  campaign_count?: number | null;
  balance_run_status?: string | null;
  balance_checked_at?: string | null;
  internal_score?: number | null;
  internal_band?: string | null;
  external_health_status?: string | null;
  external_health_score?: number | null;
  external_risk_level?: string | null;
  sentimento?: string | null;
  sinais_alerta?: string | null;
  reclamacoes?: string | null;
  wa_group_count?: number | null;
  wa_msg_count_today?: number | null;
  wa_last_msg_today?: string | null;
  wa_groups_silent_today?: number | null;
  wa_groups_only_good_morning?: number | null;
  wa_groups_without_good_morning?: number | null;
};

/** Corrige confusoes recorrentes do STT antes de qualquer roteamento/contexto. */
export function normalizarTranscricaoOperacional(valor: unknown): string {
  return String(valor ?? "")
    .replace(/\blitros\b/giu, "leads")
    .replace(/\blitro\b/giu, "lead");
}

export function normalizarEntidade(valor: unknown): string {
  return String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function perguntaSobreOnboarding(mensagem: string): boolean {
  const q = normalizarEntidade(normalizarTranscricaoOperacional(mensagem));
  return /\b(onboarding|onboard|onboardg|onbording|onbordem|ombording|ombordem|borden|boarding)\b/.test(q)
    || /\bon\s+(?:board|bord)(?:ing)?\b/.test(q);
}

/**
 * ATIVO OPERACIONAL = ACTIVE ou ONBOARDING.
 *
 * Regra de negocio da operacao, nao do banco: quem esta em onboarding JA E'
 * cliente -- contrato ativo, apenas ainda na implantacao. Responder 82 quando
 * ha 92 clientes sendo atendidos e' errado para quem toca a operacao.
 *
 * O lifecycle no banco continua distinguindo ACTIVE, ONBOARDING, CHURNED e
 * PROSPECT. A mudanca e' semantica, e mora SO aqui: qualquer contagem ou lista
 * do Jarvis passa por esta funcao, para a regra nao voltar a divergir entre
 * arquivos.
 */
export function ehAtivoOperacional(lifecycle: unknown): boolean {
  const v = String(lifecycle ?? "").toUpperCase();
  return v === "ACTIVE" || v === "ONBOARDING";
}

/** Somente ONBOARDING -- para "quantos estao em onboarding?". */
export function ehOnboarding(lifecycle: unknown): boolean {
  return String(lifecycle ?? "").toUpperCase() === "ONBOARDING";
}

/** Somente ACTIVE -- para "quantos ja sairam do onboarding?". */
export function ehEmOperacao(lifecycle: unknown): boolean {
  return String(lifecycle ?? "").toUpperCase() === "ACTIVE";
}

/** Quebra a carteira nas tres leituras de uma vez. */
export function repartirPorEstagio(clientes: ClientePermitido[]): { ativos: number; emOperacao: number; onboarding: number } {
  let emOperacao = 0, onboarding = 0;
  for (const c of clientes) {
    if (ehEmOperacao(c.lifecycle)) emOperacao += 1;
    else if (ehOnboarding(c.lifecycle)) onboarding += 1;
  }
  return { ativos: emOperacao + onboarding, emOperacao, onboarding };
}

export function contarClientesAtivos(clientes: ClientePermitido[]): number {
  return clientes.filter((c) => ehAtivoOperacional(c.lifecycle)).length;
}

export type FiltroAntiguidadeClientes = { comparador: "menos" | "mais"; meses: number };

const NUMEROS_MESES: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};

function numeroDeMeses(valor: string): number | null {
  const n = /^\d+$/.test(valor) ? Number(valor) : NUMEROS_MESES[valor];
  return Number.isInteger(n) && n > 0 && n <= 120 ? n : null;
}

function dataLimiteMesesAtras(meses: number): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const p = (tipo: string) => Number(partes.find((x) => x.type === tipo)?.value ?? 0);
  const indice = p("year") * 12 + (p("month") - 1) - meses;
  const ano = Math.floor(indice / 12);
  const mes0 = ((indice % 12) + 12) % 12;
  const ultimoDia = new Date(Date.UTC(ano, mes0 + 1, 0)).getUTCDate();
  const dia = Math.min(p("day"), ultimoDia);
  return `${ano}-${String(mes0 + 1).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

export function interpretarFiltroAntiguidadeClientes(
  mensagem: string,
  contextoAnterior = "",
): FiltroAntiguidadeClientes | null {
  const q = normalizarEntidade(mensagem);
  const anterior = normalizarEntidade(contextoAnterior);
  const falaDeCarteira = /\b(cliente|clientes|carteira|ativo|ativos|onboarding|operacao)\b/.test(q)
    || /\b(cliente|clientes|carteira|ativo|ativos|onboarding|operacao)\b/.test(anterior);
  if (!falaDeCarteira) return null;

  const faixa = q.match(/\b(menos|mais)\s+de\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+mes(?:es)?\b/);
  const recentes = q.match(/\b(?:ultimos|ultimo)\s+(\d+|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+mes(?:es)?\b/);
  const valor = faixa?.[2] ?? recentes?.[1] ?? null;
  if (!valor) return null;
  const meses = numeroDeMeses(valor);
  if (!meses) return null;
  return { comparador: faixa?.[1] === "mais" ? "mais" : "menos", meses };
}

export function filtrarClientesAtivosPorAntiguidade(
  clientes: ClientePermitido[],
  filtro: FiltroAntiguidadeClientes,
): { clientes: ClientePermitido[]; semData: number; limite: string } {
  const limite = dataLimiteMesesAtras(filtro.meses);
  const ativos = clientes.filter((c) => ehAtivoOperacional(c.lifecycle));
  const semData = ativos.filter((c) => !/^\d{4}-\d{2}-\d{2}$/.test(String(c.entrada ?? ""))).length;
  const encontrados = ativos.filter((c) => {
    const entrada = String(c.entrada ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entrada)) return false;
    return filtro.comparador === "menos" ? entrada > limite : entrada < limite;
  });
  return { clientes: encontrados, semData, limite };
}

export function resolverResponsavelMencionado(termo: string, clientes: ClientePermitido[]): string | null {
  const alvo = normalizarEntidade(termo);
  if (!alvo) return null;
  const nomes = new Set<string>();
  for (const c of clientes) {
    for (const nome of [c.gt_owner, c.cs_owner, c.designer_owner]) if (nome) nomes.add(String(nome));
  }
  const lista = [...nomes];
  const exatos = lista.filter((nome) => normalizarEntidade(nome) === alvo);
  if (exatos.length === 1) return exatos[0];
  const parciais = lista.filter((nome) => {
    const n = normalizarEntidade(nome);
    return n.startsWith(`${alvo} `) || n.split(" ").includes(alvo);
  });
  return parciais.length === 1 ? parciais[0] : null;
}

export function listarClientesAtivosPorResponsavel(clientes: ClientePermitido[], pessoa: string): ClientePermitido[] {
  const alvo = normalizarEntidade(pessoa);
  return clientes.filter((c) => ehAtivoOperacional(c.lifecycle) &&
    [c.gt_owner, c.cs_owner, c.designer_owner].some((nome) => normalizarEntidade(nome) === alvo));
}

export function contarClientesAtivosPorResponsavel(clientes: ClientePermitido[], pessoa: string): number {
  return listarClientesAtivosPorResponsavel(clientes, pessoa).length;
}

function distanciaEdicao(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const atual = [i];
    for (let j = 1; j <= b.length; j++) {
      atual[j] = Math.min(
        atual[j - 1] + 1,
        anterior[j] + 1,
        anterior[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    anterior = atual;
  }
  return anterior[b.length];
}

const TOKENS_NAO_ENTIDADE = new Set([
  "dia", "dias", "hoje", "ontem", "ultimo", "ultimos", "ultima", "ultimas",
  "lead", "leads", "cliente", "clientes", "todos", "todas", "geral", "total",
  "semana", "semanas", "mes", "meses", "ano", "anos", "quanto", "quantos",
  "teve", "tiveram", "gerados", "somando", "agencia", "nossos", "nossas",
]);

export function resolverClienteMencionado(mensagem: string, clientes: ClientePermitido[]): ClientePermitido | null {
  const q = normalizarEntidade(mensagem);
  if (!q || !clientes.length) return null;
  const qTokens = new Set(q.split(" ").filter((t) => t && !TOKENS_NAO_ENTIDADE.has(t)));
  const frequencia = new Map<string, number>();
  for (const c of clientes) {
    for (const t of new Set(normalizarEntidade(c.display_name).split(" ").filter((x) => x.length >= 4 && !TOKENS_NAO_ENTIDADE.has(x)))) {
      frequencia.set(t, (frequencia.get(t) ?? 0) + 1);
    }
  }

  let melhor: ClientePermitido | null = null;
  let melhorScore = 0;
  let segundoScore = 0;
  const frase = ` ${q} `;
  for (const c of clientes) {
    const nome = normalizarEntidade(c.display_name);
    if (!nome) continue;
    let score = 0;
    if (frase.includes(` ${nome} `)) score = 1000 + nome.length;
    else {
      const tokens = nome.split(" ").filter((t) => t.length >= 3 && !TOKENS_NAO_ENTIDADE.has(t));
      const exatos = tokens.filter((t) => qTokens.has(t));
      const unicos = exatos.filter((t) => t.length >= 4 && frequencia.get(t) === 1);
      let fuzzy = 0;
      for (const nt of tokens.filter((t) => t.length >= 6 && !qTokens.has(t))) {
        if ([...qTokens].some((qt) => qt.length >= 6 && Math.abs(qt.length - nt.length) <= 2 && distanciaEdicao(qt, nt) <= 2)) fuzzy++;
      }
      if (exatos.length >= 2) score = 650 + exatos.length * 20;
      else if (exatos.length >= 1 && fuzzy >= 1) score = 560 + fuzzy * 20;
      else if (unicos.length >= 1) score = 480 + unicos[0].length;
    }
    if (score > melhorScore) {
      segundoScore = melhorScore;
      melhorScore = score;
      melhor = c;
    } else if (score > segundoScore) segundoScore = score;
  }
  if (!melhor || melhorScore < 480 || (segundoScore > 0 && melhorScore - segundoScore < 20)) return null;
  return melhor;
}

