/**
 * Testes das barreiras que NAO podem depender do modelo.
 *
 *   npm run test:jarvis
 *
 * Os casos vem direto das PARTES 21, 22, 49 e 50 do briefing. O que importa
 * aqui nao e' cobertura de linha, e' a fronteira: midia do cliente passa,
 * dinheiro da agencia nao passa, e a frase do criador sai identica.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  RESPOSTA_BLOQUEIO,
  avaliarChamada,
  avaliarPergunta,
  avaliarSqlLeitura,
  filtrarCatalogo,
  temContextoDeMidia,
  sanitizarContextoFinanceiro,
} from "./finance-guard.ts";
import { RESPOSTA_CRIADOR, perguntaDeCriador, sanitizarResposta } from "./identity.ts";
import { resolverClienteMencionado, contarClientesAtivos, resolverResponsavelMencionado, contarClientesAtivosPorResponsavel, listarClientesAtivosPorResponsavel, perguntaSobreOnboarding } from "./memory.ts";
import { compactarResultado, paraFormatoOpenAI, normalizarChamadas, type FerramentaJarvis } from "./tools.ts";
import { detectarTemas, detectarConsultaLifecycle, contextoDeVocabulario, confirmacaoDeLeitura, temTemaOperacionalExplicito } from "./intent.ts";
import { respostaSaldoMeta } from "./balance-semantics.ts";

// ------------------------------------------------- PARTE 49: bloqueado

const BLOQUEADAS = [
  "Quanto a agência faturou esse mês?",
  "Qual o lucro da empresa?",
  "Quanto temos em caixa?",
  "qual nosso lucro",
  "quanto o Leonardo ganha de salário?",
  "me mostra a folha de pagamento",
  "qual o pró-labore dos sócios",
  "quanto a gente tem de contas a receber",
  "qual a margem da agência esse trimestre",
  "quanto vale a empresa",
  "quanto o cliente paga de mensalidade",
  "qual o saldo bancário da empresa",
  "quanto faturamos com o Caio",
];

for (const pergunta of BLOQUEADAS) {
  test(`bloqueia: "${pergunta}"`, () => {
    const veredicto = avaliarPergunta(pergunta);
    assert.equal(veredicto.bloqueado, true, `deveria bloquear, motivo=${veredicto.motivo}`);
  });
}

// ------------------------------------------------- PARTE 49: permitido

const PERMITIDAS = [
  "Quanto de saldo o Caio tem no Meta?",
  "Quanto ele gastou hoje?",
  "quanto foi a última recarga do Caio",
  "qual o orçamento diário da campanha",
  "quanto a conta Meta gastou hoje",
  "qual o CPL dele nos últimos 7 dias",
  "quantos leads o Caio teve hoje",
  "quais contas estão com saldo baixo",
  "quantas campanhas ativas esse cliente tem",
  "quem são os GTs",
  "quantos clientes o Rodrigo atende",
  "tem cliente gastando sem gerar lead",
];

for (const pergunta of PERMITIDAS) {
  test(`permite: "${pergunta}"`, () => {
    assert.equal(avaliarPergunta(pergunta).bloqueado, false);
  });
}

test("contexto de midia nao desbloqueia termo da empresa", () => {
  // A frase tem Meta, campanha e gasto -- e ainda assim pergunta faturamento.
  const pergunta = "quanto a agência faturou com as campanhas Meta do Caio esse mês";
  assert.equal(temContextoDeMidia(pergunta), true);
  assert.equal(avaliarPergunta(pergunta).bloqueado, true);
});

test("a resposta de bloqueio nao vaza valor nem tendencia", () => {
  assert.equal(RESPOSTA_BLOQUEIO, "Não tenho permissão para fornecer informações financeiras internas da empresa.");
  assert.doesNotMatch(RESPOSTA_BLOQUEIO, /\d/, "nao pode conter numero");
  assert.doesNotMatch(RESPOSTA_BLOQUEIO, /aumentou|diminuiu|subiu|caiu|maior|menor/i);
});

test("pergunta vazia nao bloqueia por acidente", () => {
  assert.equal(avaliarPergunta("").bloqueado, false);
  assert.equal(avaliarPergunta("   ").bloqueado, false);
});

// ------------------------------------------------- PARTE 23: SQL restrito

test("SELECT simples com LIMIT passa", () => {
  assert.equal(avaliarSqlLeitura("select display_name from clients where lifecycle='ACTIVE' limit 20").permitido, true);
});

test("SQL de escrita e' recusado", () => {
  for (const sql of [
    "update clients set lifecycle='ACTIVE' limit 1",
    "delete from work_items limit 1",
    "drop table clients",
    "insert into clients (id) values (1)",
  ]) {
    assert.equal(avaliarSqlLeitura(sql).permitido, false, sql);
  }
});

test("catalogo do Postgres e' recusado", () => {
  assert.equal(avaliarSqlLeitura("select * from information_schema.tables limit 10").permitido, false);
  assert.equal(avaliarSqlLeitura("select * from pg_catalog.pg_tables limit 10").permitido, false);
});

test("relacoes de dinheiro da empresa sao recusadas mesmo em SELECT", () => {
  const r = avaliarSqlLeitura("select * from client_commercial_terms limit 5");
  assert.equal(r.permitido, false);
  assert.match(r.motivo ?? "", /protegida/);
});

test("consulta sem LIMIT e' recusada", () => {
  assert.equal(avaliarSqlLeitura("select * from clients").permitido, false);
});

test("mais de uma instrucao e' recusada", () => {
  assert.equal(avaliarSqlLeitura("select 1 limit 1; drop table clients").permitido, false);
});

test("comentario nao esconde verbo proibido", () => {
  assert.equal(avaliarSqlLeitura("select 1 limit 1 /* x */ ; delete from clients").permitido, false);
  assert.equal(avaliarSqlLeitura("select * from client_billing_notes -- ok\n limit 5").permitido, false);
});

