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
type Row = Record<string, any>;

function evidenceRank(row: Row) {
  const status = String(row.verification_status || "").toUpperCase();
  return [status === "CONFIRMED" ? 0 : 1, -(Number(row.confidence || 0)), -(new Date(String(row.source_at || row.updated_at || row.created_at || 0)).getTime() || 0)];
}
function compareEvidence(a: Row, b: Row) {
  const ar = evidenceRank(a), br = evidenceRank(b);
  for (let i = 0; i < ar.length; i += 1) if (ar[i] !== br[i]) return ar[i] - br[i];
  return Number(b.id || 0) - Number(a.id || 0);
}
function nullableMoney(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("invalid_money");
  return Number(parsed.toFixed(2));
}
function nullableInt(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 120) throw new Error("invalid_term");
  return parsed;
}
function nullableText(value: unknown, max = 2000) {
  if (value === null || value === undefined) return null;
  const rendered = String(value).trim();
  return rendered ? rendered.slice(0, max) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return notFound();

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
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", user.id).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person || !(approvals || []).length) return notFound();
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  const allowed = person === "Adler Furtado" || (person === "Leonardo Augusto" && roster?.role === "COMMERCIAL");
  if (!allowed) return notFound();

  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.get("probe") === "1") return json({ ok: true, person, can_edit: true });

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const clientId = String(body?.client_id || "").trim();
    if (!clientId) return json({ error: "client_required" }, 400);
    const { data: client } = await ops.from("clients").select("id,display_name,lifecycle").eq("id", clientId).maybeSingle();
    if (!client || !["ACTIVE", "ONBOARDING"].includes(String(client.lifecycle))) return json({ error: "client_not_available" }, 404);
    let payload: Row;
    try {
      payload = {
        client_id: clientId,
        monthly_value: nullableMoney(body?.monthly_value),
        implementation_value: nullableMoney(body?.implementation_value),
        term_months: nullableInt(body?.term_months),
        implementation_payment: nullableText(body?.implementation_payment, 120),
        notes: nullableText(body?.notes, 3000),
        source: "MANUAL",
        updated_by: person,
        updated_at: new Date().toISOString(),
      };
      if (Array.isArray(body?.implementation_installments)) {
        payload.implementation_installments = body.implementation_installments
          .map((value: unknown) => nullableMoney(value))
          .filter((value: unknown) => value !== null);
      }
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "invalid_payload" }, 400);
    }
    const { data: saved, error: saveError } = await ops.from("client_commercial_terms").upsert(payload, { onConflict: "client_id" }).select("*").single();
    if (saveError) return json({ error: "save_failed", detail: saveError.message }, 500);
    return json({ ok: true, client: { id: client.id, display_name: client.display_name }, row: saved, updated_by: person, generated_at: new Date().toISOString() });
  }

  const { data: clients, error: clientsError } = await ops.from("clients")
    .select("id,display_name,lifecycle,cs_owner,gt_owner,entrada")
    .in("lifecycle", ["ACTIVE", "ONBOARDING"])
    .order("display_name", { ascending: true });
  if (clientsError) return json({ error: "query_failed", detail: clientsError.message }, 500);

  const ids = (clients || []).map((row: Row) => String(row.id));
  if (!ids.length) return json({ ok: true, rows: [], summary: {}, profile: { person, can_edit: true }, generated_at: new Date().toISOString() });

  const [{ data: terms, error: termsError }, { data: evidence, error: evidenceError }] = await Promise.all([
    ops.from("client_commercial_terms")
      .select("client_id,monthly_value,implementation_value,term_months,implementation_payment,implementation_installments,notes,source,source_crm_lead_id,updated_at,updated_by")
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
      return { confirmed, provisional, source_types: [...new Set(items.map((row) => String(row.source_type || "")).filter(Boolean))], evidence_count: items.length };
    };
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
      commercial_notes: term.notes,
      canonical_source: term.source,
      canonical_crm_lead_id: term.source_crm_lead_id,
      commercial_updated_at: term.updated_at,
      commercial_updated_by: term.updated_by,
      monthly_evidence: pick("MONTHLY"),
      implementation_evidence: pick("IMPLEMENTATION"),
      term_evidence: pick("TERM"),
      payment_evidence: pick("PAYMENT"),
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
    profile: { person, role: roster?.role || null, can_edit: true },
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
      crm_requires_exact_client_link: true,
      sources: ["CRM", "BRIEFING", "MEETING", "CONTRACT", "MANUAL"],
      editable_by: ["Adler Furtado", "Leonardo Augusto"],
    },
    generated_at: new Date().toISOString(),
  });
});
