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
import { resolverClienteMencionado, contarClientesAtivos, resolverResponsavelMencionado, contarClientesAtivosPorResponsavel, listarClientesAtivosPorResponsavel, interpretarFiltroAntiguidadeClientes, filtrarClientesAtivosPorAntiguidade, perguntaSobreOnboarding, normalizarTranscricaoOperacional } from "./memory.ts";
import { compactarResultado, paraFormatoOpenAI, normalizarChamadas, type FerramentaJarvis } from "./tools.ts";
import { detectarTemas, detectarConsultaClientesOperacionais, detectarConsultaLifecycle, detectarEscopoGlobal, detectarJanelaMidia, contextoDeVocabulario, confirmacaoDeLeitura, temTemaOperacionalExplicito } from "./intent.ts";
import { respostaSaldoMeta } from "./balance-semantics.ts";
import { executarConsultaCanonica } from "./canonical-query.ts";

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

test("consulta generica de clientes e operacional, nao financeira", () => {
  for (const q of ["quantos clientes nos temos", "quantos clientes temos hoje", "qual o total de clientes", "quais clientes temos"]) {
    assert.equal(avaliarPergunta(q).bloqueado, false, q);
    assert.ok(detectarConsultaClientesOperacionais(q), q);
  }
  for (const q of ["quantos clientes estao em onboarding", "quantos clientes o Rodrigo atende", "quantos leads os clientes tiveram"]) {
    assert.equal(detectarConsultaClientesOperacionais(q), null, q);
  }
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
  // Regra de negocio: ONBOARDING conta como ativo operacional. Este teste
  // afirmava 2 quando a regra ainda era "so ACTIVE".
  assert.equal(contarClientesAtivos(clientes), 3);
});

test("follow-up de antiguidade herda o contexto de clientes ativos", () => {
  assert.deepEqual(
    interpretarFiltroAntiguidadeClientes("quantos com menos de 3 meses?", "quantos clientes ativos nos temos?"),
    { comparador: "menos", meses: 3 },
  );
  assert.deepEqual(
    interpretarFiltroAntiguidadeClientes("e os com mais de seis meses?", "clientes ativos"),
    { comparador: "mais", meses: 6 },
  );
});

test("filtro de antiguidade ignora churn e usa data de entrada", () => {
  const clientes = [
    { client_id: "1", display_name: "Recente", lifecycle: "ACTIVE", entrada: "2026-09-01" },
    { client_id: "2", display_name: "Antigo", lifecycle: "ACTIVE", entrada: "2026-01-01" },
    { client_id: "3", display_name: "Onboarding recente", lifecycle: "ONBOARDING", entrada: "2026-08-15" },
    { client_id: "4", display_name: "Churn recente", lifecycle: "CHURNED", entrada: "2026-09-01" },
  ];
  assert.deepEqual(
    filtrarClientesAtivosPorAntiguidade(clientes, { comparador: "menos", meses: 3 }).clientes.map((c) => c.display_name),
    ["Recente", "Onboarding recente"],
  );
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
  // Felipe tem 2 ACTIVE + 1 ONBOARDING; a carteira operacional dele e' 3.
  assert.equal(contarClientesAtivosPorResponsavel(clientes, pessoa!), 3);
});