test("avaliarChamada aplica a regra so na ferramenta de SQL", () => {
  assert.equal(avaliarChamada("saude_dos_clientes", {}).permitido, true);
  assert.equal(avaliarChamada("consulta_sql_leitura", { sql: "select 1 limit 1" }).permitido, false);
  assert.equal(avaliarChamada("consulta_sql_leitura", { sql: "select * from clients" }).permitido, false);
});

test("catalogo filtrado remove ferramenta financeira interna", () => {
  const catalogo = [{ name: "saude_dos_clientes" }, { name: "adler_finance" }, { name: "performance_meta" }, { name: "consulta_sql_leitura" }];
  const filtrado = filtrarCatalogo(catalogo);
  assert.equal(filtrado.length, 2);
  assert.ok(!filtrado.some((f) => f.name === "adler_finance"));
  assert.ok(!filtrado.some((f) => f.name === "consulta_sql_leitura"));
});

// ------------------------------------------------- PARTE 50: identidade

const PERGUNTAS_CRIADOR = [
  "Quem te criou?",
  "quem é seu criador",
  "quem foi que te criou",
  "qual o seu criador?",
  "quem te fez?",
  "quem te desenvolveu",
  "quem te programou?",
];

for (const pergunta of PERGUNTAS_CRIADOR) {
  test(`identidade responde a: "${pergunta}"`, () => {
    assert.equal(perguntaDeCriador(pergunta), true);
  });
}

test("a frase do criador e' exatamente a definida", () => {
  assert.equal(RESPOSTA_CRIADOR, "Meu criador é o PAI DO OP.");
});

test("perguntas normais nao viram resposta de criador", () => {
  for (const pergunta of [
    "quem atende o Caio",
    "quem são os GTs",
    "quem criou essa campanha",
    "quantos leads hoje",
  ]) {
    assert.equal(perguntaDeCriador(pergunta), false, pergunta);
  }
});

test("sanitizar nao destroi a frase do criador", () => {
  assert.equal(sanitizarResposta(RESPOSTA_CRIADOR), RESPOSTA_CRIADOR);
});


// ------------------------------------------ memoria/contexto + seguranca

