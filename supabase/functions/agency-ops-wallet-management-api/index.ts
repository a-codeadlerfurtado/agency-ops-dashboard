import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const hidden = () => reply({ error: "not_found" }, 404);
const clean = (value: unknown) => String(value ?? "").trim();

async function identifyAdler(req: Request) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anon || !service) return null;
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const auth = createClient(supabaseUrl, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData } = await auth.auth.getUser();
  if (!userData?.user) return null;
  const db = createClient(supabaseUrl, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userData.user.id).maybeSingle(),
    ops.from("access_requests").select("id").eq("user_key", userData.user.id).eq("kind", "SIGNUP").eq("status", "APPROVED").limit(1),
  ]);
  const person = clean(pref?.collaborator_person || pref?.name);
  if (person !== "Adler Furtado" || !(approvals || []).length) return null;
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster || clean(roster.role).toUpperCase() !== "MGMT") return null;
  return { db, ops, person };
}

async function loadBoard(ctx: any) {
  const [{ data: clients, error: cErr }, { data: roster, error: rErr }, { data: wallets, error: wErr }, { data: history, error: hErr }] = await Promise.all([
    ctx.ops.from("dashboard_client_overview").select("client_id,display_name,lifecycle,gt_owner,cs_owner,priority,entrada").in("lifecycle", ["ACTIVE", "ONBOARDING"]).order("display_name"),
    ctx.ops.from("team_roster").select("person,role,is_former,email").eq("role", "GT").eq("is_former", false).not("email", "is", null).neq("email", "").order("person"),
    ctx.ops.from("wallet_registry").select("gt_owner,carteira,ordem,criada_em").order("ordem"),
    ctx.ops.from("client_lifecycle_events").select("id,client_id,event_type,occurred_at,actor,before_value,after_value,detail").eq("source", "dashboard_wallet_management").order("occurred_at", { ascending: false }).limit(60),
  ]);
  const first = cErr || rErr || wErr || hErr;
  if (first) throw first;
  const walletMap = new Map((wallets || []).map((row: Row) => [clean(row.gt_owner), row]));
  const managers = (roster || []).map((row: Row) => ({ person: row.person, ...(walletMap.get(clean(row.person)) || {}) }));
  return { clients: clients || [], managers, history: history || [], generated_at: new Date().toISOString() };
}
async function moveClient(ctx: any, body: Row) {
  const clientId = clean(body.client_id);
  const targetGt = clean(body.gt_owner) || null;
  if (!clientId) return reply({ error: "client_required" }, 400);
  const { data: client, error: cErr } = await ctx.ops.from("clients").select("id,display_name,lifecycle,gt_owner").eq("id", clientId).maybeSingle();
  if (cErr) throw cErr;
  if (!client || !["ACTIVE", "ONBOARDING"].includes(clean(client.lifecycle))) return reply({ error: "client_not_available" }, 404);
  if (targetGt) {
    const { data: gt, error: gtErr } = await ctx.ops.from("team_roster").select("person,email").eq("person", targetGt).eq("role", "GT").eq("is_former", false).not("email", "is", null).neq("email", "").maybeSingle();
    if (gtErr) throw gtErr;
    if (!gt) return reply({ error: "gt_not_available" }, 409);
  }
  const oldGt = clean(client.gt_owner) || null;
  if (oldGt === targetGt) return reply({ ok: true, unchanged: true, client_id: clientId, gt_owner: targetGt });
  const now = new Date().toISOString();
  const { data: existing, error: aErr } = await ctx.ops.from("gt_assignments").select("id,notes").eq("client_id", clientId).maybeSingle();
  if (aErr) throw aErr;
  const assignment: Row = {
    client_id: clientId,
    client_name: client.display_name,
    gt_owner: targetGt,
    assignment_status: targetGt ? "ASSIGNED" : "UNASSIGNED",
    human_confirmed: true,
    evidence_type: "dashboard_wallet_management",
    evidence_text: targetGt ? `Carteira alterada manualmente por ${ctx.person} para ${targetGt}.` : `Cliente removido de carteira manualmente por ${ctx.person}.`,
    evidence_ref: `wallet-management:${Date.now()}`,
    assigned_by: ctx.person,
    assigned_at: now,
    updated_at: now,
  };
  assignment.notes = [clean(existing?.notes), targetGt ? `Remanejado para ${targetGt} via Gestão de carteiras.` : "Removido de carteira via Gestão de carteiras."].filter(Boolean).join(" | ");
  let writeError: any = null;
  if (existing?.id) {
    const result = await ctx.ops.from("gt_assignments").update(assignment).eq("id", existing.id);
    writeError = result.error;
  } else {
    const { data: byName, error: nErr } = await ctx.ops.from("gt_assignments").select("id,notes").eq("client_name", client.display_name).maybeSingle();
    if (nErr) throw nErr;
    if (byName?.id) {
      assignment.notes = [clean(byName.notes), clean(assignment.notes)].filter(Boolean).join(" | ");
      const result = await ctx.ops.from("gt_assignments").update(assignment).eq("id", byName.id);
      writeError = result.error;
    } else {
      const result = await ctx.ops.from("gt_assignments").insert(assignment);
      writeError = result.error;
    }
  }
  if (writeError) throw writeError;
  const [{ data: confirmed, error: confirmErr }, { data: oldWallet }, { data: newWallet }] = await Promise.all([
    ctx.ops.from("clients").select("id,display_name,lifecycle,gt_owner").eq("id", clientId).maybeSingle(),
    oldGt ? ctx.ops.from("wallet_registry").select("carteira").eq("gt_owner", oldGt).maybeSingle() : Promise.resolve({ data: null }),
    targetGt ? ctx.ops.from("wallet_registry").select("carteira").eq("gt_owner", targetGt).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  if (confirmErr) throw confirmErr;
  if ((clean(confirmed?.gt_owner) || null) !== targetGt) throw new Error("assignment_not_applied");
  const eventType = targetGt ? (oldGt ? "GT_REASSIGNED" : "GT_ASSIGNED") : "GT_UNASSIGNED";
  const detail = targetGt
    ? `${client.display_name}: ${oldGt || "sem carteira"} → ${targetGt}${newWallet?.carteira ? ` · Carteira ${newWallet.carteira}` : ""}.`
    : `${client.display_name}: removido da carteira de ${oldGt || "GT não identificado"}.`;
  const { error: historyError } = await ctx.ops.from("client_lifecycle_events").insert({
    event_key: `wallet:gt:${clientId}:${Date.now()}`,
    client_id: clientId,
    event_type: eventType,
    occurred_at: now,
    source: "dashboard_wallet_management",
    actor: ctx.person,
    before_value: { gt_owner: oldGt, carteira: oldWallet?.carteira || null },
    after_value: { gt_owner: targetGt, carteira: newWallet?.carteira || null },
    detail,
  });
  if (historyError) throw historyError;
  return reply({ ok: true, client: confirmed, event_type: eventType, detail });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET", "POST"].includes(req.method)) return hidden();
  try {
    const ctx = await identifyAdler(req);
    if (!ctx) return hidden();
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("probe") === "1") return reply({ ok: true, can_manage_wallets: true });
      return reply({ ok: true, ...(await loadBoard(ctx)) });
    }
    const body = await req.json().catch(() => ({}));
    return await moveClient(ctx, body as Row);
  } catch (error) {
    console.error("[wallet-management]", error);
    return reply({ error: "wallet_management_failed", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});

