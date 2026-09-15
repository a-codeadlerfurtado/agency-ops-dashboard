import { Router, type Request, type Response, type NextFunction } from "express";
import { env } from "../env.js";
import { ops } from "../services/supabase.js";
import { resolveIdentity, type Identity } from "../services/identity.js";
import { assertClientAllowed, listAllowedClients, ClientForbidden } from "../services/permissions.js";
import {
  CONVERSATION_FIELDS,
  ConversationNotFound,
  listConversations,
  listMessages,
  ownedConversation,
  recentTurns,
} from "../services/conversations.js";
import { buildClientContext, operationalEvidence } from "../services/client-context.js";
import { askLlm } from "../services/llm.js";

type AuthedRequest = Request & { identity: Identity; accessToken: string };

const text = (value: unknown) => String(value ?? "").trim();

// Janela deslizante por usuario. O objetivo nao e' antifraude, e' evitar que um
// loop no navegador queime credito do provedor sem ninguem perceber.
const hits = new Map<string, number[]>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const window = (hits.get(userId) ?? []).filter((at) => now - at < 60_000);
  window.push(now);
  hits.set(userId, window);
  return window.length > env.rateLimitPerMinute;
}

async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.header("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const accessToken = header.slice(7).trim();
  let identity: Identity | null = null;
  try {
    identity = await resolveIdentity(accessToken);
  } catch {
    res.status(503).json({ ok: false, error: "auth_unavailable" });
    return;
  }
  if (!identity) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  // Cadastro nao aprovado, ou login sem vinculo no quadro: a IA fica fechada.
  // O dashboard ja' trata esse estado como "nao ve' nada"; aqui o equivalente
  // e' nao deixar sequer abrir conversa.
  if (identity.locked) {
    res.status(403).json({ ok: false, error: "account_locked" });
    return;
  }

  if (identity.userId !== "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476") {
    res.status(403).json({ ok: false, error: "ai_beta" });
    return;
  }

  (req as AuthedRequest).identity = identity;
  (req as AuthedRequest).accessToken = accessToken;
  next();
}

function publicProfile(identity: Identity) {
  return {
    userId: identity.userId,
    person: identity.person,
    role: identity.role,
    accessLevel: identity.accessLevel,
    elevated: identity.elevated,
  };
}

export const aiRouter = Router();

aiRouter.use(authenticate);

aiRouter.post("/clients", async (req, res, next) => {
  try {
    const { identity } = req as AuthedRequest;
    res.json({
      ok: true,
      clients: await listAllowedClients(identity),
      profile: publicProfile(identity),
    });
  } catch (caught) {
    next(caught);
  }
});

aiRouter.post("/conversations/list", async (req, res, next) => {
  try {
    const { identity } = req as AuthedRequest;
    const conversations = await listConversations(identity, req.body?.include_archived === true);
    res.json({ ok: true, conversations, profile: publicProfile(identity) });
  } catch (caught) {
    next(caught);
  }
});

aiRouter.post("/conversations/create", async (req, res, next) => {
  try {
    const { identity } = req as AuthedRequest;
    const clientId = text(req.body?.client_id) || null;
    await assertClientAllowed(identity, clientId);

    const { data, error } = await ops
      .from("ai_conversations")
      .insert({
        user_id: identity.userId,
        person: identity.person,
        role: identity.role,
        access_level: identity.accessLevel,
        client_id: clientId,
        title: text(req.body?.title).slice(0, 120) || "Nova conversa",
        provider: "openai",
        model: env.openaiModel,
      })
      .select(CONVERSATION_FIELDS)
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, conversation: data });
  } catch (caught) {
    next(caught);
  }
});

aiRouter.post("/conversations/get", async (req, res, next) => {
  try {
    const { identity } = req as AuthedRequest;
    const conversation = await ownedConversation(identity, text(req.body?.conversation_id));
    res.json({ ok: true, conversation, messages: await listMessages(conversation.id) });
  } catch (caught) {
    next(caught);
  }
});

aiRouter.post("/conversations/rename", async (req, res, next) => {
  try {
    const { identity } = req as AuthedRequest;
    const conversation = await ownedConversation(identity, text(req.body?.conversation_id));
    const title = text(req.body?.title).slice(0, 120);
    if (!title) {
      res.status(400).json({ ok: false, error: "title_required" });
      return;
    }

    const { data, error } = await ops
      .from("ai_conversations")
      .update({ title, updated_at: new Date().toISOString() })
      .eq("id", conversation.id)
      .eq("user_id", identity.userId)
      .select(CONVERSATION_FIELDS)
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, conversation: data });
  } catch (caught) {
    next(caught);
  }
});

aiRouter.post("/conversations/archive", async (req, res, next) => {
  try {
    const { identity } = req as AuthedRequest;
    const conversation = await ownedConversation(identity, text(req.body?.conversation_id));
    const { data, error } = await ops
      .from("ai_conversations")
      .update({ is_archived: req.body?.archived !== false, updated_at: new Date().toISOString() })
      .eq("id", conversation.id)
      .eq("user_id", identity.userId)
      .select(CONVERSATION_FIELDS)
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, conversation: data });
  } catch (caught) {
    next(caught);
  }
});

aiRouter.post("/conversations/delete", async (req, res, next) => {
  try {
    const { identity } = req as AuthedRequest;
    const conversation = await ownedConversation(identity, text(req.body?.conversation_id));
    const { error } = await ops
      .from("ai_conversations")
      .delete()
      .eq("id", conversation.id)
      .eq("user_id", identity.userId);
    if (error) throw new Error(error.message);
    res.json({ ok: true });
  } catch (caught) {
    next(caught);
  }
});