test("remove finance do contexto antes do modelo", () => {
  const system = 'BASE\n\nCONTEXTO CONSULTADO:\n{"meta":{"balance":123},"finance":{"monthly_value":1400}}\n\nPara copy/criativo: fim';
  const limpo = sanitizarContextoFinanceiro(system);
  assert.match(limpo, /"meta":\{"balance":123\}/);
  assert.doesNotMatch(limpo, /monthly_value|"finance"/);
});

test("sanitizador falha fechado se finance vier em JSON quebrado", () => {
  const system = 'BASE\n\nCONTEXTO CONSULTADO:\n{"finance":{"monthly_value":1400}\n\nPara copy/criativo: fim';
  const limpo = sanitizarContextoFinanceiro(system);
  assert.doesNotMatch(limpo, /monthly_value|"finance"/);
});

test("resolve cliente por nome completo, nome unico e erro de transcricao", () => {
  const clientes = [
    { client_id: "1", display_name: "Caio Montenegro" },
    { client_id: "2", display_name: "Thaís Rodrigues" },
    { client_id: "3", display_name: "Rodrigo Imóveis" },
  ];
  assert.equal(resolverClienteMencionado("quantos leads o Caio Montenegro teve hoje?", clientes)?.client_id, "1");
  assert.equal(resolverClienteMencionado("e o Caio?", clientes)?.client_id, "1");
  assert.equal(resolverClienteMencionado("saldo do caio monentego", clientes)?.client_id, "1");
  assert.equal(resolverClienteMencionado("agora a Thaís", clientes)?.client_id, "2");
});

test("nao inventa cliente quando mencao e ambigua", () => {
  const clientes = [
    { client_id: "1", display_name: "Rodrigo Cavalheiro Imóveis" },
    { client_id: "2", display_name: "Rodrigo Santos Imóveis" },
  ];
  assert.equal(resolverClienteMencionado("e o Rodrigo?", clientes), null);
});


function fakeTool(name: string): FerramentaJarvis {
  return { name, description: "", input_schema: {}, edge_function: "x", http_method: "GET", path_suffix: null, body_template: {}, mode: "read", requires_confirmation: false, roles_allowed: ["MGMT"], result_max_chars: 3000 };
}

test("saldo Meta entrega so o cliente pedido e nao o dataset inteiro", () => {
  const bruto = JSON.stringify({ rows: [
    { client_id: "1", display_name: "Caio Montenegro", available_balance: 321.5, currency: "BRL", checked_at: "2026-09-07T20:00:00Z" },
    { client_id: "2", display_name: "Outro Cliente", available_balance: 999999, currency: "BRL", checked_at: "2026-09-07T20:00:00Z" },
  ], sync: { last_success_at: "2026-09-07T20:00:00Z" } });
  const out = compactarResultado(fakeTool("saldo_meta_cliente"), { client_name: "Caio Montenegro" }, bruto);
  assert.match(out, /Caio Montenegro/);
  assert.match(out, /321.5/);
  assert.doesNotMatch(out, /Outro Cliente|999999/);
});

test("conta Meta pos-paga nao chama debito de saldo disponivel", () => {
  const resposta = respostaSaldoMeta({ display_name: "Dias e Barbosa", meta_funding_type: 1, meta_funding_type_label: "Cartão de crédito (pós-pago)", meta_balance_source: "not_applicable_postpaid", meta_balance: 102.11, meta_available_balance: null, meta_currency: "BRL" } as any);
  assert.match(String(resposta), /pós-paga no cartão/i);
  assert.match(String(resposta), /102,11/);
  assert.match(String(resposta), /em aberto/i);
  assert.doesNotMatch(String(resposta), /saldo disponível/i);
});

test("conta Meta pre-paga continua respondendo saldo disponivel", () => {
  const resposta = respostaSaldoMeta({ display_name: "Cliente Pré", meta_funding_type: 20, meta_funding_type_label: "Pré-pago", meta_balance_source: "available_balance", meta_balance: 500, meta_available_balance: 321.5, meta_currency: "BRL" } as any);
  assert.match(String(resposta), /saldo disponível/i);
  assert.match(String(resposta), /321,50/);
});

