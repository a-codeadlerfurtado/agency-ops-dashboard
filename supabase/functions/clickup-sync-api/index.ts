import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-dashboard-key,x-signature", "access-control-allow-methods": "GET,POST,OPTIONS" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const asDate = (value: unknown) => value ? new Date(Number(value)).toISOString() : null;
const normalize = (value: unknown) => String(value ?? "")
  .replace(/&amp;/gi, " e ").replace(/&/g, " e ")
  .normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const STOP_WORDS = new Set(["de","da","do","das","dos","e","imovel","imoveis","imobiliaria","imobiliario","imobiliarios","corretora","corretores","negocio","negocios","incorporadora","servico","servicos","ativo","ativos","mkt"]);
const canonical = (value: unknown) => normalize(value).split(" ").filter((token) => token && !STOP_WORDS.has(token)).join(" ");
const tokenKey = (value: unknown) => canonical(value).split(" ").filter(Boolean).sort().join(" ");
const extractClientLabel = (value: unknown) => String(value ?? "").match(/^\s*\[([^\]]+)\]/)?.[1]?.trim() || null;

async function sha256(value: string) {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(value: string, secret: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  let clickupToken = Deno.env.get("CLICKUP_API_TOKEN") ?? Deno.env.get("CLICKUP_TOKEN") ?? "";
  let teamId = Deno.env.get("CLICKUP_TEAM_ID") ?? Deno.env.get("CLICKUP_WORKSPACE_ID") ?? "";
  let webhookSecret = Deno.env.get("CLICKUP_WEBHOOK_SECRET") ?? "";
  if (!supabaseUrl || !serviceRole) return reply({ error: "server_configuration" }, 500);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: vaultConfig } = await ops.rpc("get_clickup_config");
  clickupToken ||= vaultConfig?.token ?? "";
  teamId ||= vaultConfig?.team_id ?? "";
  webhookSecret ||= vaultConfig?.webhook_secret ?? "";
  const url = new URL(req.url);

  async function dashboardAuthorized() {
    const supplied = req.headers.get("x-dashboard-key") ?? "";
    if (supplied.length < 40) return false;
    const keyHash = await sha256(supplied);
    const { data } = await ops.from("dashboard_api_keys").select("active,expires_at").eq("key_hash", keyHash).maybeSingle();
    return Boolean(data?.active && (!data.expires_at || new Date(data.expires_at) > new Date()));
  }

  let matchDataPromise: Promise<any> | null = null;

  async function getMatchData() {
    if (!matchDataPromise) {
      matchDataPromise = (async () => {
        const [clientResult, aliasResult, overrideResult] = await Promise.all([
          ops.from("clients").select("id,display_name,normalized_name,lifecycle"),
          ops.from("clickup_client_aliases").select("normalized_alias,client_id,match_method,confidence,active"),
          ops.from("clickup_task_client_overrides").select("task_id,client_id,confidence"),
        ]);
        if (clientResult.error) throw clientResult.error;
        if (aliasResult.error) throw aliasResult.error;
        if (overrideResult.error) throw overrideResult.error;
        const clients = (clientResult.data ?? []).map((client: any) => {
          const normalized = normalize(client.display_name || client.normalized_name);
          const canonicalName = canonical(client.display_name || client.normalized_name);
          return { ...client, normalized, canonical: canonicalName, compact: normalized.replaceAll(" ", ""), token_key: tokenKey(client.display_name || client.normalized_name) };
        }).sort((a: any, b: any) => b.normalized.length - a.normalized.length);
        return {
          clients,
          aliases: new Map((aliasResult.data ?? []).filter((row: any) => row.active).map((row: any) => [row.normalized_alias, row])),
          blockedAliases: new Set((aliasResult.data ?? []).filter((row: any) => !row.active).map((row: any) => row.normalized_alias)),
          overrides: new Map((overrideResult.data ?? []).map((row: any) => [String(row.task_id), row])),
        };
      })();
    }
    return matchDataPromise;
  }

  function automaticLabelMatch(label: string, clients: any[]) {
    const normalized = normalize(label);
    const canonicalName = canonical(label);
    const compact = normalized.replaceAll(" ", "");
    const labelTokenKey = tokenKey(label);
    const scored = clients.map((client: any) => {
      if (normalized === client.normalized) return { client, confidence: 1, method: "EXACT_LABEL" };
      if (canonicalName && canonicalName === client.canonical) return { client, confidence: .99, method: "CANONICAL_LABEL" };
      if (compact.length >= 4 && compact === client.compact) return { client, confidence: .98, method: "COMPACT_LABEL" };
      if (labelTokenKey.replaceAll(" ", "").length >= 4 && labelTokenKey === client.token_key) return { client, confidence: .97, method: "TOKEN_SET_LABEL" };
      if (canonicalName.length >= 4 && ` ${client.canonical} `.includes(` ${canonicalName} `)) return { client, confidence: .93, method: "LABEL_PREFIX" };
      if (client.canonical.length >= 4 && ` ${canonicalName} `.includes(` ${client.canonical} `)) return { client, confidence: .92, method: "CLIENT_PREFIX" };
      return { client, confidence: 0, method: "NONE" };
    }).sort((a: any, b: any) => b.confidence - a.confidence);
    const top = scored[0], second = scored[1];
    return top?.confidence >= .9 && top.confidence - (second?.confidence ?? 0) >= .06 ? top : null;
  }

  async function matchClient(task: any) {
    const label = extractClientLabel(task.name);
    const labelNormalized = label ? normalize(label) : null;
    const matchData = await getMatchData();
    const override = matchData.overrides.get(String(task.id));
    if (override) return { id: override.client_id, source: "TASK_OVERRIDE", confidence: Number(override.confidence ?? 1), status: "MATCHED", label, labelNormalized };
    if (labelNormalized) {
      const alias = matchData.aliases.get(labelNormalized);
      if (alias) return { id: alias.client_id, source: `BRACKET_${alias.match_method}`, confidence: Number(alias.confidence), status: "MATCHED", label, labelNormalized };
      if (matchData.blockedAliases.has(labelNormalized)) return { id: null, source: "BRACKET_AMBIGUOUS", confidence: null, status: "UNMATCHED", label, labelNormalized };
      const automatic = automaticLabelMatch(label, matchData.clients);
      if (automatic) return { id: automatic.client.id, source: `BRACKET_${automatic.method}`, confidence: automatic.confidence, status: "MATCHED", label, labelNormalized };
      return { id: null, source: "BRACKET_UNMATCHED", confidence: null, status: "UNMATCHED", label, labelNormalized };
    }
    const context = normalize([task.name, task.list?.name, task.folder?.name, task.space?.name].join(" "));
    const matched = matchData.clients.find((client: any) => client.normalized.length >= 4 && context.includes(client.normalized));
    return matched
      ? { id: matched.id, source: "TASK_CONTEXT_NAME", confidence: .8, status: "MATCHED", label: null, labelNormalized: null }
      : { id: null, source: "NO_BRACKET_LABEL", confidence: null, status: "NO_LABEL", label: null, labelNormalized: null };
  }

  function assigneeNames(task: any) {
    const names = (task.assignees ?? [])
      .map((person: any) => person.username ?? person.email ?? (person.id != null ? String(person.id) : null))
      .filter((name: unknown): name is string => Boolean(name))
      .sort();
    return names.length ? names.join(", ") : null;
  }

  async function taskRow(task: any) {
    const client = await matchClient(task);
    const closed = task.status?.type === "closed" || Boolean(task.date_closed || task.date_done);
    return {
      task_id: String(task.id), custom_id: task.custom_id ?? null, name: task.name ?? "", description: task.description ?? task.text_content ?? null,
      status: task.status?.status ?? task.status ?? null, status_type: task.status?.type ?? null, is_closed: closed,
      date_created: asDate(task.date_created), date_updated: asDate(task.date_updated), date_closed: asDate(task.date_closed ?? task.date_done),
      start_date: asDate(task.start_date), due_date: asDate(task.due_date), time_estimate_ms: task.time_estimate ?? null,
      time_spent_ms: task.time_spent ?? null, list_id: task.list?.id ? String(task.list.id) : null, list_name: task.list?.name ?? null,
      folder_id: task.folder?.id ? String(task.folder.id) : null, folder_name: task.folder?.name ?? null,
      space_id: task.space?.id ? String(task.space.id) : null, space_name: task.space?.name ?? null,
      creator_id: task.creator?.id ? String(task.creator.id) : null, creator_name: task.creator?.username ?? task.creator?.email ?? null,
      // Snapshot of assignee display names taken straight from the ClickUp payload at sync time.
      // Stored on the task row itself (not just the separate clickup_task_assignees table) so the
      // completion-notification trigger can read it immediately, without racing the assignees upsert
      // that happens after this row is written.
      assignee_names: assigneeNames(task),
      client_id: client.id, client_match_source: client.source, client_label: client.label,
      client_label_normalized: client.labelNormalized, client_match_confidence: client.confidence,
      client_match_status: client.status, url: task.url ?? null, raw_json: task, last_synced_at: new Date().toISOString(),
    };
  }

  async function upsertTasks(tasks: any[]) {
    if (!tasks.length) return 0;
    const rows = await Promise.all(tasks.map(taskRow));
    const { error } = await ops.from("clickup_tasks").upsert(rows, { onConflict: "task_id" });
    if (error) throw error;
    const taskIds = rows.map((row: any) => row.task_id);
    const { error: deleteError } = await ops.from("clickup_task_assignees").delete().in("task_id", taskIds);
    if (deleteError) throw deleteError;
    const assignees = tasks.flatMap((task: any) => (task.assignees ?? []).map((person: any) => ({
      task_id: String(task.id), user_id: String(person.id), username: person.username ?? null, email: person.email ?? null,
      initials: person.initials ?? null, profile_picture: person.profilePicture ?? person.profile_picture ?? null,
    })));
    if (assignees.length) {
      const { error: assigneeError } = await ops.from("clickup_task_assignees").upsert(assignees, { onConflict: "task_id,user_id" });
      if (assigneeError) throw assigneeError;
    }
    return rows.filter((row: any) => row.is_closed).length;
  }

  async function upsertTask(task: any) {
    return (await upsertTasks([task])) > 0;
  }

  async function getTask(taskId: string) {
    const response = await fetch(`https://api.clickup.com/api/v2/task/${encodeURIComponent(taskId)}?include_subtasks=true`, {
      headers: { Authorization: clickupToken },
    });
    if (!response.ok) throw new Error(`clickup_task_${response.status}:${await response.text()}`);
    return response.json();
  }

  if (req.method === "GET") {
    if (!(await dashboardAuthorized())) return reply({ error: "unauthorized" }, 401);
    const [tasks, closed, events, lastSync, productivity] = await Promise.all([
      ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }),
      ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).eq("is_closed", true),
      ops.from("clickup_task_events").select("id", { count: "exact", head: true }),
      ops.from("clickup_sync_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle(),
      ops.from("clickup_productivity_30d").select("*").order("tasks_done", { ascending: false }),
    ]);
    return reply({ configured: { token: Boolean(clickupToken), team_id: Boolean(teamId), webhook_secret: Boolean(webhookSecret) }, totals: { tasks: tasks.count ?? 0, closed: closed.count ?? 0, events: events.count ?? 0 }, last_sync: lastSync.data ?? null, productivity_30d: productivity.data ?? [], endpoint: `${supabaseUrl}/functions/v1/clickup-sync-api` });
  }

  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  const action = url.searchParams.get("action") ?? "webhook";

  if (action === "register") {
    if (!(await dashboardAuthorized())) return reply({ error: "unauthorized" }, 401);
    if (!clickupToken || !teamId) return reply({ error: "clickup_not_configured", required: ["CLICKUP_API_TOKEN", "CLICKUP_TEAM_ID"] }, 503);
    const endpoint = `${supabaseUrl}/functions/v1/clickup-sync-api`;
    const response = await fetch(`https://api.clickup.com/api/v2/team/${encodeURIComponent(teamId)}/webhook`, {
      method: "POST", headers: { Authorization: clickupToken, "content-type": "application/json" },
      body: JSON.stringify({ endpoint, events: ["taskCreated", "taskUpdated", "taskStatusUpdated", "taskAssigneeUpdated", "taskMoved", "taskTimeTrackedUpdated"] }),
    });
    if (!response.ok) return reply({ error: "webhook_registration_failed", detail: await response.text() }, 502);
    const body = await response.json();
    if (!body.webhook?.secret) return reply({ error: "webhook_secret_missing" }, 502);
    const { error: secretError } = await ops.rpc("set_clickup_secret", { p_name: "CLICKUP_WEBHOOK_SECRET", p_value: body.webhook.secret });
    if (secretError) return reply({ error: "webhook_secret_store_failed", detail: secretError.message }, 500);
    webhookSecret = body.webhook.secret;
    await ops.from("clickup_sync_runs").insert({ mode: "MANUAL", status: "SUCCESS", finished_at: new Date().toISOString(), metadata: { action: "webhook_registered", webhook_id: body.id ?? body.webhook.id, endpoint } });
    return reply({ ok: true, webhook_id: body.id ?? body.webhook.id, endpoint, events: body.events ?? body.webhook.events ?? [] });
  }

  if (action === "sync") {
    if (!(await dashboardAuthorized())) return reply({ error: "unauthorized" }, 401);
    if (!clickupToken || !teamId) return reply({ error: "clickup_not_configured", required: ["CLICKUP_API_TOKEN", "CLICKUP_TEAM_ID"] }, 503);
    const sinceDays = Math.min(730, Math.max(1, Number(url.searchParams.get("since_days") ?? 120)));
    const pageStart = Math.max(0, Number(url.searchParams.get("page_start") ?? 0));
    const maxPages = Math.min(10, Math.max(1, Number(url.searchParams.get("max_pages") ?? 5)));
    const startedAt = new Date().toISOString();
    const { data: run, error: runError } = await ops.from("clickup_sync_runs").insert({ mode: "MANUAL", status: "RUNNING", metadata: { since_days: sinceDays, page_start: pageStart, max_pages: maxPages } }).select("id").single();
    if (runError) return reply({ error: "sync_run_failed", detail: runError.message }, 500);
    let seen = 0, upserted = 0, closed = 0;
    let lastPage = pageStart - 1;
    let hasMore = true;
    try {
      for (let page = pageStart; page < pageStart + maxPages; page++) {
        const params = new URLSearchParams({ page: String(page), include_closed: "true", subtasks: "true", date_done_gt: String(Date.now() - sinceDays * 86400000), order_by: "updated", reverse: "true" });
        const response = await fetch(`https://api.clickup.com/api/v2/team/${encodeURIComponent(teamId)}/task?${params}`, { headers: { Authorization: clickupToken } });
        if (!response.ok) throw new Error(`clickup_list_${response.status}:${await response.text()}`);
        const body = await response.json();
        const rows = body.tasks ?? [];
        lastPage = page;
        seen += rows.length;
        closed += await upsertTasks(rows);
        upserted += rows.length;
        if (rows.length < 100) { hasMore = false; break; }
      }
      const nextPage = hasMore ? lastPage + 1 : null;
      const metadata = { since_days: sinceDays, page_start: pageStart, max_pages: maxPages, next_page: nextPage, complete: !hasMore };
      await ops.from("clickup_sync_runs").update({ status: "SUCCESS", finished_at: new Date().toISOString(), tasks_seen: seen, tasks_upserted: upserted, tasks_closed: closed, metadata }).eq("id", run.id);
      return reply({ ok: true, started_at: startedAt, tasks_seen: seen, tasks_upserted: upserted, tasks_closed: closed, next_page: nextPage, complete: !hasMore });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ops.from("clickup_sync_runs").update({ status: "ERROR", finished_at: new Date().toISOString(), tasks_seen: seen, tasks_upserted: upserted, tasks_closed: closed, error: message }).eq("id", run.id);
      return reply({ error: "sync_failed", detail: message }, 502);
    }
  }

  const raw = await req.text();
  if (!webhookSecret) return reply({ error: "webhook_secret_not_configured" }, 503);
  const signature = req.headers.get("x-signature") ?? "";
  if (!signature || !safeEqual(await hmac(raw, webhookSecret), signature)) return reply({ error: "invalid_signature" }, 401);
  const payload = JSON.parse(raw);
  const history = payload.history_items?.length ? payload.history_items : [{ id: await sha256(raw), date: String(Date.now()), user: null, before: null, after: null }];
  let accepted = 0;
  for (const item of history) {
    const eventKey = `${payload.webhook_id ?? "unknown"}:${item.id}`;
    const { error } = await ops.from("clickup_task_events").insert({
      event_key: eventKey, webhook_id: payload.webhook_id ?? null, event_type: payload.event ?? "unknown", task_id: payload.task_id ? String(payload.task_id) : null,
      actor_id: item.user?.id ? String(item.user.id) : null, actor_name: item.user?.username ?? item.user?.email ?? null,
      event_at: asDate(item.date), before_value: item.before ?? null, after_value: item.after ?? null, raw_json: payload,
    });
    if (!error) accepted++;
  }
  if (!payload.task_id || !clickupToken) return reply({ ok: true, accepted, task_refreshed: false });
  try {
    const task = await getTask(String(payload.task_id));
    const closed = await upsertTask(task);
    await ops.from("clickup_task_events").update({ processing_status: "PROCESSED", processed_at: new Date().toISOString() }).eq("webhook_id", payload.webhook_id).eq("task_id", String(payload.task_id));
    return reply({ ok: true, accepted, task_refreshed: true, closed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ops.from("clickup_task_events").update({ processing_status: "ERROR", processing_error: message, processed_at: new Date().toISOString() }).eq("webhook_id", payload.webhook_id).eq("task_id", String(payload.task_id));
    return reply({ ok: true, accepted, task_refreshed: false, warning: message }, 202);
  }
});

