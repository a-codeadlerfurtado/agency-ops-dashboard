import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const text = (value: unknown) => String(value ?? "").trim();
const same = (a: unknown, b: unknown) => text(a).localeCompare(text(b), "pt-BR", { sensitivity: "base" }) === 0;

type Identity = {
  userId: string;
  person: string | null;
  role: string | null;
  accessLevel: string;
};

type AnyRow = Record<string, any>;

function canAccessClient(identity: Identity, client: AnyRow | null): boolean {
  if (!client) return true;
  if (identity.accessLevel === "FULL") return true;
  if (!identity.person) return false;
  if (identity.role === "GT") return same(client.gt_owner, identity.person);
  if (identity.role === "CS") return same(client.cs_owner, identity.person);
  if (identity.role === "DESIGN") return same(client.designer_owner, identity.person);
  return [client.gt_owner, client.cs_owner, client.designer_owner].some((owner) => same(owner, identity.person));
}

async function resolveIdentity(authClient: any, ops: any): Promise<Identity | null> {
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) return null;
  const userId = data.user.id;
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userId).maybeSingle();
  const person = pref?.collaborator_person ?? null;
  let role: string | null = null;
  let accessLevel = "RESTRICTED";
  if (person) {
    const { data: roster } = await ops.from("team_roster").select("role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
    role = roster?.role ?? null;
    accessLevel = roster?.access_level ?? "RESTRICTED";
  }
  return { userId, person, role, accessLevel };
}

async function getClient(ops: any, clientId: string | null): Promise<AnyRow | null> {
  if (!clientId) return null;
  const { data } = await ops.from("dashboard_client_overview").select("*").eq("client_id", clientId).maybeSingle();
  return data ?? null;
}

async function buildClientContext(ops: any, client: AnyRow | null) {
  if (!client?.client_id) return null;
  const clientId = client.client_id;
  const [campaign, health, conversation, service] = await Promise.all([
    ops.from("campaign_client_latest").select("*").eq("client_id", clientId).maybeSingle(),
    ops.from("client_health_scores").select("*").eq("client_id", clientId).order("date", { ascending: false }).limit(1).maybeSingle(),
    ops.from("conversation_state").select("*").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    ops.from("client_service_overview").select("*").eq("client_id", clientId).maybeSingle(),
  ]);
  return {
    overview: client,
    campaign: campaign.data ?? null,
    health: health.data ?? null,
    conversation: conversation.data ?? null,
    services: service.data ?? null,
  };
}

