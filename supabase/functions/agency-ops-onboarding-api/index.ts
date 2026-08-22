import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await authClient.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return respond({ error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person ?? null;
  const signupApproved = (approvals ?? []).some((row: any) => row.kind === "SIGNUP");
  if (!person || !signupApproved) return respond({ error: "forbidden" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return respond({ error: "forbidden" }, 403);
  const role = String(roster.role ?? "");
  const isAdler = person === "Adler Furtado";
  const canAssign = isAdler || role === "CS";
  const canWorkOnboarding = canAssign || role === "GT";
  const [{ data: walletRows }, { data: activeGts }] = await Promise.all([
    ops.from("wallet_registry").select("gt_owner,carteira,ordem").order("ordem"),
    ops.from("team_roster").select("person").eq("role", "GT").eq("is_former", false),
  ]);
  const activeGtNames = new Set((activeGts ?? []).map((row: any) => String(row.person)));
  const gtOptions = (walletRows ?? []).filter((row: any) => activeGtNames.has(String(row.gt_owner))).slice(0, 3).map((row: any) => ({ person: row.gt_owner, carteira: row.carteira, ordem: row.ordem }));

  if (req.method === "POST") {
    if (!canAssign) return respond({ error: "forbidden" }, 403);
    const body = await req.json().catch(() => ({}));
    const requestId = String(body.request_id ?? "");
    const clientId = String(body.client_id ?? "");
    const gtOwner = String(body.gt_owner ?? "").trim();
    if (!requestId || !clientId || !gtOwner) return respond({ error: "missing_fields", required: ["request_id", "client_id", "gt_owner"] }, 400);
    if (!gtOptions.some((option: any) => option.person === gtOwner)) return respond({ error: "gt_not_allowed" }, 400);
    const { data, error } = await ops.rpc("assign_onboarding_gt", { p_request_id: requestId, p_client_id: clientId, p_gt_owner: gtOwner, p_actor: person });
    if (error) {
      const known = String(error.message ?? "");
      const status = known.includes("REQUEST_ALREADY_RESOLVED") ? 409 : known.includes("NOT_FOUND") ? 404 : known.includes("MISMATCH") || known.includes("NOT_ALLOWED") ? 400 : 500;
      return respond({ error: "assignment_failed", detail: known }, status);
    }
    return respond(data ?? { ok: true });
  }

  if (!canWorkOnboarding) return respond({ worklist: [], assignment_notifications: [], gt_options: [], playbook_slas: [], sla_summary: {}, generated_at: new Date().toISOString() });

  let workQuery = ops.from("gt_onboarding_worklist").select("*").order("integration_due_at", { ascending: true, nullsFirst: false }).order("display_name", { ascending: true });
  if (role === "GT" && !isAdler) workQuery = workQuery.eq("gt_owner", person);
  let slaQuery = ops.from("onboarding_sla_board").select("*").order("due_at", { ascending: true });
  if (role === "GT" && !isAdler) slaQuery = slaQuery.eq("gt_owner", person);
  const [workResult, slaResult] = await Promise.all([workQuery, slaQuery]);
  if (workResult.error) return respond({ error: "query_failed", detail: workResult.error.message }, 500);
  if (slaResult.error) return respond({ error: "sla_query_failed", detail: slaResult.error.message }, 500);

  let assignmentNotifications: any[] = [];
  if (canAssign) {
    const { data: requests, error: requestError } = await ops.from("onboarding_gt_assignment_requests")
      .select("id,case_id,client_id,status,trigger_status,requested_at,metadata").eq("status", "PENDING").order("requested_at", { ascending: false }).limit(100);
    if (requestError) return respond({ error: "query_failed", detail: requestError.message }, 500);
    const ids = Array.from(new Set((requests ?? []).map((request: any) => String(request.client_id)).filter(Boolean)));
    const clientNames = new Map<string, string>();
    if (ids.length) {
      const { data: clientRows, error: clientError } = await ops.from("clients").select("id,display_name").in("id", ids);
      if (clientError) return respond({ error: "query_failed", detail: clientError.message }, 500);
      for (const client of clientRows ?? []) clientNames.set(String(client.id), String(client.display_name ?? "Cliente"));
    }
    assignmentNotifications = (requests ?? []).map((request: any) => {
      const clientName = clientNames.get(String(request.client_id)) ?? "Cliente";
      const confirmed = request.trigger_status === "DONE";
      return {
        id: `gt-assignment:${request.id}`, type: "ONBOARDING_GT_ASSIGNMENT_REQUIRED", level: "HIGH", title: "Selecionar gestor de tráfego",
        description: confirmed ? `A 1ª reunião de apresentação de ${clientName} foi concluída. Selecione o GT para liberar a integração e a carteira.` : `${clientName} já avançou além da 1ª apresentação. Selecione o GT para liberar a integração e a carteira.`,
        client_id: request.client_id, client_display_name: clientName, source: "onboarding", occurred_at: request.requested_at, read_at: null,
        metadata: { ...(request.metadata ?? {}), request_id: request.id, onboarding_case_id: request.case_id, action_type: "ASSIGN_GT", action_status: "PENDING", gt_options: gtOptions },
      };
    });
  }

  const slas = slaResult.data ?? [];
  const openSlas = slas.filter((row: any) => row.status === "OPEN");
  const summary = {
    total: slas.length,
    open: openSlas.length,
    overdue: openSlas.filter((row: any) => row.sla_status === "OVERDUE").length,
    due_soon: openSlas.filter((row: any) => row.sla_status === "DUE_SOON").length,
    completed_late: slas.filter((row: any) => row.sla_status === "DONE_LATE").length,
    production_open: openSlas.filter((row: any) => row.event_type === "CREATIVE_PRODUCTION").length,
    revision_open: openSlas.filter((row: any) => row.event_type === "CREATIVE_REVISION").length,
    launch_open: openSlas.filter((row: any) => row.event_type === "CAMPAIGN_LAUNCH").length,
  };

  return respond({
    worklist: workResult.data ?? [], assignment_notifications: assignmentNotifications, gt_options: canAssign ? gtOptions : [],
    playbook_slas: slas, sla_summary: summary,
    profile: { person, role, can_assign_gt: canAssign }, generated_at: new Date().toISOString(),
  });
});