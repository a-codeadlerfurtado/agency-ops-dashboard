/**
 * Configuracao central de Capacidade Operacional.
 *
 * TUDO que e' calibravel mora aqui. Peso espalhado pelo codigo vira peso que
 * ninguem ajusta: quando o modelo errar -- e ele vai errar nas primeiras
 * semanas -- a correcao precisa ser um numero neste arquivo ou uma linha em
 * agency_ops.workload_weight_config, nunca um caca-niquel de constantes.
 *
 * Os valores abaixo sao DEFAULTS. A configuracao persistida no banco tem
 * precedencia; ver `resolverConfig`.
 */

/** Metricas cruas de um cliente numa janela. Toda contagem e' inteira e >= 0. */
export type MetricaKey =
  | "whatsapp"
  | "tasks"
  | "criativos"
  | "reunioes"
  | "alertas"
  | "risco";

export type PesosWorkload = Record<MetricaKey, number>;

/**
 * Divisao inicial pedida pela operacao. Somam 1.0 -- e' invariante, nao
 * coincidencia: `intensidade` so e' comparavel entre clientes se os pesos
 * formarem uma media ponderada. `validarConfig` recusa somas diferentes.
 */
export const PESOS_PADRAO: PesosWorkload = {
  whatsapp: 0.25,
  tasks: 0.25,
  criativos: 0.15,
  reunioes: 0.10,
  alertas: 0.15,
  risco: 0.10,
};

/**
 * Faixa do score final.
 *
 * PISO e' o cliente que nao gera nada na janela; TETO trava o outlier. Sem
 * teto, um cliente em crise pontual (200 mensagens numa semana) sequestraria a
 * carteira inteira do GT e a recomendacao de distribuicao junto.
 */
export const PISO_SCORE = 0.7;
export const AMPLITUDE_SCORE = 1.3;
export const TETO_SCORE = 3.0;

/**
 * Cliente em ONBOARDING custa mais caro que cliente em regime: reuniao de
 * kickoff, configuracao de conta, primeira leva de criativos. O multiplicador
 * e' configuravel porque o custo real do onboarding muda conforme o processo
 * amadurece.
 */
export const MULTIPLICADOR_ONBOARDING = 1.25;

/** Faixas visuais (limite superior de cada uma, em % de utilizacao). */
export type Faixa = "SAUDAVEL" | "ATENCAO" | "LIMITE" | "CRITICO" | "SOBRECARGA";

export const LIMITES_FAIXA = {
  saudavel: 70,
  atencao: 85,
  limite: 90,
  critico: 100,
} as const;

/**
 * Dias entre decidir contratar e a pessoa produzir. Nao e' o tempo de
 * recrutamento: inclui rampa. Se a previsao de 90% chegar antes disso, a
 * recomendacao muda de "planejar" para "iniciar agora" -- e' a unica regra da
 * secao 34 que depende de tempo real.
 */
export const LEAD_TIME_CONTRATACAO_DIAS = 14;

/**
 * Janela de normalizacao. 7d capta o pico recente, 30d capta o regime. O score
 * usa as duas: pico sozinho oscila demais para decidir contratacao.
 */
export const PESO_JANELA_7D = 0.4;
export const PESO_JANELA_30D = 0.6;

export type ConfigCapacidade = {
  pesos: PesosWorkload;
  pisoScore: number;
  amplitudeScore: number;
  tetoScore: number;
  multiplicadorOnboarding: number;
  limitesFaixa: { saudavel: number; atencao: number; limite: number; critico: number };
  leadTimeContratacaoDias: number;
  pesoJanela7d: number;
  pesoJanela30d: number;
};

export const CONFIG_PADRAO: ConfigCapacidade = {
  pesos: PESOS_PADRAO,
  pisoScore: PISO_SCORE,
  amplitudeScore: AMPLITUDE_SCORE,
  tetoScore: TETO_SCORE,
  multiplicadorOnboarding: MULTIPLICADOR_ONBOARDING,
  limitesFaixa: LIMITES_FAIXA,
  leadTimeContratacaoDias: LEAD_TIME_CONTRATACAO_DIAS,
  pesoJanela7d: PESO_JANELA_7D,
  pesoJanela30d: PESO_JANELA_30D,
};

/**
 * Funde a configuracao do banco sobre o default.
 *
 * Parcial de proposito: a tabela guarda so o que foi calibrado. Um peso
 * ausente no banco nao pode zerar a metrica -- zerar silenciosamente uma
 * dimensao inteira do score e' o tipo de erro que ninguem percebe por semanas.
 */
export function resolverConfig(parcial?: Partial<ConfigCapacidade> | null): ConfigCapacidade {
  if (!parcial) return CONFIG_PADRAO;
  return {
    ...CONFIG_PADRAO,
    ...parcial,
    pesos: { ...CONFIG_PADRAO.pesos, ...(parcial.pesos ?? {}) },
    limitesFaixa: { ...CONFIG_PADRAO.limitesFaixa, ...(parcial.limitesFaixa ?? {}) },
  };
}

export type ProblemaConfig = { campo: string; motivo: string };

/**
 * Valida antes de calcular. Config invalida vinda do banco deve falhar alto,
 * na borda, e nao virar utilizacao errada num card que alguem usa para decidir
 * contratacao.
 */
export function validarConfig(config: ConfigCapacidade): ProblemaConfig[] {
  const problemas: ProblemaConfig[] = [];

  const soma = Object.values(config.pesos).reduce((total, peso) => total + peso, 0);
  if (Math.abs(soma - 1) > 0.001) {
    problemas.push({ campo: "pesos", motivo: `a soma dos pesos e' ${soma.toFixed(3)}, deveria ser 1.000` });
  }
  for (const [chave, peso] of Object.entries(config.pesos)) {
    if (!Number.isFinite(peso) || peso < 0) problemas.push({ campo: `pesos.${chave}`, motivo: "peso negativo ou nao numerico" });
  }

  const { saudavel, atencao, limite, critico } = config.limitesFaixa;
  if (!(saudavel < atencao && atencao < limite && limite < critico)) {
    problemas.push({ campo: "limitesFaixa", motivo: "os limites precisam ser estritamente crescentes" });
  }
  if (config.pisoScore <= 0) problemas.push({ campo: "pisoScore", motivo: "precisa ser maior que zero" });
  if (config.tetoScore <= config.pisoScore) problemas.push({ campo: "tetoScore", motivo: "precisa ser maior que pisoScore" });
  if (config.leadTimeContratacaoDias < 0) problemas.push({ campo: "leadTimeContratacaoDias", motivo: "nao pode ser negativo" });

  const somaJanelas = config.pesoJanela7d + config.pesoJanela30d;
  if (Math.abs(somaJanelas - 1) > 0.001) {
    problemas.push({ campo: "pesoJanela", motivo: `7d + 30d = ${somaJanelas.toFixed(3)}, deveria ser 1.000` });
  }

  return problemas;
}
