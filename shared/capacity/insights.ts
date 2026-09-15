/**
 * Recomendacoes e resumo executivo.
 *
 * Tudo aqui e' deterministico. LLM nao entra para escrever frase que a regra
 * ja' sabe escrever: custa dinheiro, adiciona latencia e introduz variacao numa
 * tela onde a mesma situacao precisa produzir sempre o mesmo texto.
 *
 * A interface `OperationalCapacityInsightsProvider` existe para o dia em que
 * fizer sentido plugar analise que a regra NAO consegue fazer -- correlacao
 * entre setores, deteccao de padrao historico. O contrato ja' esta' pronto; a
 * implementacao de hoje e' a de regras.
 */

import { type ConfigCapacidade, CONFIG_PADRAO } from "./config.ts";
import { type CargaResponsavel, type ResumoOperacao } from "./capacity.ts";
import { type ResultadoPrevisao } from "./forecast.ts";

export type Severidade = "INFO" | "ATENCAO" | "ALTO" | "CRITICO";

export type Recomendacao = {
  codigo: string;
  severidade: Severidade;
  titulo: string;
  detalhe: string;
};

export type EstadoCapacidade = {
  resumo: ResumoOperacao;
  cargas: CargaResponsavel[];
  previsao: ResultadoPrevisao;
  semResponsavel: { clientes: number; cargaPontos: number };
};

export interface OperationalCapacityInsightsProvider {
  readonly tipo: "RULE_BASED" | "AI";
  recomendar(estado: EstadoCapacidade, config?: ConfigCapacidade): Recomendacao[];
  resumoExecutivo(estado: EstadoCapacidade, config?: ConfigCapacidade): string;
}

function nomeMaisCarregado(cargas: CargaResponsavel[]): CargaResponsavel | null {
  const calibrados = cargas.filter((c) => c.ativo && c.utilizacaoPct !== null);
  if (!calibrados.length) return null;
  return calibrados.reduce((pior, atual) =>
    (atual.utilizacaoPct as number) > (pior.utilizacaoPct as number) ? atual : pior,
  );
}

/** Quem deve receber o proximo cliente: maior folga ABSOLUTA em pontos. */
export function recomendarProximoCliente(
  cargas: CargaResponsavel[],
  papel = "GT",
): { recomendado: CargaResponsavel | null; explicacao: string } {
  const elegiveis = (cargas ?? []).filter(
    (c) => c.ativo && c.papel === papel && c.folgaPontos !== null && c.folgaPontos > 0,
  );
  if (!elegiveis.length) {
    return {
      recomendado: null,
      explicacao: "Nenhum responsavel com folga positiva e capacidade calibrada. Redistribuir ou contratar antes da proxima entrada.",
    };
  }
  const recomendado = elegiveis.reduce((melhor, atual) =>
    (atual.folgaPontos as number) > (melhor.folgaPontos as number) ? atual : melhor,
  );
  return {
    recomendado,
    explicacao: `${recomendado.pessoa} tem a maior capacidade livre no momento: ${recomendado.folgaPontos} pontos, com utilizacao de ${recomendado.utilizacaoPct}%.`,
  };
}

export class RuleBasedInsightsProvider implements OperationalCapacityInsightsProvider {
  readonly tipo = "RULE_BASED" as const;

