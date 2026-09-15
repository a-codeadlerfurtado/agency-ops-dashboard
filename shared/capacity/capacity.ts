/**
 * Utilizacao, faixas e folga.
 *
 * Contrato inegociavel deste arquivo: nunca devolver NaN, Infinity ou data
 * absurda. Capacidade zero, carteira vazia e GT recem-contratado sao estados
 * NORMAIS da operacao, nao erro -- cada um tem uma resposta propria e nenhuma
 * delas e' uma divisao por zero vazando para a tela.
 */

import { type ConfigCapacidade, type Faixa, CONFIG_PADRAO } from "./config.ts";
import { type ScoreCliente } from "./workload.ts";

export type CapacidadeResponsavel = {
  /** Nome canonico em team_roster.person. */
  pessoa: string;
  papel: string;
  capacidadePontos: number;
  /** Falso para GT afastado: continua na lista, sai da capacidade agregada. */
  ativo: boolean;
};

export type CargaResponsavel = {
  pessoa: string;
  papel: string;
  clientes: number;
  clientesOnboarding: number;
  cargaPontos: number;
  capacidadePontos: number;
  /** Null quando a capacidade nao esta calibrada. Nunca Infinity. */
  utilizacaoPct: number | null;
  folgaPontos: number | null;
  faixa: Faixa | "NAO_CALIBRADO";
  ativo: boolean;
};

export function faixaDe(utilizacaoPct: number | null, config: ConfigCapacidade = CONFIG_PADRAO): Faixa | "NAO_CALIBRADO" {
  if (utilizacaoPct === null || !Number.isFinite(utilizacaoPct)) return "NAO_CALIBRADO";
  const { saudavel, atencao, limite, critico } = config.limitesFaixa;
  if (utilizacaoPct < saudavel) return "SAUDAVEL";
  if (utilizacaoPct < atencao) return "ATENCAO";
  if (utilizacaoPct < limite) return "LIMITE";
  if (utilizacaoPct <= critico) return "CRITICO";
  return "SOBRECARGA";
}

/**
 * Capacidade <= 0 devolve null, nao Infinity.
 *
 * Um GT sem capacidade configurada nao esta "infinitamente sobrecarregado":
 * ele esta NAO CALIBRADO, e a UI precisa oferecer a configuracao em vez de
 * pintar um card vermelho que ninguem sabe interpretar.
 */
export function utilizacao(cargaPontos: number, capacidadePontos: number): number | null {
  if (!Number.isFinite(capacidadePontos) || capacidadePontos <= 0) return null;
  if (!Number.isFinite(cargaPontos) || cargaPontos < 0) return 0;
  return arredondar((cargaPontos / capacidadePontos) * 100);
}

export function folga(cargaPontos: number, capacidadePontos: number): number | null {
  if (!Number.isFinite(capacidadePontos) || capacidadePontos <= 0) return null;
  const carga = Number.isFinite(cargaPontos) && cargaPontos > 0 ? cargaPontos : 0;
  return arredondar(capacidadePontos - carga);
}

/**
 * Agrega scores por responsavel.
 *
 * Responsaveis configurados sem nenhum cliente APARECEM com carga 0 -- some-los
 * esconderia justamente o GT recem-contratado, que e' quem deveria receber o
 * proximo cliente. Cliente sem GT vai para o balde `semResponsavel`, que a UI
 * mostra como pendencia de atribuicao em vez de somar na conta de alguem.
 */
export function agregarPorResponsavel(
  scores: ScoreCliente[],
  responsaveis: CapacidadeResponsavel[],
  config: ConfigCapacidade = CONFIG_PADRAO,
): { cargas: CargaResponsavel[]; semResponsavel: { clientes: number; cargaPontos: number } } {
  const porPessoa = new Map<string, ScoreCliente[]>();
  let semDono: ScoreCliente[] = [];

  for (const score of scores ?? []) {
    const dono = (score.gtOwner ?? "").trim();
    if (!dono) { semDono = semDono.concat(score); continue; }
    porPessoa.set(dono, (porPessoa.get(dono) ?? []).concat(score));
  }

  const cargas: CargaResponsavel[] = (responsaveis ?? []).map((responsavel) => {
    const meus = porPessoa.get(responsavel.pessoa) ?? [];
    const cargaPontos = arredondar(meus.reduce((total, s) => total + s.score, 0));
    const util = utilizacao(cargaPontos, responsavel.capacidadePontos);
    return {
      pessoa: responsavel.pessoa,
      papel: responsavel.papel,
      clientes: meus.length,
      clientesOnboarding: meus.filter((s) => s.lifecycle === "ONBOARDING").length,
      cargaPontos,
      capacidadePontos: responsavel.capacidadePontos,
      utilizacaoPct: util,
      folgaPontos: folga(cargaPontos, responsavel.capacidadePontos),
      faixa: faixaDe(util, config),
      ativo: responsavel.ativo,
    };
  });

  return {
    cargas,
    semResponsavel: {
      clientes: semDono.length,
      cargaPontos: arredondar(semDono.reduce((total, s) => total + s.score, 0)),
    },
  };
}

export type ResumoOperacao = {
  clientesReais: number;
  clientesOnboarding: number;
  clientesEquivalentes: number;
  cargaPontos: number;
  capacidadePontos: number;
  utilizacaoPct: number | null;
  folgaPontos: number | null;
  folgaPct: number | null;
  faixa: Faixa | "NAO_CALIBRADO";
  /** Quantos clientes MEDIOS ainda cabem. Null quando nao ha' base para media. */
  clientesRestantesEstimados: number | null;
  cargaMediaPorCliente: number | null;
};

/**
 * Consolidado da operacao.
 *
 * Soma so responsaveis ATIVOS: contar a capacidade de quem esta afastado
 * inventaria folga que nao existe -- e' o erro que faz a operacao descobrir o
 * gargalo depois que ele ja aconteceu.
 */
export function resumirOperacao(
  cargas: CargaResponsavel[],
  semResponsavel: { clientes: number; cargaPontos: number },
  config: ConfigCapacidade = CONFIG_PADRAO,
): ResumoOperacao {
  const ativos = (cargas ?? []).filter((c) => c.ativo);
  const cargaPontos = arredondar(
    ativos.reduce((total, c) => total + c.cargaPontos, 0) + (semResponsavel?.cargaPontos ?? 0),
  );
  const capacidadePontos = arredondar(ativos.reduce((total, c) => total + c.capacidadePontos, 0));
  const clientesReais = ativos.reduce((total, c) => total + c.clientes, 0) + (semResponsavel?.clientes ?? 0);
  const clientesOnboarding = ativos.reduce((total, c) => total + c.clientesOnboarding, 0);

  const util = utilizacao(cargaPontos, capacidadePontos);
  const folgaPontos = folga(cargaPontos, capacidadePontos);
  const cargaMedia = clientesReais > 0 ? arredondar(cargaPontos / clientesReais) : null;

  return {
    clientesReais,
    clientesOnboarding,
    clientesEquivalentes: cargaPontos,
    cargaPontos,
    capacidadePontos,
    utilizacaoPct: util,
    folgaPontos,
    folgaPct: util === null ? null : arredondar(Math.max(0, 100 - util)),
    faixa: faixaDe(util, config),
    clientesRestantesEstimados:
      folgaPontos === null || cargaMedia === null || cargaMedia <= 0
        ? null
        : Math.max(0, Math.floor(folgaPontos / cargaMedia)),
    cargaMediaPorCliente: cargaMedia,
  };
}

function arredondar(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.round(valor * 100) / 100;
}
