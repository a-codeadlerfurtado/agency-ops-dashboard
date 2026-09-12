/**
 * Loop de agente da Jarvis.
 *
 * Fluxo: prepare-chat (contexto e escopo) -> modelo com ferramentas -> executa
 * leituras -> repete ate a resposta final -> complete-chat (persistencia).
 *
 * Escrita nunca executa aqui. Vira pendencia e para. Um agente de voz erra de
 * ouvido -- "cria demanda pro Rodrigo" e "pra o Rodrigo" viram a mesma coisa, e
 * a diferenca entre as duas pode ser uma task no nome errado.
 */

import { CanalSse } from "./sse";
import { identidade, sanitizarResposta } from "./identity";
import { avaliarChamada, filtrarCatalogo, sanitizarContextoFinanceiro } from "./finance-guard";
import { resolverClienteMencionado, contarClientesAtivos, resolverResponsavelMencionado, contarClientesAtivosPorResponsavel, normalizarTranscricaoOperacional, type ClientePermitido } from "./memory";
import { tentarFastPath } from "./fast-path";
import { carregarMidiaClienteDia } from "./state";
import { contextoDeVocabulario } from "./intent";
import {
  carregarCatalogo, paraFormatoOpenAI, normalizarChamadas,
  executarFerramenta, resumirAcao,
  type EnvJarvis, type FerramentaJarvis,
} from "./tools";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const WORKSPACE = `${SUPABASE}/functions/v1/agency-ops-ai-workspace`;
/** Mesma fonte de perfil que o dashboard usa em app/shared.tsx. */
const PERFIL = `${SUPABASE}/functions/v1/agency-ops-profile-lite`;
const MODELO_PREFERIDO = "gpt-5.4-mini";
const MODELO_FALLBACK = "gpt-5-mini";
const MODELO = MODELO_PREFERIDO;
let modeloOpenAIResolvido: string | null = null;
const MAX_RODADAS = 6;
const TETO_MS = 45_000;
const CONTEXTO_MAX = 14_000;
const CONTEXTO_REDUZIDO = 8_000;

function dataOperacional(offsetDays = 0): string {
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const n = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value ?? 0);
  const d = new Date(Date.UTC(n("year"), n("month") - 1, n("day") + offsetDays));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

const SIM = /^(sim|confirma|confirmar|confirmado|pode|pode ir|vai|ok|isso|manda|beleza|positivo)\.?$/i;
const NAO = /^(nao|não|cancela|cancelar|deixa|deixa quieto|para|negativo|esquece)\.?$/i;

export type Identidade = { pessoa: string; papel: string; userId: string | null };

/**
 * Mensagem para o usuario quando nada deu certo.
 *
 * Amigavel, mas com um codigo curto no fim. Sem o codigo, "nao consegui
 * responder" e indistinguivel entre modelo fora do ar, catalogo vazio e
 * contexto estourado -- foi exatamente o que travou o primeiro diagnostico.
 * O codigo nao diz nada de tabela, coluna, token ou segredo.
 */
function mensagemDeFalha(motivo: string | null): string {
  switch (motivo) {
    case "contexto_grande":
      return "A pergunta trouxe contexto demais e não coube. Tenta de novo mais específica. (código: contexto_grande)";
    case "quota_ai_esgotada":
      return "A API da OpenAI recusou a chamada por limite ou saldo. As consultas operacionais compatíveis continuam funcionando pelo modo direto. (código: quota_ai_esgotada)";
    case "openai_sem_chave":
      return "A integração da OpenAI ainda está sem chave configurada. (código: openai_sem_chave)";
    case "modelo_indisponivel":
      return "O modelo não respondeu agora. Tenta de novo em instantes. (código: modelo_indisponivel)";
    case "modelo_sem_texto":
      return "Entendi a pergunta, mas não consegui formular a resposta. (código: modelo_sem_texto)";
    case "sem_ferramentas":
      return "Estou sem acesso às ferramentas agora, então não consigo consultar a operação. (código: sem_ferramentas)";
    default:
      return "Não consegui responder agora. (código: desconhecido)";
  }
}