  recomendar(estado: EstadoCapacidade, config: ConfigCapacidade = CONFIG_PADRAO): Recomendacao[] {
    const recomendacoes: Recomendacao[] = [];
    const { resumo, cargas, previsao } = estado;
    const { saudavel, atencao, limite, critico } = config.limitesFaixa;
    const util = resumo.utilizacaoPct;

    if (util === null) {
      recomendacoes.push({
        codigo: "NAO_CALIBRADO",
        severidade: "INFO",
        titulo: "Capacidade ainda nao calibrada",
        detalhe: "Nenhum responsavel ativo tem capacidade configurada. Defina os pontos por profissional para habilitar as previsoes.",
      });
      return recomendacoes;
    }

    if (util < saudavel) {
      recomendacoes.push({ codigo: "SAUDAVEL", severidade: "INFO", titulo: "Operacao saudavel", detalhe: `Utilizacao em ${util}%, dentro da faixa confortavel.` });
    } else if (util < atencao) {
      recomendacoes.push({ codigo: "MONITORAR", severidade: "ATENCAO", titulo: "Monitorar crescimento", detalhe: `Utilizacao em ${util}%. Ainda ha' folga, mas o ritmo de entrada merece acompanhamento.` });
    } else if (util < limite) {
      recomendacoes.push({ codigo: "PLANEJAR", severidade: "ALTO", titulo: "Planejar a proxima contratacao", detalhe: `Utilizacao em ${util}%. Comece a mapear candidatos antes de a folga acabar.` });
    } else if (util <= critico) {
      recomendacoes.push({ codigo: "CONTRATAR", severidade: "CRITICO", titulo: "Iniciar contratacao", detalhe: `Utilizacao em ${util}%. A operacao esta' no limite de absorcao.` });
    } else {
      recomendacoes.push({ codigo: "URGENTE", severidade: "CRITICO", titulo: "Redistribuicao ou contratacao urgente", detalhe: `Utilizacao em ${util}%, acima da capacidade configurada.` });
    }

    // A regra que realmente decide: se a saturacao chega antes de a contratacao
    // ficar pronta, planejar ja' e' tarde.
    const dias90 = previsao?.ate90?.diasUteis;
    if (typeof dias90 === "number" && dias90 <= config.leadTimeContratacaoDias && util < limite) {
      recomendacoes.push({
        codigo: "LEAD_TIME",
        severidade: "CRITICO",
        titulo: "Iniciar contratacao imediatamente",
        detalhe: `A estimativa aponta 90% em ${dias90} dias uteis, dentro do lead time de ${config.leadTimeContratacaoDias} dias. Comecar depois disso chega atrasado.`,
      });
    }

    const sobrecarregados = cargas.filter(
      (c) => c.ativo && c.utilizacaoPct !== null && c.utilizacaoPct >= limite,
    );
    for (const carga of sobrecarregados) {
      recomendacoes.push({
        codigo: "RESPONSAVEL_NO_LIMITE",
        severidade: carga.utilizacaoPct !== null && carga.utilizacaoPct > critico ? "CRITICO" : "ALTO",
        titulo: `${carga.pessoa} em ${carga.utilizacaoPct}% da capacidade`,
        detalhe: `${carga.clientes} clientes, ${carga.cargaPontos} de ${carga.capacidadePontos} pontos. Nao direcionar novas entradas para esta carteira.`,
      });
    }

    const naoCalibrados = cargas.filter((c) => c.ativo && c.utilizacaoPct === null);
    if (naoCalibrados.length) {
      recomendacoes.push({
        codigo: "PARCIAL",
        severidade: "ATENCAO",
        titulo: "Capacidade incompleta",
        detalhe: `${naoCalibrados.length} responsavel(is) ativo(s) sem capacidade configurada. Os numeros gerais estao subestimados ate' a configuracao ser preenchida.`,
      });
    }

    if (estado.semResponsavel?.clientes > 0) {
      recomendacoes.push({
        codigo: "SEM_RESPONSAVEL",
        severidade: "ATENCAO",
        titulo: `${estado.semResponsavel.clientes} cliente(s) sem responsavel`,
        detalhe: `Somam ${estado.semResponsavel.cargaPontos} pontos que entram no total da operacao mas nao aparecem em nenhuma carteira.`,
      });
    }

    return recomendacoes;
  }

  resumoExecutivo(estado: EstadoCapacidade, config: ConfigCapacidade = CONFIG_PADRAO): string {
    const { resumo, cargas, previsao } = estado;
    if (resumo.utilizacaoPct === null) {
      return "Capacidade ainda nao calibrada. Configure os pontos de capacidade por responsavel para que o modulo possa calcular utilizacao e previsoes.";
    }

    const partes: string[] = [`Operacao em ${resumo.utilizacaoPct}%.`];

    const pior = nomeMaisCarregado(cargas);
    if (pior) partes.push(`Maior carga: ${pior.pessoa}, em ${pior.utilizacaoPct}%.`);

    const { recomendado } = recomendarProximoCliente(cargas);
    if (recomendado) partes.push(`${recomendado.pessoa} tem cerca de ${recomendado.folgaPontos} pontos livres.`);

    const dias90 = previsao?.ate90;
    if (typeof dias90?.diasUteis === "number" && dias90.diasUteis > 0) {
      partes.push(
        `Mantendo o crescimento liquido dos ultimos 30 dias, a operacao deve atingir 90% em aproximadamente ${dias90.diasUteis} dias uteis.`,
      );
    } else if (dias90?.motivo) {
      partes.push(`Sem estimativa de saturacao: ${dias90.motivo}.`);
    }

    const util = resumo.utilizacaoPct;
    if (util >= config.limitesFaixa.critico) partes.push("Recomendacao: redistribuir carteira ou contratar com urgencia.");
    else if (util >= config.limitesFaixa.limite) partes.push("Recomendacao: iniciar contratacao.");
    else if (util >= config.limitesFaixa.atencao) partes.push("Recomendacao: planejar a proxima contratacao.");
    else partes.push("Recomendacao: nenhuma contratacao necessaria no momento.");

    return partes.join(" ");
  }
}
