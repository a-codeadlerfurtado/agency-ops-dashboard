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

export async function recentTurns(conversationId: string, limit: number) {
  const { data, error } = await ops
    .from("ai_messages")
    .select("role,content,created_at")
    .eq("conversation_id", conversationId)
    .in("role", ["user", "assistant"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return [...(data ?? [])]
    .reverse()
    .map((row: Record<string, any>) => ({
      role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: String(row.content),
    }));
}
