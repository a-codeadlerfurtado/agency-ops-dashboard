import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function isAiDomainTask(name: unknown, listName: unknown) {
  const title = norm(name);
  const list = norm(listName);
  const combined = `${title} ${list}`;
  const obviouslyOtherTeam = /criativ|design|arte|video|copy|campanh|trafego pago|gestor de trafego/.test(list)
    || /- criativ|- campanha|- ajuste na campanha/.test(title);

  if (/\bagente\b|\bn8n\b|chatbot|bot de atendimento|inteligencia artificial/.test(combined)) return true;
  if (/\bia\b.{0,60}(lead|atendimento|agente|fluxo|whatsapp|automacao|integracao|follow up)|(?:lead|atendimento|agente|fluxo|whatsapp|automacao|integracao|follow up).{0,60}\bia\b/.test(combined)) return true;
  return !obviouslyOtherTeam && /(^| )ia( |$)/.test(combined);
}

function mapClickupStatus(value: unknown) {
  const status = norm(value);
  if (/progress|andamento|fazendo|doing/.test(status)) return "IN_PROGRESS";
  if (/wait|aguard|bloque|pendencia externa/.test(status)) return "WAITING";
  return "OPEN";
}

function priorityRank(priority: unknown) {
  return ({ CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as Record<string, number>)[String(priority ?? "MEDIUM")] ?? 2;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);

  const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: auth } } });
  const { data: userData } = await authClient.auth.getUser();
  const user = userData?.user;
  if (!user) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", user.id).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);

  const person = String(pref?.collaborator_person ?? "");
  if (!person || !(approvals ?? []).length) return reply({ error: "forbidden" }, 403);

  const { data: roster } = await ops.from("team_roster")
    .select("person,role")
    .eq("person", person)
    .eq("is_former", false)
    .maybeSingle();

  if (!roster || roster.person !== "Gabriel Castro" || roster.role !== "AI") {
    return reply({ error: "forbidden" }, 403);
  }

  const [{ data: serviceRows, error: serviceError }, { data: n8nRows, error: n8nError }] = await Promise.all([
    ops.from("client_services")
      .select("client_id,service_status,agent_name,last_evidence_at")
      .eq("service_key", "IA")
      .eq("owner_key", "OURS")
      .in("service_status", ["ACTIVE", "BUILDING"]),
    ops.from("ai_source_registry")
      .select("client_id,source_key,updated_at")
      .eq("source_type", "N8N_CHAT")
      .eq("owner_hint", "OURS")
      .eq("active", true),
  ]);

  if (serviceError || n8nError) {
    return reply({ error: "query_failed", detail: serviceError?.message ?? n8nError?.message }, 500);
  }

  const n8nIds = new Set((n8nRows ?? []).map((row: any) => String(row.client_id)).filter(Boolean));
  const serviceByClient = new Map((serviceRows ?? []).map((row: any) => [String(row.client_id), row]));

  // OURS + ACTIVE/BUILDING defines the Castro workspace.
  // n8n is evidence of implementation stage, not a prerequisite to see BUILDING clients.
  const aiIds = [...serviceByClient.keys()];
  if (!aiIds.length) {
    return reply({
      profile: { person, role: roster.role },
      clients: [],
      items: [],
      summary: { total: 0, open: 0, in_progress: 0, waiting: 0, overdue: 0, completed: 0 },
      generated_at: new Date().toISOString(),
    });
  }

  const { data: clients, error: clientsError } = await ops.from("clients")
    .select("id,display_name,lifecycle,cs_owner,gt_owner")
    .in("id", aiIds)
    .in("lifecycle", ["ACTIVE", "ONBOARDING"])
    .order("display_name");

  if (clientsError) return reply({ error: "query_failed", detail: clientsError.message }, 500);

  const clientById = new Map((clients ?? []).map((row: any) => [String(row.id), row]));
  const activeIds = [...clientById.keys()];

  if (!activeIds.length) {
    return reply({
      profile: { person, role: roster.role },
      clients: [],
      items: [],
      summary: { total: 0, open: 0, in_progress: 0, waiting: 0, overdue: 0, completed: 0 },
      generated_at: new Date().toISOString(),
    });
  }

  const isScopedWorkItem = (row: any) => {
    const metadata = row?.metadata ?? {};
    return row?.target_person === "Gabriel Castro"
      || row?.target_role === "AI"
      || metadata.ai_workspace === true
      || metadata.ai_service_owned === true
      || metadata.n8n_verified === true;
  };

  async function visibleWorkItem(id: string) {
    const { data } = await ops.from("work_items").select("*").eq("id", id).maybeSingle();
    if (!data || !clientById.has(String(data.client_id))) return null;
    return isScopedWorkItem(data) ? data : null;
  }

  async function materializeClickup(taskId: string) {
    const sourceId = `clickup:${taskId}`;
    const { data: existing } = await ops.from("work_items")
      .select("*")
      .eq("source", "ai_clickup_mirror")
      .eq("source_id", sourceId)
      .maybeSingle();

    if (existing) return existing;

    const { data: task, error: taskError } = await ops.from("clickup_tasks")
      .select("task_id,client_id,name,status,is_closed,due_date,url,assignee_names,date_created,date_updated,list_name")
      .eq("task_id", taskId)
      .maybeSingle();

    if (
      taskError
      || !task
      || task.is_closed
      || !clientById.has(String(task.client_id))
      || !isAiDomainTask(task.name, task.list_name)
    ) return null;

    const { data: created, error: createError } = await ops.from("work_items").insert({
      client_id: task.client_id,
      type: "TECHNICAL",
      status: mapClickupStatus(task.status),
      priority: "MEDIUM",
      title: String(task.name ?? "Demanda IA").slice(0, 240),
      description: "Demanda de IA importada automaticamente do ClickUp para a Central de Trabalho do Head de IA.",
      source: "ai_clickup_mirror",
      source_id: sourceId,
      created_by_user_key: "system:ai-work-center",
      created_by_person: "Sistema · IA",
      target_role: "AI",
      target_person: "Gabriel Castro",
      due_at: task.due_date ?? null,
      metadata: {
        ai_workspace: true,
        ai_service_owned: true,
        n8n_verified: n8nIds.has(String(task.client_id)),
        imported_from_clickup: true,
        clickup_task_id: task.task_id,
        clickup_url: task.url ?? null,
        clickup_status_at_import: task.status ?? null,
        clickup_list_name: task.list_name ?? null,
      },
    }).select("*").single();

    if (createError) {
      const { data: retry } = await ops.from("work_items")
        .select("*")
        .eq("source", "ai_clickup_mirror")
        .eq("source_id", sourceId)
        .maybeSingle();
      if (retry) return retry;
      throw new Error(`mirror_create:${createError.message}`);
    }

    return created;
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    if (action === "create") {
      const clientId = String(body.client_id ?? "");
      const title = String(body.title ?? "").trim();
      if (!clientById.has(clientId) || !title) return reply({ error: "missing_or_invalid_fields" }, 400);

      const priority = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(String(body.priority))
        ? String(body.priority)
        : "MEDIUM";

      const { data, error } = await ops.from("work_items").insert({
        client_id: clientId,
        type: "TECHNICAL",
        status: "OPEN",
        priority,
        title: title.slice(0, 240),
        description: String(body.description ?? "").trim().slice(0, 6000) || null,
        source: "ai_work_center",
        source_id: `ai-work:${crypto.randomUUID()}`,
        created_by_user_key: user.id,
        created_by_person: person,
        target_role: "AI",
        target_person: "Gabriel Castro",
        due_at: body.due_at || null,
        metadata: {
          ai_workspace: true,
          ai_service_owned: true,
          n8n_verified: n8nIds.has(clientId),
          created_inside_ai_work_center: true,
        },
      }).select("*").single();

      if (error) return reply({ error: "query_failed", detail: error.message }, 500);
      return reply({ ok: true, item: data });
    }

    if (action === "update") {
      let item = null as any;
      const rawId = String(body.id ?? "");
      if (rawId.startsWith("clickup:")) item = await materializeClickup(rawId.slice(8));
      else item = await visibleWorkItem(rawId.replace(/^work:/, ""));
      if (!item) return reply({ error: "not_found_or_forbidden" }, 404);

      const patch: Record<string, unknown> = {};

      if (body.status && ["OPEN", "IN_PROGRESS", "WAITING", "SNOOZED", "COMPLETED", "DISMISSED"].includes(String(body.status))) {
        patch.status = String(body.status);
        if (body.status === "IN_PROGRESS" && !item.started_at) patch.started_at = new Date().toISOString();

        if (body.status === "COMPLETED") {
          const resolution = String(body.resolution ?? "").trim();
          if (!resolution) return reply({ error: "resolution_required" }, 400);
          patch.completed_at = new Date().toISOString();
          patch.completed_by = person;
          patch.resolution = resolution.slice(0, 6000);
        }

        if (body.status !== "COMPLETED" && item.status === "COMPLETED") {
          patch.completed_at = null;
          patch.completed_by = null;
          patch.resolution = null;
        }
      }

      if (body.priority && ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(String(body.priority))) {
        patch.priority = String(body.priority);
      }
      if (Object.prototype.hasOwnProperty.call(body, "due_at")) patch.due_at = body.due_at || null;
      if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 240);
      if (typeof body.description === "string") patch.description = body.description.trim().slice(0, 6000) || null;

      if (!Object.keys(patch).length) return reply({ error: "nothing_to_update" }, 400);

      const { data, error } = await ops.from("work_items")
        .update(patch)
        .eq("id", item.id)
        .select("*")
        .single();

      if (error) return reply({ error: "query_failed", detail: error.message }, 500);
      return reply({ ok: true, item: data });
    }

    if (action === "comment") {
      const comment = String(body.comment ?? "").trim();
      if (!comment) return reply({ error: "comment_required" }, 400);

      let item = null as any;
      const rawId = String(body.id ?? "");
      if (rawId.startsWith("clickup:")) item = await materializeClickup(rawId.slice(8));
      else item = await visibleWorkItem(rawId.replace(/^work:/, ""));
      if (!item) return reply({ error: "not_found_or_forbidden" }, 404);

      const { data, error } = await ops.from("work_item_events").insert({
        work_item_id: item.id,
        event_type: "COMMENT",
        actor_user_key: user.id,
        actor_person: person,
        previous_status: item.status,
        new_status: item.status,
        detail: comment.slice(0, 6000),
        metadata: { origin: "ai_work_center" },
      }).select("*").single();

      if (error) return reply({ error: "query_failed", detail: error.message }, 500);
      return reply({ ok: true, event: data, work_item_id: item.id });
    }

    return reply({ error: "unknown_action" }, 404);
  }

  const [workRes, clickupRes] = await Promise.all([
    ops.from("work_items")
      .select("*")
      .in("client_id", activeIds)
      .order("updated_at", { ascending: false })
      .limit(1000),
    ops.from("clickup_tasks")
      .select("task_id,client_id,name,status,is_closed,due_date,url,assignee_names,date_created,date_updated,list_name")
      .in("client_id", activeIds)
      .eq("is_closed", false)
      .order("date_updated", { ascending: false })
      .limit(1000),
  ]);

  if (workRes.error || clickupRes.error) {
    return reply({ error: "query_failed", detail: workRes.error?.message ?? clickupRes.error?.message }, 500);
  }

  const allWork = (workRes.data ?? []).filter(isScopedWorkItem);
  const mirroredClickup = new Set(
    allWork
      .filter((row: any) => row.source === "ai_clickup_mirror" && String(row.source_id ?? "").startsWith("clickup:"))
      .map((row: any) => String(row.source_id).slice(8)),
  );

  const workIds = allWork.map((row: any) => row.id);
  const eventsByWork = new Map<string, any[]>();

  if (workIds.length) {
    const { data: events } = await ops.from("work_item_events")
      .select("*")
      .in("work_item_id", workIds)
      .order("occurred_at", { ascending: false })
      .limit(3000);

    for (const event of events ?? []) {
      const key = String(event.work_item_id);
      const bucket = eventsByWork.get(key) ?? [];
      bucket.push(event);
      eventsByWork.set(key, bucket);
    }
  }

  const workItems = allWork.map((row: any) => {
    const client: any = clientById.get(String(row.client_id));
    return {
      id: `work:${row.id}`,
      native_id: row.id,
      source: row.source === "ai_clickup_mirror" ? "CLICKUP_IMPORT" : "CENTRAL",
      client_id: row.client_id,
      display_name: client?.display_name ?? "Cliente",
      status: row.status,
      priority: row.priority ?? "MEDIUM",
      title: row.title,
      description: row.description,
      due_at: row.due_at,
      started_at: row.started_at,
      completed_at: row.completed_at,
      resolution: row.resolution,
      created_at: row.created_at,
      updated_at: row.updated_at,
      clickup_url: row.metadata?.clickup_url ?? null,
      events: (eventsByWork.get(String(row.id)) ?? []).slice(0, 60),
    };
  });

  const clickupItems = (clickupRes.data ?? [])
    .filter((row: any) => !mirroredClickup.has(String(row.task_id)) && isAiDomainTask(row.name, row.list_name))
    .map((row: any) => {
      const client: any = clientById.get(String(row.client_id));
      return {
        id: `clickup:${row.task_id}`,
        native_id: row.task_id,
        source: "CLICKUP",
        client_id: row.client_id,
        display_name: client?.display_name ?? "Cliente",
        status: mapClickupStatus(row.status),
        priority: "MEDIUM",
        title: row.name,
        description: "Demanda aberta no ClickUp. Ao movimentar ou comentar, ela passa a ser acompanhada pela Central de Trabalho da IA.",
        due_at: row.due_date,
        started_at: null,
        completed_at: null,
        resolution: null,
        created_at: row.date_created,
        updated_at: row.date_updated,
        clickup_url: row.url ?? null,
        events: [],
      };
    });

  const items = [...workItems, ...clickupItems].sort((a: any, b: any) => {
    const statusRank: Record<string, number> = { IN_PROGRESS: 0, OPEN: 1, WAITING: 2, SNOOZED: 3, COMPLETED: 4, DISMISSED: 5 };
    return (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9)
      || String(a.display_name ?? "").localeCompare(String(b.display_name ?? ""), "pt-BR")
      || priorityRank(a.priority) - priorityRank(b.priority)
      || String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999"));
  });

  const now = Date.now();
  const openItems = items.filter((item: any) => !["COMPLETED", "DISMISSED"].includes(item.status));

  const summary = {
    total: items.length,
    open: openItems.filter((item: any) => item.status === "OPEN").length,
    in_progress: openItems.filter((item: any) => item.status === "IN_PROGRESS").length,
    waiting: openItems.filter((item: any) => ["WAITING", "SNOOZED"].includes(item.status)).length,
    overdue: openItems.filter((item: any) => item.due_at && new Date(item.due_at).getTime() < now).length,
    completed: items.filter((item: any) => item.status === "COMPLETED").length,
  };

  return reply({
    profile: { person, role: roster.role },
    clients: (clients ?? []).map((client: any) => ({
      ...client,
      service: serviceByClient.get(String(client.id)) ?? null,
      n8n_verified: n8nIds.has(String(client.id)),
    })),
    items,
    summary,
    generated_at: new Date().toISOString(),
  });
});
