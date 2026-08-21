import { ops } from "./supabase.js";
import type { Identity } from "./identity.js";

export const CONVERSATION_FIELDS =
  "id,title,client_id,provider,model,is_archived,created_at,updated_at,last_message_at,metadata";

export class ConversationNotFound extends Error {
  constructor() {
    super("conversation_not_found");
  }
}

/**
 * Carrega a conversa exigindo posse.
 *
 * O filtro por user_id fica no mesmo `select` da busca por id, de proposito:
 * assim nao existe caminho em que a conversa e' lida primeiro e a posse
 * conferida depois. Trocar o UUID na requisicao devolve 404, nao 403 - o
 * usuario nao deve nem descobrir que a conversa de outra pessoa existe.
 */
export async function ownedConversation(identity: Identity, conversationId: string) {
  const { data, error } = await ops
    .from("ai_conversations")
    .select("*")
    .eq("id", conversationId)
    .eq("user_id", identity.userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new ConversationNotFound();
  return data as Record<string, any>;
}

export async function listConversations(identity: Identity, includeArchived: boolean) {
  let query = ops
    .from("ai_conversations")
    .select(CONVERSATION_FIELDS)
    .eq("user_id", identity.userId)
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (!includeArchived) query = query.eq("is_archived", false);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function listMessages(conversationId: string) {
  const { data, error } = await ops
    .from("ai_messages")
    .select("id,role,content,provider,model,source,latency_ms,created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Memoria operacional curta por chamada.
 *
 * O historico completo continua salvo em ai_messages para a interface e auditoria.
 * Aqui entram somente as trocas mais recentes, com teto de caracteres. Isso evita
 * que uma resposta antiga enorme (por exemplo uma lista de dezenas de clientes)
 * domine a pergunta atual, aumente tokens e deixe o modelo "preso" no assunto
 * anterior.
 */
export async function recentTurns(conversationId: string, limit: number) {
  const { data, error } = await ops
    .from("ai_messages")
    .select("role,content,created_at")
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const MAX_CONTEXT_CHARS = 16_000;
  const MAX_TURN_CHARS = 6_000;
  let used = 0;
  const newestFirst: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const row of data ?? []) {
    if (used >= MAX_CONTEXT_CHARS) break;
    let content = String((row as Record<string, any>).content ?? "").trim();
    if (!content) continue;

    if (content.length > MAX_TURN_CHARS) {
      content = `${content.slice(0, MAX_TURN_CHARS)}\n[trecho antigo reduzido para preservar foco na pergunta atual]`;
    }

    const remaining = MAX_CONTEXT_CHARS - used;
    if (content.length > remaining) content = content.slice(0, remaining);
    if (!content) break;

    newestFirst.push({
      role: (row as Record<string, any>).role === "assistant" ? "assistant" : "user",
      content,
    });
    used += content.length;
  }

  return newestFirst.reverse();
}