function texto(resultado: any): string {
  for (const c of [resultado?.response, resultado?.result?.response, resultado?.result?.text,
                   resultado?.text, resultado?.choices?.[0]?.message?.content]) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

async function chamarOpenAI(env: EnvJarvis, mensagens: any[], ferramentas: FerramentaJarvis[], modoVoz = false): Promise<any> {
  const key = String(env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new Error("openai_api_key_ausente");
  const executar = async (model: string) => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: mensagens, ...(ferramentas.length ? { tools: paraFormatoOpenAI(ferramentas), parallel_tool_calls: false } : {}), max_completion_tokens: modoVoz ? 480 : 900 }),
    signal: AbortSignal.timeout(40_000),
  });
  let model = modeloOpenAIResolvido ?? MODELO_PREFERIDO;
  let r = await executar(model);
  let raw = await r.text();
  if (!r.ok && model === MODELO_PREFERIDO && /model.*(not found|does not exist)|invalid.*model|gpt-5[.-]5-mini/i.test(raw)) {
    model = MODELO_FALLBACK; modeloOpenAIResolvido = model; r = await executar(model); raw = await r.text();
  }
  if (!r.ok) { let detail = raw.slice(0, 500); try { const j=JSON.parse(raw); detail=String(j?.error?.code ?? j?.error?.type ?? "openai_error")+":"+String(j?.error?.message ?? "").slice(0,300); } catch {} throw new Error(`openai_${r.status}:${detail}`); }
  const out = raw ? JSON.parse(raw) : {}; modeloOpenAIResolvido = String(out?.model ?? model); return out;
}

async function rest(caminho: string, jwt: string, env: EnvJarvis, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE}/rest/v1/${caminho}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: env.SUPABASE_ANON_KEY ?? "",
      "content-type": "application/json",
      "accept-profile": "agency_ops",
      "content-profile": "agency_ops",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(8_000),
  });
}

