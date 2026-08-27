import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const csvEscape = (value: unknown) => { const text = value == null ? "" : String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"','""')}"` : text; };
const csvResponse = (rows: unknown[][], filename: string) => new Response("\ufeff" + rows.map(row => row.map(csvEscape).join(",")).join("\r\n"), { headers: { ...CORS, "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
type Row = Record<string, any>;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return respond({ error: "method_not_allowed" }, 405);
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
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle();
  const person = String(pref?.collaborator_person || "");
  if (person !== "Adler Furtado") return respond({ error: "not_found" }, 404);
  const { data: roster } = await ops.from("team_roster").select("person,is_former").eq("person", "Adler Furtado").eq("is_former", false).maybeSingle();
  if (!roster) return respond({ error: "not_found" }, 404);

  const url = new URL(req.url);
  const clientId = String(url.searchParams.get("client_id") || "").trim();
  const requestedRun = String(url.searchParams.get("run_id") || "").trim();
  const exportMode = String(url.searchParams.get("export") || "").trim().toLowerCase();

  const { data: runs, error: runsError } = await ops.from("meta_performance_runs").select("*").order("snapshot_date", { ascending: false }).limit(52);
  if (runsError) return respond({ error: "runs_failed", detail: runsError.message }, 500);
  const allRuns = runs || [];
  const selectedRun = requestedRun ? allRuns.find((row: Row) => String(row.id) === requestedRun) : allRuns[0];
  const selectedRunId = selectedRun ? String(selectedRun.id) : "";

  if (exportMode && !selectedRunId) return respond({ error: "run_not_found" }, 404);
  if (exportMode === "summary") {
    let q = ops.from("meta_performance_snapshots").select("client_name,gt_owner,snapshot_date,period_days,date_from,date_to,requested_period_days,available_period_days,is_partial_period,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,leads,results,cpl,cost_per_result,campaign_count,active_campaigns,paused_campaigns,data_status").eq("run_id", selectedRunId).order("client_name", { ascending: true }).order("period_days", { ascending: true });
    if (clientId) q = q.eq("client_id", clientId);
    const { data, error } = await q;
    if (error) return respond({ error: "export_failed", detail: error.message }, 500);
    const header = ["cliente","gt","snapshot","janela_dias","inicio","fim","dias_solicitados","dias_disponiveis","periodo_parcial","gasto","impressoes","alcance","cliques","ctr","cpc","cpm","frequencia","leads","resultados","cpl","custo_por_resultado","campanhas","ativas","pausadas","status_dados"];
    const rows = [header, ...(data || []).map((x: Row) => [x.client_name,x.gt_owner,x.snapshot_date,x.period_days,x.date_from,x.date_to,x.requested_period_days,x.available_period_days,x.is_partial_period,x.spend,x.impressions,x.reach,x.clicks,x.ctr,x.cpc,x.cpm,x.frequency,x.leads,x.results,x.cpl,x.cost_per_result,x.campaign_count,x.active_campaigns,x.paused_campaigns,x.data_status])];
    return csvResponse(rows, clientId ? `meta-${selectedRun.snapshot_date}-cliente.csv` : `meta-${selectedRun.snapshot_date}-geral.csv`);
  }
  if (exportMode === "detailed") {
    let q = ops.from("meta_campaign_performance_snapshots").select("client_name,gt_owner,snapshot_date,period_days,date_from,date_to,meta_ad_account_id,campaign_id,campaign_name,campaign_status,objective,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,leads,results,cpl,cost_per_result,result_type,data_status").eq("run_id", selectedRunId).order("client_name", { ascending: true }).order("period_days", { ascending: true }).order("campaign_name", { ascending: true });
    if (clientId) q = q.eq("client_id", clientId);
    const { data, error } = await q;
    if (error) return respond({ error: "export_failed", detail: error.message }, 500);
    const header = ["cliente","gt","snapshot","janela_dias","inicio","fim","conta_meta","campanha_id","campanha","status_campanha","objetivo","gasto","impressoes","alcance","cliques","ctr","cpc","cpm","frequencia","leads","resultados","cpl","custo_por_resultado","tipo_resultado","status_dados"];
    const rows = [header, ...(data || []).map((x: Row) => [x.client_name,x.gt_owner,x.snapshot_date,x.period_days,x.date_from,x.date_to,x.meta_ad_account_id,x.campaign_id,x.campaign_name,x.campaign_status,x.objective,x.spend,x.impressions,x.reach,x.clicks,x.ctr,x.cpc,x.cpm,x.frequency,x.leads,x.results,x.cpl,x.cost_per_result,x.result_type,x.data_status])];
    return csvResponse(rows, clientId ? `meta-${selectedRun.snapshot_date}-cliente-detalhado.csv` : `meta-${selectedRun.snapshot_date}-geral-detalhado.csv`);
  }

  if (clientId) {
    const [{ data: client }, { data: snapshots, error: snapError }] = await Promise.all([
      ops.from("clients").select("id,display_name,lifecycle,entrada,gt_owner,cs_owner").eq("id", clientId).maybeSingle(),
      ops.from("meta_performance_snapshots").select("*").eq("client_id", clientId).order("snapshot_date", { ascending: false }).order("period_days", { ascending: true }).limit(208),
    ]);
    if (snapError) return respond({ error: "snapshots_failed", detail: snapError.message }, 500);
    const runIdForCampaigns = requestedRun || String((snapshots || [])[0]?.run_id || "");
    let campaigns: Row[] = [];
    if (runIdForCampaigns) {
      const result = await ops.from("meta_campaign_performance_snapshots").select("*").eq("client_id", clientId).eq("run_id", runIdForCampaigns).order("period_days", { ascending: true }).order("spend", { ascending: false }).limit(1500);
      if (!result.error) campaigns = result.data || [];
    }
    return respond({ profile: { person, adler_only: true }, client, snapshots: snapshots || [], campaigns, runs: allRuns, selected_run_id: runIdForCampaigns, generated_at: new Date().toISOString() });
  }

  let snapshots: Row[] = [], previousSnapshots: Row[] = [];
  if (selectedRunId) {
    const result = await ops.from("meta_performance_snapshots").select("*").eq("run_id", selectedRunId).order("client_name", { ascending: true }).order("period_days", { ascending: true }).limit(1000);
    if (result.error) return respond({ error: "snapshots_failed", detail: result.error.message }, 500);
    snapshots = result.data || [];
    const selectedIndex = allRuns.findIndex((row: Row) => String(row.id) === selectedRunId);
    const previousRun = selectedIndex >= 0 ? allRuns[selectedIndex + 1] : null;
    if (previousRun) {
      const prev = await ops.from("meta_performance_snapshots").select("client_id,period_days,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,leads,results,cpl,cost_per_result,data_status").eq("run_id", previousRun.id).order("client_name", { ascending: true }).limit(1000);
      previousSnapshots = prev.data || [];
    }
  }

  const [{ count: activeCount }, { data: activeIds }, { data: integrations }] = await Promise.all([
    ops.from("clients").select("id", { count: "exact", head: true }).eq("lifecycle", "ACTIVE"),
    ops.from("clients").select("id").eq("lifecycle", "ACTIVE"),
    ops.from("client_integrations").select("client_id,meta_ad_account_id").eq("system", "META_BM").not("meta_ad_account_id", "is", null),
  ]);
  const activeSet = new Set((activeIds || []).map((row: Row) => String(row.id)));
  const integratedSet = new Set((integrations || []).filter((row: Row) => activeSet.has(String(row.client_id))).map((row: Row) => String(row.client_id)));
  const status7 = snapshots.filter((row: Row) => Number(row.period_days) === 7);
  const coverage = {
    active_clients: Number(activeCount || 0),
    integrated_clients: integratedSet.size,
    without_meta: Math.max(0, Number(activeCount || 0) - integratedSet.size),
    ok: status7.filter((row: Row) => row.data_status === "OK").length,
    partial_period: status7.filter((row: Row) => row.data_status === "PARTIAL_PERIOD").length,
    no_delivery: status7.filter((row: Row) => row.data_status === "NO_DELIVERY").length,
    api_issues: status7.filter((row: Row) => ["API_ERROR","API_PARTIAL"].includes(String(row.data_status))).length,
  };

  return respond({ profile: { person, adler_only: true }, runs: allRuns, selected_run: selectedRun || null, snapshots, previous_snapshots: previousSnapshots, coverage, generated_at: new Date().toISOString() });
});
