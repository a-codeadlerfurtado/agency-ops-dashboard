/**
 * Catalogo e execucao de ferramentas.
 *
 * Principio: a Jarvis nao tem permissao propria. Toda chamada leva o JWT do
 * usuario logado, entao ela ve e faz exatamente o que aquela pessoa ve e faz.
 * O catalogo diz o que EXISTE; quem pode o que continua sendo decidido pela
 * edge function de destino. `roles_allowed` aqui e economia de rodada, nao
 * controle de acesso -- nunca confie nele como fronteira de seguranca.
 */

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";

export type FerramentaJarvis = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  edge_function: string;
  http_method: "GET" | "POST";
  path_suffix: string | null;
  body_template: Record<string, unknown> | null;
  mode: "read" | "write";
  requires_confirmation: boolean;
  roles_allowed: string[];
  result_max_chars: number;
};

// Fatia minima do KV que usamos. O projeto nao carrega
// @cloudflare/workers-types, entao declarar o que se usa e mais honesto
// do que puxar a tipagem inteira do runtime so por causa de dois metodos.
type CacheKv = {
  get: (chave: string, tipo: "json") => Promise<unknown | null>;
  put: (chave: string, valor: string, opcoes?: { expirationTtl?: number }) => Promise<void>;
};

export type EnvJarvis = {
  AI?: { run: (modelo: string, entrada: Record<string, unknown>) => Promise<unknown> };
  OPENAI_API_KEY?: string;
  AI_RATE_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
  JARVIS_CACHE?: CacheKv;
  SUPABASE_ANON_KEY?: string;
  JARVIS_SERVICE_TOKEN?: string;
  N8N_JARVIS_WEBHOOK?: string;
  AI_GATEWAY_OPENAI?: string;
  JARVIS_TTS_URL?: string;
  JARVIS_TTS_TOKEN?: string;
  KOKORO_URL?: string;
  KOKORO_TOKEN?: string;
};

const FERRAMENTAS_FIXAS: FerramentaJarvis[] = [
  {
    name: "saldo_meta_cliente",
    description: "Consulta o estado financeiro da conta Meta de um cliente. Em pré-pago, available_balance é saldo disponível. Em pós-pago/cartão, balance representa valor em aberto e NÃO deve ser chamado de saldo disponível. É mídia do cliente, não finança interna da agência.",
    input_schema: { type: "object", required: ["client_name"], properties: { client_name: { type: "string", description: "nome exato do cliente resolvido no contexto" } } },
    edge_function: "agency-ops-client-balances-api", http_method: "GET", path_suffix: null, body_template: {},
    mode: "read", requires_confirmation: false, roles_allowed: ["MGMT", "GT", "CS"], result_max_chars: 2200,
  },
  {
    name: "equipe_atual",
    description: "Consulta a equipe atual, cargos e tamanho de carteira por pessoa. Use para contar ou listar GTs, CS, Design, AI, Comercial e Gestão, e para responder quantos clientes um responsável atende.",
    input_schema: { type: "object", properties: { role: { type: "string", enum: ["GT", "CS", "DESIGN", "AI", "COMMERCIAL", "MGMT"], description: "cargo opcional" }, person: { type: "string", description: "nome ou primeiro nome do responsável, por exemplo Felipe" } } },
    edge_function: "agency-ops-leadership-team-api", http_method: "GET", path_suffix: null, body_template: {},
    mode: "read", requires_confirmation: false, roles_allowed: ["MGMT"], result_max_chars: 2600,
  },
  {
    name: "campanhas_cliente",
    description: "Consulta Meta Ads ao vivo em um período para um cliente: campanhas, status, gasto, leads e resultados.",
    input_schema: { type: "object", required: ["client_name", "since", "until"], properties: { client_name: { type: "string" }, since: { type: "string" }, until: { type: "string" }, lifecycle: { type: "string" } } },
    edge_function: "agency-ops-campaigns-api", http_method: "GET", path_suffix: null, body_template: {},
    mode: "read", requires_confirmation: false, roles_allowed: ["MGMT", "GT"], result_max_chars: 3000,
  },
];

function ajustarFerramenta(f: FerramentaJarvis): FerramentaJarvis {
  if (f.name !== "campanhas_cliente") return f;
  return {
    ...f,
    description: "Consulta Meta Ads ao vivo em um período para um cliente: campanhas, status, gasto, leads e resultados. Para hoje, use a data de hoje em since e until (America/Sao_Paulo).",
    input_schema: {
      type: "object", required: ["client_name", "since", "until"],
      properties: {
        client_name: { type: "string", description: "nome exato do cliente resolvido no contexto" },
        since: { type: "string", description: "AAAA-MM-DD em America/Sao_Paulo" },
        until: { type: "string", description: "AAAA-MM-DD em America/Sao_Paulo" },
        lifecycle: { type: "string", description: "normalmente ACTIVE" },
      },
    },
    result_max_chars: 3000,
  };
}