/** Quem esta falando. Sem isso o escopo por papel nao existe. */
export async function identificarUsuario(jwt: string, env: EnvJarvis): Promise<Identidade> {
  let userId: string | null = null;
  try {
    const carga = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    userId = typeof carga?.sub === "string" ? carga.sub : null;
  } catch { /* token opaco; segue sem id */ }

  const identityCacheKey = userId ? `jarvis:identity:v1:${userId}` : null;
  if (identityCacheKey && env.JARVIS_CACHE) {
    const hit = await env.JARVIS_CACHE.get(identityCacheKey, "json").catch(() => null) as any;
    const role = String(hit?.papel ?? "").trim().toUpperCase();
    if (role) return { pessoa: String(hit?.pessoa ?? "").trim(), papel: role, userId };
  }

  // Papel NAO sai de consulta direta a user_preferences/team_roster com o JWT
  // do usuario. O papel `authenticated` nao tem GRANT nessas tabelas: o
  // PostgREST responde 403 42501 "permission denied for table", a leitura
  // falhava calada e todo mundo virava UNASSIGNED. Nenhum filtro resolveria --
  // o dashboard tambem nao le assim. Ele chama esta Edge Function, que resolve
  // com service role do lado do servidor (ver app/shared.tsx:290 e o espelho em
  // server/src/services/identity.ts). Reusar o contrato canonico mantem Jarvis
  // e Dashboard concordando sobre quem e' quem -- inclusive is_former, papel e
  // aprovacao, que ja sao decididos la dentro.
  let pessoa = "";
  let papel = "UNASSIGNED";

  const resposta = await fetch(PERFIL, {
    headers: { authorization: `Bearer ${jwt}`, apikey: env.SUPABASE_ANON_KEY ?? "" },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);

  if (resposta?.ok) {
    const corpo = (await resposta.json().catch(() => null)) as any;
    const perfil = corpo?.profile;
    pessoa = String(perfil?.person ?? "").trim();
    papel = String(perfil?.role ?? "").trim().toUpperCase() || "UNASSIGNED";
  }

  if (identityCacheKey && env.JARVIS_CACHE && papel !== "UNASSIGNED") {
    await env.JARVIS_CACHE.put(identityCacheKey, JSON.stringify({ pessoa, papel }), { expirationTtl: 120 }).catch(() => {});
  }

  // Diagnostico do gate sem vazar identidade: so o booleano, o papel e o
  // status da fonte. Sem token, sem nome, sem UUID, sem corpo de resposta.
  console.info({
    event: "jarvis_identity_resolved",
    resolved: papel !== "UNASSIGNED",
    role: papel,
    status: resposta?.status ?? 0,
  });

  return { pessoa, papel, userId };
}

async function workspace(acao: string, jwt: string, carga: unknown): Promise<any> {
  const r = await fetch(`${WORKSPACE}/${acao}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    body: JSON.stringify(carga ?? {}),
    signal: AbortSignal.timeout(15_000),
  });
  return r.json().catch(() => null);
}


/**
 * Cronometra e nomeia cada etapa do agente.
 *
 * Existe porque "The operation was aborted due to timeout" chegou cru na tela
 * sem dizer QUAL chamada estourou -- e eram cinco candidatas. Log estruturado
 * por estagio transforma isso em uma linha com nome e duracao.
 *
 * Nao registra jwt, token, payload nem valor financeiro: so' nome do estagio,
 * duracao e o par nome/mensagem do erro.
 */
async function estagio<T>(nome: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.info({ event: "jarvis_stage", stage: nome, ms: Date.now() - t0, ok: true });
    return r;
  } catch (erro) {
    console.error({
      event: "jarvis_stage_failed", stage: nome, ms: Date.now() - t0,
      error_name: erro instanceof Error ? erro.name : "unknown",
      error_message: erro instanceof Error ? erro.message : String(erro),
    });
    throw erro;
  }
}

/** AbortSignal.timeout lanca TimeoutError; AbortController.abort lanca AbortError. */
export function ehTimeout(erro: unknown): boolean {
  const nome = erro instanceof Error ? erro.name : "";
  return nome === "TimeoutError" || nome === "AbortError";
}

async function carregarClientesPermitidos(eu: Identidade, jwt: string, env: EnvJarvis): Promise<ClientePermitido[]> {
  const chave = eu.userId ? `jarvis:clientes:v2:${eu.userId}` : null;
  if (chave && env.JARVIS_CACHE) {
    const hit = await env.JARVIS_CACHE.get(chave, "json").catch(() => null);
    if (Array.isArray(hit)) return hit as ClientePermitido[];
  }
  const resposta = await workspace("clients", jwt, {});
  const clientes = (Array.isArray(resposta?.clients) ? resposta.clients : [])
    .map((c: any) => ({
      client_id: String(c?.client_id ?? ""),
      display_name: String(c?.display_name ?? ""),
      lifecycle: String(c?.lifecycle ?? ""),
      gt_owner: c?.gt_owner ? String(c.gt_owner) : null,
      cs_owner: c?.cs_owner ? String(c.cs_owner) : null,
      designer_owner: c?.designer_owner ? String(c.designer_owner) : null,
    }))
    .filter((c: ClientePermitido) => c.client_id && c.display_name);
  if (chave && env.JARVIS_CACHE && clientes.length) {
    await env.JARVIS_CACHE.put(chave, JSON.stringify(clientes), { expirationTtl: 300 }).catch(() => {});
  }
  return clientes;
}


/** Aquece apenas identidade, carteira e catalogo enquanto o usuario ainda esta falando. */
export async function aquecerContextoLeve(jwt: string, env: EnvJarvis): Promise<{ ok: boolean; role: string }> {
  const eu = await identificarUsuario(jwt, env);
  if (eu.papel === "UNASSIGNED") return { ok: false, role: eu.papel };
  await Promise.allSettled([
    carregarClientesPermitidos(eu, jwt, env),
    carregarCatalogo(eu.papel, jwt, env),
  ]);
  return { ok: true, role: eu.papel };
}

/** Pendencia aberta e recente do usuario, para resolver "sim" por voz. */
export async function pendenciaAberta(jwt: string, env: EnvJarvis): Promise<any | null> {
  const limite = new Date(Date.now() - 15 * 60_000).toISOString();
  const r = await rest(
    `jarvis_pending_actions?select=*&status=eq.PENDING&created_at=gte.${limite}&order=created_at.desc&limit=1`,
    jwt, env,
  ).catch(() => null);
  if (!r?.ok) return null;
  const linhas = (await r.json().catch(() => [])) as any[];
  return linhas?.[0] ?? null;
}

export type EntradaChat = {
  conversation_id?: string | null;
  message?: string;
  client_id?: string | null;
  voice?: boolean;
};

export async function rodarAgente(
  entrada: EntradaChat,
  jwt: string,
  env: EnvJarvis,
  canal: CanalSse | null,
  identidadeForcada?: Identidade,
  ferramentasPermitidas?: string[],
  defer?: (promise: Promise<unknown>) => void,
): Promise<{ resposta: string; chamadas: Array<{ name: string; ok: boolean; ms: number }>; pendencia: string | null; conversation_id: string | null }> {
  const inicio = Date.now();
  const eu = identidadeForcada ?? (await estagio("identify_user", () => identificarUsuario(jwt, env)));
  const mensagem = normalizarTranscricaoOperacional(entrada.message).trim();
  const chamadas: Array<{ name: string; ok: boolean; ms: number }> = [];
  const catalogoPromise = estagio("catalog", () => carregarCatalogo(eu.papel, jwt, env))
    .catch(() => [] as FerramentaJarvis[]);

  // Resolve um cliente citado ANTES do prepare-chat. Isso permite que "Caio",
  // "Caio Montenegro" e pequenos erros de transcricao mudem o foco da conversa.
  // Sem esta etapa, uma conversa ja vinculada a um cliente nunca trocava para
  // outro: o workspace prioriza o client_id persistido.
  const clientesPermitidos = await estagio("clients_allowed", () => carregarClientesPermitidos(eu, jwt, env)).catch(() => [] as ClientePermitido[]);
  const mencionado = resolverClienteMencionado(mensagem, clientesPermitidos);
  const clientIdPreferido = String(entrada.client_id ?? mencionado?.client_id ?? "").trim() || null;

  // conversations/create SAIU do caminho critico.
  //
  // Ele ficava aqui, antes do fast path, sem `.catch()` e com timeout de 15s do
  // helper `workspace`. Numa origem de preview nova o localStorage nao tem
  // conversation_id, entao TODA primeira pergunta -- inclusive "qual o saldo do
  // X", que o fast path responde de snapshot -- esperava a criacao da conversa.
  // Quando a edge function demorava, o TimeoutError subia cru ate a UI.
  //
  // Agora a conversa e' criada depois da resposta, no trecho de persistencia,
  // ou logo antes do prepare-chat no caminho que realmente precisa de historico.
  let conversationId = entrada.conversation_id ?? null;
  // Catálogo antes do prepare-chat: o fast path consegue responder de cache/snapshot
  // sem montar o contexto grande do LLM. Só usa ferramenta ao vivo se o dado estiver velho.
  const catalogo = filtrarCatalogo(await catalogoPromise)
    .filter((f) => !ferramentasPermitidas || ferramentasPermitidas.includes(f.name));
  const scopeKey = eu.userId ?? `${eu.papel}:${eu.pessoa}`;
  const fast = await estagio("fast_path", () => tentarFastPath({
    message: mensagem, conversationId, explicitClient: mencionado, clients: clientesPermitidos,
    jwt, env, scopeKey, catalogo, canal,
  })).catch(() => null);
  if (fast) {
    chamadas.push(...fast.chamadas);
    const direta = sanitizarResposta(fast.resposta);
    canal?.emitir("token", { text: direta });
    const persistir = (async () => {
      // Fora do caminho critico: a resposta ja' foi entregue acima.
      let convId = conversationId;
      if (!convId) {
        const criada = await estagio("conversation_create_deferred",
          () => workspace("conversations/create", jwt, { client_id: clientIdPreferido })).catch(() => null);
        convId = criada?.conversation?.id ?? criada?.id ?? null;
      }
      const preparadoFast = await workspace("prepare-chat", jwt, {
        conversation_id: convId, message: mensagem, client_id: clientIdPreferido,
      }).catch(() => null);
      if (!preparadoFast?.ok) return;
      await workspace("complete-chat", jwt, {
        conversation_id: preparadoFast.conversation_id ?? convId,
        request_id: preparadoFast.request_id, answer: direta, original_message: mensagem,
        model: `deterministic:${fast.source}`, latency_ms: Date.now() - inicio,
        context_sources: [fast.source], context_client: preparadoFast.context_client ?? null,
        intents: preparadoFast.intents ?? [],
        metadata: { tool_calls: chamadas, agent: "jarvis", fast_path: fast.source },
      }).catch(() => null);
    })();
    if (defer) defer(persistir); else void persistir;
    return { resposta: direta, chamadas, pendencia: null, conversation_id: conversationId };
  }

  if (conversationId && mencionado?.client_id) {
    const troca = await workspace("conversations/set-client", jwt, {
      conversation_id: conversationId,
      client_id: mencionado.client_id,
    }).catch(() => null);
    if (!troca?.ok) {
      console.warn({ event: "jarvis_client_switch_failed", conversation: Boolean(conversationId) });
    }
  }

  // Caminho que precisa de historico: aqui a conversa e' necessaria mesmo.
  // Com `.catch`, uma falha vira contexto indisponivel -- nunca erro cru na UI.
  if (!conversationId) {
    const criada = await estagio("conversation_create",
      () => workspace("conversations/create", jwt, { client_id: clientIdPreferido })).catch(() => null);
    conversationId = criada?.conversation?.id ?? criada?.id ?? null;
  }

  // Sem conversa nao adianta chamar prepare-chat: ele exige uuid e responde 500
  // com "invalid input syntax for type uuid" depois de ~10s. Falhar aqui e' mais
  // rapido e devolve uma frase util em vez de gastar o timeout inteiro.
  if (!conversationId) {
    console.error({ event: "jarvis_sem_conversa", stage: "conversation_create" });
    canal?.emitir("error", { message: "Não consegui consultar agora. Tenta novamente em alguns segundos." });
    return {
      resposta: "Não consegui consultar agora. Tenta novamente em alguns segundos.",
      chamadas, pendencia: null, conversation_id: null,
    };
  }

  const preparado = await estagio("prepare_chat", () => workspace("prepare-chat", jwt, {
    conversation_id: conversationId,
    message: mensagem,
    client_id: clientIdPreferido,
  })).catch(() => null);
  if (!preparado?.ok) {
    console.error({
      event: "jarvis_prepare_falhou", tem_conversa: Boolean(conversationId),
      erro: String(preparado?.error ?? "sem_detalhe"),
    });
    canal?.emitir("error", { message: "contexto_indisponivel" });
    return {
      resposta: "Não consegui carregar o contexto agora. (código: contexto_indisponivel)",
      chamadas, pendencia: null, conversation_id: conversationId,
    };
  }

  // Se não caiu no fast path, agora sim segue para contexto grande + LLM.
  const porNome = new Map<string, FerramentaJarvis>(catalogo.map((f) => [f.name, f]));

  // Fast path operacional: consultas objetivas nao ficam refens da cota do LLM.
  // Mantem escopo/JWT/fonte canonica e ainda persiste o turno na mesma conversa.
  const turnos = Array.isArray(preparado.turns) ? preparado.turns as Array<{ role?: string; content?: string }> : [];
  const ultimoUsuario = [...turnos].reverse().find((t) => t?.role === "user" && String(t?.content ?? "").trim() !== mensagem);
  const perguntaTotalAtivos = /\bquantos?\b[\s\S]{0,80}\bclientes?\b[\s\S]{0,40}\bativos?\b/i.test(mensagem) && !/\bcom\s+(?:o|a)?\s*[\p{L}-]+/iu.test(mensagem);
  if (perguntaTotalAtivos && clientesPermitidos.length) {
    const total = contarClientesAtivos(clientesPermitidos);
    const direta = sanitizarResposta(eu.papel === "MGMT"
      ? `Temos ${total} ${total === 1 ? "cliente ativo" : "clientes ativos"} hoje.`
      : `No seu escopo, há ${total} ${total === 1 ? "cliente ativo" : "clientes ativos"} hoje.`);
    canal?.emitir("token", { text: direta });
    const persistir = workspace("complete-chat", jwt, { conversation_id: preparado.conversation_id ?? conversationId, request_id: preparado.request_id, answer: direta, original_message: mensagem, model: "deterministic:workspace_clients", latency_ms: Date.now() - inicio, context_sources: ["dashboard_client_overview"], context_client: null, intents: preparado.intents ?? [], metadata: { tool_calls: chamadas, agent: "jarvis", fast_path: "active_clients_total" } }).catch(() => null);
    if (defer) defer(persistir); else await persistir;
    return { resposta: direta, chamadas, pendencia: null, conversation_id: conversationId };
  }

  const perguntaCarteiraAnterior = /\bquantos?\b[\s\S]{0,80}\bcom\s+(?:o|a)?\s*[\p{L}-]+/iu.test(String(ultimoUsuario?.content ?? "")) || /\bclientes?\b[\s\S]{0,40}\bativos?\b/i.test(String(ultimoUsuario?.content ?? ""));
  const carteiraExplicita = mensagem.match(/\bquantos?\b[\s\S]{0,80}\bcom\s+(?:o|a)?\s*([\p{L}-]+)/iu)?.[1] ?? null;
  const carteiraCurta = perguntaCarteiraAnterior ? (mensagem.match(/^(?:e\s+)?(?:o|a)?\s*([\p{L}-]{3,})(?:\s+[\p{L}-]+)?[?!. ]*$/iu)?.[1] ?? null) : null;
  const termoResponsavel = carteiraExplicita ?? carteiraCurta;
  const responsavel = termoResponsavel ? resolverResponsavelMencionado(termoResponsavel, clientesPermitidos) : null;
  if (responsavel && clientesPermitidos.length) {
    const total = contarClientesAtivosPorResponsavel(clientesPermitidos, responsavel);
    const direta = sanitizarResposta(`${responsavel} está com ${total} ${total === 1 ? "cliente ativo" : "clientes ativos"}.`);
    canal?.emitir("token", { text: direta });
    const persistir = workspace("complete-chat", jwt, { conversation_id: preparado.conversation_id ?? conversationId, request_id: preparado.request_id, answer: direta, original_message: mensagem, model: "deterministic:workspace_clients", latency_ms: Date.now() - inicio, context_sources: ["dashboard_client_overview"], context_client: null, intents: preparado.intents ?? [], metadata: { tool_calls: chamadas, agent: "jarvis", fast_path: "portfolio_owner_cached" } }).catch(() => null);
    if (defer) defer(persistir); else await persistir;
    return { resposta: direta, chamadas, pendencia: null, conversation_id: conversationId };
  }
  const followupPeriodo = /^(?:e\s+)?(?:hoje|ontem)[?!. ]*$/i.test(mensagem);
  const querLeads = /\bleads?\b/i.test(mensagem) || (followupPeriodo && /\bleads?\b/i.test(String(ultimoUsuario?.content ?? "")));
  const offsetPeriodo = /\bontem\b/i.test(mensagem) ? -1 : /\bhoje\b/i.test(mensagem) ? 0 : null;
  const clienteContexto = String(mencionado?.display_name ?? preparado?.context_client?.display_name ?? preparado?.context_client?.name ?? "").trim();
  if (querLeads && offsetPeriodo !== null && clienteContexto) {
    const dia = dataOperacional(offsetPeriodo);
    const clientIdLeads = String(mencionado?.client_id ?? preparado?.context_client?.client_id ?? preparado?.context_client?.id ?? "").trim();
    if (clientIdLeads) {
      const snap = await carregarMidiaClienteDia(clientIdLeads, dia, jwt, env).catch(() => null);
      const leadsSnap = snap?.ok ? Number(snap?.leads) : Number.NaN;
      if (Number.isFinite(leadsSnap)) {
        const direta = sanitizarResposta(`${String(snap?.display_name ?? clienteContexto)} teve ${leadsSnap} ${leadsSnap === 1 ? "lead" : "leads"} ${offsetPeriodo === 0 ? "hoje" : "ontem"}.`);
        canal?.emitir("token", { text: direta });
        const persistir = workspace("complete-chat", jwt, { conversation_id: preparado.conversation_id ?? conversationId, request_id: preparado.request_id, answer: direta, original_message: mensagem, model: "deterministic:media_snapshot", latency_ms: Date.now() - inicio, context_sources: ["META_CAMPAIGN_INSIGHTS"], context_client: preparado.context_client ?? null, intents: preparado.intents ?? [], metadata: { tool_calls: chamadas, agent: "jarvis", fast_path: "leads_period_snapshot" } }).catch(() => null);
        if (defer) defer(persistir); else void persistir;
        return { resposta: direta, chamadas, pendencia: null, conversation_id: conversationId };
      }
    }
    const ferramenta = porNome.get("campanhas_cliente");
    if (ferramenta) {
      const dia = dataOperacional(offsetPeriodo);
      const args = { client_name: clienteContexto, since: dia, until: dia, lifecycle: "ACTIVE", details: "0" };
      const t0 = Date.now();
      canal?.emitir("tool_start", { name: ferramenta.name, summary: ferramenta.description });
      const r = await executarFerramenta(ferramenta, args, jwt, env);
      const ms = Date.now() - t0;
      chamadas.push({ name: ferramenta.name, ok: r.ok, ms });
      canal?.emitir("tool_end", { name: ferramenta.name, ok: r.ok, ms });
      let direta = "";
      try {
        const d = JSON.parse(r.content); const leads = d?.totals?.leads; const nome = String(d?.client?.display_name ?? clienteContexto);
        if (r.ok && d?.ok && leads !== null && leads !== undefined && Number.isFinite(Number(leads))) direta = `${nome} teve ${Number(leads)} ${Number(leads) === 1 ? "lead" : "leads"} ${offsetPeriodo === 0 ? "hoje" : "ontem"}.` + (d?.totals?.partial_data ? " Os dados estão marcados como parciais pela fonte." : "");
        else if (r.ok && d?.ok) direta = `A fonte ao vivo não trouxe uma contagem de leads para ${nome} nesse período.`;
      } catch { /* resposta da ferramenta sera tratada abaixo */ }
      if (!direta) direta = r.ok ? "Consultei a fonte ao vivo, mas não consegui interpretar a contagem de leads com segurança." : "Não consegui consultar os leads ao vivo agora.";
      direta = sanitizarResposta(direta);
      if (canal) canal.emitir("token", { text: direta });
      const persistir = workspace("complete-chat", jwt, { conversation_id: preparado.conversation_id ?? conversationId, request_id: preparado.request_id, answer: direta, original_message: mensagem, model: "deterministic:campanhas_cliente", latency_ms: Date.now() - inicio, context_sources: preparado.context_sources ?? [], context_client: preparado.context_client ?? null, intents: preparado.intents ?? [], metadata: { tool_calls: chamadas, agent: "jarvis", fast_path: "leads_period" } }).catch(() => null);
      if (defer) defer(persistir); else void persistir;
      return { resposta: direta, chamadas, pendencia: null, conversation_id: conversationId };
    }
  }

  // Fast path de carteira: follow-ups como "e quantos estão com o Felipe"
  // não dependem do modelo entender novamente que Felipe é um responsável.
  const carteiraMatch = mensagem.match(/\bquantos?\b[\s\S]{0,80}\bcom\s+(?:o|a)?\s*([\p{L}-]+)/iu);
  if (carteiraMatch?.[1]) {
    const ferramenta = porNome.get("equipe_atual");
    if (ferramenta) {
      const args = { person: carteiraMatch[1] };
      const t0 = Date.now();
      canal?.emitir("tool_start", { name: ferramenta.name, summary: ferramenta.description });
      const r = await executarFerramenta(ferramenta, args, jwt, env);
      const ms = Date.now() - t0;
      chamadas.push({ name: ferramenta.name, ok: r.ok, ms });
      canal?.emitir("tool_end", { name: ferramenta.name, ok: r.ok, ms });
      try {
        const d = JSON.parse(r.content);
        const membro = Array.isArray(d?.members) && d.members.length === 1 ? d.members[0] : null;
        const total = membro?.clients_active;
        if (r.ok && membro && total !== null && total !== undefined && Number.isFinite(Number(total))) {
          let direta = sanitizarResposta(`${membro.person} está com ${Number(total)} ${Number(total) === 1 ? "cliente ativo" : "clientes ativos"}.`);
          canal?.emitir("token", { text: direta });
          const persistir = workspace("complete-chat", jwt, { conversation_id: preparado.conversation_id ?? conversationId, request_id: preparado.request_id, answer: direta, original_message: mensagem, model: "deterministic:equipe_atual", latency_ms: Date.now() - inicio, context_sources: preparado.context_sources ?? [], context_client: preparado.context_client ?? null, intents: preparado.intents ?? [], metadata: { tool_calls: chamadas, agent: "jarvis", fast_path: "portfolio_owner" } }).catch(() => null);
          if (defer) defer(persistir); else await persistir;
          return { resposta: direta, chamadas, pendencia: null, conversation_id: conversationId };
        }
      } catch { /* segue para o modelo se a fonte não retornar carteira */ }
    }
  }

  // Catalogo vazio nao impede responder -- pergunta simples nao precisa de
  // ferramenta -- mas precisa aparecer no log, porque e a diferenca entre
  // "nao sei" e "nao tenho como saber".
  if (!catalogo.length) {
    console.warn({
      event: "jarvis_catalogo_vazio", papel: eu.papel,
      tem_pessoa: Boolean(eu.pessoa), restrito: Boolean(ferramentasPermitidas),
    });
  }

  let contexto = sanitizarContextoFinanceiro(String(preparado.system ?? ""));
  contexto += contextoDeVocabulario(mensagem);
  contexto += "\n\nREGRA DE CONTINUIDADE: uma palavra/tema operacional explícito na mensagem atual vence assunto antigo incompatível. Use memória apenas para completar pronomes, entidade, período ou ação claramente continuada; nunca para substituir o tema que o usuário acabou de pedir.";
  if (entrada.voice) contexto += "\n\nMODO VOZ: responda de forma oral e direta. Prefira 1 ou 2 frases e no máximo cerca de 350 caracteres, salvo quando o usuário pedir detalhes, lista extensa ou explicação longa. Não repita a pergunta.";
  const montarMensagens = (limite: number) => [
    { role: "system", content: `${identidade(eu.pessoa, eu.papel)}\n\n${contexto.slice(0, limite)}` },
    ...((preparado.turns ?? []) as Array<{ role: string; content: string }>).map((t) => ({
      role: t.role === "assistant" ? "assistant" : "user",
      content: String(t.content ?? ""),
    })),
  ];

  const mensagens: any[] = montarMensagens(CONTEXTO_MAX);
  let resposta = "";
  let pendencia: string | null = null;
  // Codigo tecnico curto, seguro de mostrar: sem nome de tabela, sem token.
  let motivo: string | null = null;

  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    if (Date.now() - inicio > TETO_MS) break;
    const ultima = rodada === MAX_RODADAS - 1;

    // Catalogo vazio nao vira `tools: []`: array vazio e parametro invalido em
    // parte dos runtimes, e a falha vinha disfarcada de "nao sei responder".
    const comFerramentas = !ultima && catalogo.length > 0;

    let saida: any;
    try {
      saida = await chamarOpenAI(env, mensagens, comFerramentas ? catalogo : [], entrada.voice === true);
    } catch (erro) {
      const detalhe = erro instanceof Error ? erro.message : String(erro);
      // So corta contexto se o erro for de tamanho. Antes cortava para qualquer
      // falha, gastava rodada a toa e saia sem deixar rastro.
      const eTamanho = /context|token|length|too (large|long)|413/i.test(detalhe);
      const eQuota = /insufficient_quota|billing|quota|openai_429/i.test(detalhe);
      const semChave = /openai_api_key_ausente/i.test(detalhe);
      console.error({
        event: "jarvis_model_failed", rodada, com_ferramentas: comFerramentas,
        ferramentas: catalogo.length, contexto_chars: contexto.length,
        e_tamanho: eTamanho, detalhe,
      });
      if (eTamanho && contexto.length > CONTEXTO_REDUZIDO) {
        contexto = contexto.slice(0, CONTEXTO_REDUZIDO);
        mensagens.splice(0, mensagens.length, ...montarMensagens(CONTEXTO_REDUZIDO));
        continue;
      }
      motivo = semChave ? "openai_sem_chave" : eQuota ? "quota_ai_esgotada" : eTamanho ? "contexto_grande" : "modelo_indisponivel";
      break;
    }

    const pedidos = comFerramentas ? normalizarChamadas(saida) : [];
    if (!pedidos.length) {
      resposta = texto(saida);
      if (!resposta) {
        // O modelo respondeu vazio. Acontece quando ele tenta chamar ferramenta
        // num formato que o normalizador nao reconhece. Uma tentativa sem
        // ferramenta nenhuma costuma destravar -- e se nao destravar, o log diz.
        console.warn({
          event: "jarvis_resposta_vazia", rodada, com_ferramentas: comFerramentas,
          finish_reason: saida?.choices?.[0]?.finish_reason ?? null,
          chaves: Object.keys(saida ?? {}).slice(0, 8),
        });
        motivo = "modelo_sem_texto";
        if (comFerramentas) { catalogo.length = 0; continue; }
      }
      break;
    }

    // Chat Completions exige o turno do assistente com tool_calls antes dos resultados.
    const comId = pedidos.map((p, i) => ({ ...p, id: p.id ?? `call_${rodada}_${i}` }));
    mensagens.push({
      role: "assistant",
      content: saida?.choices?.[0]?.message?.content ?? null,
      tool_calls: comId.map((p) => ({ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.args) } })),
    });
    for (const pedido of comId) {
      const ferramenta = porNome.get(pedido.name);
      if (!ferramenta) {
        mensagens.push({ role: "tool", tool_call_id: pedido.id, content: "ferramenta inexistente" });
        continue;
      }
      if (!ferramenta.roles_allowed.includes(eu.papel)) {
        mensagens.push({ role: "tool", tool_call_id: pedido.id, content: "sem permissao para esta ferramenta" });
        continue;
      }

      if (ferramenta.mode === "write") {
        // nao executa. registra e devolve a bola para a pessoa.
        const resumo = resumirAcao(ferramenta, pedido.args);
        const criada = await rest("jarvis_pending_actions", jwt, env, {
          method: "POST",
          headers: { prefer: "return=representation" },
          body: JSON.stringify({
            user_id: eu.userId, conversation_id: conversationId,
            tool_name: ferramenta.name, arguments: pedido.args, summary: resumo,
          }),
        }).catch(() => null);
        const linhas = criada?.ok ? ((await criada.json().catch(() => [])) as any[]) : [];
        const id = linhas?.[0]?.id ?? null;
        if (id) {
          pendencia = id;
          canal?.emitir("pending", { action_id: id, summary: resumo });
          resposta = `${resumo}. Confirmo?`;
        } else {
          resposta = "Não consegui registrar essa ação agora.";
        }
        return { resposta, chamadas, pendencia, conversation_id: conversationId };
      }

      // Segunda barreira: o modelo pode chegar a uma consulta financeira a
      // partir de pergunta inocente ("panorama geral da empresa"). Aqui a
      // chamada ja' esta' montada e da' para olhar o SQL de verdade.
      const permissao = avaliarChamada(ferramenta.name, pedido.args);
      if (!permissao.permitido) {
        console.warn({ event: "jarvis_chamada_bloqueada", tool: ferramenta.name, motivo: permissao.motivo });
        chamadas.push({ name: ferramenta.name, ok: false, ms: 0 });
        mensagens.push({
          role: "tool", tool_call_id: pedido.id,
          content: `Consulta recusada: ${permissao.motivo}. Nao tente contornar; use uma ferramenta especifica ou informe que o dado nao esta disponivel.`,
        });
        continue;
      }

      const t0 = Date.now();
      canal?.emitir("tool_start", { name: ferramenta.name, summary: ferramenta.description });
      const r = await executarFerramenta(ferramenta, pedido.args, jwt, env);
      const ms = Date.now() - t0;
      chamadas.push({ name: ferramenta.name, ok: r.ok, ms });
      canal?.emitir("tool_end", { name: ferramenta.name, ok: r.ok, ms });
      mensagens.push({ role: "tool", tool_call_id: pedido.id, content: r.content });
    }
  }

  if (!resposta) {
    console.error({
      event: "jarvis_sem_resposta", motivo, papel: eu.papel,
      ferramentas: catalogo.length, chamadas: chamadas.length,
      duracao_ms: Date.now() - inicio,
    });
  }
  resposta = sanitizarResposta(resposta || mensagemDeFalha(motivo));
  if (canal) for (const parte of resposta.split(/(?<=[.!?\n])\s+/)) {
    if (parte.trim()) canal.emitir("token", { text: `${parte} ` });
  }

  const persistir = workspace("complete-chat", jwt, {
    conversation_id: preparado.conversation_id ?? conversationId,
    request_id: preparado.request_id,
    answer: resposta,
    original_message: mensagem,
    model: MODELO,
    latency_ms: Date.now() - inicio,
    context_sources: preparado.context_sources ?? [],
    context_client: preparado.context_client ?? null,
    intents: preparado.intents ?? [],
    metadata: { tool_calls: chamadas, agent: "jarvis" },
  }).catch(() => null);
  if (defer) defer(persistir); else await persistir;

  return { resposta, chamadas, pendencia, conversation_id: conversationId };
}

export { SIM, NAO, MODELO };
