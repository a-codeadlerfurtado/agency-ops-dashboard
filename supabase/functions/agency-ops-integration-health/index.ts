import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// Divergencia = o cruzamento discorda (CONFLICT) ou so' bate em parte (PARTIAL).
// STALE_EXTERNAL e NO_EXTERNAL nao entram: ali o problema e' ausencia/atraso de
// dado externo, nao contradicao entre as fontes.
const DIVERGENT = ["CONFLICT", "PARTIAL"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return json({ error: "server_configuration" }, 500);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const url = new URL(req.url);
  const clientId = url.searchParams.get("client_id");

  const [health, notionCfg, notionJob] = await Promise.all([
    ops.from("integration_health_overview").select("source_key,source_label,status,last_event_at,lag_minutes,detail,metadata"),
    ops.from("automation_settings").select("value,updated_at").eq("key", "notion_client_health_source").maybeSingle(),
    ops.from("automation_health").select("last_success_at,last_error_at,last_error,updated_at").eq("job_name", "notion_client_health_sync").maybeSingle(),
  ]);
  if (health.error) return json({ error: "integration_health_query_failed", detail: health.error.message }, 500);

  const notionStatus = String(notionCfg.data?.value?.source_status || "AWAITING_ACCESS");
  let integrations = (health.data ?? []).map((item: any) => {
    if (item.source_key !== "NOTION") return item;

    if (notionStatus === "MISSING_API_KEY") {
      return {
        ...item,
        status: "FAIL",
        last_event_at: notionJob.data?.last_error_at || notionCfg.data?.updated_at || item.last_event_at,
        detail: "Integração do Dashboard Saúde dos Clientes configurada, mas falta o secret NOTION_API_KEY no Supabase.",
        metadata: {
          ...(item.metadata || {}),
          source_status: notionStatus,
          last_error: notionJob.data?.last_error || "Missing NOTION_API_KEY",
          workspace_account: notionCfg.data?.value?.workspace_account || null,
          data_source_id: notionCfg.data?.value?.data_source_id || null,
        },
      };
    }

    if (notionStatus === "CONFIGURED_PENDING_FIRST_SYNC") {
      return {
        ...item,
        status: "DELAY",
        detail: "Dashboard Saúde dos Clientes configurado; aguardando a primeira sincronização bem-sucedida.",
        metadata: { ...(item.metadata || {}), source_status: notionStatus },
      };
    }

    return { ...item, metadata: { ...(item.metadata || {}), source_status: notionStatus } };
  });

  const rank: Record<string, number> = { FAIL: 0, DELAY: 1, OK: 2 };
  integrations = integrations.sort((a: any, b: any) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));

  if (clientId) {
    const cross = await ops.from("client_health_crosscheck").select("*").eq("client_id", clientId).maybeSingle();
    if (cross.error) return json({ error: "client_health_crosscheck_failed", detail: cross.error.message }, 500);
    return json({ integrations, client_health_crosscheck: cross.data, generated_at: new Date().toISOString() });
  }

  const crossSummary = await ops.from("client_health_crosscheck").select("crosscheck_status");
  if (crossSummary.error) return json({ error: "crosscheck_summary_failed", detail: crossSummary.error.message }, 500);

  const summary: Record<string, number> = {};
  for (const row of crossSummary.data ?? []) summary[row.crosscheck_status] = (summary[row.crosscheck_status] ?? 0) + 1;

  // O contador sozinho nao permite agir: quem le' "14 divergencias" ainda precisa
  // descobrir quais sao. Devolvemos as linhas divergentes junto, ja' com os dois
  // lados do cruzamento, para a tela poder mostrar cliente a cliente.
  const details = await ops
    .from("client_health_crosscheck")
    .select(
      "client_id,display_name,crosscheck_status,internal_band,internal_score,internal_date," +
        "external_health_status,external_health_score,external_risk_level,external_summary," +
        "external_recommended_action,external_source_key,external_source_url,external_source_updated_at",
    )
    .in("crosscheck_status", DIVERGENT)
    .order("display_name");
  if (details.error) return json({ error: "crosscheck_details_failed", detail: details.error.message }, 500);

  return json({
    integrations,
    client_health_crosscheck_summary: summary,
    client_health_crosscheck_details: details.data ?? [],
    generated_at: new Date().toISOString(),
  });
});
