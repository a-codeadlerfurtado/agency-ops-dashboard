import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

type Row = Record<string, any>;

const STAGE_ALIASES: Record<string, string[]> = {
  SALES_CONFIRMED: ["venda confirmada", "crm won"],
  OPERATIONAL_ACTIVATION: ["ativacao operacional"],
  INTRO_MEETING: ["primeira reuniao", "1a reuniao", "reuniao de apresentacao", "apresentacao"],
  PRODUCT_PERSONA_MEETING: ["produto e persona", "produto persona", "produto + persona", "segunda reuniao", "2a reuniao"],
  PRODUCT_FORM: ["formulario produto", "formulario de produto"],
  PERSONA_FORM: ["formulario persona", "formulario de persona"],
  RAW_ASSETS: ["materiais brutos", "materiais no drive", "arquivos no drive", "fotos e videos"],
  INTEGRATION_MEETING: ["reuniao de integracao", "integracao com gt", "integracao do gt", "integracao"],
  ACCESS_VALIDATION: ["validacao de acessos", "validacao dos acessos", "acessos validados"],
  CREATIVE_PRODUCTION: ["producao criativa", "criativos em producao"],
  CREATIVE_APPROVAL: ["aprovacao de criativos", "criativos aprovados", "cliente aprovou os criativos"],
  READY_TO_LAUNCH: ["pronto para lancar", "pronto para campanha"],
  CAMPAIGN_LAUNCH: ["campanha no ar", "campanha publicada", "campanha lancada", "campanha ativa"],
};

const COMPLETION_WORDS = [
  "avancou", "concluiu", "concluida", "concluido", "finalizou", "terminou", "completou",
  "ja fez", "foi feita", "foi feito", "realizada", "realizado", "pode avancar", "pode passar",
];

function norm(value: unknown) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim().replace(/\s+/g, " ");
}

function clientScore(command: string, name: string) {
  const n = norm(name);
  if (!n) return 0;
  if (command.includes(n)) return 10000 + n.length;
  const tokens = n.split(" ").filter((token) => token.length >= 4);
  const matched = tokens.filter((token) => command.split(" ").includes(token));
  if (tokens.length && matched.length === tokens.length) return 5000 + matched.join("").length;
  if (matched.length >= 2) return 1500 + matched.join("").length;
  if (matched.length === 1 && matched[0].length >= 6) return 200 + matched[0].length;
  return 0;
}