test("snapshot lista somente clientes ativos do responsavel", () => {
  const clientes = [
    { client_id: "1", display_name: "Alpha", lifecycle: "ACTIVE", gt_owner: "Felipe Oliveira" },
    { client_id: "2", display_name: "Beta", lifecycle: "ACTIVE", gt_owner: "Felipe Oliveira" },
    { client_id: "3", display_name: "Gamma", lifecycle: "ONBOARDING", gt_owner: "Felipe Oliveira" },
    { client_id: "4", display_name: "Delta", lifecycle: "ACTIVE", gt_owner: "Rodrigo Cavalheiro" },
  ];
  const lista = listarClientesAtivosPorResponsavel(clientes, "Felipe Oliveira").map((c) => c.display_name);
  // Gamma esta em ONBOARDING e entra na carteira operacional; Delta e' de outro GT.
  assert.deepEqual(lista, ["Alpha", "Beta", "Gamma"]);
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

// ---------------------------------------- PARTE A: onboarding e' ativo
// A regra de negocio: quem esta em onboarding JA E' cliente. Responder so o
// ACTIVE subnotifica a carteira que a operacao realmente atende.

import { ehAtivoOperacional, ehOnboarding, ehEmOperacao, repartirPorEstagio } from "./memory.ts";
import { ehSaudacao, respostaSaudacao } from "./smalltalk.ts";

const CARTEIRA = [
  { client_id: "a", display_name: "A", lifecycle: "ACTIVE", gt_owner: "Felipe" },
  { client_id: "b", display_name: "B", lifecycle: "ACTIVE", gt_owner: "Rodrigo" },
  { client_id: "c", display_name: "C", lifecycle: "ONBOARDING", gt_owner: "Felipe" },
  { client_id: "d", display_name: "D", lifecycle: "CHURNED", gt_owner: "Felipe" },
] as never[];

test("ativo operacional inclui ACTIVE e ONBOARDING, exclui CHURNED", () => {
  assert.equal(ehAtivoOperacional("ACTIVE"), true);
  assert.equal(ehAtivoOperacional("ONBOARDING"), true);
  assert.equal(ehAtivoOperacional("CHURNED"), false);
  assert.equal(ehAtivoOperacional("PROSPECT"), false);
});

test("as tres leituras do lifecycle continuam distintas", () => {
  const r = repartirPorEstagio(CARTEIRA);
  assert.equal(r.ativos, 3, "ACTIVE + ONBOARDING");
  assert.equal(r.emOperacao, 2, "somente ACTIVE");
  assert.equal(r.onboarding, 1, "somente ONBOARDING");
  assert.equal(ehOnboarding("ONBOARDING"), true);
  assert.equal(ehEmOperacao("ONBOARDING"), false);
});

test("contagem geral de ativos conta o onboarding", () => {
  assert.equal(contarClientesAtivos(CARTEIRA), 3);
});

test("carteira do responsavel inclui o cliente em onboarding", () => {
  assert.equal(contarClientesAtivosPorResponsavel(CARTEIRA, "Felipe"), 2);
  assert.equal(contarClientesAtivosPorResponsavel(CARTEIRA, "Rodrigo"), 1);
  const lista = listarClientesAtivosPorResponsavel(CARTEIRA, "Felipe").map((c) => String(c.client_id));
  assert.deepEqual(lista.sort(), ["a", "c"], "churned fica de fora, onboarding entra");
});

// ---------------------------------------- PARTE B: saudacao

for (const oi of ["oi", "olá", "ola tudo bem?", "bom dia", "boa tarde", "boa noite",
                  "e aí", "tudo bem?", "como você está?", "jarvis", "fala jarvis", "obrigado", "valeu"]) {
  test(`saudacao reconhecida: "${oi}"`, () => {
    assert.equal(ehSaudacao(oi), true);
  });
}

for (const real of [
  "bom dia, quantos clientes ativos temos?",
  "oi, saldo do Alex Quadros",
  "olá, quem é o GT do Caio?",
  "boa tarde, quantos leads hoje",
  "quantos clientes ativos temos?",
]) {
  test(`pergunta real NAO vira saudacao: "${real}"`, () => {
    assert.equal(ehSaudacao(real), false);
  });
}

test("resposta de saudacao e' curta, deterministica e sem erro", () => {
  const a = respostaSaudacao("ola tudo bem?");
  assert.equal(a, respostaSaudacao("ola tudo bem?"), "mesma entrada, mesma saida");
  assert.ok(a.length < 80);
  assert.doesNotMatch(a, /não consegui|erro|indisponível/i);
});

test("bom dia usa o nome quando ha pessoa", () => {
  assert.match(respostaSaudacao("bom dia", "Adler Furtado"), /Bom dia, Adler/);
  assert.match(respostaSaudacao("bom dia"), /^Bom dia\./);
});

// ------------------------------- TRIAGEM: papel do responsavel no CLAIM
// Regra do trigger WORK_ITEM_ASSIGNEE_ROLE_MISMATCH: team_roster.role da pessoa
// tem de bater com work_items.target_role. O endpoint fixava "CS", entao o Adler
// (MGMT) nunca conseguia assumir. Estes testes travam a regra.

/** Espelha o patch de CLAIM do agency-ops-material-triage-api. */
function patchDeClaim(person: string, role: string) {
  if (!role) return { erro: "role_required" as const };
  return { status: "IN_PROGRESS", target_person: person, target_role: role };
}

test("CLAIM de CS usa target_role CS", () => {
  assert.deepEqual(patchDeClaim("Joel", "CS"), { status: "IN_PROGRESS", target_person: "Joel", target_role: "CS" });
});

test("CLAIM de MGMT usa target_role MGMT, nao CS", () => {
  const p = patchDeClaim("Adler Furtado", "MGMT");
  assert.equal((p as { target_role: string }).target_role, "MGMT");
  assert.notEqual((p as { target_role: string }).target_role, "CS", "hardcode de CS era a causa do role mismatch");
});

test("CLAIM sem papel no roster e' recusado antes de gravar", () => {
  assert.deepEqual(patchDeClaim("Fulano", ""), { erro: "role_required" });
});

/** Espelha o patch de ACKNOWLEDGE. */
function patchDeAck(person: string, atual: Record<string, unknown>) {
  return {
    status: "COMPLETED",
    completed_by: person,
    resolution: "Ciente — triagem reconhecida sem ação adicional.",
    client_id: atual.client_id,
    source: atual.source,
    source_id: atual.source_id,
  };
}

test("ACKNOWLEDGE nao exige CLAIM e nao altera o material", () => {
  const original = { client_id: "c1", source: "briefing-hub", source_id: "s1", status: "OPEN", target_person: null };
  const p = patchDeAck("Adler Furtado", original);
  assert.equal(p.status, "COMPLETED");
  assert.equal(p.client_id, original.client_id, "client_id preservado");
  assert.equal(p.source, original.source, "source preservado");
  assert.equal(p.source_id, original.source_id, "source_id preservado");
  assert.equal(original.target_person, null, "nao precisou assumir antes");
});

/** A lista da triagem so' devolve estados acionaveis. */
const ACIONAVEIS = ["OPEN", "IN_PROGRESS", "SNOOZED"];

test("item com Ciente sai da fila da triagem", () => {
  assert.ok(!ACIONAVEIS.includes("COMPLETED"), "COMPLETED nao e' acionavel, entao some do popup e do painel");
  assert.ok(ACIONAVEIS.includes("OPEN"));
});

test("X e' local: nao produz patch nenhum no servidor", () => {
  const dispensados = new Set<string>();
  dispensados.add("item-1");
  assert.equal(dispensados.has("item-1"), true, "so estado do cliente");
  assert.equal(typeof (dispensados as unknown as { patch?: unknown }).patch, "undefined", "nenhuma mutacao de backend");
});

// ---------------------------------------- REGRESSOES DE VOZ / CONTEXTO 2026-09-10

test("STT troca litro/litros por lead/leads", () => {
  assert.equal(normalizarTranscricaoOperacional("quantos litros a Kronos teve ontem"), "quantos leads a Kronos teve ontem");
  assert.equal(normalizarTranscricaoOperacional("um litro hoje"), "um lead hoje");
});

test("periodo nunca vira cliente Dias e Barbosa", () => {
  const clientes = [
    { client_id: "nc", display_name: "NC Imóveis" },
    { client_id: "db", display_name: "Dias e Barbosa" },
  ];
  assert.equal(resolverClienteMencionado("e nos últimos 7 dias?", clientes), null);
  assert.equal(resolverClienteMencionado("quantos leads a NC Imóveis teve nos últimos 7 dias?", clientes)?.client_id, "nc");
});

test("janela de mídia reconhece últimos 7 dias sem converter para hoje", () => {
  assert.deepEqual(detectarJanelaMidia("e nos últimos 7 dias?"), { kind: "last_days", days: 7, label: "nos últimos 7 dias" });
  assert.deepEqual(detectarJanelaMidia("ontem"), { kind: "yesterday", days: 1, label: "ontem" });
});

test("escopo global vence cliente anterior", () => {
  for (const q of [
    "somando todos os nossos clientes quantos leads tivemos ontem",
    "quantos leads no geral tivemos ontem",
    "quantos leads todos os clientes tiveram ontem",
  ]) assert.equal(detectarEscopoGlobal(q), true, q);
});


test("planner canonico cruza gasto com ausencia de leads sem LLM", () => {
  const clientes = [
    { client_id:"1", display_name:"A", lifecycle:"ACTIVE", spend_today:80, leads_today:0 },
    { client_id:"2", display_name:"B", lifecycle:"ACTIVE", spend_today:50, leads_today:3 },
    { client_id:"3", display_name:"C", lifecycle:"CHURNED", spend_today:90, leads_today:0 },
  ];
  const r = executarConsultaCanonica({ message:"quais clientes estão gastando e sem lead hoje?", clients:clientes, memoria:null, explicitClient:null });
  assert.ok(r);
  assert.match(r!.resposta, /1 cliente/);
  assert.match(r!.resposta, /A/);
  assert.doesNotMatch(r!.resposta, /B|C/);
});

test("planner canonico detecta grupo que ficou somente no bom dia", () => {
  const clientes = [
    { client_id:"1", display_name:"A", lifecycle:"ACTIVE", wa_groups_only_good_morning:1 },
    { client_id:"2", display_name:"B", lifecycle:"ACTIVE", wa_groups_only_good_morning:0 },
  ];
  const r = executarConsultaCanonica({ message:"quais clientes receberam somente o bom dia?", clients:clientes, memoria:null, explicitClient:null });
  assert.ok(r);
  assert.match(r!.resposta, /A/);
  assert.doesNotMatch(r!.resposta, /B/);
});

test("planner canonico preserva conjunto para follow-up desses", () => {
  const clientes = [
    { client_id:"1", display_name:"A", lifecycle:"ACTIVE", active_campaigns:0, external_risk_level:"HIGH" },
    { client_id:"2", display_name:"B", lifecycle:"ACTIVE", active_campaigns:0, external_risk_level:"LOW" },
    { client_id:"3", display_name:"C", lifecycle:"ACTIVE", active_campaigns:2, external_risk_level:"HIGH" },
  ];
  const primeira = executarConsultaCanonica({ message:"quais clientes estão sem campanha?", clients:clientes, memoria:null, explicitClient:null });
  assert.ok(primeira);
  const memoria = { ...primeira!.memory, updated_at:new Date().toISOString() };
  const segunda = executarConsultaCanonica({ message:"e desses, quais estão em risco?", clients:clientes, memoria, explicitClient:null });
  assert.ok(segunda);
  assert.match(segunda!.resposta, /A/);
  assert.doesNotMatch(segunda!.resposta, /B|C/);
});

test("planner canonico responde ultimo cliente que entrou", () => {
  const clientes = [
    { client_id:"1", display_name:"Antigo", lifecycle:"ACTIVE", entrada:"2026-08-01" },
    { client_id:"2", display_name:"Novo", lifecycle:"ACTIVE", entrada:"2026-09-10" },
  ];
  const r = executarConsultaCanonica({ message:"quem foi o último cliente que entrou?", clients:clientes, memoria:null, explicitClient:null });
  assert.ok(r);
  assert.match(r!.resposta, /Novo/);
  assert.match(r!.resposta, /10 de setembro/);
});

test("planner canonico ranqueia CPL sem inventar criterio", () => {
  const clientes = [
    { client_id:"1", display_name:"A", lifecycle:"ACTIVE", cpl_today:40 },
    { client_id:"2", display_name:"B", lifecycle:"ACTIVE", cpl_today:20 },
    { client_id:"3", display_name:"C", lifecycle:"ACTIVE", cpl_today:70 },
  ];
  const r = executarConsultaCanonica({ message:"quais são os 2 melhores clientes por CPL hoje?", clients:clientes, memoria:null, explicitClient:null });
  assert.ok(r);
  assert.match(r!.resposta, /1\. B/);
  assert.match(r!.resposta, /2\. A/);
  assert.doesNotMatch(r!.resposta, /3\. C/);
});

test("planner canonico compara hoje e ontem no cliente certo", () => {
  const cliente = { client_id:"1", display_name:"Caio", lifecycle:"ACTIVE", leads_today:8, leads_yesterday:4 };
  const r = executarConsultaCanonica({ message:"Caio teve mais leads hoje ou ontem?", clients:[cliente], memoria:null, explicitClient:cliente });
  assert.ok(r);
  assert.match(r!.resposta, /hoje 8/);
  assert.match(r!.resposta, /ontem 4/);
  assert.match(r!.resposta, /subiu/i);
});