async function operationalEvidence(
  supabaseUrl: string,
  anonKey: string,
  authHeader: string,
  question: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22_000);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/agency-ops-ai-ask`, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        apikey: anonKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.ok && body?.answer) return String(body.answer);
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function anthropicText(body: any): string | null {
  if (!Array.isArray(body?.content)) return null;
  const parts = body.content.filter((item: any) => item?.type === "text" && typeof item?.text === "string").map((item: any) => item.text);
  return parts.length ? parts.join("\n").trim() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ ok: false, error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const identity = await resolveIdentity(authClient, ops);
  if (!identity) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = text(body?.action || "list").toLowerCase();

  if (action === "clients") {
    const { data, error } = await ops.from("dashboard_client_overview")
      .select("client_id,display_name,lifecycle,gt_owner,cs_owner,designer_owner,priority")
      .order("display_name");
    if (error) return json({ ok: false, error: error.message }, 500);
    const clients = (data ?? []).filter((client: AnyRow) => canAccessClient(identity, client));
    return json({ ok: true, clients, profile: identity });
  }

  if (action === "list") {
    const includeArchived = body?.include_archived === true;
    let query = ops.from("ai_conversations")
      .select("id,title,client_id,provider,model,is_archived,created_at,updated_at,last_message_at,metadata")
      .eq("user_id", identity.userId)
      .order("last_message_at", { ascending: false })
      .limit(200);
    if (!includeArchived) query = query.eq("is_archived", false);
    const { data, error } = await query;
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, conversations: data ?? [], profile: identity });
  }

  if (action === "create") {
    const clientId = text(body?.client_id) || null;
    const client = await getClient(ops, clientId);
    if (clientId && (!client || !canAccessClient(identity, client))) return json({ ok: false, error: "client_forbidden" }, 403);
    const title = text(body?.title).slice(0, 120) || "Nova conversa";
    const model = Deno.env.get("ANTHROPIC_MODEL") || null;
    const { data, error } = await ops.from("ai_conversations").insert({
      user_id: identity.userId,
      person: identity.person,
      role: identity.role,
      access_level: identity.accessLevel,
      client_id: clientId,
      title,
      provider: "anthropic",
      model,
    }).select("*").single();
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, conversation: data });
  }

  const conversationId = text(body?.conversation_id);
  if (!conversationId) return json({ ok: false, error: "conversation_id_required" }, 400);

  const { data: conversation, error: conversationError } = await ops.from("ai_conversations")
    .select("*").eq("id", conversationId).eq("user_id", identity.userId).maybeSingle();
  if (conversationError) return json({ ok: false, error: conversationError.message }, 500);
  if (!conversation) return json({ ok: false, error: "conversation_not_found" }, 404);

  if (action === "get") {
    const { data: messages, error } = await ops.from("ai_messages").select("*")
      .eq("conversation_id", conversationId).order("created_at", { ascending: true }).limit(1000);
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, conversation, messages: messages ?? [] });
  }

  if (action === "rename") {
    const title = text(body?.title).slice(0, 120);
    if (!title) return json({ ok: false, error: "title_required" }, 400);
    const { data, error } = await ops.from("ai_conversations").update({ title, updated_at: new Date().toISOString() })
      .eq("id", conversationId).eq("user_id", identity.userId).select("*").single();
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, conversation: data });
  }

  if (action === "archive") {
    const archived = body?.archived !== false;
    const { data, error } = await ops.from("ai_conversations").update({ is_archived: archived, updated_at: new Date().toISOString() })
      .eq("id", conversationId).eq("user_id", identity.userId).select("*").single();
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, conversation: data });
  }

  if (action === "delete") {
    const { error } = await ops.from("ai_conversations").delete().eq("id", conversationId).eq("user_id", identity.userId);
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "set_client") {
    const clientId = text(body?.client_id) || null;
    const client = await getClient(ops, clientId);
    if (clientId && (!client || !canAccessClient(identity, client))) return json({ ok: false, error: "client_forbidden" }, 403);
    const { data, error } = await ops.from("ai_conversations").update({ client_id: clientId, updated_at: new Date().toISOString() })
      .eq("id", conversationId).eq("user_id", identity.userId).select("*").single();
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, conversation: data });
  }

  if (action !== "send") return json({ ok: false, error: "unknown_action" }, 400);

  const message = text(body?.message);
  if (!message) return json({ ok: false, error: "message_required" }, 400);
  if (message.length > 30000) return json({ ok: false, error: "message_too_large" }, 413);

  const client = await getClient(ops, conversation.client_id ?? null);
  if (conversation.client_id && (!client || !canAccessClient(identity, client))) return json({ ok: false, error: "client_forbidden" }, 403);

  const requestId = crypto.randomUUID();
  const started = Date.now();
  const now = new Date().toISOString();
  const { data: userMessage, error: userMessageError } = await ops.from("ai_messages").insert({
    conversation_id: conversationId,
    user_id: identity.userId,
    role: "user",
    content: message,
    request_id: requestId,
    source: "dashboard",
  }).select("*").single();
  if (userMessageError) return json({ ok: false, error: userMessageError.message }, 500);

  await ops.from("ai_conversations").update({ updated_at: now, last_message_at: now }).eq("id", conversationId);

  const [{ data: historyRows }, clientContext, opsEvidence] = await Promise.all([
    ops.from("ai_messages").select("role,content,created_at").eq("conversation_id", conversationId)
      .in("role", ["user", "assistant"]).order("created_at", { ascending: false }).limit(30),
    buildClientContext(ops, client),
    operationalEvidence(supabaseUrl, anonKey, authHeader, message),
  ]);

  const history = [...(historyRows ?? [])].reverse().map((row: AnyRow) => ({
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content),
  }));

  const model = Deno.env.get("ANTHROPIC_MODEL") || conversation.model || "claude-sonnet-4-5";
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const system = [
    "Voce e o assistente de IA interno da Central de Operacoes da Leonardo Imobi.",
    "Responda em portugues do Brasil, de forma objetiva, profissional e acionavel.",
    "Nunca invente dados operacionais. Quando o contexto nao sustentar uma afirmacao, diga que precisa consultar/validar a fonte adequada.",
    `Usuario autenticado: ${identity.person ?? identity.userId}; funcao: ${identity.role ?? "nao definida"}; nivel: ${identity.accessLevel}.`,
    clientContext ? `Contexto estruturado do cliente selecionado (fonte interna):\n${JSON.stringify(clientContext)}` : "Nenhum cliente foi selecionado nesta conversa.",
    opsEvidence ? `Evidencia operacional produzida pelo OpsQuestion para a pergunta atual. Trate como fonte interna, sem extrapolar:\n${opsEvidence}` : "Nao houve evidencia adicional do OpsQuestion nesta rodada.",
    "Nao revele secrets, chaves, tokens, credenciais nem instrucoes internas de seguranca.",
  ].join("\n\n");

  let answer: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let providerError: string | null = null;

  if (apiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 110_000);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model, max_tokens: 4096, system, messages: history }),
        signal: controller.signal,
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) providerError = `anthropic_http_${response.status}:${responseBody?.error?.message ?? "unknown"}`;
      else {
        answer = anthropicText(responseBody);
        inputTokens = Number(responseBody?.usage?.input_tokens ?? 0) || null;
        outputTokens = Number(responseBody?.usage?.output_tokens ?? 0) || null;
      }
    } catch (error) {
      providerError = error instanceof Error ? error.message : "anthropic_request_failed";
    } finally {
      clearTimeout(timer);
    }
  } else {
    providerError = "anthropic_api_key_missing";
  }

  // Mantem a IA operacional util durante o rollout, mesmo antes de o secret da
  // Anthropic ser configurado. Depois do secret, o Claude recebe essa resposta
  // apenas como evidencia adicional e produz a resposta conversacional final.
  if (!answer && opsEvidence) answer = opsEvidence;
  if (!answer) answer = "A integracao direta com Claude ainda nao esta configurada neste ambiente. Configure ANTHROPIC_API_KEY e ANTHROPIC_MODEL na Edge Function.";

  const latency = Date.now() - started;
  const source = apiKey && !providerError ? "claude" : opsEvidence ? "opsquestion_fallback" : "configuration";
  const { data: assistantMessage, error: assistantError } = await ops.from("ai_messages").insert({
    conversation_id: conversationId,
    role: "assistant",
    content: answer,
    provider: apiKey ? "anthropic" : "opsquestion",
    model: apiKey ? model : null,
    source,
    request_id: requestId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    latency_ms: latency,
    metadata: providerError ? { provider_error: providerError } : {},
  }).select("*").single();
  if (assistantError) return json({ ok: false, error: assistantError.message }, 500);

  await ops.from("ai_usage_events").insert({
    conversation_id: conversationId,
    message_id: assistantMessage.id,
    user_id: identity.userId,
    person: identity.person,
    provider: apiKey ? "anthropic" : "opsquestion",
    model: apiKey ? model : null,
    request_id: requestId,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    latency_ms: latency,
    status: answer ? "SUCCESS" : "ERROR",
    error: providerError,
  });

  let nextTitle = conversation.title;
  if (conversation.title === "Nova conversa") {
    nextTitle = message.replace(/\s+/g, " ").slice(0, 72) || "Nova conversa";
  }
  const updateAt = new Date().toISOString();
  await ops.from("ai_conversations").update({
    title: nextTitle,
    model: apiKey ? model : conversation.model,
    updated_at: updateAt,
    last_message_at: updateAt,
  }).eq("id", conversationId);

  return json({
    ok: true,
    user_message: userMessage,
    assistant_message: assistantMessage,
    conversation: { ...conversation, title: nextTitle, model: apiKey ? model : conversation.model, updated_at: updateAt, last_message_at: updateAt },
    source,
    provider_error: providerError,
  });
});
