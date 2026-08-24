import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const notFound = () => json({ error: "not_found" }, 404);

type Row = Record<string, any>;

function evidenceRank(row: Row) {
  const status = String(row.verification_status || "").toUpperCase();
  const statusRank = status === "CONFIRMED" ? 0 : 1;
  return [statusRank, -(Number(row.confidence || 0)), -(new Date(String(row.source_at || row.updated_at || row.created_at || 0)).getTime() || 0)];
}

function compareEvidence(a: Row, b: Row) {
  const ar = evidenceRank(a), br = evidenceRank(b);
  for (let i = 0; i < ar.length; i += 1) if (ar[i] !== br[i]) return ar[i] - br[i];
  return Number(b.id || 0) - Number(a.id || 0);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return notFound();

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anon || !service) return json({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return notFound();

  const auth = createClient(supabaseUrl, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return notFound();

  const db = createClient(supabaseUrl, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: allowed, error: authError } = await ops.rpc("is_contract_viewer", { p_user_key: user.id });
  if (authError || allowed !== true) return notFound();

  const url = new URL(req.url);
  if (url.searchParams.get("probe") === "1") return json({ ok: true });

  const { data: clients, error: clientsError } = await ops.from("clients")
    .select("id,display_name,lifecycle,cs_owner,gt_owner,entrada")
    .in("lifecycle", ["ACTIVE", "ONBOARDING"])
    .order("display_name", { ascending: true });
  if (clientsError) return json({ error: "query_failed", detail: clientsError.message }, 500);

  const ids = (clients || []).map((row: Row) => String(row.id));
  if (!ids.length) return json({ ok: true, rows: [], summary: {}, generated_at: new Date().toISOString() });

  const [{ data: terms, error: termsError }, { data: evidence, error: evidenceError }] = await Promise.all([
    ops.from("client_commercial_terms")
      .select("client_id,monthly_value,implementation_value,term_months,implementation_payment,implementation_installments,notes,source,updated_at")
      .in("client_id", ids),
    ops.from("client_commercial_term_evidence")
      .select("id,client_id,source_type,source_id,source_at,field_key,numeric_value,text_value,array_value,evidence_excerpt,confidence,verification_status,metadata,created_at,updated_at")
      .in("client_id", ids)
      .in("field_key", ["MONTHLY", "IMPLEMENTATION", "TERM", "PAYMENT"]),
  ]);
  if (termsError || evidenceError) return json({ error: "query_failed", detail: termsError?.message || evidenceError?.message }, 500);

  const termsByClient = new Map((terms || []).map((row: Row) => [String(row.client_id), row]));
  const evidenceByClient = new Map<string, Map<string, Row[]>>();
  for (const row of evidence || []) {
    const clientId = String(row.client_id);
    const field = String(row.field_key || "").toUpperCase();
    if (!evidenceByClient.has(clientId)) evidenceByClient.set(clientId, new Map());
    const byField = evidenceByClient.get(clientId)!;
    byField.set(field, [...(byField.get(field) || []), row]);
  }

  const rows = (clients || []).map((client: Row) => {
    const clientId = String(client.id);
    const term = termsByClient.get(clientId) || {};
    const byField = evidenceByClient.get(clientId) || new Map<string, Row[]>();

    const pick = (field: string) => {
      const items = [...(byField.get(field) || [])].sort(compareEvidence);
      const confirmed = items.find((row) => String(row.verification_status).toUpperCase() === "CONFIRMED") || null;
      const provisional = items.find((row) => String(row.verification_status).toUpperCase() !== "CONFIRMED") || null;
      return {
        confirmed,
        provisional,
        source_types: [...new Set(items.map((row) => String(row.source_type || "")).filter(Boolean))],
        evidence_count: items.length,
      };
    };

    const monthlyEvidence = pick("MONTHLY");
    const implementationEvidence = pick("IMPLEMENTATION");
    const termEvidence = pick("TERM");
    const paymentEvidence = pick("PAYMENT");

    return {
      client_id: clientId,
      display_name: client.display_name,
      lifecycle: client.lifecycle,
      cs_owner: client.cs_owner,
      gt_owner: client.gt_owner,
      entrada: client.entrada,
      monthly_value: term.monthly_value,
      implementation_value: term.implementation_value,
      term_months: term.term_months,
      implementation_payment: term.implementation_payment,
      implementation_installments: term.implementation_installments,
      canonical_source: term.source,
      commercial_notes: term.notes,
      commercial_updated_at: term.updated_at,
      monthly_evidence: monthlyEvidence,
      implementation_evidence: implementationEvidence,
      term_evidence: termEvidence,
      payment_evidence: paymentEvidence,
    };
  });

  const monthlyConfirmed = rows.filter((row: Row) => row.monthly_value !== null && row.monthly_value !== undefined).length;
  const implementationConfirmed = rows.filter((row: Row) => row.implementation_value !== null && row.implementation_value !== undefined).length;
  const termConfirmed = rows.filter((row: Row) => row.term_months !== null && row.term_months !== undefined).length;
  const monthlyTotal = rows.reduce((sum: number, row: Row) => sum + (row.monthly_value == null ? 0 : Number(row.monthly_value || 0)), 0);
  const implementationTotal = rows.reduce((sum: number, row: Row) => sum + (row.implementation_value == null ? 0 : Number(row.implementation_value || 0)), 0);
  const monthlyCandidates = rows.filter((row: Row) => row.monthly_value == null && row.monthly_evidence?.provisional).length;
  const implementationCandidates = rows.filter((row: Row) => row.implementation_value == null && row.implementation_evidence?.provisional).length;

  return json({
    ok: true,
    summary: {
      current_clients: rows.length,
      monthly_confirmed: monthlyConfirmed,
      implementation_confirmed: implementationConfirmed,
      term_confirmed: termConfirmed,
      monthly_total_confirmed: monthlyTotal,
      implementation_total_confirmed: implementationTotal,
      monthly_candidates: monthlyCandidates,
      implementation_candidates: implementationCandidates,
    },
    rows,
    policy: {
      totals_include_only_confirmed_values: true,
      provisional_values_are_review_candidates_only: true,
      sources: ["BRIEFING", "MEETING", "CONTRACT"],
    },
    generated_at: new Date().toISOString(),
  });
});
