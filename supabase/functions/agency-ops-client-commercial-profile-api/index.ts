import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const CORS_BASE = {
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};

type Row = Record<string, any>;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed
    ? { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" }
    : CORS_BASE;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return reply({ error: "origin_not_allowed" }, 403);
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData?.user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;

  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("status", "APPROVED"),
  ]);
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person || !(approvals || []).some((row: Row) => row.kind === "SIGNUP")) return reply({ error: "profile_locked" }, 403);

  const { data: roster } = await ops.from("team_roster")
    .select("person,role,access_level,is_former")
    .eq("person", person)
    .eq("is_former", false)
    .maybeSingle();
  if (!roster) return reply({ error: "profile_not_found" }, 403);

  const role = String(roster.role || "").toUpperCase();
  const isAdler = person === "Adler Furtado";
  const isLeonardo = person === "Leonardo Augusto" && role === "COMMERCIAL";
  const canViewFiscal = isAdler || isLeonardo || ["GT", "CS", "MGMT"].includes(role);
  if (!canViewFiscal) return reply({ error: "forbidden" }, 403);
  const elevated = (approvals || []).some((row: Row) => row.kind === "ELEVATION");

  const requestUrl = new URL(req.url);
  const clientId = String(requestUrl.searchParams.get("client_id") || "").trim();
  const name = String(requestUrl.searchParams.get("name") || "").trim();
  if (!clientId && !name) return reply({ error: "missing_client" }, 400);

  let client: Row | null = null;
  if (clientId) {
    const { data, error } = await ops.from("clients")
      .select("id,display_name,lifecycle,gt_owner,cs_owner")
      .eq("id", clientId)
      .maybeSingle();
    if (error) return reply({ error: "query_failed" }, 500);
    client = data;
  } else {
    const { data, error } = await ops.from("clients")
      .select("id,display_name,lifecycle,gt_owner,cs_owner")
      .eq("display_name", name)
      .limit(2);
    if (error) return reply({ error: "query_failed" }, 500);
    if ((data || []).length > 1) return reply({ error: "ambiguous_client" }, 409);
    client = data?.[0] ?? null;
  }
  if (!client) return reply({ error: "client_not_found" }, 404);

  if (role === "GT" && !elevated && String(client.gt_owner || "") !== person) return reply({ error: "forbidden" }, 403);

  const { data: identity, error: identityError } = await ops.from("client_business_identity")
    .select("legal_name,cnpj,cpf,representative_name,representative_cpf,source_type,source_id,confidence,verified_at")
    .eq("client_id", client.id)
    .maybeSingle();
  if (identityError) return reply({ error: "query_failed" }, 500);

  const fiscalType = identity?.cnpj ? "CNPJ" : identity?.cpf ? "CPF" : null;
  const fiscalValue = identity?.cnpj || identity?.cpf || null;
  const fiscal = {
    legal_name: identity?.legal_name ?? null,
    fiscal_type: fiscalType,
    fiscal_value: fiscalValue,
    identified: Boolean(fiscalType && fiscalValue),
    verified_at: identity?.verified_at ?? null,
  };

  let management: Row | null = null;
  if (isAdler || isLeonardo) {
    const [{ data: terms, error: termsError }, { data: contracts, error: contractError }] = await Promise.all([
      ops.from("client_private_commercial_terms")
        .select("monthly_value,implementation_value,implementation_payment_terms,implementation_due_timing,first_monthly_due_terms,minimum_ad_budget,source_type,source_id,evidence_excerpt,confidence,verified_at")
        .eq("client_id", client.id)
        .maybeSingle(),
      ops.from("client_contracts")
        .select("id,document_name,document_status,is_finished,contract_start_date,contract_end_date,term_months,source_created_at,created_at")
        .eq("client_id", client.id)
        .eq("is_deleted", false)
        .order("source_created_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(1),
    ]);
    if (termsError || contractError) return reply({ error: "query_failed" }, 500);
    const contract = contracts?.[0] ?? null;
    management = {
      legal_name: identity?.legal_name ?? null,
      cnpj: identity?.cnpj ?? null,
      cpf: identity?.cpf ?? null,
      representative_name: identity?.representative_name ?? null,
      representative_cpf: identity?.representative_cpf ?? null,
      monthly_value: terms?.monthly_value ?? null,
      implementation_value: terms?.implementation_value ?? null,
      implementation_payment_terms: terms?.implementation_payment_terms ?? null,
      implementation_due_timing: terms?.implementation_due_timing ?? null,
      first_monthly_due_terms: terms?.first_monthly_due_terms ?? null,
      minimum_ad_budget: terms?.minimum_ad_budget ?? null,
      contract_id: contract?.id ?? null,
      document_name: contract?.document_name ?? null,
      contract_status: contract?.document_status ?? null,
      contract_finished: contract?.is_finished ?? null,
      contract_start_date: contract?.contract_start_date ?? null,
      contract_end_date: contract?.contract_end_date ?? null,
      term_months: contract?.term_months ?? null,
      commercial_evidence: terms?.evidence_excerpt ?? null,
      commercial_confidence: terms?.confidence ?? null,
      commercial_verified_at: terms?.verified_at ?? null,
    };
  }

  return reply({
    client: { client_id: client.id, display_name: client.display_name, lifecycle: client.lifecycle },
    fiscal,
    management,
    permissions: { fiscal: true, commercial_private: Boolean(isAdler || isLeonardo) },
    generated_at: new Date().toISOString(),
  });
});