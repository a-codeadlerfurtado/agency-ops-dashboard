import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

const CLOUDFLARE_AI_BASE = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/ai";
const MAX_PROMPT_CHARS = 18_000;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function safeAnswer(body: any, raw = "") {
  const candidates = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message, body?.assistant_message?.content];
  for (const value of candidates) if (typeof value === "string" && value.trim()) return value.trim();
  if (raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
}

async function callCloudflare(authHeader: string, question: string) {
  let conversationId = "";
  async function post(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${CLOUDFLARE_AI_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const raw = await response.text();
    let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok || !parsed?.ok) throw new Error(`cloudflare_${response.status}`);
    return parsed;
  }

  try {
    const created = await post("/conversations/create", { client_id: null, title: "Consultor de Performance" });
    conversationId = String(created?.conversation?.id || "");
    if (!conversationId) throw new Error("conversation_missing");
    const result = await post("/chat", { conversation_id: conversationId, message: question });
    const answer = safeAnswer({ assistant_message: result?.assistant_message });
    if (!answer) throw new Error("empty_answer");
    return answer;
  } finally {
    if (conversationId) {
      try { await post("/conversations/delete", { conversation_id: conversationId }); } catch {}
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "Método não permitido." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ ok: false, error: "Consultor temporariamente indisponível." }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply({ ok: false, error: "Sessão indisponível." }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return reply({ ok: false, error: "Sessão indisponível." }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person ?? null;
  if (!person || !(approvals ?? []).length) return reply({ ok: false, error: "Seu acesso ao Consultor ainda não está liberado." }, 403);

  const { data: roster } = await ops.from("team_roster").select("person,role").eq("person", person).eq("is_former", false).maybeSingle();
  const role = String(roster?.role || "");
  if (!roster || !["GT", "MGMT"].includes(role)) return reply({ ok: false, error: "O Consultor de Performance não está disponível para este perfil." }, 403);

  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return reply({ ok: false, error: "Não há contexto suficiente para gerar a leitura." }, 400);
  if (question.length > MAX_PROMPT_CHARS) {
    return reply({ ok: false, error: "O contexto deste cliente ficou grande demais para uma única leitura. Atualize a carteira e tente novamente." }, 400);
  }

  const isConsultantPrompt = question.includes("DADOS ATUAIS DO DASHBOARD:") || (question.includes("DADOS ATUAIS:") && question.includes("PERGUNTA DO GT:"));
  if (!isConsultantPrompt) return reply({ ok: false, error: "Esta rota é exclusiva do Consultor de Performance." }, 400);

  try {
    const answer = await callCloudflare(authHeader, question);
    return reply({ ok: true, answer, source: "META_CONSULTANT_AI", generated_at: new Date().toISOString() });
  } catch (error) {
    console.error("[meta-consultant-ai]", error instanceof Error ? error.message : String(error));
    return reply({ ok: false, error: "Não foi possível gerar a leitura agora. Tente novamente em alguns segundos." }, 502);
  }
});
