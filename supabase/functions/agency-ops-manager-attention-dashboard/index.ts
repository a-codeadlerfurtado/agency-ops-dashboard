import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const db = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const ops = db.schema("agency_ops");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function setting(name: string): Promise<string | null> {
  const { data, error } = await ops.from("automation_settings").select("value").eq("key", name).maybeSingle();
  if (error) return null;
  const value: any = data?.value;
  if (typeof value === "string") return value.trim() || null;
  if (value == null) return null;
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("health") === "1") return json({ ok: true, service: "agency-ops-manager-attention-dashboard", version: 2, channel: "DASHBOARD_ONLY" });
  if (req.method !== "GET" && req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const expected = await setting("MANAGER_RADAR_CRON_SECRET");
  const given = req.headers.get("x-manager-radar-key") || url.searchParams.get("key");
  if (!expected || expected !== given) return json({ ok: false, error: "unauthorized" }, 401);

  const slot = String(url.searchParams.get("slot") || "manual").slice(0, 40);
  const dryRun = url.searchParams.get("dry_run") === "1";
  const radarUrl = new URL(`${SUPABASE_URL}/functions/v1/agency-ops-manager-attention-radar`);
  radarUrl.searchParams.set("slot", slot);
  radarUrl.searchParams.set("dry_run", "1");

  const radarResponse = await fetch(radarUrl, { headers: { "x-manager-radar-key": expected } });
  const radar = await radarResponse.json().catch(() => null);
  if (!radarResponse.ok || !radar?.ok) return json({ ok: false, error: "radar_failed", details: radar?.error || `HTTP ${radarResponse.status}` }, 502);

  const runId = Number(radar.run_id || 0) || null;
  const runDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const items = Array.isArray(radar?.analysis?.items) ? radar.analysis.items : [];
  const actionable = items.filter((item: any) => ['COBRAR_AGORA','ACOMPANHAR_HOJE','VERIFICAR_INTERNO'].includes(String(item?.level || "")));

  if (dryRun) return json({ ok: true, dry_run: true, channel: "DASHBOARD_ONLY", slot, run_id: runId, alert_count: actionable.length });

  const alertIds: string[] = [];
  for (const item of actionable) {
    const { data, error } = await ops.rpc("upsert_manager_attention_alert", {
      p_run_id: runId,
      p_run_date: runDate,
      p_slot: slot,
      p_item: item,
    });
    if (error) {
      if (runId) await ops.from("manager_attention_digest_runs").update({ delivery_status: "DASHBOARD_ERROR", error: `dashboard:${error.message}` }).eq("id", runId);
      return json({ ok: false, error: `dashboard_upsert:${error.message}` }, 500);
    }
    if (data) alertIds.push(String(data));
  }

  if (runId) {
    await ops.from("manager_attention_digest_runs").update({
      delivery_status: alertIds.length ? "DASHBOARD_PUSHED" : "NO_ALERTS",
      notification_id: null,
      error: null,
    }).eq("id", runId);
  }

  return json({ ok: true, channel: "DASHBOARD_ONLY", slot, run_id: runId, alert_count: alertIds.length, alert_ids: alertIds });
});