function explicitStage(command: string) {
  let best: { code: string; alias: string } | null = null;
  for (const [code, aliases] of Object.entries(STAGE_ALIASES)) {
    for (const aliasRaw of aliases) {
      const alias = norm(aliasRaw);
      if (command.includes(alias) && (!best || alias.length > best.alias.length)) best = { code, alias };
    }
  }
  return best?.code || null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData?.user?.id) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = authData.user.id;
  const [{ data: pref }, { data: approval }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = String(pref?.collaborator_person || "");
  if (person !== "Adler Furtado" || !(approval || []).length) return respond({ error: "forbidden", detail: "Comando operacional disponível apenas para Adler." }, 403);

  const body = await req.json().catch(() => ({}));
  const rawCommand = String(body?.command || "").trim();
  if (rawCommand.length < 5) return respond({ error: "command_too_short", detail: "Escreva o cliente e o que avançou." }, 400);
  if (rawCommand.length > 1000) return respond({ error: "command_too_long", detail: "Comando muito longo." }, 400);
  const command = norm(rawCommand);
  const isCompletion = COMPLETION_WORDS.some((word) => command.includes(norm(word)));
  if (!isCompletion) return respond({ error: "action_not_understood", detail: "Por segurança, este campo só executa avanços/conclusões. Ex.: ‘Estela Giraldi concluiu Produto + Persona’." }, 422);

  const { data: cases, error: caseError } = await ops.from("onboarding_cases")
    .select("id,client_id,status,current_stage,next_action,next_action_due")
    .eq("status", "OPEN");
  if (caseError) return respond({ error: "cases_failed", detail: caseError.message }, 500);
  const caseRows = cases || [];
  const clientIds = Array.from(new Set(caseRows.map((row: Row) => String(row.client_id)).filter(Boolean)));
  const { data: clients, error: clientError } = await ops.from("clients").select("id,display_name").in("id", clientIds);
  if (clientError) return respond({ error: "clients_failed", detail: clientError.message }, 500);
  const clientMap = new Map((clients || []).map((row: Row) => [String(row.id), row]));

  const candidates = caseRows.map((item: Row) => {
    const client = clientMap.get(String(item.client_id)) || {};
    return { case: item, client, score: clientScore(command, String(client.display_name || "")) };
  }).filter((item: Row) => item.score > 0).sort((a: Row, b: Row) => b.score - a.score);

  if (!candidates.length) return respond({ error: "client_not_found", detail: "Não consegui identificar com segurança qual cliente você quis atualizar." }, 422);
  if (candidates.length > 1 && candidates[0].score < 5000 && candidates[1].score === candidates[0].score) {
    return respond({ error: "client_ambiguous", detail: "Encontrei mais de um cliente possível. Escreva o nome mais completo.", options: candidates.slice(0, 4).map((item: Row) => item.client.display_name) }, 409);
  }

  const selected = candidates[0];
  const caseRow = selected.case;
  const client = selected.client;
  let stageCode = explicitStage(command);
  const refersCurrent = ["essa etapa", "etapa atual", "nesta etapa", "nessa etapa", "avancou a etapa", "avancou dessa etapa"].some((phrase) => command.includes(norm(phrase)));
  if (!stageCode && refersCurrent) stageCode = String(caseRow.current_stage || "");
  if (!stageCode && command.includes("avancou")) stageCode = String(caseRow.current_stage || "");
  if (!stageCode) return respond({ error: "stage_not_found", detail: `Identifiquei ${client.display_name}, mas não entendi qual etapa avançou. Você pode escrever “etapa atual” ou citar a etapa.` }, 422);
  if (stageCode === "COMPLETED") return respond({ error: "already_completed", detail: "Esse onboarding já está concluído." }, 409);

  const { data: stages, error: stagesError } = await ops.from("onboarding_stages")
    .select("id,stage_code,status,completed_at,due_at")
    .eq("case_id", caseRow.id);
  if (stagesError) return respond({ error: "stages_failed", detail: stagesError.message }, 500);
  const stage = (stages || []).find((row: Row) => String(row.stage_code) === stageCode);
  if (!stage) return respond({ error: "stage_missing", detail: "A etapa identificada não existe neste onboarding." }, 409);

  const { data: defs } = await ops.from("onboarding_stage_definitions").select("code,label,ordem").eq("code", stageCode).maybeSingle();
  if (String(stage.status).toUpperCase() === "DONE") {
    return respond({ ok: true, changed: false, already_done: true, client: client.display_name, stage_code: stageCode, stage_label: defs?.label || stageCode, message: `${client.display_name}: essa etapa já estava concluída.` });
  }

  const sourceId = `adler-command:${crypto.randomUUID()}`;
  const { data: attemptId, error: rpcError } = await ops.rpc("register_onboarding_stage_attempt", {
    p_case_id: caseRow.id,
    p_stage_code: stageCode,
    p_outcome: "SUCCESS",
    p_reason_code: "MANUAL_OPERATIONAL_CONFIRMATION",
    p_reason_detail: "Atualização manual informada por Adler no comando do onboarding.",
    p_objective: `Confirmar conclusão da etapa ${defs?.label || stageCode}`,
    p_objective_achieved: true,
    p_retry_required: false,
    p_ended_at: new Date().toISOString(),
    p_source: "manual_adler_command",
    p_source_id: sourceId,
    p_evidence_text: rawCommand,
    p_detected_by: person,
    p_confidence: "CONFIRMED",
    p_metadata: { actor_user_id: userKey, command: rawCommand, parser: "deterministic_v1", client_name: client.display_name, stage_code: stageCode },
  });
  if (rpcError) return respond({ error: "update_failed", detail: rpcError.message }, 500);

  const [{ data: refreshedCase }, { data: refreshedStage }] = await Promise.all([
    ops.from("onboarding_cases").select("id,current_stage,next_action,next_action_due,onboarding_risk,blocked_by,updated_at").eq("id", caseRow.id).maybeSingle(),
    ops.from("onboarding_stages").select("stage_code,status,completed_at,due_at").eq("case_id", caseRow.id).eq("stage_code", stageCode).maybeSingle(),
  ]);

  return respond({
    ok: true,
    changed: true,
    attempt_id: attemptId,
    client: client.display_name,
    client_id: caseRow.client_id,
    case_id: caseRow.id,
    stage_code: stageCode,
    stage_label: defs?.label || stageCode,
    stage: refreshedStage,
    case: refreshedCase,
    message: `${client.display_name}: ${defs?.label || stageCode} marcada como concluída.`,
  });
});
