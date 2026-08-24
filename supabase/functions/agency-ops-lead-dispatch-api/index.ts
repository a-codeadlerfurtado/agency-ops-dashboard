import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const validDate = (v: string | null) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function nextDay(day: string) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function bestCampaign(row: any, resolvedClientId: string | null) {
  if (!resolvedClientId || !Array.isArray(row?.expected_candidates)) return null;
  const candidates = row.expected_candidates
    .filter((candidate: any) => String(candidate?.client_id ?? "") === resolvedClientId)
    .map((candidate: any) => ({
      campaign_id: candidate?.campaign_id ? String(candidate.campaign_id) : null,
      campaign_name: candidate?.campaign_name ? String(candidate.campaign_name) : null,
      score: Number(candidate?.score ?? 0),
    }))
    .filter((candidate: any) => candidate.campaign_id && candidate.campaign_name)
    .sort((a: any, b: any) => b.score - a.score);
  const best = candidates[0] ?? null;
  // Abaixo de 0,70 o nome do produto pode ser genérico demais. Mantém o disparo
  // no total do cliente, mas não inventa campanha.
  return best && best.score >= 0.70 ? best : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

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
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person ?? null;
  if (!person || !(approvals ?? []).some((row: any) => row.kind === "SIGNUP")) return reply({ error: "forbidden" }, 403);

  const { data: roster } = await ops.from("team_roster").select("person,role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return reply({ error: "forbidden" }, 403);
  const elevated = roster.access_level === "RESTRICTED" && (approvals ?? []).some((row: any) => row.kind === "ELEVATION");
  const walletScoped = (roster.role === "GT" || roster.access_level === "WALLET_ONLY") && !elevated;

  const url = new URL(req.url);
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  if (!validDate(since) || !validDate(until) || since! > until!) return reply({ error: "invalid_period" }, 400);

  let clientsQuery = ops.from("clients").select("id,display_name,lifecycle,gt_owner").in("lifecycle", ["ACTIVE", "ONBOARDING"]);
  if (walletScoped) clientsQuery = clientsQuery.eq("gt_owner", roster.person);
  const { data: clients, error: clientError } = await clientsQuery.order("display_name");
  if (clientError) return reply({ error: "query_failed", detail: clientError.message }, 500);
  const clientIds = new Set((clients ?? []).map((row: any) => String(row.id)));
  const clientById = new Map((clients ?? []).map((row: any) => [String(row.id), row]));

  const startIso = `${since}T00:00:00-03:00`;
  const endIso = `${nextDay(until!)}T00:00:00-03:00`;
  const { data: dispatches, error: dispatchError } = await ops.from("meta_lead_dispatches")
    .select("id,message_id,event_at,product_label,recipient_client_id,expected_client_id,routing_status,expected_candidates")
    .gte("event_at", startIso).lt("event_at", endIso).order("event_at", { ascending: true }).limit(10000);
  if (dispatchError) return reply({ error: "query_failed", detail: dispatchError.message }, 500);

  const clientAgg = new Map<string, any>();
  const campaignAgg = new Map<string, any>();
  let unknownClient = 0;
  let routingConflicts = 0;
  let matchedCampaigns = 0;
  let unmatchedCampaigns = 0;

  for (const row of dispatches ?? []) {
    // recipient_client_id representa quem efetivamente recebeu o disparo. expected_client_id
    // só entra quando o destinatário não pôde ser identificado diretamente.
    const resolvedClientId = row.recipient_client_id ? String(row.recipient_client_id) : row.expected_client_id ? String(row.expected_client_id) : null;
    if (!resolvedClientId || !clientIds.has(resolvedClientId)) { unknownClient += 1; continue; }
    const current = clientAgg.get(resolvedClientId) ?? {
      client_id: resolvedClientId,
      display_name: clientById.get(resolvedClientId)?.display_name ?? resolvedClientId,
      dispatches: 0,
      campaign_matched: 0,
      campaign_unmatched: 0,
      routing_conflicts: 0,
      products: {} as Record<string, number>,
    };
    current.dispatches += 1;
    const product = String(row.product_label || "Produto não identificado").trim();
    current.products[product] = (current.products[product] ?? 0) + 1;
    if (String(row.routing_status) === "ROUTING_CONFLICT") { current.routing_conflicts += 1; routingConflicts += 1; }

    const campaign = bestCampaign(row, resolvedClientId);
    if (campaign) {
      current.campaign_matched += 1;
      matchedCampaigns += 1;
      const key = `${resolvedClientId}:${campaign.campaign_id}`;
      const c = campaignAgg.get(key) ?? {
        client_id: resolvedClientId,
        campaign_id: campaign.campaign_id,
        campaign_name: campaign.campaign_name,
        dispatches: 0,
        score_sum: 0,
        products: {} as Record<string, number>,
      };
      c.dispatches += 1;
      c.score_sum += campaign.score;
      c.products[product] = (c.products[product] ?? 0) + 1;
      campaignAgg.set(key, c);
    } else {
      current.campaign_unmatched += 1;
      unmatchedCampaigns += 1;
    }
    clientAgg.set(resolvedClientId, current);
  }

  const clientRows = [...clientAgg.values()].map((row: any) => ({
    ...row,
    products: Object.entries(row.products).sort((a: any, b: any) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
  }));
  const campaignRows = [...campaignAgg.values()].map((row: any) => ({
    client_id: row.client_id,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    dispatches: row.dispatches,
    match_score_avg: row.dispatches ? Number((row.score_sum / row.dispatches).toFixed(4)) : null,
    products: Object.entries(row.products).sort((a: any, b: any) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
  }));

  return reply({
    profile: { person: roster.person, role: roster.role, scope: walletScoped ? "WALLET" : "FULL" },
    period: { since, until, timezone: "America/Sao_Paulo" },
    clients: clientRows,
    campaigns: campaignRows,
    summary: {
      dispatches_total: clientRows.reduce((sum: number, row: any) => sum + Number(row.dispatches || 0), 0),
      clients_with_dispatches: clientRows.length,
      campaign_matched: matchedCampaigns,
      campaign_unmatched: unmatchedCampaigns,
      routing_conflicts: routingConflicts,
      unknown_client_dispatches: unknownClient,
      source: "WHATSAPP_FROM_ME_META_LEAD_DISPATCH",
    },
    generated_at: new Date().toISOString(),
  });
});
