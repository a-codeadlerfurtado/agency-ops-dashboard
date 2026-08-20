// [LEONARDO IMOBI] agency-ops-contracts-api — area privada de contratos.
//
// REGRA ABSOLUTA: contratos sao ADLER ONLY. Para qualquer outro usuario esta
// rota se comporta como inexistente (404), sem revelar que a area existe.
// A autorizacao NAO e' feita aqui por comparacao de string: quem decide e'
// agency_ops.is_contract_viewer(text), a fonte unica de verdade no banco.
// access_level = FULL explicitamente nao basta.
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
// Uma unica forma de negar. Nunca diferencie "nao autenticado" de "sem
// permissao": as duas respostas tem que ser indistinguiveis de rota inexistente.
const notFound = () => json({ error: "not_found" }, 404);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return notFound();

  const url = new URL(req.url);
  const isProbe = url.searchParams.get("probe") === "1";
  const clientId = url.searchParams.get("client_id");

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

  // Autorizacao centralizada. Qualquer erro aqui nega o acesso: falha fechada.
  const { data: allowed, error: authorizationError } = await ops.rpc("is_contract_viewer", { p_user_key: user.id });
  const isViewer = authorizationError ? false : allowed === true;

  if (!isViewer) {
    // O probe do menu lateral roda em toda carga de pagina de todo usuario.
    // Registrar cada uma inundaria a auditoria sem agregar sinal, entao so'
    // gravamos tentativa real de leitura/acao.
    if (!isProbe) {
      await ops.from("contract_access_audit").insert({
        user_id: user.id,
        person: null,
        action: "CONTRACTS_API_ACCESS",
        allowed: false,
        metadata: { method: req.method, authorization_error: authorizationError?.message ?? null },
      });
    }
    return notFound();
  }

  // Autorizado. O probe para por aqui: nao consulta nada e nao devolve dado.
  if (isProbe) return json({ ok: true });

  await ops.from("contract_access_audit").insert({
    user_id: user.id,
    person: "Adler Furtado",
    action: req.method === "GET" ? (clientId ? "VIEW_CLIENT_CONTRACT" : "VIEW_CONTRACTS_TAB") : "CONTRACT_NOTIFICATION_ACTION",
    allowed: true,
    metadata: { method: req.method, client_id: clientId },
  });

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "mark_notification_read" && body?.id) {
      const { error } = await ops.from("contract_private_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", String(body.id));
      if (error) return json({ error: "query_failed" }, 500);
      return json({ ok: true });
    }
    if (body?.action === "mark_all_notifications_read") {
      const { error } = await ops.from("contract_private_notifications")
        .update({ read_at: new Date().toISOString() })
        .is("read_at", null);
      if (error) return json({ error: "query_failed" }, 500);
      return json({ ok: true });
    }
    return notFound();
  }

  // Ficha contratual de um cliente so' — alimenta a secao "Contrato" dentro do
  // drawer do cliente, que so' existe para o Adler.
  if (clientId) {
    const { data, error } = await ops.from("contract_private_dashboard")
      .select("*").eq("client_id", clientId).maybeSingle();
    if (error) return json({ error: "query_failed" }, 500);
    const { data: history } = await ops.from("client_contracts")
      .select("id,document_name,document_status,contract_start_date,contract_end_date,signed_file_url,original_file_url,renewal_of_contract_id,term_source,term_confidence")
      .eq("client_id", clientId)
      .order("contract_start_date", { ascending: false, nullsFirst: false });
    return json({ ok: true, contract: data || null, history: history || [], generated_at: new Date().toISOString() });
  }

  const [summaryRes, rowsRes, notificationsRes, docsRes] = await Promise.all([
    ops.from("contract_portfolio_summary").select("*").maybeSingle(),
    ops.from("contract_private_dashboard").select("*").order("days_remaining", { ascending: true, nullsFirst: false }),
    ops.from("contract_private_notifications").select("*").order("occurred_at", { ascending: false }).limit(100),
    ops.from("client_contracts").select("id", { count: "exact", head: true }),
  ]);

  if (summaryRes.error || rowsRes.error || notificationsRes.error) return json({ error: "query_failed" }, 500);
  return json({
    ok: true,
    summary: summaryRes.data || {},
    contracts: rowsRes.data || [],
    notifications: notificationsRes.data || [],
    source: { provider: "Autentique", documents_ingested: docsRes.count || 0 },
    generated_at: new Date().toISOString(),
  });
});
