import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser();
  if (userError || !userData.user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const { data: preference } = await ops.from("user_preferences")
    .select("collaborator_person")
    .eq("user_key", userData.user.id)
    .maybeSingle();
  const person = preference?.collaborator_person ?? null;
  if (!person) return respond({ error: "collaborator_required" }, 403);

  const [{ data: roster }, { data: signupApproval }] = await Promise.all([
    ops.from("team_roster").select("person,role,access_level,clickup_user,is_former").eq("person", person).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userData.user.id).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1).maybeSingle(),
  ]);
  if (!roster || roster.is_former || !signupApproval) return respond({ error: "forbidden" }, 403);

  const { data: views, error: viewsError } = await ops.rpc("dashboard_allowed_views", { p_person: person, p_role: roster.role });
  if (viewsError || !Array.isArray(views) || !views.includes("work")) return respond({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const clientId = body.client_id ? String(body.client_id) : null;
  if (!title) return respond({ error: "missing_fields", required: ["title"] }, 400);

  let scopedClient: any = null;
  if (clientId) {
    const { data: client, error: clientError } = await ops.from("dashboard_client_overview")
      .select("client_id,display_name,gt_owner,cs_owner,designer_owner,lifecycle")
      .eq("client_id", clientId)
      .maybeSingle();
    if (clientError) return respond({ error: "query_failed", detail: clientError.message }, 500);
    if (!client) return respond({ error: "client_not_found" }, 404);
    scopedClient = client;

    // GT continua rigidamente limitado à própria carteira. CS pode abrir solicitação
    // para qualquer cliente da operação, conforme a regra operacional do dashboard.
    if (roster.role === "GT" && scopedClient.gt_owner !== person) return respond({ error: "forbidden" }, 403);
  }

  const itemType = ["ESCALATION","CREATIVE_REQUEST","TECHNICAL","CLIENT_FOLLOWUP","CLICKUP","FINANCE","GENERAL"].includes(String(body.type)) ? String(body.type) : "GENERAL";
  const priority = ["CRITICAL","HIGH","MEDIUM","LOW"].includes(String(body.priority)) ? String(body.priority) : "MEDIUM";
  const targetRole = typeof body.target_role === "string" ? body.target_role.slice(0, 40) : null;
  const targetPerson = typeof body.target_person === "string" ? body.target_person.slice(0, 160) : null;
  const metadata = typeof body.metadata === "object" && body.metadata ? { ...body.metadata } : {};
  let clickupTask: any = null;

  if (body.create_clickup === true || itemType === "CLICKUP") {
    const { data: config, error: configError } = await ops.rpc("get_clickup_config");
    if (configError || !config?.token) return respond({ error: "clickup_not_configured" }, 503);

    const listByRole: Record<string, string> = {
      GT: "901317155229",
      DESIGN: "901317155418",
      CS: "1000210000004387",
      MGMT: "901326095338",
      AI: "901326095338",
    };
    const listId = listByRole[targetRole ?? ""] ?? "901326095338";
    const assignees: number[] = [];

    if (targetPerson) {
      const { data: rosterTarget } = await ops.from("team_roster").select("clickup_user").eq("person", targetPerson).maybeSingle();
      if (rosterTarget?.clickup_user) {
        const { data: assigneeRows } = await ops.from("clickup_task_assignees")
          .select("user_id,username")
          .ilike("username", rosterTarget.clickup_user)
          .limit(1);
        const assigneeId = Number(assigneeRows?.[0]?.user_id);
        if (Number.isFinite(assigneeId)) assignees.push(assigneeId);
      }
    }

    const clickupName = scopedClient?.display_name ? `[${scopedClient.display_name}] ${title}` : title;
    const clickupResponse = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, {
      method: "POST",
      headers: { Authorization: config.token, "content-type": "application/json" },
      body: JSON.stringify({
        name: clickupName.slice(0, 240),
        description: description.slice(0, 4000) || undefined,
        assignees,
        due_date: body.due_at ? new Date(body.due_at).getTime() : undefined,
      }),
    });
    if (!clickupResponse.ok) return respond({ error: "clickup_create_failed", detail: await clickupResponse.text() }, 502);
    clickupTask = await clickupResponse.json();
    metadata.clickup_task_id = String(clickupTask.id);
    metadata.clickup_url = clickupTask.url ?? null;
    metadata.clickup_list_id = listId;
  }

  const result = await ops.from("work_items").insert({
    client_id: clientId,
    type: itemType,
    priority,
    title: title.slice(0, 240),
    description: description.slice(0, 4000) || null,
    source: typeof body.source === "string" ? body.source.slice(0, 80) : "dashboard",
    source_id: typeof body.source_id === "string" ? body.source_id.slice(0, 240) : (clickupTask?.id ? String(clickupTask.id) : null),
    created_by_user_key: userData.user.id,
    created_by_person: person,
    target_role: targetRole,
    target_person: targetPerson,
    due_at: body.due_at ?? null,
    metadata,
  }).select().single();

  if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
  return respond({ ok: true, item: result.data, clickup: clickupTask ? { id: String(clickupTask.id), url: clickupTask.url ?? null } : null });
});