function combinarCatalogo(linhas: FerramentaJarvis[], papel: string): FerramentaJarvis[] {
  const mapa = new Map<string, FerramentaJarvis>();
  for (const f of linhas.map(ajustarFerramenta)) mapa.set(f.name, f);
  for (const f of FERRAMENTAS_FIXAS) if (f.roles_allowed.includes(papel)) mapa.set(f.name, f);
  return [...mapa.values()];
}

/** Catalogo filtrado pelo papel, com cache curto em KV. */
export async function carregarCatalogo(papel: string, jwt: string, env: EnvJarvis): Promise<FerramentaJarvis[]> {
  const chave = `catalogo:${papel}`;
  if (env.JARVIS_CACHE) {
    const guardado = await env.JARVIS_CACHE.get(chave, "json").catch(() => null);
    if (guardado) return combinarCatalogo(guardado as FerramentaJarvis[], papel);
  }

  const resposta = await fetch(`${SUPABASE}/rest/v1/rpc/jarvis_tool_catalog`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: env.SUPABASE_ANON_KEY ?? "",
      "content-type": "application/json",
      "content-profile": "agency_ops",
      accept: "application/json",
    },
    body: JSON.stringify({ p_role: papel }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!resposta.ok) return combinarCatalogo([], papel);
  const linhas = (await resposta.json().catch(() => [])) as FerramentaJarvis[];

  if (env.JARVIS_CACHE && linhas.length) {
    await env.JARVIS_CACHE.put(chave, JSON.stringify(linhas), { expirationTtl: 60 }).catch(() => {});
  }
  return combinarCatalogo(linhas, papel);
}

/** Converte para o formato de `tools` do Workers AI. */
export function paraFormatoWorkersAi(ferramentas: FerramentaJarvis[]) {
  // O binding nativo do Workers AI usa o formato tradicional da Cloudflare:
  // { name, description, parameters }. O wrapper OpenAI { type, function }
  // pertence ao endpoint compatível com OpenAI e faz env.AI.run rejeitar tools.
  return ferramentas.map((f) => ({
    name: f.name,
    description: f.description,
    parameters: f.input_schema ?? { type: "object", properties: {} },
  }));
}

