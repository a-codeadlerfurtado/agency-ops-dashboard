/**
 * Previsao de saturacao.
 *
 * Projeta CARGA, nao contagem de clientes -- e' a diferenca entre "cabem mais
 * 13 clientes" e "cabem mais 13 clientes SE forem parecidos com os que entraram
 * ultimamente". A carga media do cliente novo sai do historico real de
 * entradas, nao de 1.0 por decreto.
 *
 * Toda saida carrega as premissas junto. Previsao sem premissa vira promessa, e
 * a operacao passa a cobrar a data como se fosse compromisso.
 */

import { type ConfigCapacidade, CONFIG_PADRAO } from "./config.ts";

/** Dias uteis por semana. Feriado nao entra: o erro que ele introduz e' menor
 *  que a incerteza do proprio crescimento, e a lista de feriados seria mais uma
 *  tabela para manter. */
const DIAS_UTEIS_POR_SEMANA = 5;

export type HistoricoCrescimento = {
  /** Entradas liquidas (entradas - churn) na janela. Pode ser negativo. */
  liquido30d: number;
  liquido60d: number;
  liquido90d: number;
  /** Carga media dos clientes que ENTRARAM nos ultimos 90 dias. */
  cargaMediaNovoCliente: number;
};

export type Premissa = { rotulo: string; valor: string };

export type Previsao = {
  /** Dias UTEIS ate o limiar. Null = nao ha' previsao possivel. */
  diasUteis: number | null;
  /** Data estimada em ISO (yyyy-mm-dd). Null junto com diasUteis. */
  dataEstimada: string | null;
  /** Motivo textual quando nao ha' previsao -- a UI mostra isto, nao "--". */
  motivo?: string;
};

export type ResultadoPrevisao = {
  crescimentoLiquidoDiaUtil: number;
  cargaMediaNovoCliente: number;
  cargaAdicionalPorDiaUtil: number;
  ate90: Previsao;
  ate100: Previsao;
  premissas: Premissa[];
};

/**
 * Crescimento liquido por dia util, com as tres janelas ponderadas.
 *
 * 30d pesa mais que 90d porque a decisao e' de curto prazo, mas 90d entra para
 * nao deixar um mes atipico -- ferias, uma leva de churn -- virar tendencia.
 */
export function crescimentoLiquidoDiaUtil(historico: HistoricoCrescimento): number {
  const porDiaUtil = (liquido: number, diasCorridos: number) => {
    const diasUteis = (diasCorridos / 7) * DIAS_UTEIS_POR_SEMANA;
    return diasUteis > 0 ? liquido / diasUteis : 0;
  };
  const j30 = porDiaUtil(numero(historico?.liquido30d), 30);
  const j60 = porDiaUtil(numero(historico?.liquido60d), 60);
  const j90 = porDiaUtil(numero(historico?.liquido90d), 90);
  return arredondar(j30 * 0.5 + j60 * 0.3 + j90 * 0.2, 3);
}

function diasUteisParaCorridos(diasUteis: number): number {
  return Math.ceil((diasUteis / DIAS_UTEIS_POR_SEMANA) * 7);
}

function dataApos(hoje: Date, diasUteis: number): string {
  const data = new Date(hoje.getTime());
  data.setUTCDate(data.getUTCDate() + diasUteisParaCorridos(diasUteis));
  return data.toISOString().slice(0, 10);
}

/**
 * Quantos dias uteis ate a carga atingir `alvoPontos`.
 *
 * Tres estados de "sem previsao", todos legitimos e todos com texto proprio:
 * ja passou do alvo, capacidade nao calibrada, e crescimento nulo ou negativo.
 * Nenhum deles pode virar data.
 */
function projetar(
  cargaAtual: number,
  capacidade: number,
  limiarPct: number,
  cargaPorDiaUtil: number,
  hoje: Date,
): Previsao {
  if (!Number.isFinite(capacidade) || capacidade <= 0) {
    return { diasUteis: null, dataEstimada: null, motivo: "capacidade ainda nao calibrada" };
  }
  const alvo = capacidade * (limiarPct / 100);
  if (cargaAtual >= alvo) {
    return { diasUteis: 0, dataEstimada: hoje.toISOString().slice(0, 10), motivo: "limiar ja atingido" };
  }
  if (!Number.isFinite(cargaPorDiaUtil) || cargaPorDiaUtil <= 0) {
    return { diasUteis: null, dataEstimada: null, motivo: "sem crescimento liquido no periodo" };
  }
  const dias = Math.ceil((alvo - cargaAtual) / cargaPorDiaUtil);
  // Teto de 2 anos: acima disso a projecao linear perde qualquer sentido e uma
  // data em 2031 num card de operacao so destroi a confianca no modulo.
  if (dias > 500) {
    return { diasUteis: null, dataEstimada: null, motivo: "crescimento atual leva mais de 2 anos ate o limiar" };
  }
  return { diasUteis: dias, dataEstimada: dataApos(hoje, dias) };
}

export function preverSaturacao(
  cargaAtualPontos: number,
  capacidadePontos: number,
  historico: HistoricoCrescimento,
  config: ConfigCapacidade = CONFIG_PADRAO,
  hoje: Date = new Date(),
): ResultadoPrevisao {
  const crescimento = crescimentoLiquidoDiaUtil(historico);
  const cargaMedia = numero(historico?.cargaMediaNovoCliente) || 1;
  const cargaPorDiaUtil = arredondar(crescimento * cargaMedia, 3);

  return {
    crescimentoLiquidoDiaUtil: crescimento,
    cargaMediaNovoCliente: arredondar(cargaMedia, 2),
    cargaAdicionalPorDiaUtil: cargaPorDiaUtil,
    ate90: projetar(cargaAtualPontos, capacidadePontos, config.limitesFaixa.limite, cargaPorDiaUtil, hoje),
    ate100: projetar(cargaAtualPontos, capacidadePontos, config.limitesFaixa.critico, cargaPorDiaUtil, hoje),
    premissas: [
      { rotulo: "Crescimento liquido medio", valor: `${crescimento.toFixed(2)} cliente/dia util` },
      { rotulo: "Carga media do cliente novo", valor: `${cargaMedia.toFixed(2)} ponto` },
      { rotulo: "Janelas consideradas", valor: "30d (50%), 60d (30%), 90d (20%)" },
      { rotulo: "Capacidade considerada", valor: `${arredondar(capacidadePontos, 1)} pontos de responsaveis ativos` },
    ],
  };
}

function numero(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function arredondar(valor: number, casas = 2): number {
  if (!Number.isFinite(valor)) return 0;
  const fator = 10 ** casas;
  return Math.round(valor * fator) / fator;
}
