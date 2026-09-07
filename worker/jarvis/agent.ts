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
import {
  carregarCatalogo, paraFormatoWorkersAi, normalizarChamadas,
  executarFerramenta, resumirAcao,
  type EnvJarvis, type FerramentaJarvis,
} from "./tools";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const WORKSPACE = `${SUPABASE}/functions/v1/agency-ops-ai-workspace`;
const MODELO = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_RODADAS = 6;
const TETO_MS = 45_000;
const CONTEXTO_MAX = 14_000;
const CONTEXTO_REDUZIDO = 8_000;

const SIM = /^(sim|confirma|confirmar|confirmado|pode|pode ir|vai|ok|isso|manda|beleza|positivo)\.?$/i;
const NAO = /^(nao|não|cancela|cancelar|deixa|deixa quieto|para|negativo|esquece)\.?$/i;

export type Identidade = { pessoa: string; papel: string; userId: string | null };

function texto(resultado: any): string {
  for (const c of [resultado?.response, resultado?.result?.response, resultado?.result?.text,
                   resultado?.text, resultado?.choices?.[0]?.message?.content]) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
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

  let pessoa = "";
  const prefs = await rest("user_preferences?select=collaborator_person&limit=1", jwt, env).catch(() => null);
  if (prefs?.ok) {
    const linhas = (await prefs.json().catch(() => [])) as any[];
    pessoa = String(linhas?.[0]?.collaborator_person ?? "").trim();
  }
  if (!pessoa) return { pessoa: "", papel: "UNASSIGNED", userId };

  let papel = "UNASSIGNED";
  const roster = await rest(
    `team_roster?select=person,role&person=eq.${encodeURIComponent(pessoa)}&limit=1`, jwt, env,
  ).catch(() => null);
  if (roster?.ok) {
    const linhas = (await roster.json().catch(() => [])) as any[];
    papel = String(linhas?.[0]?.role ?? "UNASSIGNED").trim() || "UNASSIGNED";
  }
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
): Promise<{ resposta: string; chamadas: Array<{ name: string; ok: boolean; ms: number }>; pendencia: string | null }> {
  const inicio = Date.now();
  const eu = identidadeForcada ?? (await identificarUsuario(jwt, env));
  const mensagem = String(entrada.message ?? "").trim();
  const chamadas: Array<{ name: string; ok: boolean; ms: number }> = [];

  let conversationId = entrada.conversation_id ?? null;
  if (!conversationId) {
    const criada = await workspace("conversations/create", jwt, { client_id: entrada.client_id ?? null });
    conversationId = criada?.conversation?.id ?? criada?.id ?? null;
  }

  const preparado = await workspace("prepare-chat", jwt, {
    conversation_id: conversationId,
    message: mensagem,
    client_id: entrada.client_id ?? null,
  });
  if (!preparado?.ok) {
    canal?.emitir("error", { message: "nao consegui carregar o contexto" });
    return { resposta: "Não consegui carregar o contexto agora.", chamadas, pendencia: null };
  }

  const catalogo = (await carregarCatalogo(eu.papel, jwt, env))
    .filter((f) => !ferramentasPermitidas || ferramentasPermitidas.includes(f.name));
  const porNome = new Map<string, FerramentaJarvis>(catalogo.map((f) => [f.name, f]));

  let contexto = String(preparado.system ?? "");
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

  for (let rodada = 0; rodada < MAX_RODADAS; rodada++) {
    if (Date.now() - inicio > TETO_MS) break;
    const ultima = rodada === MAX_RODADAS - 1;

    let saida: any;
    try {
      saida = await env.AI!.run(MODELO, {
        messages: mensagens,
        ...(ultima ? {} : { tools: paraFormatoWorkersAi(catalogo) }),
        temperature: 0.15,
        max_tokens: 900,
      });
    } catch (erro) {
      // uma unica tentativa com contexto cortado; se o problema era tamanho, resolve
      if (contexto.length > CONTEXTO_REDUZIDO) {
        contexto = contexto.slice(0, CONTEXTO_REDUZIDO);
        mensagens.splice(0, mensagens.length, ...montarMensagens(CONTEXTO_REDUZIDO));
        continue;
      }
      canal?.emitir("error", { message: erro instanceof Error ? erro.message : "modelo indisponivel" });
      break;
    }

    const pedidos = ultima ? [] : normalizarChamadas(saida);
    if (!pedidos.length) { resposta = texto(saida); break; }

    for (const pedido of pedidos) {
      const ferramenta = porNome.get(pedido.name);
      if (!ferramenta) {
        mensagens.push({ role: "tool", name: pedido.name, content: "ferramenta inexistente" });
        continue;
      }
      if (!ferramenta.roles_allowed.includes(eu.papel)) {
        mensagens.push({ role: "tool", name: pedido.name, content: "sem permissao para esta ferramenta" });
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
        return { resposta, chamadas, pendencia };
      }

      const t0 = Date.now();
      canal?.emitir("tool_start", { name: ferramenta.name, summary: ferramenta.description });
      const r = await executarFerramenta(ferramenta, pedido.args, jwt, env);
      const ms = Date.now() - t0;
      chamadas.push({ name: ferramenta.name, ok: r.ok, ms });
      canal?.emitir("tool_end", { name: ferramenta.name, ok: r.ok, ms });
      mensagens.push({ role: "tool", name: ferramenta.name, content: r.content });
    }
  }

  resposta = sanitizarResposta(resposta || "Não consegui responder isso agora.");
  if (canal) for (const parte of resposta.split(/(?<=[.!?\n])\s+/)) {
    if (parte.trim()) canal.emitir("token", { text: `${parte} ` });
  }

  await workspace("complete-chat", jwt, {
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

  return { resposta, chamadas, pendencia };
}

export { SIM, NAO, MODELO };
