// [LEONARDO IMOBI] agency-ops-contracts-api — area privada de contratos da direcao.
// Acesso permitido somente a Adler Furtado e Leonardo Augusto via
// agency_ops.is_contract_viewer(text). access_level = FULL nao basta.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const notFound = () => json({ error: "not_found" }, 404);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return notFound();

  const requestUrl = new URL(req.url);
  const isProbe = requestUrl.searchParams.get("probe") === "1";
  const clientId = requestUrl.searchParams.get("client_id");
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return notFound();

  const auth = createClient(supabaseUrl, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return notFound();

  const db = createClient(supabaseUrl, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: allowed, error: authorizationError }, { data: preference }] = await Promise.all([
    ops.rpc("is_contract_viewer", { p_user_key: user.id }),
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
  ]);
  const person = String(preference?.collaborator_person || "").trim() || null;
  const isViewer = authorizationError ? false : allowed === true;

  if (!isViewer) {
    if (!isProbe) await ops.from("contract_access_audit").insert({
      user_id: user.id, person, action: "CONTRACTS_API_ACCESS", allowed: false,
      metadata: { method: req.method, authorization_error: authorizationError?.message ?? null },
    });
    return notFound();
  }

  if (isProbe) {
    const { count } = await ops.from("contract_private_notifications").select("id", { count: "exact", head: true }).is("read_at", null);
    return json({ ok: true, unread: count || 0, person });
  }

  await ops.from("contract_access_audit").insert({
    user_id: user.id, person,
    action: req.method === "GET" ? (clientId ? "VIEW_CLIENT_CONTRACT" : "VIEW_CONTRACTS_TAB") : "CONTRACT_NOTIFICATION_ACTION",
    allowed: true, metadata: { method: req.method, client_id: clientId },
  });

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "mark_notification_read" && body?.id) {
      const { error } = await ops.from("contract_private_notifications").update({ read_at: new Date().toISOString() }).eq("id", String(body.id));
      if (error) return json({ error: "query_failed" }, 500);
      return json({ ok: true });
    }
    if (body?.action === "mark_all_notifications_read") {
      const { error } = await ops.from("contract_private_notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
      if (error) return json({ error: "query_failed" }, 500);
      return json({ ok: true });
    }
    return notFound();
  }

  if (clientId) {
    const { data, error } = await ops.from("contract_private_dashboard").select("*").eq("client_id", clientId).maybeSingle();
    if (error) return json({ error: "query_failed" }, 500);
    const { data: history } = await ops.from("client_contracts")
      .select("id,document_name,document_status,contract_start_date,contract_end_date,signed_file_url,original_file_url,renewal_of_contract_id,term_source,term_confidence")
      .eq("client_id", clientId).order("contract_start_date", { ascending: false, nullsFirst: false });
    return json({ ok: true, person, contract: data || null, history: history || [], generated_at: new Date().toISOString() });
  }

  const [summaryRes, rowsRes, notificationsRes, docsRes] = await Promise.all([
    ops.from("contract_portfolio_summary").select("*").maybeSingle(),
    ops.from("contract_private_dashboard").select("*").order("days_remaining", { ascending: true, nullsFirst: false }),
    ops.from("contract_private_notifications").select("*").order("occurred_at", { ascending: false }).limit(100),
    ops.from("client_contracts").select("id", { count: "exact", head: true }),
  ]);
  if (summaryRes.error || rowsRes.error || notificationsRes.error) return json({ error: "query_failed" }, 500);
  return json({ ok: true, person, summary: summaryRes.data || {}, contracts: rowsRes.data || [], notifications: notificationsRes.data || [], source: { provider: "Autentique", documents_ingested: docsRes.count || 0 }, generated_at: new Date().toISOString() });
});