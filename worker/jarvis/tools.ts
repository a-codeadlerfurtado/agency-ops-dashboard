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
  AI_RATE_LIMITER?: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
  JARVIS_CACHE?: CacheKv;
  SUPABASE_ANON_KEY?: string;
  JARVIS_SERVICE_TOKEN?: string;
  N8N_JARVIS_WEBHOOK?: string;
  AI_GATEWAY_OPENAI?: string;
  KOKORO_URL?: string;
  KOKORO_TOKEN?: string;
};

/** Catalogo filtrado pelo papel, com cache curto em KV. */
export async function carregarCatalogo(papel: string, jwt: string, env: EnvJarvis): Promise<FerramentaJarvis[]> {
  const chave = `catalogo:${papel}`;
  if (env.JARVIS_CACHE) {
    const guardado = await env.JARVIS_CACHE.get(chave, "json").catch(() => null);
    if (guardado) return guardado as FerramentaJarvis[];
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
  if (!resposta.ok) return [];
  const linhas = (await resposta.json().catch(() => [])) as FerramentaJarvis[];

  if (env.JARVIS_CACHE && linhas.length) {
    await env.JARVIS_CACHE.put(chave, JSON.stringify(linhas), { expirationTtl: 60 }).catch(() => {});
  }
  return linhas;
}

/** Converte para o formato de `tools` do Workers AI. */
export function paraFormatoWorkersAi(ferramentas: FerramentaJarvis[]) {
  return ferramentas.map((f) => ({
    type: "function" as const,
    function: {
      name: f.name,
      description: f.description,
      parameters: f.input_schema ?? { type: "object", properties: {} },
    },
  }));
}

/**
 * O modelo pode devolver `arguments` como objeto ou como string JSON,
 * dependendo do formato. Normaliza os dois sem estourar.
 */
export function normalizarChamadas(resposta: any): Array<{ name: string; args: Record<string, unknown> }> {
  const cruas = resposta?.tool_calls ?? resposta?.result?.tool_calls ?? resposta?.choices?.[0]?.message?.tool_calls ?? [];
  if (!Array.isArray(cruas)) return [];
  const saida: Array<{ name: string; args: Record<string, unknown> }> = [];
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
    saida.push({ name: nome, args });
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
      signal: AbortSignal.timeout(12_000),
    });
    const texto = await resposta.text();
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
