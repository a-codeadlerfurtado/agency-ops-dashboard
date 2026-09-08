/**
 * Simuladores: crescimento, contratacao e comparacao de cenarios.
 *
 * Regra que vale para os tres: valor financeiro AUSENTE nao vira zero nem
 * estimativa. Vira `null` com um motivo, e a UI pede o numero. Payback
 * calculado sobre custo inventado e' pior que payback nenhum -- alguem contrata
 * em cima dele.
 */

import { type ConfigCapacidade, CONFIG_PADRAO } from "./config.ts";
import { type CargaResponsavel, faixaDe, utilizacao } from "./capacity.ts";
import { type Faixa } from "./config.ts";

export type CenarioCrescimento = {
  novosClientes: number;
  /** Horizonte em dias corridos. So rotula o cenario; nao entra na conta. */
  periodoDias: 7 | 15 | 30 | 60 | 90;
  churnPrevisto: number;
  /** Carga media atribuida a cada cliente novo. */
  cargaMediaNovoCliente: number;
};

export type ImpactoResponsavel = {
  pessoa: string;
  utilizacaoAntesPct: number | null;
  utilizacaoDepoisPct: number | null;
  faixaAntes: Faixa | "NAO_CALIBRADO";
  faixaDepois: Faixa | "NAO_CALIBRADO";
  cargaDepoisPontos: number;
};

export type ResultadoCrescimento = {
  clientesLiquidos: number;
  cargaAdicionalPontos: number;
  utilizacaoAntesPct: number | null;
  utilizacaoDepoisPct: number | null;
  faixaDepois: Faixa | "NAO_CALIBRADO";
  responsaveisAcimaDoLimite: number;
  impactos: ImpactoResponsavel[];
  premissas: string[];
};

/**
 * Distribui os clientes novos por MAIOR FOLGA, um a um.
 *
 * Distribuir igualmente entre os GTs seria mais simples e estaria errado: a
 * operacao real manda o cliente para quem tem espaco, entao simular divisao
 * uniforme sempre estoura o GT que ja estava cheio e superestima o problema.
 * Responsavel nao calibrado fica de fora do rateio -- sem capacidade nao da'
 * para saber se cabe.
 */
function distribuirPorFolga(cargas: CargaResponsavel[], cargaTotal: number): Map<string, number> {
  const destino = new Map<string, number>();
  const elegiveis = cargas.filter((c) => c.ativo && c.capacidadePontos > 0);
  if (!elegiveis.length || cargaTotal <= 0) return destino;

  // Passos pequenos aproximam a chegada gradual dos clientes; um lote unico
  // no GT mais folgado distorceria o resultado.
  const passos = Math.max(1, Math.ceil(cargaTotal));
  const incremento = cargaTotal / passos;
  const acumulado = new Map(elegiveis.map((c) => [c.pessoa, c.cargaPontos]));

  for (let i = 0; i < passos; i += 1) {
    let melhor = elegiveis[0];
    let melhorFolga = -Infinity;
    for (const candidato of elegiveis) {
      const folgaAtual = candidato.capacidadePontos - (acumulado.get(candidato.pessoa) ?? 0);
      if (folgaAtual > melhorFolga) { melhorFolga = folgaAtual; melhor = candidato; }
    }
    acumulado.set(melhor.pessoa, (acumulado.get(melhor.pessoa) ?? 0) + incremento);
    destino.set(melhor.pessoa, (destino.get(melhor.pessoa) ?? 0) + incremento);
  }
  return destino;
}