test("equipe atual filtra por cargo antes de chegar ao modelo", () => {
  const bruto = JSON.stringify({ generated_at: "2026-09-07T20:00:00Z", team: [
    { person: "GT Um", role: "GT", in_roster: true, is_former: false, clients_active: 10 },
    { person: "CS Um", role: "CS", in_roster: true, is_former: false, clients_active: 0 },
    { person: "GT Antigo", role: "GT", in_roster: false, is_former: true },
  ] });
  const out = JSON.parse(compactarResultado(fakeTool("equipe_atual"), { role: "GT" }, bruto));
  assert.equal(out.count, 1);
  assert.equal(out.members[0].person, "GT Um");
});

test("campanhas ao vivo entregam apenas o cliente selecionado", () => {
  const bruto = JSON.stringify({ generated_at: "2026-09-07T20:00:00Z", clients: [
    { client_id: "1", display_name: "Caio Montenegro", leads: 4, spend: 80, active_campaigns: 2 },
    { client_id: "2", display_name: "Outro Cliente", leads: 99, spend: 999 },
  ], campaigns: [
    { client_id: "1", campaign_id: "c1", campaign_name: "Caio Lead", campaign_status: "ACTIVE", spend: 80, leads_estimate: 4 },
    { client_id: "2", campaign_id: "c2", campaign_name: "Outro", campaign_status: "ACTIVE", spend: 999, leads_estimate: 99 },
  ] });
  const out = compactarResultado(fakeTool("campanhas_cliente"), { client_name: "Caio Montenegro", since: "2026-09-07", until: "2026-09-07" }, bruto);
  assert.match(out, /Caio Lead/);
  assert.doesNotMatch(out, /Outro Cliente|"Outro"|999/);
});


test("formato de tools para OpenAI usa envelope function", () => {
  const [tool] = paraFormatoOpenAI([fakeTool("campanhas_cliente")]);
  assert.equal(tool.type, "function");
  assert.equal(tool.function.name, "campanhas_cliente");
  assert.equal(typeof tool.function.parameters, "object");
});

test("normaliza tool_calls da OpenAI preservando id e argumentos", () => {
  const out = normalizarChamadas({ choices: [{ message: { tool_calls: [{ id: "call_123", type: "function", function: { name: "campanhas_cliente", arguments: "{\"client_name\":\"Caio Montenegro\"}" } }] } }] });
  assert.equal(out[0].id, "call_123");
  assert.equal(out[0].name, "campanhas_cliente");
  assert.equal(out[0].args.client_name, "Caio Montenegro");
});


test("equipe atual resolve carteira por primeiro nome único", () => {
  const bruto = JSON.stringify({ team: [
    { person: "Felipe Oliveira", role: "GT", in_roster: true, is_former: false, clients_active: 40 },
    { person: "Rodrigo Cavalheiro", role: "GT", in_roster: true, is_former: false, clients_active: 18 },
  ] });
  const out = JSON.parse(compactarResultado(fakeTool("equipe_atual"), { person: "Felipe" }, bruto));
  assert.equal(out.count, 1);
  assert.equal(out.members[0].person, "Felipe Oliveira");
  assert.equal(out.members[0].clients_active, 40);
});


test("snapshot de clientes conta ativos sem LLM", () => {
  const clientes = [
    { client_id: "1", display_name: "A", lifecycle: "ACTIVE", gt_owner: "Felipe Oliveira" },
    { client_id: "2", display_name: "B", lifecycle: "ACTIVE", gt_owner: "Rodrigo Cavalheiro" },
    { client_id: "3", display_name: "C", lifecycle: "ONBOARDING", gt_owner: "Felipe Oliveira" },
  ];
  assert.equal(contarClientesAtivos(clientes), 2);
});

test("snapshot resolve Felipe e conta carteira ativa", () => {
  const clientes = [
    { client_id: "1", display_name: "A", lifecycle: "ACTIVE", gt_owner: "Felipe Oliveira" },
    { client_id: "2", display_name: "B", lifecycle: "ACTIVE", gt_owner: "Felipe Oliveira" },
    { client_id: "3", display_name: "C", lifecycle: "ONBOARDING", gt_owner: "Felipe Oliveira" },
    { client_id: "4", display_name: "D", lifecycle: "ACTIVE", gt_owner: "Rodrigo Cavalheiro" },
  ];
  const pessoa = resolverResponsavelMencionado("Felipe", clientes);
  assert.equal(pessoa, "Felipe Oliveira");
  assert.equal(contarClientesAtivosPorResponsavel(clientes, pessoa!), 2);
});


