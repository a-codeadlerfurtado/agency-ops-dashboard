import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const norm = (v: unknown) => String(v ?? "").trim().toLocaleLowerCase("pt-BR");
const opsDay = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await authClient.auth.getUser();
  if (!userData?.user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;

  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person ?? pref?.name ?? null;
  if (!person || !(approvals ?? []).some((row: any) => row.kind === "SIGNUP")) return respond({ error: "profile_locked" }, 403);

  const [{ data: roster }, { data: identity }, { data: teamStats }] = await Promise.all([
    ops.from("team_roster").select("person,role,access_level,clickup_user").eq("person", person).eq("is_former", false).maybeSingle(),
    ops.from("team_identity_map").select("clickup_user_id,clickup_username,auth_user_id,sincronizado_pct,faltando").eq("person", person).maybeSingle(),
    ops.from("team_overview").select("clients_active,clients_onboarding,clients_attention,clients_follow_up,tasks_done,tasks_open,tasks_overdue,tasks_done_30d,clients_touched,last_task_done_at").eq("person", person).maybeSingle(),
  ]);
  if (!roster) return respond({ error: "profile_not_found" }, 404);

  const clickupUserId = identity?.clickup_user_id ? String(identity.clickup_user_id) : null;
  const clickupUsername = identity?.clickup_username ?? roster.clickup_user ?? null;
  if (!clickupUserId && !clickupUsername) return respond({ error: "clickup_identity_missing", profile: { person, role: roster.role } }, 200);

  const startToday = `${opsDay()}T00:00:00-03:00`;
  let openRes: any;
  let closedRes: any;

  if (clickupUserId) {
    [openRes, closedRes] = await Promise.all([
      ops.from("clickup_tasks").select("task_id,name,status,status_type,date_created,date_updated,start_date,due_date,time_estimate_ms,list_name,client_id,url,clickup_task_assignees!inner(user_id,username,email)")
        .eq("is_closed", false).eq("clickup_task_assignees.user_id", clickupUserId).order("due_date", { ascending: true, nullsFirst: false }).limit(2000),
      ops.from("clickup_tasks").select("task_id,name,status,status_type,date_created,date_updated,date_closed,start_date,due_date,time_estimate_ms,list_name,client_id,url,clickup_task_assignees!inner(user_id,username,email)")
        .eq("is_closed", true).eq("clickup_task_assignees.user_id", clickupUserId).gte("date_closed", startToday).order("date_closed", { ascending: false }).limit(1000),
    ]);
  } else {
    [openRes, closedRes] = await Promise.all([
      ops.from("clickup_tasks").select("task_id,name,status,status_type,date_created,date_updated,start_date,due_date,time_estimate_ms,list_name,client_id,url,clickup_task_assignees(user_id,username,email)").eq("is_closed", false).order("due_date", { ascending: true, nullsFirst: false }).limit(2000),
      ops.from("clickup_tasks").select("task_id,name,status,status_type,date_created,date_updated,date_closed,start_date,due_date,time_estimate_ms,list_name,client_id,url,clickup_task_assignees(user_id,username,email)").eq("is_closed", true).gte("date_closed", startToday).order("date_closed", { ascending: false }).limit(1000),
    ]);
  }

  const [clientsRes, designSummaryRes] = await Promise.all([
    ops.from("dashboard_client_overview").select("client_id,display_name,lifecycle,gt_owner,cs_owner").limit(500),
    roster.role === "DESIGN" ? ops.from("designer_profile_overview").select("*").eq("person", person).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  if (openRes.error) return respond({ error: "query_failed", detail: openRes.error.message }, 500);
  if (closedRes.error) return respond({ error: "query_failed", detail: closedRes.error.message }, 500);

  const allClients: any[] = clientsRes.data ?? [];
  const clientMap = new Map(allClients.map((row: any) => [String(row.client_id), row]));
  const ownerKeys = new Set([norm(clickupUsername), norm(person)].filter(Boolean));
  const assigned = (row: any) => (row.clickup_task_assignees ?? []).some((a: any) => {
    if (clickupUserId && String(a.user_id ?? "") === clickupUserId) return true;
    const email = norm(a.email);
    return [a.username, a.email, email.split("@")[0]].some((candidate) => ownerKeys.has(norm(candidate)));
  });
  const clientInScope = (row: any) => {
    if (!row.client_id) return true;
    const client = clientMap.get(String(row.client_id));
    if (!client) return true;
    if (roster.role === "GT") return client.gt_owner === person;
    if (roster.role === "CS") return client.cs_owner === person;
    return true;
  };
  const isDesignTask = (row: any) => {
    if (roster.role !== "DESIGN") return true;
    const haystack = norm(`${row.list_name ?? ""} ${row.name ?? ""}`);
    return /(criativ|design|arte|vídeo|video|copy|imagem|roteiro|carrossel|edi[cç][aã]o|revis[aã]o|ajuste na campanha|feed|story|thumb|banner|logo)/i.test(haystack);
  };
  const expose = (row: any) => {
    const client = row.client_id ? clientMap.get(String(row.client_id)) : null;
    return {
      task_id: row.task_id, name: row.name, status: row.status, status_type: row.status_type ?? null,
      date_created: row.date_created ?? null, date_updated: row.date_updated ?? null, date_closed: row.date_closed ?? null,
      start_date: row.start_date ?? null, due_date: row.due_date ?? null, time_estimate_ms: row.time_estimate_ms ?? null,
      list_name: row.list_name ?? null, client_id: row.client_id ?? null,
      client_display_name: client?.display_name ?? null, url: row.url ?? null,
    };
  };
  const filterPersonal = (row: any) => assigned(row) && clientInScope(row) && isDesignTask(row);
  const openTasks = (openRes.data ?? []).filter(filterPersonal).map(expose);
  const closedToday = (closedRes.data ?? []).filter(filterPersonal).map(expose);

  const clientGt = roster.role === "DESIGN"
    ? allClients.filter((row: any) => ["ACTIVE", "ONBOARDING"].includes(row.lifecycle)).map((row: any) => ({ client_id: row.client_id, gt_owner: row.gt_owner ?? null }))
    : [];

  return respond({
    profile: {
      person, role: roster.role, access_level: roster.access_level,
      clickup_user_id: clickupUserId, clickup_username: clickupUsername,
      auth_user_id: identity?.auth_user_id ?? null,
      synchronized_pct: Number(identity?.sincronizado_pct ?? 0), missing_identities: identity?.faltando ?? [],
    },
    focus: { owner: person, open_tasks: openTasks, closed_today: closedToday, summary: designSummaryRes.data ?? null },
    stats: teamStats ?? null,
    client_gt: clientGt,
    generated_at: new Date().toISOString(),
  });
});