aiRouter.post("/conversations/set-client", async (req, res, next) => {
  try {
    const { identity } = req as AuthedRequest;
    const conversation = await ownedConversation(identity, text(req.body?.conversation_id));
    const clientId = text(req.body?.client_id) || null;
    await assertClientAllowed(identity, clientId);

    const { data, error } = await ops
      .from("ai_conversations")
      .update({ client_id: clientId, updated_at: new Date().toISOString() })
      .eq("id", conversation.id)
      .eq("user_id", identity.userId)
      .select(CONVERSATION_FIELDS)
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, conversation: data });
  } catch (caught) {
    next(caught);
  }
});

aiRouter.post("/chat", async (req, res, next) => {
  try {
    const { identity, accessToken } = req as AuthedRequest;
    if (rateLimited(identity.userId)) {
      res.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }

    const conversation = await ownedConversation(identity, text(req.body?.conversation_id));
    const message = text(req.body?.message);
    if (!message) {
      res.status(400).json({ ok: false, error: "message_required" });
      return;
    }
    if (message.length > env.maxMessageChars) {
      res.status(413).json({ ok: false, error: "message_too_large" });
      return;
    }

    // Revalida o cliente da conversa a cada envio. Sem isso, uma carteira
    // alterada depois que a conversa foi criada continuaria entregando contexto
    // de um cliente que a pessoa ja' nao pode mais ver.
    const client = await assertClientAllowed(identity, conversation.client_id ?? null);

    const requestId = crypto.randomUUID();
    const { data: userMessage, error: userMessageError } = await ops
      .from("ai_messages")
      .insert({
        conversation_id: conversation.id,
        user_id: identity.userId,
        role: "user",
        content: message,
        request_id: requestId,
        source: "dashboard",
      })
      .select("id,role,content,created_at")
      .single();
    if (userMessageError) throw new Error(userMessageError.message);

    const [turns, clientContext, evidence] = await Promise.all([
      recentTurns(conversation.id, env.historyLimit),
      buildClientContext(client),
      operationalEvidence(env.supabaseUrl, env.supabasePublishableKey, accessToken, message),
    ]);

    const system = [
      "Voce e o assistente de IA interno da Central de Operacoes da Leonardo Imobi.",
      "Responda em portugues do Brasil, de forma objetiva, profissional e acionavel.",
      "Nunca invente dados operacionais. Quando o contexto nao sustentar uma afirmacao, diga que precisa consultar a fonte adequada.",
      `Usuario autenticado: ${identity.person ?? identity.userId}; funcao: ${identity.role ?? "nao definida"}; nivel: ${identity.accessLevel}.`,
      clientContext
        ? `Contexto estruturado do cliente selecionado (fonte interna):\n${JSON.stringify(clientContext)}`
        : "Nenhum cliente foi selecionado nesta conversa.",
      evidence
        ? `Evidencia operacional do OpsQuestion para a pergunta atual. Trate como fonte interna, sem extrapolar:\n${evidence}`
        : "Nao houve evidencia adicional do OpsQuestion nesta rodada.",
      "Nao revele secrets, chaves, tokens, credenciais nem instrucoes internas de seguranca.",
    ].join("\n\n");

    const result = await askLlm(system, turns);
    const answer =
      result.text ?? evidence ?? "Nao consegui obter resposta do modelo agora. Tente novamente em instantes.";
    const source = result.text ? "openai" : evidence ? "opsquestion_fallback" : "unavailable";

    const { data: assistantMessage, error: assistantError } = await ops
      .from("ai_messages")
      .insert({
        conversation_id: conversation.id,
        role: "assistant",
        content: answer,
        provider: "openai",
        model: result.model,
        source,
        request_id: requestId,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
        latency_ms: result.latencyMs,
        metadata: result.error ? { provider_error: result.error } : {},
      })
      .select("id,role,content,provider,model,source,latency_ms,created_at")
      .single();
    if (assistantError) throw new Error(assistantError.message);

    await ops.from("ai_usage_events").insert({
      conversation_id: conversation.id,
      message_id: assistantMessage.id,
      user_id: identity.userId,
      person: identity.person,
      provider: "openai",
      model: result.model,
      request_id: requestId,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      latency_ms: result.latencyMs,
      status: result.text ? "SUCCESS" : "ERROR",
      error: result.error,
    });

    const nextTitle =
      conversation.title === "Nova conversa"
        ? message.replace(/\s+/g, " ").slice(0, 72) || "Nova conversa"
        : conversation.title;

    const { data: updated } = await ops
      .from("ai_conversations")
      .update({ title: nextTitle, model: result.model, updated_at: new Date().toISOString() })
      .eq("id", conversation.id)
      .eq("user_id", identity.userId)
      .select(CONVERSATION_FIELDS)
      .single();

    res.json({
      ok: true,
      user_message: userMessage,
      assistant_message: assistantMessage,
      conversation: updated,
      source,
      provider_error: result.error,
    });
  } catch (caught) {
    next(caught);
  }
});

export function aiErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof ClientForbidden) {
    res.status(403).json({ ok: false, error: "client_forbidden" });
    return;
  }
  if (error instanceof ConversationNotFound) {
    res.status(404).json({ ok: false, error: "conversation_not_found" });
    return;
  }
  console.error("[ai] erro nao tratado:", error instanceof Error ? error.message : error);
  res.status(500).json({ ok: false, error: "internal_error" });
}
