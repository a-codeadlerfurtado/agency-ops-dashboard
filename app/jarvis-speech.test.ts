/**
 * Testes da fala em blocos, do medidor de nivel e do detector de interrupcao.
 *
 *   npm run test:jarvis
 */

import test from "node:test";
import assert from "node:assert/strict";

import { dividirFala, suavizarNivel, passoInterrupcao, INTERRUPCAO, type EstadoInterrupcao } from "./jarvis-speech.ts";
import { idDeTela, referenciaClienteDaTela, resolverClienteDaTela } from "../worker/jarvis/screen-context.ts";

const LONGA = "O Caio Montenegro teve 12 leads ontem, com custo por lead de R$ 18,40. "
  + "Hoje a campanha principal já entregou 5 leads e o saldo da conta cobre mais quatro dias no ritmo atual. "
  + "Se quiser, eu detalho por campanha.";

test("resposta curta fica em um bloco so", () => {
  assert.deepEqual(dividirFala("O Caio teve 12 leads ontem."), ["O Caio teve 12 leads ontem."]);
  assert.deepEqual(dividirFala(""), []);
  assert.deepEqual(dividirFala("   "), []);
});

test("resposta longa vira primeira frase + restante, sem perder texto", () => {
  const partes = dividirFala(LONGA);
  assert.equal(partes.length, 2);
  assert.equal(partes[0], "O Caio Montenegro teve 12 leads ontem, com custo por lead de R$ 18,40.");
  assert.equal(partes.join(" "), LONGA);
});

test("nunca passa de dois blocos", () => {
  const texto = Array.from({ length: 12 }, (_, i) => `Esta é a frase número ${i + 1} da resposta da Jarvis.`).join(" ");
  assert.equal(dividirFala(texto).length, 2);
});

test("numero com ponto e abreviacao nao sao fim de frase", () => {
  const texto = "O investimento do Sr. João Batista da Silva chegou a 1.500 reais nos últimos sete dias de veiculação. "
    + "O custo por lead ficou em 22 reais, dentro da meta combinada com o cliente para este mês de campanha.";
  const partes = dividirFala(texto);
  assert.equal(partes.length, 2);
  assert.ok(partes[0].includes("Sr. João"));
  assert.ok(partes[0].includes("1.500 reais"));
  assert.ok(partes[0].endsWith("veiculação."));
});

test("primeira frase curta demais e' agrupada com a seguinte", () => {
  const texto = "Certo. O cliente Painel Connect Imóveis está com três campanhas ativas e teve 9 leads hoje até agora. "
    + "O saldo disponível na conta de anúncios cobre aproximadamente seis dias de veiculação no ritmo atual.";
  const partes = dividirFala(texto);
  assert.equal(partes.length, 2);
  assert.ok(partes[0].startsWith("Certo. O cliente"));
});

test("sobra pequena nao gera segundo pedido de sintese", () => {
  const texto = "O cliente Painel Connect Imóveis está com três campanhas ativas, nove leads hoje e saldo para aproximadamente seis dias de veiculação no ritmo atual. Quer o detalhe?";
  assert.equal(dividirFala(texto).length, 1);
});

test("nivel sobe rapido e desce devagar, sempre entre 0 e 1", () => {
  const subiu = suavizarNivel(0, 1);
  const desceu = suavizarNivel(1, 0);
  assert.ok(subiu > 0.5);
  assert.ok(desceu > 0.8);
  assert.equal(suavizarNivel(0.2, 5) <= 1, true);
  assert.equal(suavizarNivel(Number.NaN, 0.5) >= 0, true);
});

function rodar(amostras: Array<[number, number]>): boolean {
  let estado: EstadoInterrupcao = { ecoMax: 0, acimaMs: 0 };
  for (const [t, rms] of amostras) {
    const r = passoInterrupcao(estado, t, rms);
    estado = r.estado;
    if (r.interromper) return true;
  }
  return false;
}

function serie(deMs: number, ateMs: number, rms: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let t = deMs; t < ateMs; t += INTERRUPCAO.passoMs) out.push([t, rms]);
  return out;
}

test("eco da propria Jarvis nao interrompe", () => {
  // O microfone ouve 0.03 de eco o tempo todo: calibra nisso e nunca dispara.
  assert.equal(rodar(serie(0, 4000, 0.03)), false);
});

test("eco alto calibrado tambem nao interrompe", () => {
  assert.equal(rodar(serie(0, 4000, 0.09)), false);
});

test("fala sustentada por cima interrompe", () => {
  assert.equal(rodar([...serie(0, 800, 0.02), ...serie(800, 1200, 0.2)]), true);
});

test("clique curto ou tosse nao interrompe", () => {
  assert.equal(rodar([...serie(0, 800, 0.02), ...serie(800, 920, 0.3), ...serie(920, 2000, 0.02)]), false);
});

test("nada dispara durante a calibragem", () => {
  assert.equal(rodar(serie(0, INTERRUPCAO.calibragemMs, 0.9)), false);
});

// ------------------------------------------------- contexto de tela

const CLIENTES = [
  { client_id: "11111111-1111-4111-8111-111111111111", display_name: "Caio Montenegro" },
  { client_id: "22222222-2222-4222-8222-222222222222", display_name: "Painel Connect Imóveis" },
];

test("idDeTela aceita so UUID", () => {
  assert.equal(idDeTela("11111111-1111-4111-8111-111111111111"), "11111111-1111-4111-8111-111111111111");
  assert.equal(idDeTela("1; drop table"), null);
  assert.equal(idDeTela(null), null);
  assert.equal(idDeTela({}), null);
});

test("frase que aponta para a tela", () => {
  for (const f of ["quantos leads ele teve ontem?", "qual o saldo dessa conta", "como está esse cliente", "e o CPL dela hoje?", "quanto gastou essa imobiliária aqui"]) {
    assert.equal(referenciaClienteDaTela(f), true, f);
  }
  for (const f of ["quantos leads tivemos hoje?", "quantos clientes ativos temos", "qual o saldo do Caio Montenegro", "me passa o panorama geral"]) {
    assert.equal(referenciaClienteDaTela(f), false, f);
  }
});

test("cliente da tela so vale com frase apontando e dentro da lista permitida", () => {
  const id = CLIENTES[1].client_id;
  assert.equal(resolverClienteDaTela("quantos leads ele teve ontem?", id, CLIENTES)?.display_name, "Painel Connect Imóveis");
  // pergunta global com drawer aberto: tela ignorada
  assert.equal(resolverClienteDaTela("quantos leads tivemos hoje?", id, CLIENTES), null);
  // UUID fora da lista do usuario: ignorado
  assert.equal(resolverClienteDaTela("quantos leads ele teve?", "33333333-3333-4333-8333-333333333333", CLIENTES), null);
  // lixo vindo do navegador: ignorado
  assert.equal(resolverClienteDaTela("quantos leads ele teve?", "abc", CLIENTES), null);
  assert.equal(resolverClienteDaTela("quantos leads ele teve?", id, []), null);
});
