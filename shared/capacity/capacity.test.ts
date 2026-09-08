/**
 * Testes do nucleo de Capacidade Operacional.
 *
 * Roda com o test runner nativo do Node (>= 22), sem dependencia nova:
 *   npm run test:capacity
 *
 * A maioria dos casos aqui e' de BORDA, nao de caminho feliz. O caminho feliz
 * dessas contas e' trivial; o que quebra painel de capacidade em producao e'
 * divisao por zero, churn contado como ativo e previsao virando data absurda.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CONFIG_PADRAO, resolverConfig, validarConfig } from "./config.ts";
import {
  type EntradaCliente,
  type MetricasJanela,
  calcularBasePopulacional,
  calcularScoreCliente,
  calcularScores,
  contaComoCarga,
  normalizar,
  percentil,
} from "./workload.ts";
import { agregarPorResponsavel, faixaDe, folga, resumirOperacao, utilizacao } from "./capacity.ts";
import { crescimentoLiquidoDiaUtil, preverSaturacao } from "./forecast.ts";
import { simularContratacao, simularCrescimento } from "./simulate.ts";
import { RuleBasedInsightsProvider, recomendarProximoCliente } from "./insights.ts";

const HOJE = new Date("2026-09-07T12:00:00Z");

function metricas(parcial: Partial<MetricasJanela> = {}): MetricasJanela {
  return { whatsapp: 0, tasks: 0, criativos: 0, reunioes: 0, alertas: 0, risco: 0, ...parcial };
}

function cliente(id: string, parcial: Partial<EntradaCliente> = {}): EntradaCliente {
  return {
    clientId: id,
    nome: `Cliente ${id}`,
    lifecycle: "ACTIVE",
    gtOwner: "GT Um",
    metricas7d: metricas(),
    metricas30d: metricas(),
    ...parcial,
  };
}

// ---------------------------------------------------------------- config

test("config padrao e' valida e os pesos somam 1", () => {
  assert.deepEqual(validarConfig(CONFIG_PADRAO), []);
});

test("config invalida e' recusada em vez de calcular errado", () => {
  const quebrada = resolverConfig({ pesos: { ...CONFIG_PADRAO.pesos, whatsapp: 0.9 } });
  const problemas = validarConfig(quebrada);
  assert.ok(problemas.some((p) => p.campo === "pesos"));
});

test("config parcial do banco nao zera metrica ausente", () => {
  const resolvida = resolverConfig({ pesos: { whatsapp: 0.3 } as never });
  assert.equal(resolvida.pesos.tasks, CONFIG_PADRAO.pesos.tasks);
  assert.equal(resolvida.pesos.whatsapp, 0.3);
});

test("limites de faixa fora de ordem sao recusados", () => {
  const problemas = validarConfig(resolverConfig({ limitesFaixa: { saudavel: 90, atencao: 70, limite: 85, critico: 100 } }));
  assert.ok(problemas.some((p) => p.campo === "limitesFaixa"));
});

// ---------------------------------------------------------------- workload

test("percentil de lista vazia e' 0, nunca NaN", () => {
  assert.equal(percentil([], 0.9), 0);
  assert.ok(Number.isFinite(percentil([], 0.5)));
});

test("normalizar com p90 zero devolve 0 em vez de dividir por zero", () => {
  assert.equal(normalizar(10, 0), 0);
  assert.ok(Number.isFinite(normalizar(10, 0)));
});

test("normalizar trava outlier em 1.5", () => {
  assert.equal(normalizar(1000, 10), 1.5);
});

test("nenhuma metrica sozinha domina o score", () => {
  // Um cliente com WhatsApp absurdo e nada mais nao pode chegar perto do teto:
  // whatsapp pesa 25% e o normalizado trava em 1.5, logo intensidade <= 0.375.
  const carteira = [
    cliente("a", { metricas30d: metricas({ whatsapp: 100 }) }),
    cliente("b", { metricas30d: metricas({ whatsapp: 100 }) }),
    cliente("extremo", { metricas30d: metricas({ whatsapp: 100000 }) }),
  ];
  const scores = calcularScores(carteira, CONFIG_PADRAO, HOJE);
  const extremo = scores.find((s) => s.clientId === "extremo");
  assert.ok(extremo);
  assert.ok(extremo.score < 1.3, `score do extremo foi ${extremo.score}, deveria ficar abaixo de 1.3`);
});

test("cliente sem atividade nenhuma recebe o piso", () => {
  const scores = calcularScores([cliente("vazio")], CONFIG_PADRAO, HOJE);
  assert.equal(scores[0].score, CONFIG_PADRAO.pisoScore);
});

test("cliente pesado pontua acima do leve na mesma carteira", () => {
  const carteira = [
    cliente("leve", { metricas30d: metricas({ whatsapp: 5, tasks: 1 }) }),
    cliente("medio", { metricas30d: metricas({ whatsapp: 40, tasks: 8, reunioes: 2 }) }),
    cliente("pesado", { metricas30d: metricas({ whatsapp: 120, tasks: 30, criativos: 12, reunioes: 6, alertas: 8, risco: 3 }) }),
  ];
  const scores = calcularScores(carteira, CONFIG_PADRAO, HOJE);
  const porId = new Map(scores.map((s) => [s.clientId, s.score]));
  assert.ok((porId.get("pesado") as number) > (porId.get("medio") as number));
  assert.ok((porId.get("medio") as number) > (porId.get("leve") as number));
});

test("CHURNED e PRE_OPS_CHURN nao entram na carga", () => {
  assert.equal(contaComoCarga("CHURNED"), false);
  assert.equal(contaComoCarga("PRE_OPS_CHURN"), false);
  assert.equal(contaComoCarga("ACTIVE"), true);
  assert.equal(contaComoCarga("ONBOARDING"), true);

  const scores = calcularScores([
    cliente("ativo"),
    cliente("saiu", { lifecycle: "CHURNED" }),
    cliente("saiu-antes", { lifecycle: "PRE_OPS_CHURN" }),
  ], CONFIG_PADRAO, HOJE);
  assert.equal(scores.length, 1);
  assert.equal(scores[0].clientId, "ativo");
});

test("onboarding pesa mais que ativo com as mesmas metricas", () => {
  const mesmasMetricas = metricas({ whatsapp: 30, tasks: 5 });
  const carteira = [
    cliente("ativo", { metricas30d: mesmasMetricas }),
    cliente("onb", { lifecycle: "ONBOARDING", metricas30d: mesmasMetricas }),
  ];
  const scores = calcularScores(carteira, CONFIG_PADRAO, HOJE);
  const ativo = scores.find((s) => s.clientId === "ativo");
  const onb = scores.find((s) => s.clientId === "onb");
  assert.ok(onb && ativo && onb.score > ativo.score);
});

test("override vigente substitui o score automatico", () => {
  const base = calcularBasePopulacional([cliente("x")], CONFIG_PADRAO);
  const score = calcularScoreCliente(
    cliente("x", { override: { valor: 2.5, motivo: "cliente juridico", autor: "Adler", criadoEm: "2026-09-01", validoAte: null } }),
    base, CONFIG_PADRAO, HOJE,
  );
  assert.equal(score.origem, "OVERRIDE");
  assert.equal(score.score, 2.5);
  assert.ok(score.componentes.length > 0, "componentes continuam expostos para comparacao");
});

test("override expirado e' ignorado e volta ao automatico", () => {
  const base = calcularBasePopulacional([cliente("x")], CONFIG_PADRAO);
  const score = calcularScoreCliente(
    cliente("x", { override: { valor: 3.0, motivo: "pico temporario", autor: "Adler", criadoEm: "2026-07-01", validoAte: "2026-08-01" } }),
    base, CONFIG_PADRAO, HOJE,
  );
  assert.equal(score.origem, "AUTOMATICO");
});

test("override respeita o teto de score", () => {
  const base = calcularBasePopulacional([cliente("x")], CONFIG_PADRAO);
  const score = calcularScoreCliente(
    cliente("x", { override: { valor: 99, motivo: "erro de digitacao", autor: "Adler", criadoEm: "2026-09-01", validoAte: null } }),
    base, CONFIG_PADRAO, HOJE,
  );
  assert.equal(score.score, CONFIG_PADRAO.tetoScore);
});

test("carteira vazia nao quebra", () => {
  assert.deepEqual(calcularScores([], CONFIG_PADRAO, HOJE), []);
  assert.deepEqual(calcularScores([cliente("a", { lifecycle: "CHURNED" })], CONFIG_PADRAO, HOJE), []);
});

// ---------------------------------------------------------------- capacidade

test("capacidade zero devolve null, nunca Infinity", () => {
  assert.equal(utilizacao(50, 0), null);
  assert.equal(utilizacao(50, -10), null);
  assert.equal(folga(50, 0), null);
  assert.equal(faixaDe(null), "NAO_CALIBRADO");
});

test("faixas respeitam os limites configurados", () => {
  assert.equal(faixaDe(50), "SAUDAVEL");
  assert.equal(faixaDe(75), "ATENCAO");
  assert.equal(faixaDe(87), "LIMITE");
  assert.equal(faixaDe(95), "CRITICO");
  assert.equal(faixaDe(120), "SOBRECARGA");
});

test("GT com menos clientes pode estar mais carregado", () => {
  const scores = [
    ...Array.from({ length: 3 }, (_, i) => ({ clientId: `a${i}`, nome: "x", gtOwner: "GT A", lifecycle: "ACTIVE" as const, score: 2.0, origem: "AUTOMATICO" as const, intensidade: 0, componentes: [] })),
    ...Array.from({ length: 5 }, (_, i) => ({ clientId: `b${i}`, nome: "x", gtOwner: "GT B", lifecycle: "ACTIVE" as const, score: 0.8, origem: "AUTOMATICO" as const, intensidade: 0, componentes: [] })),
  ];
  const { cargas } = agregarPorResponsavel(scores, [
    { pessoa: "GT A", papel: "GT", capacidadePontos: 10, ativo: true },
    { pessoa: "GT B", papel: "GT", capacidadePontos: 10, ativo: true },
  ]);
  const a = cargas.find((c) => c.pessoa === "GT A");
  const b = cargas.find((c) => c.pessoa === "GT B");
  assert.ok(a && b);
  assert.ok(a.clientes < b.clientes, "GT A tem menos clientes");
  assert.ok((a.utilizacaoPct as number) > (b.utilizacaoPct as number), "e ainda assim esta mais carregado");
});

test("GT recem-contratado aparece com carga zero em vez de sumir", () => {
  const { cargas } = agregarPorResponsavel([], [{ pessoa: "Novo", papel: "GT", capacidadePontos: 50, ativo: true }]);
  assert.equal(cargas.length, 1);
  assert.equal(cargas[0].cargaPontos, 0);
  assert.equal(cargas[0].utilizacaoPct, 0);
  assert.equal(cargas[0].faixa, "SAUDAVEL");
});

test("cliente sem GT vai para o balde proprio e nao some da conta", () => {
  const { cargas, semResponsavel } = agregarPorResponsavel(
    [{ clientId: "orfao", nome: "x", gtOwner: null, lifecycle: "ACTIVE", score: 1.4, origem: "AUTOMATICO", intensidade: 0, componentes: [] }],
    [{ pessoa: "GT Um", papel: "GT", capacidadePontos: 50, ativo: true }],
  );
  assert.equal(cargas[0].clientes, 0);
  assert.equal(semResponsavel.clientes, 1);
  assert.equal(semResponsavel.cargaPontos, 1.4);

  const resumo = resumirOperacao(cargas, semResponsavel);
  assert.equal(resumo.clientesReais, 1, "o orfao continua contando no total da operacao");
});

test("GT afastado sai da capacidade agregada", () => {
  const { cargas, semResponsavel } = agregarPorResponsavel([], [
    { pessoa: "Ativo", papel: "GT", capacidadePontos: 70, ativo: true },
    { pessoa: "Afastado", papel: "GT", capacidadePontos: 70, ativo: false },
  ]);
  const resumo = resumirOperacao(cargas, semResponsavel);
  assert.equal(resumo.capacidadePontos, 70, "so a capacidade de quem esta ativo");
});

test("resumo sem nenhum responsavel calibrado nao produz NaN", () => {
  const { cargas, semResponsavel } = agregarPorResponsavel([], [{ pessoa: "X", papel: "GT", capacidadePontos: 0, ativo: true }]);
  const resumo = resumirOperacao(cargas, semResponsavel);
  assert.equal(resumo.utilizacaoPct, null);
  assert.equal(resumo.faixa, "NAO_CALIBRADO");
  assert.equal(resumo.clientesRestantesEstimados, null);
});

// ---------------------------------------------------------------- previsao

test("crescimento negativo nao vira previsao de saturacao", () => {
  const previsao = preverSaturacao(100, 200, { liquido30d: -5, liquido60d: -8, liquido90d: -10, cargaMediaNovoCliente: 1.1 }, CONFIG_PADRAO, HOJE);
  assert.equal(previsao.ate90.diasUteis, null);
  assert.equal(previsao.ate90.dataEstimada, null);
  assert.ok(previsao.ate90.motivo);
});

test("dias sem vendas devolvem motivo, nao data", () => {
  const previsao = preverSaturacao(100, 200, { liquido30d: 0, liquido60d: 0, liquido90d: 0, cargaMediaNovoCliente: 1 }, CONFIG_PADRAO, HOJE);
  assert.equal(previsao.ate100.diasUteis, null);
  assert.match(previsao.ate100.motivo ?? "", /sem crescimento/);
});

test("crescimento minusculo nao gera data absurda", () => {
  const previsao = preverSaturacao(10, 1000, { liquido30d: 0.1, liquido60d: 0.1, liquido90d: 0.1, cargaMediaNovoCliente: 1 }, CONFIG_PADRAO, HOJE);
  assert.equal(previsao.ate100.dataEstimada, null);
  assert.match(previsao.ate100.motivo ?? "", /2 anos/);
});

test("limiar ja atingido devolve zero dias, nao numero negativo", () => {
  const previsao = preverSaturacao(195, 200, { liquido30d: 10, liquido60d: 20, liquido90d: 30, cargaMediaNovoCliente: 1 }, CONFIG_PADRAO, HOJE);
  assert.equal(previsao.ate90.diasUteis, 0);
});

test("capacidade nao calibrada nao produz previsao", () => {
  const previsao = preverSaturacao(50, 0, { liquido30d: 10, liquido60d: 20, liquido90d: 30, cargaMediaNovoCliente: 1 }, CONFIG_PADRAO, HOJE);
  assert.match(previsao.ate90.motivo ?? "", /nao calibrada/);
});

test("previsao sempre acompanha as premissas", () => {
  const previsao = preverSaturacao(100, 200, { liquido30d: 8, liquido60d: 14, liquido90d: 20, cargaMediaNovoCliente: 1.2 }, CONFIG_PADRAO, HOJE);
  assert.ok(previsao.premissas.length >= 3);
  assert.ok(previsao.ate90.diasUteis !== null && previsao.ate90.diasUteis > 0);
  assert.ok(Number.isFinite(crescimentoLiquidoDiaUtil({ liquido30d: 8, liquido60d: 14, liquido90d: 20, cargaMediaNovoCliente: 1.2 })));
});

// ---------------------------------------------------------------- simuladores

test("simular +20 clientes eleva a utilizacao e conta quem estoura", () => {
  const { cargas } = agregarPorResponsavel(
    Array.from({ length: 40 }, (_, i) => ({ clientId: `c${i}`, nome: "x", gtOwner: i % 2 ? "A" : "B", lifecycle: "ACTIVE" as const, score: 1.5, origem: "AUTOMATICO" as const, intensidade: 0, componentes: [] })),
    [{ pessoa: "A", papel: "GT", capacidadePontos: 35, ativo: true }, { pessoa: "B", papel: "GT", capacidadePontos: 35, ativo: true }],
  );
  const resultado = simularCrescimento(cargas, { novosClientes: 20, periodoDias: 30, churnPrevisto: 0, cargaMediaNovoCliente: 1.1 });
  assert.ok((resultado.utilizacaoDepoisPct as number) > (resultado.utilizacaoAntesPct as number));
  assert.ok(resultado.responsaveisAcimaDoLimite > 0);
  assert.ok(resultado.premissas.length > 0);
});

test("churn maior que vendas alivia em vez de estourar", () => {
  const { cargas } = agregarPorResponsavel(
    Array.from({ length: 10 }, (_, i) => ({ clientId: `c${i}`, nome: "x", gtOwner: "A", lifecycle: "ACTIVE" as const, score: 1, origem: "AUTOMATICO" as const, intensidade: 0, componentes: [] })),
    [{ pessoa: "A", papel: "GT", capacidadePontos: 20, ativo: true }],
  );
  const resultado = simularCrescimento(cargas, { novosClientes: 2, periodoDias: 30, churnPrevisto: 6, cargaMediaNovoCliente: 1 });
  assert.equal(resultado.clientesLiquidos, -4);
  assert.ok((resultado.utilizacaoDepoisPct as number) < (resultado.utilizacaoAntesPct as number));
  assert.ok((resultado.utilizacaoDepoisPct as number) >= 0, "nunca negativo");
});

test("simular contratacao sem dado financeiro nao inventa valor", () => {
  const resultado = simularContratacao(180, 210, 1.2, { quantidade: 1, papel: "GT", capacidadePontosPorPessoa: 70 });
  assert.equal(resultado.custoMensalTotal, null);
  assert.equal(resultado.clientesParaPagarContratacao, null);
  assert.ok(resultado.faltando.includes("custo mensal da contratacao"));
  assert.ok((resultado.utilizacaoDepoisPct as number) < (resultado.utilizacaoAntesPct as number));
  assert.equal(resultado.capacidadeAdicionalPontos, 70);
});

test("simular contratacao com dados financeiros calcula quantos clientes pagam", () => {
  const resultado = simularContratacao(180, 210, 1.2, {
    quantidade: 1, papel: "GT", capacidadePontosPorPessoa: 70,
    custoMensalPorPessoa: 4500, ticketMedioMensal: 1400, margemEstimadaPorCliente: 900,
  });
  assert.equal(resultado.custoMensalTotal, 4500);
  assert.equal(resultado.clientesParaPagarContratacao, 5);
  assert.deepEqual(resultado.faltando, []);
});

// ---------------------------------------------------------------- insights

test("proximo cliente vai para quem tem maior folga, nao menos clientes", () => {
  const { cargas } = agregarPorResponsavel(
    [
      { clientId: "1", nome: "x", gtOwner: "PoucosPesados", lifecycle: "ACTIVE", score: 2.8, origem: "AUTOMATICO", intensidade: 0, componentes: [] },
      { clientId: "2", nome: "x", gtOwner: "PoucosPesados", lifecycle: "ACTIVE", score: 2.8, origem: "AUTOMATICO", intensidade: 0, componentes: [] },
      ...Array.from({ length: 5 }, (_, i) => ({ clientId: `l${i}`, nome: "x", gtOwner: "MuitosLeves", lifecycle: "ACTIVE" as const, score: 0.7, origem: "AUTOMATICO" as const, intensidade: 0, componentes: [] })),
    ],
    [{ pessoa: "PoucosPesados", papel: "GT", capacidadePontos: 7, ativo: true }, { pessoa: "MuitosLeves", papel: "GT", capacidadePontos: 7, ativo: true }],
  );
  const { recomendado } = recomendarProximoCliente(cargas);
  assert.equal(recomendado?.pessoa, "MuitosLeves");
});

test("sem ninguem com folga, a recomendacao diz isso em vez de escolher alguem", () => {
  const { cargas } = agregarPorResponsavel(
    [{ clientId: "1", nome: "x", gtOwner: "A", lifecycle: "ACTIVE", score: 10, origem: "AUTOMATICO", intensidade: 0, componentes: [] }],
    [{ pessoa: "A", papel: "GT", capacidadePontos: 5, ativo: true }],
  );
  const { recomendado, explicacao } = recomendarProximoCliente(cargas);
  assert.equal(recomendado, null);
  assert.match(explicacao, /Redistribuir ou contratar/);
});

test("saturacao dentro do lead time vira recomendacao de contratar ja", () => {
  const provider = new RuleBasedInsightsProvider();
  const { cargas, semResponsavel } = agregarPorResponsavel(
    Array.from({ length: 30 }, (_, i) => ({ clientId: `c${i}`, nome: "x", gtOwner: "A", lifecycle: "ACTIVE" as const, score: 1, origem: "AUTOMATICO" as const, intensidade: 0, componentes: [] })),
    [{ pessoa: "A", papel: "GT", capacidadePontos: 40, ativo: true }],
  );
  const resumo = resumirOperacao(cargas, semResponsavel);
  const previsao = preverSaturacao(resumo.cargaPontos, resumo.capacidadePontos, { liquido30d: 12, liquido60d: 22, liquido90d: 30, cargaMediaNovoCliente: 1.2 }, CONFIG_PADRAO, HOJE);
  const recomendacoes = provider.recomendar({ resumo, cargas, previsao, semResponsavel });
  assert.ok(recomendacoes.some((r) => r.codigo === "LEAD_TIME"), "deveria alertar sobre o lead time");
});

test("resumo executivo e' deterministico e nunca imprime NaN", () => {
  const provider = new RuleBasedInsightsProvider();
  const { cargas, semResponsavel } = agregarPorResponsavel(
    Array.from({ length: 12 }, (_, i) => ({ clientId: `c${i}`, nome: "x", gtOwner: "A", lifecycle: "ACTIVE" as const, score: 1.4, origem: "AUTOMATICO" as const, intensidade: 0, componentes: [] })),
    [{ pessoa: "A", papel: "GT", capacidadePontos: 25, ativo: true }],
  );
  const resumo = resumirOperacao(cargas, semResponsavel);
  const previsao = preverSaturacao(resumo.cargaPontos, resumo.capacidadePontos, { liquido30d: 3, liquido60d: 5, liquido90d: 7, cargaMediaNovoCliente: 1.3 }, CONFIG_PADRAO, HOJE);
  const estado = { resumo, cargas, previsao, semResponsavel };

  const primeiro = provider.resumoExecutivo(estado);
  const segundo = provider.resumoExecutivo(estado);
  assert.equal(primeiro, segundo, "mesma entrada, mesmo texto");
  assert.doesNotMatch(primeiro, /NaN|Infinity|undefined|null/);
});

test("operacao sem calibragem produz resumo explicativo, nao numero quebrado", () => {
  const provider = new RuleBasedInsightsProvider();
  const { cargas, semResponsavel } = agregarPorResponsavel([], [{ pessoa: "A", papel: "GT", capacidadePontos: 0, ativo: true }]);
  const resumo = resumirOperacao(cargas, semResponsavel);
  const previsao = preverSaturacao(0, 0, { liquido30d: 0, liquido60d: 0, liquido90d: 0, cargaMediaNovoCliente: 1 }, CONFIG_PADRAO, HOJE);
  const texto = provider.resumoExecutivo({ resumo, cargas, previsao, semResponsavel });
  assert.match(texto, /nao calibrada/);
  assert.doesNotMatch(texto, /NaN|Infinity/);
});
