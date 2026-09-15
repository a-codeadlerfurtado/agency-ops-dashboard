/**
 * Score de carga operacional por cliente.
 *
 * Regra que orienta o arquivo inteiro: NENHUMA variavel pode dominar o score.
 * Contagem crua nao serve -- mensagens de WhatsApp vem em centenas e reunioes
 * em unidades; somar as duas faria o score virar "numero de mensagens" com
 * enfeite. Por isso tudo passa por normalizacao contra a POPULACAO do periodo
 * antes de ser ponderado.
 *
 * A normalizacao usa p90, nao maximo: o maximo e' sempre um outlier e faria o
 * resto da carteira parecer leve por comparacao.
 */

import {
  type ConfigCapacidade,
  type MetricaKey,
  CONFIG_PADRAO,
} from "./config.ts";

/** Contagens cruas de um cliente numa janela. Ausente = 0, nunca null. */
export type MetricasJanela = Record<MetricaKey, number>;

export type LifecycleCliente = "ACTIVE" | "ONBOARDING" | "CHURNED" | "PRE_OPS_CHURN" | "PAUSED";

export type OverrideCarga = {
  valor: number;
  motivo: string;
  autor: string;
  criadoEm: string;
  /** ISO date. Nulo = sem validade. */
  validoAte: string | null;
};

export type EntradaCliente = {
  clientId: string;
  nome: string;
  lifecycle: LifecycleCliente;
  /** Responsavel na carteira. Null e' legitimo: cliente sem GT atribuido. */
  gtOwner: string | null;
  metricas7d: MetricasJanela;
  metricas30d: MetricasJanela;
  override?: OverrideCarga | null;
};

export type ComponenteScore = {
  metrica: MetricaKey;
  /** Valor combinado das janelas, antes de normalizar. */
  bruto: number;
  /** 0..~1.5 depois da normalizacao por p90. */
  normalizado: number;
  peso: number;
  /** Quanto esta metrica somou na intensidade final. */
  contribuicao: number;
};

export type ScoreCliente = {
  clientId: string;
  nome: string;
  gtOwner: string | null;
  lifecycle: LifecycleCliente;
  score: number;
  /** "AUTOMATICO" ou "OVERRIDE" -- a UI precisa deixar isso explicito. */
  origem: "AUTOMATICO" | "OVERRIDE";
  intensidade: number;
  componentes: ComponenteScore[];
  /** Preenchido so quando origem = OVERRIDE. */
  override?: OverrideCarga;
};

/** Estatisticas da populacao, por metrica, usadas para normalizar. */
export type BasePopulacional = Record<MetricaKey, { mediana: number; p90: number }>;

const METRICAS: MetricaKey[] = ["whatsapp", "tasks", "criativos", "reunioes", "alertas", "risco"];

function numero(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Percentil por interpolacao linear. Lista vazia -> 0, nunca NaN. */
export function percentil(valores: number[], p: number): number {
  const limpos = valores.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!limpos.length) return 0;
  if (limpos.length === 1) return limpos[0];
  const posicao = (limpos.length - 1) * Math.min(Math.max(p, 0), 1);
  const baixo = Math.floor(posicao);
  const alto = Math.ceil(posicao);
  if (baixo === alto) return limpos[baixo];
  return limpos[baixo] + (limpos[alto] - limpos[baixo]) * (posicao - baixo);
}

/**
 * Combina as duas janelas numa grandeza comparavel.
 *
 * 30d entra como MEDIA SEMANAL (dividido por ~4.3), senao a janela longa
 * dominaria a curta por puro efeito de tamanho e o score deixaria de reagir a
 * um cliente que esquentou nesta semana.
 */
export function combinarJanelas(
  metricas7d: MetricasJanela,
  metricas30d: MetricasJanela,
  config: ConfigCapacidade = CONFIG_PADRAO,
): MetricasJanela {
  const combinado = {} as MetricasJanela;
  for (const metrica of METRICAS) {
    const recente = numero(metricas7d?.[metrica]);
    const regime = numero(metricas30d?.[metrica]) / (30 / 7);
    combinado[metrica] = recente * config.pesoJanela7d + regime * config.pesoJanela30d;
  }
  return combinado;
}

/**
 * Calcula mediana e p90 de cada metrica sobre a carteira viva.
 *
 * Precisa receber SO os clientes que entram na conta (nao churnados): incluir
 * churnado achataria o p90 com uma fila de zeros e inflaria o score de todo
 * mundo que restou.
 */
export function calcularBasePopulacional(
  clientes: EntradaCliente[],
  config: ConfigCapacidade = CONFIG_PADRAO,
): BasePopulacional {
  const base = {} as BasePopulacional;
  const combinados = clientes.map((cliente) => combinarJanelas(cliente.metricas7d, cliente.metricas30d, config));
  for (const metrica of METRICAS) {
    const valores = combinados.map((m) => m[metrica]);
    base[metrica] = { mediana: percentil(valores, 0.5), p90: percentil(valores, 0.9) };
  }
  return base;
}