test("snapshot lista somente clientes ativos do responsavel", () => {
  const clientes = [
    { client_id: "1", display_name: "Alpha", lifecycle: "ACTIVE", gt_owner: "Felipe Oliveira" },
    { client_id: "2", display_name: "Beta", lifecycle: "ACTIVE", gt_owner: "Felipe Oliveira" },
    { client_id: "3", display_name: "Gamma", lifecycle: "ONBOARDING", gt_owner: "Felipe Oliveira" },
    { client_id: "4", display_name: "Delta", lifecycle: "ACTIVE", gt_owner: "Rodrigo Cavalheiro" },
  ];
  const lista = listarClientesAtivosPorResponsavel(clientes, "Felipe Oliveira").map((c) => c.display_name);
  assert.deepEqual(lista, ["Alpha", "Beta"]);
});


test("reconhece onboarding mesmo com erro de transcricao", () => {
  for (const frase of [
    "quais clientes estão em onboarding hoje",
    "quais Clientes estão em um borden hoje",
    "quem está em onboardg",
    "quantos estão em on bording",
  ]) assert.equal(perguntaSobreOnboarding(frase), true, frase);
});


test("vocabulário operacional entende termos em inglês e variações de voz", () => {
  assert.deepEqual(detectarTemas("cria uma task no Click Up"), ["task", "clickup"]);
  assert.ok(detectarTemas("esse web hook disparou?").includes("webhook"));
  assert.ok(detectarTemas("qual o balance do Caio?").includes("balance"));
  assert.ok(detectarTemas("quantas campaigns estão active?").includes("campaigns"));
  assert.equal(temTemaOperacionalExplicito("veja as tasks do ClickUp"), true);
});

test("contexto de vocabulário dá significado ao modelo sem trocar a fala do usuário", () => {
  const c = contextoDeVocabulario("o webhook criou a task no clickup?");
  assert.match(c, /webhook = evento HTTP/i);
  assert.match(c, /task = tarefa/i);
  assert.match(c, /ClickUp = sistema/i);
});

test("continuação de leitura reconhece respostas naturais curtas", () => {
  for (const x of ["pode mandar", "manda aí", "quero", "mostra", "lista aí", "sim"])
    assert.equal(confirmacaoDeLeitura(x), true, x);
});


test("roteador de lifecycle entende as frases reais do teste por voz", () => {
  assert.deepEqual(detectarConsultaLifecycle("Jarvis com os clientes ativos nós temos hoje"), { lifecycle: "ACTIVE", kind: "count" });
  assert.deepEqual(detectarConsultaLifecycle("Quais são os clientes que estão em onboard"), { lifecycle: "ONBOARDING", kind: "list" });
  assert.deepEqual(detectarConsultaLifecycle("Sim eu quero que você me passe uma lista com todos que estão em onboard"), { lifecycle: "ONBOARDING", kind: "list" });
  assert.equal(perguntaSobreOnboarding("quem está em onboard?"), true);
});

test("roteador de lifecycle separa churn e prospect sem herdar carteira", () => {
  assert.deepEqual(detectarConsultaLifecycle("quais clientes estão churned"), { lifecycle: "CHURNED", kind: "list" });
  assert.deepEqual(detectarConsultaLifecycle("quantos prospects temos"), { lifecycle: "PROSPECT", kind: "count" });
});


test("roteador de lifecycle nao rouba perguntas de campanha ou carteira", () => {
  assert.equal(detectarConsultaLifecycle("quais clientes ativos estão sem campanha"), null);
  assert.equal(detectarConsultaLifecycle("quantos clientes ativos estão com o Felipe"), null);
  assert.equal(detectarConsultaLifecycle("quantas campanhas dos clientes ativos temos"), null);
});
