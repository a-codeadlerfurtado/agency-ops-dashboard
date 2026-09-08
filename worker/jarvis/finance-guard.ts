/**
 * Barreira de dinheiro interno da empresa.
 *
 * Nao e' instrucao de prompt. Prompt e' pedido: o modelo obedece na maioria das
 * vezes e falha justamente quando alguem insiste, reformula ou pergunta de
 * lado ("mais ou menos quanto?", "aumentou em relacao ao mes passado?"). Isto
 * aqui e' garantia, roda no Worker, antes de o modelo ver a pergunta e antes de
 * qualquer ferramenta executar.
 *
 * A distincao central -- e a parte dificil -- e' que MIDIA DO CLIENTE nao e'
 * FINANCA DA EMPRESA:
 *
 *   permitido : saldo da conta Meta do Caio, recarga, gasto em trafego,
 *               orcamento diario de campanha, custo por lead
 *   bloqueado : faturamento, lucro, margem, caixa, folha, pro-labore,
 *               contas a pagar/receber, mensalidade que o cliente paga a agencia
 *
 * Os dois falam de "quanto" e de "reais". O que separa nao e' a palavra
 * dinheiro, e' de QUEM e' o dinheiro.
 */

/** Resposta unica. Nao confirma, nao aproxima, nao diz se subiu ou desceu. */
export const RESPOSTA_BLOQUEIO =
  "Não tenho permissão para fornecer informações financeiras internas da empresa.";

/**
 * Tira acento, baixa a caixa e trata hifen/underscore como espaco.
 *
 * O hifen nao e' detalhe: "pro-labore" e "pro labore" sao a mesma pergunta e
 * so' uma das duas estava na lista -- foi o teste que pegou. Mesma armadilha
 * vale para "custo-salarial" e "fluxo-de-caixa".
 */
function normalizar(texto: string): string {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Termos que so existem quando se fala do dinheiro DA AGENCIA.
 *
 * Cada um foi escolhido por nao ter leitura possivel em midia de cliente:
 * ninguem pergunta o "pro-labore" de uma campanha nem o "valuation" de um
 * anuncio.
 */
const TERMOS_EMPRESA = [
  "faturamento", "faturou", "faturar", "faturamos",
  "receita da empresa", "receita da agencia", "nossa receita", "receita bruta", "receita liquida",
  "lucro", "lucratividade", "margem da empresa", "margem da agencia", "nossa margem",
  "caixa da empresa", "nosso caixa", "em caixa", "fluxo de caixa",
  "saldo bancario", "conta bancaria", "contas bancarias", "dados bancarios",
  "distribuicao de lucros", "dividendo", "dividendos",
  "pro labore", "prolabore",
  "remuneracao dos socios", "quanto os socios", "participacao societaria",
  "salario", "salarios", "folha salarial", "folha de pagamento", "custo salarial",
  "quanto ganha", "quanto ele ganha", "quanto ela ganha", "quanto recebe de salario",
  "contas a pagar", "contas a receber", "despesas internas", "despesa da empresa",
  "imposto da empresa", "impostos da empresa", "carga tributaria",
  "valuation", "quanto vale a empresa",
  "mensalidade que", "quanto o cliente paga", "quanto cobramos", "quanto cobra a agencia",
  "ticket medio da agencia", "nosso ticket",
];

/**
 * Contexto de midia. Presenca destes NAO libera sozinha -- serve para desempatar
 * uma pergunta que tem palavra de dinheiro mas e' claramente sobre a conta de
 * anuncios de um cliente.
 */
const TERMOS_MIDIA = [
  "meta", "meta ads", "facebook", "instagram", "conta de anuncio", "conta de anuncios",
  "campanha", "campanhas", "conjunto", "anuncio", "anuncios", "adset",
  "saldo", "recarga", "recarregou", "recarregar",
  "trafego", "investimento em trafego", "verba", "orcamento diario", "budget",
  "cpl", "custo por lead", "cpc", "cpm", "gasto", "gastou", "gastando", "spend",
];

export type VeredictoFinanceiro = {
  bloqueado: boolean;
  /** Termo que disparou o bloqueio. Só para log; nunca vai para o usuario. */
  motivo: string | null;
};

/**
 * Classifica a pergunta do usuario.
 *
 * Regra de decisao: termo de empresa bloqueia. Contexto de midia NAO
 * desbloqueia termo de empresa -- "quanto a agencia faturou com o Meta do
 * Caio?" continua sendo faturamento. O caminho inverso (termo de midia sem
 * termo de empresa) passa, que e' o caso comum e legitimo.
 *
 * Assumir bloqueio no empate e' deliberado: o custo de recusar uma pergunta
 * legitima e' o usuario reformular; o custo do contrario e' vazar folha
 * salarial numa resposta falada em voz alta.
 */
export function avaliarPergunta(texto: string): VeredictoFinanceiro {
  const limpo = normalizar(texto);
  if (!limpo) return { bloqueado: false, motivo: null };

  for (const termo of TERMOS_EMPRESA) {
    if (limpo.includes(termo)) return { bloqueado: true, motivo: termo };
  }
  return { bloqueado: false, motivo: null };
}

/** Só para log/telemetria: indica se a pergunta tinha contexto de midia. */
export function temContextoDeMidia(texto: string): boolean {
  const limpo = normalizar(texto);
  return TERMOS_MIDIA.some((termo) => limpo.includes(termo));
}

/**
 * Remove o bloco financeiro interno que o workspace legado ainda pode anexar
 * ao contexto quando a pergunta contem palavras ambiguas como "saldo".
 * Saldo Meta e' permitido; monthly_value/finance da agencia nunca precisa
 * chegar ao modelo para responder isso.
 */
export function sanitizarContextoFinanceiro(system: string): string {
  const marcador = "CONTEXTO CONSULTADO:\n";
  const inicio = system.indexOf(marcador);
  if (inicio < 0) return system;
  const jsonInicio = inicio + marcador.length;
  const fim = system.indexOf("\n\nPara copy/criativo:", jsonInicio);
  if (fim < 0) return system.includes('"finance"') ? system.slice(0, jsonInicio) + "{}" : system;
  const bruto = system.slice(jsonInicio, fim);
  try {
    const contexto = JSON.parse(bruto) as Record<string, unknown>;
    if (contexto && typeof contexto === "object") delete contexto.finance;
    return system.slice(0, jsonInicio) + JSON.stringify(contexto) + system.slice(fim);
  } catch {
    // Falha fechada: se o JSON com finance nao puder ser interpretado,
    // descarta o payload consultado em vez de arriscar mandar valor protegido.
    return bruto.includes('"finance"')
      ? system.slice(0, jsonInicio) + "{}" + system.slice(fim)
      : system;
  }
}

/**
 * Relacoes que a consulta livre NAO pode tocar, mesmo sendo leitura.
 *
 * Sao os termos comerciais do contrato: quanto cada cliente paga a agencia.
 * Isso e' receita da empresa vista pelo outro lado, e a PARTE 21 bloqueia
 * receita.
 */
const RELACOES_PROIBIDAS = [
  "client_commercial_terms",
  "client_private_commercial_terms",
  "client_commercial_term_evidence",
  "client_billing_notes",
  "dashboard_api_keys",
  "client_access_vault",
  "client_access_vault_audit",
  "credential_exposure_findings",
  "team_login_emails",
  "user_preferences",
];

/**
 * Palavras que denunciam consulta de escrita ou de metadado de schema.
 *
 * A edge function ja' e' read-only, mas defesa em profundidade custa uma
 * regex: se um dia alguem trocar a funcao de destino, a barreira continua aqui.
 */
const SQL_PROIBIDO = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|pg_read|pg_ls|information_schema|pg_catalog|pg_shadow|pg_authid)\b/i;

