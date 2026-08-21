import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Painel de saude do cliente para a aba "Saude" da Central.
//
// Funcao propria, e nao mais um campo no agency-ops-dashboard-api, por dois
// motivos: a aba nao e' a tela inicial (carregar isso em todo login seria peso
// a toa), e o arquivo do dashboard-api tem 48 KB - mexer nele para acrescentar
// uma tela nova poe em risco o que ja' funciona.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

type Identity = {
  person: string | null;
  role: string | null;
  accessLevel: string;
  elevated: boolean;
  locked: boolean;
  isFull: boolean;
  isWalletOnly: boolean;
  views: string[];
};

/**
 * Mesma resolucao de identidade do agency-ops-dashboard-api.
 *
 * Repetir a regra aqui e' deliberado, mas repetir *outra* regra nao seria: se
 * esta tela usasse criterio proprio, ela viraria caminho alternativo para ver
 * cliente que o Dashboard esconde. As duas leem user_preferences -> team_roster
 * e as aprovacoes em access_requests, e a lista de abas vem da mesma RPC.
 */
async function resolveIdentity(ops: any, authClient: any): Promise<Identity | null> {
  const { data, error } = await authClient.auth.getUser();
  if (error || !data?.user) return null;
  const userKey = data.user.id;

  const { data: pref } = await ops
    .from("user_preferences").select("collaborator_person").eq("user_key", userKey).maybeSingle();
  const person = pref?.collaborator_person ?? null;

  let role: string | null = null;
  let accessLevel = "RESTRICTED";
  if (person) {
    const { data: roster } = await ops
      .from("team_roster").select("role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
    role = roster?.role ?? null;
    accessLevel = roster?.access_level ?? "RESTRICTED";
  }

  const { data: decisions } = await ops
    .from("access_requests").select("kind,status").eq("user_key", userKey).eq("status", "APPROVED");
  const approvals = decisions ?? [];
  const accountApproved = approvals.some((row: any) => row.kind === "SIGNUP");
  const elevated = accessLevel === "RESTRICTED" && approvals.some((row: any) => row.kind === "ELEVATION");
  const locked = !accountApproved || (!person && !elevated);

  let views: string[] = [];
  if (!locked) {
    const { data: viewRows } = await ops.rpc("dashboard_allowed_views", { p_person: person, p_role: role });
    if (Array.isArray(viewRows)) views = viewRows;
  }

  return {
    person,
    role,
    accessLevel,
    elevated,
    locked,
    isFull: accessLevel === "FULL" || elevated,
    isWalletOnly: accessLevel === "WALLET_ONLY" && !elevated,
    views,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return json({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  // Cliente separado, com a chave publica, so' para validar a sessao. O cliente
  // privilegiado nunca recebe o Authorization do usuario.
  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const identity = await resolveIdentity(ops, authClient);
  if (!identity) return json({ error: "unauthorized" }, 401);
  if (identity.locked || !identity.views.includes("health")) return json({ error: "forbidden" }, 403);

  const { data, error } = await ops
    .from("client_health_board").select("*").order("prioridade", { ascending: false }).limit(400);
  if (error) return json({ error: "query_failed", detail: error.message }, 500);

  let rows = data ?? [];

  // Quem tem carteira ve' a carteira; quem nao tem, ve' a base.
  //
  // O recorte pergunta ao wallet_registry em vez de decidir por papel. Hoje isso
  // significa GT recortado e CS inteiro - CS nao tem divisao de carteira, atende
  // todo mundo, e recortar por dono devolveria zero para eles. Amanha, se algum
  // CS ganhar carteira, basta cadastrar: a regra nao muda.
  let carteiraDe: string | null = null;
  if (identity.person) {
    const { data: carteira } = await ops
      .from("wallet_registry").select("carteira").eq("gt_owner", identity.person).maybeSingle();
    carteiraDe = carteira?.carteira ?? null;
  }

  if (carteiraDe) {
    rows = rows.filter((row: any) => row.gt_owner === identity.person);
  }

  const ativos = rows.filter((row: any) => row.lifecycle === "ACTIVE" || row.lifecycle === "ONBOARDING");
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const media = (campo: string) => {
    const vals = ativos.map((r: any) => num(r[campo])).filter((v): v is number => v !== null);
    return vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)) : null;
  };

  return json({
    clients: rows,
    resumo: {
      total: rows.length,
      ativos: ativos.length,
      risco_alto: ativos.filter((r: any) => (num(r.external_risk_avg) ?? 0) >= 50).length,
      insatisfeitos: ativos.filter((r: any) => (num(r.external_satisfaction_avg) ?? 100) < 50).length,
      sentimento_negativo: ativos.filter((r: any) => r.sentimento === "Negativo" || r.sentimento === "Crítico").length,
      divergentes: ativos.filter((r: any) => r.crosscheck_status === "CONFLICT" || r.crosscheck_status === "PARTIAL").length,
      sem_dado_externo: ativos.filter((r: any) => r.crosscheck_status === "NO_EXTERNAL").length,
      satisfacao_media: media("external_satisfaction_avg"),
      risco_medio: media("external_risk_avg"),
    },
    profile: {
      person: identity.person,
      role: identity.role,
      access_level: identity.accessLevel,
      scoped: Boolean(carteiraDe),
      carteira: carteiraDe,
    },
    generated_at: new Date().toISOString(),
  });
});