export function simularCrescimento(
  cargas: CargaResponsavel[],
  cenario: CenarioCrescimento,
  config: ConfigCapacidade = CONFIG_PADRAO,
): ResultadoCrescimento {
  const ativos = (cargas ?? []).filter((c) => c.ativo);
  const liquidos = numero(cenario?.novosClientes) - numero(cenario?.churnPrevisto);
  const cargaMedia = numero(cenario?.cargaMediaNovoCliente) || 1;
  const cargaAdicional = arredondar(liquidos * cargaMedia);

  const cargaAtual = ativos.reduce((total, c) => total + c.cargaPontos, 0);
  const capacidade = ativos.reduce((total, c) => total + c.capacidadePontos, 0);
  const distribuicao = distribuirPorFolga(ativos, Math.max(0, cargaAdicional));

  // Churn liquido negativo alivia a operacao inteira proporcionalmente: nao da'
  // para saber de quem sera' o cliente que sai.
  const fatorAlivio = cargaAdicional < 0 && cargaAtual > 0 ? 1 + cargaAdicional / cargaAtual : 1;

  const impactos: ImpactoResponsavel[] = ativos.map((carga) => {
    const acrescimo = distribuicao.get(carga.pessoa) ?? 0;
    const depois = arredondar(cargaAdicional < 0 ? carga.cargaPontos * fatorAlivio : carga.cargaPontos + acrescimo);
    const utilDepois = utilizacao(depois, carga.capacidadePontos);
    return {
      pessoa: carga.pessoa,
      utilizacaoAntesPct: carga.utilizacaoPct,
      utilizacaoDepoisPct: utilDepois,
      faixaAntes: carga.faixa,
      faixaDepois: faixaDe(utilDepois, config),
      cargaDepoisPontos: depois,
    };
  });

  const cargaDepois = arredondar(Math.max(0, cargaAtual + cargaAdicional));
  const utilDepois = utilizacao(cargaDepois, capacidade);

  return {
    clientesLiquidos: liquidos,
    cargaAdicionalPontos: cargaAdicional,
    utilizacaoAntesPct: utilizacao(arredondar(cargaAtual), capacidade),
    utilizacaoDepoisPct: utilDepois,
    faixaDepois: faixaDe(utilDepois, config),
    responsaveisAcimaDoLimite: impactos.filter(
      (i) => i.utilizacaoDepoisPct !== null && i.utilizacaoDepoisPct >= config.limitesFaixa.limite,
    ).length,
    impactos,
    premissas: [
      `${cenario?.novosClientes ?? 0} entradas e ${cenario?.churnPrevisto ?? 0} saidas em ${cenario?.periodoDias ?? 30} dias`,
      `carga media de ${cargaMedia.toFixed(2)} ponto por cliente novo`,
      "novos clientes distribuidos para quem tem maior folga a cada passo",
    ],
  };
}

export type CenarioContratacao = {
  quantidade: number;
  papel: "GT" | "CS" | "DESIGN" | "OUTRO";
  capacidadePontosPorPessoa: number;
  /** Ausentes quando a operacao ainda nao informou. Nao inventar. */
  custoMensalPorPessoa?: number | null;
  ticketMedioMensal?: number | null;
  margemEstimadaPorCliente?: number | null;
};

export type ResultadoContratacao = {
  utilizacaoAntesPct: number | null;
  utilizacaoDepoisPct: number | null;
  capacidadeAdicionalPontos: number;
  clientesEquivalentesAdicionais: number | null;
  custoMensalTotal: number | null;
  clientesParaPagarContratacao: number | null;
  paybackMeses: number | null;
  /** O que faltou para completar a conta financeira. */
  faltando: string[];
};

export function simularContratacao(
  cargaAtualPontos: number,
  capacidadeAtualPontos: number,
  cargaMediaPorCliente: number | null,
  cenario: CenarioContratacao,
): ResultadoContratacao {
  const quantidade = Math.max(0, Math.floor(numero(cenario?.quantidade)));
  const capacidadeAdicional = arredondar(quantidade * numero(cenario?.capacidadePontosPorPessoa));
  const capacidadeDepois = arredondar(capacidadeAtualPontos + capacidadeAdicional);

  const faltando: string[] = [];
  const custoUnitario = valorOpcional(cenario?.custoMensalPorPessoa);
  const margemPorCliente = valorOpcional(cenario?.margemEstimadaPorCliente);
  if (custoUnitario === null) faltando.push("custo mensal da contratacao");
  if (margemPorCliente === null) faltando.push("margem operacional estimada por cliente");

  const custoTotal = custoUnitario === null ? null : arredondar(custoUnitario * quantidade);
  const clientesParaPagar =
    custoTotal === null || margemPorCliente === null || margemPorCliente <= 0
      ? null
      : Math.ceil(custoTotal / margemPorCliente);

  return {
    utilizacaoAntesPct: utilizacao(cargaAtualPontos, capacidadeAtualPontos),
    utilizacaoDepoisPct: utilizacao(cargaAtualPontos, capacidadeDepois),
    capacidadeAdicionalPontos: capacidadeAdicional,
    clientesEquivalentesAdicionais:
      cargaMediaPorCliente && cargaMediaPorCliente > 0
        ? Math.floor(capacidadeAdicional / cargaMediaPorCliente)
        : null,
    custoMensalTotal: custoTotal,
    clientesParaPagarContratacao: clientesParaPagar,
    // Payback so faz sentido com ritmo de vendas; sem ele seria numero
    // decorativo. Fica para a fatia que integra o forecast comercial.
    paybackMeses: null,
    faltando,
  };
}

function valorOpcional(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function numero(valor: unknown): number {
  const n = Number(valor);
  return Number.isFinite(n) ? n : 0;
}

function arredondar(valor: number): number {
  if (!Number.isFinite(valor)) return 0;
  return Math.round(valor * 100) / 100;
}