/** Converte para o formato de function calling da OpenAI Chat Completions. */
export function paraFormatoOpenAI(ferramentas: FerramentaJarvis[]) {
  return ferramentas.map((f) => ({
    type: "function" as const,
    function: {
      name: f.name,
      description: f.description,
      parameters: f.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

export type ChamadaNormalizada = {
  /** id do modelo quando ele manda; null quando nao manda */
  id: string | null;
  name: string;
  args: Record<string, unknown>;
};

/**
 * O modelo pode devolver `arguments` como objeto ou como string JSON,
 * dependendo do formato. Normaliza os dois sem estourar.
 *
 * O `id` e preservado porque e ele que amarra a chamada ao resultado: o
 * historico compativel com OpenAI exige `assistant.tool_calls[].id` e o
 * `tool.tool_call_id` correspondente. Sem esse par, o modelo recebe resultados
 * soltos e nao sabe de qual chamada cada um veio.
 */
export function normalizarChamadas(resposta: any): ChamadaNormalizada[] {
  const cruas = resposta?.tool_calls ?? resposta?.result?.tool_calls ?? resposta?.choices?.[0]?.message?.tool_calls ?? [];
  if (!Array.isArray(cruas)) return [];
  const saida: ChamadaNormalizada[] = [];
  for (const c of cruas) {
    const nome = String(c?.name ?? c?.function?.name ?? "").trim();
    if (!nome) continue;
    const brutos = c?.arguments ?? c?.function?.arguments ?? {};
    let args: Record<string, unknown> = {};
    if (typeof brutos === "string") {
      try { args = JSON.parse(brutos); } catch { args = {}; }
    } else if (brutos && typeof brutos === "object") {
      args = brutos as Record<string, unknown>;
    }
    const idBruto = c?.id ?? c?.tool_call_id ?? null;
    const id = typeof idBruto === "string" && idBruto.trim() ? idBruto.trim() : null;
    saida.push({ id, name: nome, args });
  }
  return saida;
}

/**
 * Guarda do SQL de ultimo recurso.
 *
 * Nao substitui a protecao da propria edge function nem a RLS -- e a primeira
 * de tres camadas. Um agente que erra o SQL nao deve nem chegar la.
 */
export function validarSqlLeitura(bruto: unknown): { ok: true; sql: string } | { ok: false; motivo: string } {
  const sql = String(bruto ?? "").trim().replace(/;+\s*$/, "");
  const minusculo = sql.toLowerCase();
  if (!minusculo.startsWith("select")) return { ok: false, motivo: "a consulta precisa comecar com select" };
  if (sql.includes(";")) return { ok: false, motivo: "apenas uma consulta por vez" };
  if (/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|copy)\b/.test(minusculo)) {
    return { ok: false, motivo: "somente leitura" };
  }
  // qualquer schema qualificado que nao seja agency_ops fica de fora
  const schemas = minusculo.match(/\b([a-z_][a-z0-9_]*)\s*\.\s*[a-z_]/g) ?? [];
  for (const s of schemas) {
    const nome = s.split(".")[0].trim();
    if (nome !== "agency_ops" && !/^[a-z]$/.test(nome)) {
      return { ok: false, motivo: `fora de agency_ops: ${nome}` };
    }
  }
  const limite = minusculo.match(/\blimit\s+(\d+)/);
  if (!limite) return { ok: true, sql: `${sql} limit 200` };
  if (Number(limite[1]) > 200) return { ok: true, sql: sql.replace(/\blimit\s+\d+/i, "limit 200") };
  return { ok: true, sql };
}

function norm(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function compactarResultado(ferramenta: FerramentaJarvis, args: Record<string, unknown>, bruto: string): string {
  let corpo: any;
  try { corpo = JSON.parse(bruto); } catch { return bruto; }

  if (ferramenta.name === "saldo_meta_cliente") {
    const alvo = norm(args.client_name);
    const linhas = Array.isArray(corpo?.rows) ? corpo.rows : [];
    const matches = linhas.filter((r: any) => norm(r?.display_name) === alvo || (alvo && norm(r?.display_name).includes(alvo)));
    if (matches.length !== 1) return JSON.stringify({ ok: false, error: matches.length ? "ambiguous_client" : "client_not_found" });
    const r = matches[0];
    return JSON.stringify({
      ok: true, source: "META_BALANCE_SYNC", source_updated_at: r.checked_at ?? corpo?.sync?.last_success_at ?? null,
      client: { client_id: r.client_id, display_name: r.display_name, lifecycle: r.lifecycle, gt_owner: r.gt_owner, cs_owner: r.cs_owner },
      media: {
        available_balance: r.available_balance, balance: r.balance, currency: r.currency,
        funding_type: r.funding_type, funding_type_label: r.funding_type_label, payment_display: r.payment_display, balance_source: r.balance_source,
        account_status: r.account_status, disable_reason: r.disable_reason, checked_at: r.checked_at,
        latest_spend_date: r.latest_spend_date, spend_7d: r.spend_7d, avg_daily_spend: r.avg_daily_spend,
        latest_day_spend: r.latest_day_spend, active_campaigns: r.active_campaigns,
        run_status: r.run_status, days_remaining: r.days_remaining,
      },
      note: "Nao existe historico canonico de ultima recarga nesta fonte; nao inferir data ou valor de recarga.",
    });
  }

  if (ferramenta.name === "equipe_atual") {
    const role = String(args.role ?? "").trim().toUpperCase();
    let team = Array.isArray(corpo?.team) ? corpo.team : [];
    team = team.filter((m: any) => m?.in_roster !== false && m?.is_former !== true);
    if (role) team = team.filter((m: any) => String(m?.role ?? "").toUpperCase() === role);
    const person = norm(args.person);
    if (person) {
      const exact = team.filter((m: any) => norm(m?.person) === person);
      const partial = exact.length ? exact : team.filter((m: any) => norm(m?.person).split(" ").includes(person) || norm(m?.person).startsWith(`${person} `));
      team = partial.length === 1 ? partial : [];
    }
    return JSON.stringify({
      ok: true, source: "TEAM_ROSTER", source_updated_at: corpo?.generated_at ?? null, role: role || null,
      count: team.length,
      members: team.map((m: any) => ({ person: m.person, role: m.role, clients_active: m.clients_active ?? null, clients_onboarding: m.clients_onboarding ?? null, carteira: m.carteira ?? null, portfolio_count: Array.isArray(m.portfolio) ? m.portfolio.length : null })),
    });
  }

  if (ferramenta.name === "campanhas_cliente") {
    const alvo = norm(args.client_name);
    const clientes = Array.isArray(corpo?.clients) ? corpo.clients : [];
    const matches = clientes.filter((r: any) => norm(r?.display_name) === alvo || (alvo && norm(r?.display_name).includes(alvo)));
    if (matches.length !== 1) return JSON.stringify({ ok: false, error: matches.length ? "ambiguous_client" : "client_not_found" });
    const c = matches[0];
    const campanhas = (Array.isArray(corpo?.campaigns) ? corpo.campaigns : []).filter((x: any) => String(x?.client_id ?? "") === String(c.client_id ?? ""));
    return JSON.stringify({
      ok: true, source: "META_MARKETING_API", source_updated_at: corpo?.generated_at ?? null,
      period: { since: args.since ?? null, until: args.until ?? null, timezone: "America/Sao_Paulo" },
      client: { client_id: c.client_id, display_name: c.display_name, gt_owner: c.gt_owner, lifecycle: c.lifecycle },
      totals: { spend: c.spend, leads: c.leads, results: c.results, impressions: c.impressions, clicks: c.clicks, active_campaigns: c.active_campaigns, campaign_count: c.campaign_count, delivery_status: c.delivery_status, partial_data: c.partial_data },
      campaigns: campanhas.slice(0, 30).map((x: any) => ({ campaign_id: x.campaign_id, campaign_name: x.campaign_name, campaign_status: x.campaign_status, spend: x.spend, leads: x.leads_estimate, results: x.result_count, cost_per_result: x.cost_per_result, has_delivery: x.has_delivery })),
    });
  }

  return bruto;
}

export async function executarFerramenta(
  ferramenta: FerramentaJarvis,
  argumentos: Record<string, unknown>,
  jwt: string,
  env: EnvJarvis,
): Promise<{ ok: boolean; status: number; content: string }> {
  let args = argumentos ?? {};

  if (ferramenta.name === "consulta_sql_leitura") {
    const validado = validarSqlLeitura(args.sql);
    if (!validado.ok) return { ok: false, status: 400, content: `consulta recusada: ${validado.motivo}` };
    args = { ...args, sql: validado.sql };
  }

  const base = `${SUPABASE}/functions/v1/${ferramenta.edge_function}${ferramenta.path_suffix ?? ""}`;
  const corpo = { ...(ferramenta.body_template ?? {}), ...args };

  // GET leva os argumentos na query -- varias funcoes de leitura sao GET puro.
  let url = base;
  if (ferramenta.http_method === "GET") {
    const params = new URLSearchParams();
    for (const [chave, valor] of Object.entries(corpo)) {
      if (valor === null || valor === undefined || valor === "") continue;
      params.set(chave, String(valor));
    }
    const qs = params.toString();
    if (qs) url = `${base}?${qs}`;
  }

  try {
    const resposta = await fetch(url, {
      method: ferramenta.http_method,
      headers: {
        authorization: `Bearer ${jwt}`,
        apikey: env.SUPABASE_ANON_KEY ?? "",
        "content-type": "application/json",
      },
      body: ferramenta.http_method === "GET" ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(ferramenta.name === "campanhas_cliente" ? 30_000 : 12_000),
    });
    const bruto = await resposta.text();
    const texto = resposta.ok ? compactarResultado(ferramenta, args, bruto) : bruto;
    return {
      ok: resposta.ok,
      status: resposta.status,
      content: texto.slice(0, Math.max(200, ferramenta.result_max_chars)),
    };
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    // devolve como conteudo, nao como excecao: o modelo precisa saber que a
    // ferramenta falhou para dizer isso em vez de inventar o dado
    return { ok: false, status: 504, content: `ferramenta indisponivel: ${motivo}` };
  }
}

/** Frase curta para a confirmacao falada. Deterministica, sem gastar modelo. */
export function resumirAcao(ferramenta: FerramentaJarvis, args: Record<string, unknown>): string {
  const t = (chave: string) => String(args[chave] ?? "").trim();
  switch (ferramenta.name) {
    case "criar_demanda":
    case "criar_task_clickup": {
      const alvo = t("target_person") || t("target_role") || "a operacao";
      return `Criar demanda para ${alvo}: ${t("title") || "sem titulo"}`;
    }
    case "reatribuir_demanda":
      return `Passar a demanda ${t("work_item_id")} para ${t("target_person")}`;
    case "acao_campanha":
      return `${t("desired_status") === "PAUSED" ? "Pausar" : "Reativar"} a campanha ${t("campaign_name")} do cliente ${t("client_name")}`;
    case "anotar_campanha":
      return `Anotar na campanha ${t("campaign_name")}: ${t("note").slice(0, 80)}`;
    case "registrar_diario":
      return `Registrar no diario: ${t("report_text").slice(0, 80)}`;
    case "comando_onboarding":
      return `Executar no onboarding: ${t("command")}`;
    default:
      return `Executar ${ferramenta.name}`;
  }
}
