import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type,x-dashboard-key",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return reply({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!url || !anon || !service) return reply({ error: "server_configuration" }, 500);

  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const { data: userData, error: userError } = await auth.auth.getUser();
  if (userError || !userData?.user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const [{ data: preference }, { data: signup }] = await Promise.all([
    ops.from("user_preferences").select("user_key,name,role,theme,sounds_enabled,win_sound_enabled,win_celebration_enabled,notifications_enabled,animations_enabled,interface_density,collaborator_person,metadata").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userKey).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = String(preference?.collaborator_person || preference?.name || "").trim();
  if (person !== "Leonardo Augusto" || !(signup || []).length) return reply({ error: "forbidden" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).maybeSingle();
  if (!roster || roster.is_former || String(roster.role) !== "COMMERCIAL") return reply({ error: "forbidden" }, 403);

  const requestUrl = new URL(req.url);
  const view = requestUrl.searchParams.get("view") || "home";

  if (req.method === "POST") {
    if (view !== "preferences") return reply({ error: "forbidden" }, 403);
    const body = await req.json().catch(() => ({}));
    const allowed = ["theme", "sounds_enabled", "win_sound_enabled", "win_celebration_enabled", "notifications_enabled", "animations_enabled", "interface_density"];
    const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
    const { data, error } = await ops.from("user_preferences").update({ ...patch, updated_at: new Date().toISOString() }).eq("user_key", userKey).select().single();
    if (error) return reply({ error: "preferences_update_failed" }, 500);
    return reply({ ok: true, preferences: data });
  }

  if (view !== "home") return reply({ error: "forbidden", scope: "COMMERCIAL_READ_ONLY" }, 403);

  return reply({
    kpis: {},
    clients: [],
    alerts: [],
    commitments: [],
    conversations: [],
    media: {},
    health: { latest_whatsapp_message: null, latest_notion_sync: null, failed_jobs_24h: [], last_jobs: [] },
    operations: { sla: { waiting_agency: [], waiting_client: [], overdue_commitments: [] }, evidence_review: [], task_log: {}, personal_focus: null, design_focus: null },
    clickup: { productivity_30d: [], productivity_daily: [], recent_completed: [], total_completed: 0, last_sync: null, configured: null, webhook_configured: null, indexing: null },
    campaigns: [],
    notifications: [],
    preclients: [],
    won_events: [],
    audit_runs: [],
    audit_issues: [],
    integration_health: [],
    team: [],
    unassigned_clients: [],
    portfolio: null,
    wallets: [],
    adjustments: [],
    stage_labels: {},
    access_requests_pending: [],
    preferences: {
      name: preference?.name || "Leonardo Augusto",
      role: "Direção Comercial",
      theme: preference?.theme || "dark",
      sounds_enabled: preference?.sounds_enabled,
      win_sound_enabled: preference?.win_sound_enabled,
      win_celebration_enabled: preference?.win_celebration_enabled,
      notifications_enabled: preference?.notifications_enabled,
      animations_enabled: preference?.animations_enabled,
      interface_density: preference?.interface_density,
    },
    profile: {
      person: "Leonardo Augusto",
      role: "COMMERCIAL",
      display_role: "Direção Comercial",
      access_level: "COMMERCIAL_READ_ONLY",
      portfolio_scoped: false,
      elevated: false,
      can_decide_access_requests: false,
      can_view_operational_alerts: false,
      can_manage_finance: false,
      is_executive: true,
      locked: false,
      account_approved: true,
      views: ["overview", "clients", "campaigns", "commercial_direction"],
      views_stale: false,
      carteira: null,
      scope_model: "COMMERCIAL_ONLY",
    },
    auth_mode: "login",
    generated_at: new Date().toISOString(),
  });
});
