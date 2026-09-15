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
const clean = (value: unknown) => String(value ?? "").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return reply({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await authClient.auth.getUser();
  if (!userData?.user) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle();
  const person = clean(pref?.collaborator_person);
  if (!person) return reply({ error: "forbidden", detail: "campaign_notes_profile_required" }, 403);

  const { data: roster } = await ops.from("team_roster").select("role,is_former").eq("person", person).maybeSingle();
  const role = clean(roster?.role).toUpperCase();
  const isGt = role === "GT";
  const isAdler = role === "MGMT" && person === "Adler Furtado";
  if (!roster || roster.is_former || (!isGt && !isAdler)) {
    return reply({ error: "forbidden", detail: "campaign_notes_gt_or_adler_only" }, 403);
  }

  const url = new URL(req.url);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const clientName = clean(req.method === "GET" ? url.searchParams.get("client_name") : body?.client_name);
  const campaignName = clean(req.method === "GET" ? url.searchParams.get("campaign_name") : body?.campaign_name);
  const accountKey = clean(req.method === "GET" ? url.searchParams.get("account_key") : body?.account_key);
  if (!clientName || !campaignName) return reply({ error: "campaign_context_required" }, 400);

  let clientQuery = ops.from("campaign_client_latest")
    .select("client_id,display_name,gt_owner,lifecycle")
    .eq("display_name", clientName);
  if (isGt) clientQuery = clientQuery.eq("gt_owner", person);
  const { data: client, error: clientError } = await clientQuery.maybeSingle();
  if (clientError) return reply({ error: "query_failed", detail: clientError.message }, 500);
  if (!client?.client_id) {
    return reply({
      error: isGt ? "campaign_outside_wallet" : "client_not_found",
      detail: isGt ? "Esta campanha não pertence à carteira deste GT." : "Cliente não localizado para observações de campanha.",
    }, isGt ? 403 : 404);
  }

  const { data: candidates, error: campaignError } = await ops.from("meta_campaign_inventory")
    .select("client_id,account_key,meta_ad_account_id,campaign_id,campaign_name,campaign_status,objective,checked_at")
    .eq("client_id", client.client_id)
    .eq("campaign_name", campaignName)
    .order("checked_at", { ascending: false })
    .limit(25);
  if (campaignError) return reply({ error: "query_failed", detail: campaignError.message }, 500);

  const exact = (candidates ?? []).find((row: any) => !accountKey || clean(row.account_key) === accountKey || clean(row.meta_ad_account_id) === accountKey);
  const campaign = exact ?? (accountKey ? null : (candidates ?? [])[0]);
  if (!campaign?.campaign_id) return reply({ error: "campaign_not_found" }, 404);

  if (req.method === "POST") {
    const note = clean(body?.note);
    if (!note) return reply({ error: "note_required" }, 400);
    if (note.length > 4000) return reply({ error: "note_too_long", max: 4000 }, 400);
    const storedAccount = clean(campaign.account_key) || clean(campaign.meta_ad_account_id) || accountKey || null;
    const { data: inserted, error: insertError } = await ops.from("campaign_notes").insert({
      client_id: client.client_id,
      campaign_id: String(campaign.campaign_id),
      campaign_name: campaign.campaign_name ?? campaignName,
      account_key: storedAccount,
      note,
      author_user_key: userKey,
      author_person: person,
    }).select("id,client_id,campaign_id,campaign_name,account_key,note,author_person,created_at").single();
    if (insertError) return reply({ error: "save_failed", detail: insertError.message }, 500);
    return reply({ ok: true, note: inserted }, 201);
  }

  const { data: notes, error: notesError } = await ops.from("campaign_notes")
    .select("id,client_id,campaign_id,campaign_name,account_key,note,author_person,created_at")
    .eq("client_id", client.client_id)
    .eq("campaign_id", String(campaign.campaign_id))
    .order("created_at", { ascending: false })
    .limit(100);
  if (notesError) return reply({ error: "query_failed", detail: notesError.message }, 500);

  return reply({
    eligible: true,
    person,
    role,
    scope: isAdler ? "ALL" : "WALLET",
    client: { client_id: client.client_id, display_name: client.display_name, gt_owner: client.gt_owner },
    campaign,
    notes: notes ?? [],
  });
});