export type VeredictoSql = {
  permitido: boolean;
  motivo: string | null;
};

/**
 * Valida o SQL da ferramenta de ultimo recurso.
 *
 * Nao transforma `consulta_sql_leitura` em consulta arbitraria segura -- isso
 * nao existe. Transforma numa consulta RESTRITA: um unico SELECT, com LIMIT,
 * sem tocar nas relacoes de dinheiro da empresa nem no catalogo do Postgres.
 * Se a pergunta precisar de algo alem disso, o caminho e' criar ferramenta
 * tipada, nao afrouxar esta.
 */
export function avaliarSqlLeitura(sql: unknown): VeredictoSql {
  const texto = String(sql ?? "").trim();
  if (!texto) return { permitido: false, motivo: "consulta vazia" };
  if (texto.length > 2000) return { permitido: false, motivo: "consulta longa demais" };

  const semComentarios = texto.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const limpo = semComentarios.toLowerCase();

  if (!/^\s*(with|select)\b/.test(limpo)) return { permitido: false, motivo: "precisa comecar com SELECT" };
  // Ponto-e-virgula no meio = mais de uma instrucao.
  if (/;\s*\S/.test(semComentarios)) return { permitido: false, motivo: "mais de uma instrucao" };
  if (SQL_PROIBIDO.test(limpo)) return { permitido: false, motivo: "verbo ou catalogo proibido" };
  if (!/\blimit\b/.test(limpo)) return { permitido: false, motivo: "consulta sem LIMIT" };

  for (const relacao of RELACOES_PROIBIDAS) {
    if (new RegExp(`\\b${relacao}\\b`).test(limpo)) {
      return { permitido: false, motivo: `relacao protegida: ${relacao}` };
    }
  }

  return { permitido: true, motivo: null };
}

/**
 * Ferramentas retiradas do catalogo antes de o modelo ver a lista.
 *
 * Ferramenta que o modelo nao enxerga e' ferramenta que ele nao chama -- mais
 * barato e mais confiavel do que interceptar a chamada depois. Hoje nenhuma
 * das 17 expoe caixa da agencia diretamente; a lista existe para o dia em que
 * a finance-api virar ferramenta e alguem esquecer deste arquivo.
 */
const FERRAMENTAS_BLOQUEADAS = new Set<string>([
  "financeiro_interno",
  "faturamento",
  "adler_finance",
  "folha_pagamento",
  // O endpoint legado exige segredo interno e, mais importante, SQL livre nao
  // faz parte da arquitetura final da Jarvis. Consultas operacionais devem ser
  // ferramentas tipadas com campos projetados e permissao server-side.
  "consulta_sql_leitura",
]);

export function filtrarCatalogo<T extends { name: string }>(ferramentas: T[]): T[] {
  return (ferramentas ?? []).filter((f) => !FERRAMENTAS_BLOQUEADAS.has(f.name));
}

/**
 * Ultima checagem, com a chamada ja' montada.
 *
 * Existe porque `avaliarPergunta` olha o texto do usuario e o modelo pode
 * chegar sozinho a uma consulta financeira a partir de pergunta inocente
 * ("me da um panorama geral da empresa").
 */
export function avaliarChamada(nome: string, args: Record<string, unknown>): VeredictoSql {
  if (FERRAMENTAS_BLOQUEADAS.has(nome)) {
    return { permitido: false, motivo: "ferramenta bloqueada" };
  }
  if (nome === "consulta_sql_leitura") {
    return avaliarSqlLeitura(args?.sql);
  }
  return { permitido: true, motivo: null };
}