/**
 * Normaliza contra o p90 e trava em 1.5.
 *
 * O teto em 1.5 (e nao 1.0) e' de proposito: quem esta acima do p90 DEVE
 * pesar mais que quem esta nele, so nao pode pesar sem limite. p90 zero --
 * metrica que a operacao inteira nao usa -- devolve 0 em vez de dividir por
 * zero.
 */
export function normalizar(valor: number, p90: number): number {
  if (!Number.isFinite(valor) || valor <= 0) return 0;
  if (!Number.isFinite(p90) || p90 <= 0) return 0;
  return Math.min(valor / p90, 1.5);
}

function overrideVigente(override: OverrideCarga | null | undefined, hoje: Date): OverrideCarga | null {
  if (!override) return null;
  if (!Number.isFinite(override.valor) || override.valor <= 0) return null;
  if (!override.validoAte) return override;
  const limite = new Date(`${override.validoAte}T23:59:59Z`);
  if (Number.isNaN(limite.getTime())) return override;
  return limite.getTime() >= hoje.getTime() ? override : null;
}

/**
 * Score de um cliente.
 *
 * score = (PISO + AMPLITUDE * intensidade) * multiplicador de lifecycle
 *
 * com intensidade = soma ponderada das metricas normalizadas. Como os pesos
 * somam 1 e cada normalizado vive em [0, 1.5], a intensidade vive em [0, 1.5]
 * e o score cai naturalmente na escala que a operacao pediu: ~0.7 para o
 * cliente que nao gera nada, ~1.0 para o mediano, 2.0+ para o pesado.
 */
export function calcularScoreCliente(
  cliente: EntradaCliente,
  base: BasePopulacional,
  config: ConfigCapacidade = CONFIG_PADRAO,
  hoje: Date = new Date(),
): ScoreCliente {
  const vigente = overrideVigente(cliente.override, hoje);
  const combinado = combinarJanelas(cliente.metricas7d, cliente.metricas30d, config);

  const componentes: ComponenteScore[] = METRICAS.map((metrica) => {
    const bruto = combinado[metrica];
    const normalizado = normalizar(bruto, base?.[metrica]?.p90 ?? 0);
    const peso = config.pesos[metrica] ?? 0;
    return { metrica, bruto, normalizado, peso, contribuicao: normalizado * peso };
  });

  const intensidade = componentes.reduce((total, c) => total + c.contribuicao, 0);

  // Override substitui o valor final, mas os componentes continuam expostos:
  // quem definiu 2.0 na mao precisa conseguir comparar com o que o automatico
  // teria dado, senao o override nunca e' revisado.
  if (vigente) {
    return {
      clientId: cliente.clientId,
      nome: cliente.nome,
      gtOwner: cliente.gtOwner,
      lifecycle: cliente.lifecycle,
      score: Math.min(vigente.valor, config.tetoScore),
      origem: "OVERRIDE",
      intensidade,
      componentes,
      override: vigente,
    };
  }

  const multiplicador = cliente.lifecycle === "ONBOARDING" ? config.multiplicadorOnboarding : 1;
  const bruto = (config.pisoScore + config.amplitudeScore * intensidade) * multiplicador;
  const score = Math.min(Math.max(bruto, config.pisoScore), config.tetoScore);

  return {
    clientId: cliente.clientId,
    nome: cliente.nome,
    gtOwner: cliente.gtOwner,
    lifecycle: cliente.lifecycle,
    score: arredondar(score),
    origem: "AUTOMATICO",
    intensidade,
    componentes,
  };
}

/** CHURNED e PRE_OPS_CHURN sao a MESMA coisa para efeito de carga. */
export function contaComoCarga(lifecycle: LifecycleCliente): boolean {
  return lifecycle === "ACTIVE" || lifecycle === "ONBOARDING";
}

/**
 * Calcula a carteira inteira de uma vez.
 *
 * Filtra churn ANTES de montar a base populacional -- ordem importa, ver
 * comentario em `calcularBasePopulacional`.
 */
export function calcularScores(
  clientes: EntradaCliente[],
  config: ConfigCapacidade = CONFIG_PADRAO,
  hoje: Date = new Date(),
): ScoreCliente[] {
  const vivos = (clientes ?? []).filter((cliente) => contaComoCarga(cliente.lifecycle));
  if (!vivos.length) return [];
  const base = calcularBasePopulacional(vivos, config);
  return vivos.map((cliente) => calcularScoreCliente(cliente, base, config, hoje));
}

function arredondar(valor: number): number {
  return Math.round(valor * 100) / 100;
}
