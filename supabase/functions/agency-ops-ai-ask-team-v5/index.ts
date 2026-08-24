import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const clip = (value: unknown, max = 240) => {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function resolveNamed(question: string, rows: any[], field: string) {
  const q = ` ${norm(question)} `;
  let best: any = null;
  let score = 0;
  for (const row of rows) {
    const value = norm(row?.[field]);
    if (!value || value.length < 3) continue;
    let current = q.includes(` ${value} `) ? 1000 + value.length : 0;
    if (!current) {
      const parts = value.split(" ").filter((p) => p.length >= 4);
      current = parts.filter((p) => q.includes(` ${p} `)).reduce((s, p) => s + p.length, 0);
    }
    if (current > score) { best = row; score = current; }
  }
  return score >= 4 ? best : null;
}

function actionLines(answer: string) {
  const rawLower = answer.toLowerCase();
  const marker = Math.max(rawLower.lastIndexOf("próximos passos"), rawLower.lastIndexOf("proximos passos"));
  if (marker < 0) return [];
  const section = answer.slice(marker);
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const numbered = lines.filter((line) => /^(?:\d{1,2}[.)]|[-•])\s+/.test(line));
  const source = numbered.length ? numbered : lines.slice(1, 4);
  return source.slice(0, 3).map((line) => line.replace(/^(?:\d{1,2}[.)]|[-•])\s+/, "").trim()).filter((line) => line.length >= 8);
}

function inferRole(text: string) {
  const q = norm(text);
  if (/^(operacoes|operacao|adler|gestao|management)\b/.test(q)) return "MGMT";
  if (/^(designer|design)\b/.test(q)) return "DESIGN";
  if (/^(cs|customer success|atendimento|relacionamento)\b/.test(q)) return "CS";
  if (/^(gt|gestor de trafego|trafego)\b/.test(q)) return "GT";
  if (/\b(operacoes|operacao|adler|gestao|management)\b/.test(q)) return "MGMT";
  if (/\b(designer|design|criativo|criativos)\b/.test(q)) return "DESIGN";
  if (/\b(cs|customer success|atendimento|relacionamento)\b/.test(q)) return "CS";
  if (/\b(gt|gestor de trafego|trafego|campanha|meta ads|meta)\b/.test(q)) return "GT";
  return "MGMT";
}

function inferPriority(text: string) {
  const q = norm(text);
  if (/\b(critico|critica|imediato|imediata|agora|urgente|risco alto|churn)\b/.test(q)) return "CRITICAL";
  if (/\b(alta|alto|prioridade|hoje|sla vencido|atrasado)\b/.test(q)) return "HIGH";
  if (/\b(baixa|baixo|quando possivel|sem urgencia)\b/.test(q)) return "LOW";
  return "MEDIUM";
}

function inferType(text: string) {
  const q = norm(text);
  if (/\b(criativo|criativos|design|logo|layout|arte)\b/.test(q)) return "CREATIVE_REQUEST";
  if (/\b(integracao|api|z api|zapi|erro tecnico|webhook|falha tecnica|sincronizacao)\b/.test(q)) return "TECHNICAL";
  if (/\b(responder|follow up|cobrar|retorno|contato)\b/.test(q)) return "CLIENT_FOLLOWUP";
  if (/\b(clickup|task|tarefa)\b/.test(q)) return "CLICKUP";
  if (/\b(escalar|escalonar|escalacao)\b/.test(q)) return "ESCALATION";
  return "GENERAL";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return respond({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ ok: false, error: "server_configuration" }, 500);

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return respond({ ok: false, error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));

  const v4 = await fetch(`${supabaseUrl}/functions/v1/agency-ops-ai-ask-team-v4`, {
    method: "POST",
    headers: { Authorization: authorization, apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await v4.text();
  let result: any = null;
  try { result = raw ? JSON.parse(raw) : null; } catch {}
  if (!v4.ok || !result?.ok) {
    return new Response(raw, {
      status: v4.status,
      headers: { ...CORS, "content-type": v4.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const answer = String(result.answer || "");
  const lines = actionLines(answer);
  if (!lines.length) return respond({ ...result, suggested_actions: [] });

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await auth.auth.getUser();
  if (!userData?.user) return respond({ ...result, suggested_actions: [] });

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: roster }, { data: clients }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("team_roster").select("person,role,is_former").eq("is_former", false),
    ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner").in("lifecycle", ["ACTIVE", "ONBOARDING", "CHURNED"]).limit(600),
  ]);
  const person = pref?.collaborator_person ?? null;
  const me = (roster ?? []).find((row: any) => row.person === person);
  if (!person || !me) return respond({ ...result, suggested_actions: [] });

  const permitted = me.role === "GT" ? (clients ?? []).filter((c: any) => c.gt_owner === person)
    : me.role === "DESIGN" ? (clients ?? []).filter((c: any) => c.designer_owner === person)
    : (clients ?? []);
  const explicitClient = result.client ? (permitted ?? []).find((c: any) => norm(c.display_name) === norm(result.client)) : null;

  const actions = lines.map((text, index) => {
    const client = explicitClient || resolveNamed(text, permitted ?? [], "display_name");
    const role = inferRole(text);
    let targetPerson: string | null = null;
    if (client && role === "CS") targetPerson = client.cs_owner || null;
    else if (client && role === "DESIGN") targetPerson = client.designer_owner || null;
    else if (role !== "GT") {
      const named = resolveNamed(text, roster ?? [], "person");
      if (named && named.role === role) targetPerson = named.person;
    }
    return {
      id: `${result.request_id || "ops"}:${index + 1}`,
      title: clip(text, 220),
      description: text,
      client_id: client?.id ?? null,
      client_name: client?.display_name ?? null,
      target_role: role,
      target_person: targetPerson,
      priority: inferPriority(text),
      type: inferType(text),
      create_clickup: /\b(clickup|task|tarefa)\b/.test(norm(text)),
      source: "opsquestion_v5",
      source_id: result.request_id || null,
    };
  });

  return respond({ ...result, suggested_actions: actions });
});
