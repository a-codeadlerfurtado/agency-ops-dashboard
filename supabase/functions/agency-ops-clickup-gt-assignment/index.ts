import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const ops = db.schema("agency_ops");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
async function secret(name: string): Promise<string | null> { const { data, error } = await ops.rpc("get_secret", { p_name: name }); return error ? null : ((data as string) || null); }

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const routingSecret = await secret("CLICKUP_GT_ASSIGNMENT_SECRET");
  if (!routingSecret || req.headers.get("x-clickup-gt-routing-key") !== routingSecret) return json({ ok: false, error: "unauthorized" }, 401);
  const body = await req.json().catch(() => ({}));
  const generatedTaskId = Number(body?.generated_task_id);
  if (!Number.isFinite(generatedTaskId)) return json({ ok: false, error: "invalid_generated_task_id" }, 400);
  const { data: task, error: taskError } = await ops.from("generated_tasks").select("id, client_id, clickup_task_id, area, status").eq("id", generatedTaskId).maybeSingle();
  if (taskError || !task) return json({ ok: false, error: taskError?.message || "task_not_found" }, 404);
  if (task.status !== "ENVIADA" || !task.clickup_task_id) return json({ ok: true, skipped: true, reason: "task_not_sent" });
  const area = String(task.area || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!area.includes("gestor de trafego") && !area.includes("trafego pago")) return json({ ok: true, skipped: true, reason: "not_gt_task" });
  const { data: client } = await ops.from("clients").select("id, display_name, gt_owner").eq("id", task.client_id).maybeSingle();
  const gtOwner = client?.gt_owner ? String(client.gt_owner) : null;
  if (!gtOwner) { await ops.from("task_engine_gt_assignment_audit").insert({ generated_task_id: task.id, clickup_task_id: task.clickup_task_id, client_id: task.client_id, status: "SKIPPED", detail: "client_without_gt_owner" }); return json({ ok: true, skipped: true, reason: "client_without_gt_owner" }); }
  const { data: mapping } = await ops.from("task_engine_gt_clickup_map").select("gt_owner, clickup_user_id").eq("gt_owner", gtOwner).eq("active", true).maybeSingle();
  if (!mapping?.clickup_user_id) { await ops.from("task_engine_gt_assignment_audit").insert({ generated_task_id: task.id, clickup_task_id: task.clickup_task_id, client_id: task.client_id, gt_owner: gtOwner, status: "SKIPPED", detail: "gt_without_clickup_mapping" }); return json({ ok: true, skipped: true, reason: "gt_without_clickup_mapping", gt_owner: gtOwner }); }
  const clickupToken = await secret("CLICKUP_API_TOKEN");
  if (!clickupToken) return json({ ok: false, error: "missing_clickup_token" }, 500);
  const allGtIds = [101700446, 228200406, 234082138];
  const targetId = Number(mapping.clickup_user_id);
  const removeIds = allGtIds.filter((id) => id !== targetId);
  const response = await fetch(`https://api.clickup.com/api/v2/task/${task.clickup_task_id}`, { method: "PUT", headers: { Authorization: clickupToken, "content-type": "application/json" }, body: JSON.stringify({ assignees: { add: [targetId], rem: removeIds } }) });
  const raw = await response.text();
  await ops.from("task_engine_gt_assignment_audit").insert({ generated_task_id: task.id, clickup_task_id: task.clickup_task_id, client_id: task.client_id, gt_owner: gtOwner, clickup_user_id: targetId, status: response.ok ? "APPLIED" : "FAILED", detail: response.ok ? `assigned_to:${gtOwner}` : `clickup_${response.status}:${raw.slice(0, 350)}` });
  if (!response.ok) return json({ ok: false, error: "clickup_update_failed", status: response.status }, 502);
  return json({ ok: true, generated_task_id: task.id, client: client?.display_name ?? null, gt_owner: gtOwner, clickup_user_id: targetId });
});