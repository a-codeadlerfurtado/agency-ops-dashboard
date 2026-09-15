import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALL_VIEWS = [
  "overview","focus","work","clients","creative","health","onboarding","campaigns",
  "preclients","conversations","team","diary","clickup","evidence","audit","alerts",
  "opsperf","finance","executive"
];
const VIEW_LABELS: Record<string,string> = {
  overview:"Visão geral", focus:"Foco do dia", work:"Central de Trabalho", clients:"Clientes",
  creative:"Central Criativa", health:"Saúde", onboarding:"Onboarding", campaigns:"Campanhas",
  preclients:"Pré-clientes", conversations:"Conversas", team:"Equipe", diary:"Diário",
  clickup:"ClickUp", evidence:"Evidências", audit:"Auditoria", alerts:"Alertas",
  opsperf:"Desempenho OP", finance:"Financeiro", executive:"Executivo"
};
const ROLES = new Set(["GT","CS","DESIGN","AI","MGMT","COMMERCIAL"]);
const ACCESS_LEVELS = new Set(["FULL","WALLET_ONLY","RESTRICTED"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type":"application/json; charset=utf-8", "cache-control":"no-store" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!["GET","POST"].includes(req.method)) return json({ ok:false, error:"method_not_allowed" }, 405);

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ ok:false, error:"unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth:{ persistSession:false, autoRefreshToken:false } });
  const ops = admin.schema("agency_ops");
  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const requester = authData?.user;
  if (authError || !requester) return json({ ok:false, error:"unauthorized" }, 401);

  const { data: pref } = await ops.from("user_preferences")
    .select("user_key,collaborator_person,email")
    .eq("user_key", requester.id)
    .maybeSingle();
  const requesterPerson = pref?.collaborator_person || null;
  if (requesterPerson !== "Adler Furtado") return json({ ok:false, error:"forbidden" }, 403);

  const { data: requesterRoster } = await ops.from("team_roster")
    .select("person,role")
    .eq("person", "Adler Furtado")
    .maybeSingle();
  if (requesterRoster?.role !== "MGMT") return json({ ok:false, error:"forbidden" }, 403);

  async function audit(action:string, entityId:string, before:unknown, after:unknown) {
    await ops.from("audit_events").insert({
      actor:"Adler Furtado", action, entity:"team_profile", entity_id:entityId, before, after
    });
  }

  async function ensureCentralBrain() {
    await ops.from("team_roster").update({
      role:"MGMT", access_level:"FULL", is_former:false, updated_at:new Date().toISOString()
    }).eq("person", "Adler Furtado");

    await ops.from("dashboard_view_permissions").upsert(
      ALL_VIEWS.map((view_key) => ({
        view_key, scope_type:"PERSON", scope_value:"Adler Furtado", allowed:true,
        note:"Cérebro central: acesso total e permanente do Adler", updated_at:new Date().toISOString()
      })),
      { onConflict:"view_key,scope_type,scope_value" }
    );

    const { data: elevated } = await ops.from("access_requests")
      .select("id")
      .eq("user_key", requester.id)
      .eq("kind", "ELEVATION")
      .eq("status", "APPROVED")
      .limit(1);
    if (!elevated?.length) {
      await ops.from("access_requests").insert({
        user_key: requester.id,
        person:"Adler Furtado",
        status:"APPROVED",
        requested_at:new Date().toISOString(),
        decided_at:new Date().toISOString(),
        decided_by:"Adler Furtado",
        note:"Acesso elevado permanente do cérebro central",
        kind:"ELEVATION"
      });
    }
  }

  await ensureCentralBrain();

  if (req.method === "POST") {
    let body:any;
    try { body = await req.json(); } catch { return json({ ok:false, error:"invalid_json" }, 400); }
    const action = String(body?.action || "");
    const person = String(body?.person || "").trim();
    if (!person) return json({ ok:false, error:"missing_person" }, 400);

    const { data: current } = await ops.from("team_roster").select("*").eq("person", person).maybeSingle();
    if (!current) return json({ ok:false, error:"profile_not_found" }, 404);

    if (action === "UPDATE_PROFILE") {
      if (person === "Adler Furtado") return json({ ok:false, error:"central_brain_locked" }, 409);
      const role = String(body?.role || current.role).toUpperCase();
      const accessLevel = String(body?.access_level || current.access_level).toUpperCase();
      const isFormer = Boolean(body?.is_former);
      if (!ROLES.has(role)) return json({ ok:false, error:"invalid_role" }, 400);
      if (!ACCESS_LEVELS.has(accessLevel)) return json({ ok:false, error:"invalid_access_level" }, 400);
      const patch = { role, access_level:accessLevel, is_former:isFormer, updated_at:new Date().toISOString() };
      const result = await ops.from("team_roster").update(patch).eq("person", person).select().single();
      if (result.error) return json({ ok:false, error:"update_failed", detail:result.error.message }, 500);
      await audit("TEAM_PROFILE_UPDATED", person, { role:current.role, access_level:current.access_level, is_former:current.is_former }, patch);
      return json({ ok:true });
    }

    if (action === "SET_VIEW") {
      const viewKey = String(body?.view_key || "");
      if (!ALL_VIEWS.includes(viewKey)) return json({ ok:false, error:"invalid_view" }, 400);
      if (person === "Adler Furtado" && body?.allowed !== true) return json({ ok:false, error:"central_brain_locked" }, 409);
      const allowed = Boolean(body?.allowed);
      const { data: before } = await ops.from("dashboard_view_permissions")
        .select("allowed,note").eq("view_key",viewKey).eq("scope_type","PERSON").eq("scope_value",person).maybeSingle();
      const result = await ops.from("dashboard_view_permissions").upsert({
        view_key:viewKey, scope_type:"PERSON", scope_value:person, allowed,
        note:"Definido pela Central de Perfis", updated_at:new Date().toISOString()
      }, { onConflict:"view_key,scope_type,scope_value" });
      if (result.error) return json({ ok:false, error:"permission_update_failed", detail:result.error.message }, 500);
      await audit("TEAM_VIEW_PERMISSION_SET", person, { view_key:viewKey, override:before ?? null }, { view_key:viewKey, allowed });
      return json({ ok:true });
    }

    if (action === "CLEAR_VIEW_OVERRIDE") {
      const viewKey = String(body?.view_key || "");
      if (!ALL_VIEWS.includes(viewKey)) return json({ ok:false, error:"invalid_view" }, 400);
      if (person === "Adler Furtado") return json({ ok:false, error:"central_brain_locked" }, 409);
      const result = await ops.from("dashboard_view_permissions").delete()
        .eq("view_key",viewKey).eq("scope_type","PERSON").eq("scope_value",person);
      if (result.error) return json({ ok:false, error:"permission_clear_failed", detail:result.error.message }, 500);
      await audit("TEAM_VIEW_OVERRIDE_CLEARED", person, { view_key:viewKey }, { inherited:true });
      return json({ ok:true });
    }

    if (action === "RESET_VIEWS_TO_ROLE") {
      if (person === "Adler Furtado") return json({ ok:false, error:"central_brain_locked" }, 409);
      const result = await ops.from("dashboard_view_permissions").delete()
        .eq("scope_type","PERSON").eq("scope_value",person);
      if (result.error) return json({ ok:false, error:"permissions_reset_failed", detail:result.error.message }, 500);
      await audit("TEAM_VIEW_PERMISSIONS_RESET_TO_ROLE", person, null, { inherited_from_role:true });
      return json({ ok:true });
    }

    if (action === "SET_ELEVATED" || action === "SET_ACCOUNT_APPROVED") {
      if (person === "Adler Furtado" && body?.enabled !== true) return json({ ok:false, error:"central_brain_locked" }, 409);
      const kind = action === "SET_ELEVATED" ? "ELEVATION" : "SIGNUP";
      const enabled = Boolean(body?.enabled);
      const { data: userPref } = await ops.from("user_preferences")
        .select("user_key").eq("collaborator_person", person).maybeSingle();
      if (!userPref?.user_key) return json({ ok:false, error:"profile_has_no_login" }, 409);
      if (enabled) {
        const { data: existing } = await ops.from("access_requests").select("id")
          .eq("user_key",userPref.user_key).eq("kind",kind).eq("status","APPROVED").limit(1);
        if (!existing?.length) {
          const result = await ops.from("access_requests").insert({
            user_key:userPref.user_key, person, status:"APPROVED", requested_at:new Date().toISOString(),
            decided_at:new Date().toISOString(), decided_by:"Adler Furtado",
            note:"Definido pela Central de Perfis", kind
          });
          if (result.error) return json({ ok:false, error:"access_grant_failed", detail:result.error.message }, 500);
        }
      } else {
        const result = await ops.from("access_requests").update({
          status:"DENIED", decided_at:new Date().toISOString(), decided_by:"Adler Furtado",
          note:"Revogado pela Central de Perfis"
        }).eq("user_key",userPref.user_key).eq("kind",kind).eq("status","APPROVED");
        if (result.error) return json({ ok:false, error:"access_revoke_failed", detail:result.error.message }, 500);
      }
      await audit(kind === "ELEVATION" ? "TEAM_ELEVATION_CHANGED" : "TEAM_ACCOUNT_APPROVAL_CHANGED", person, null, { enabled });
      return json({ ok:true });
    }

    return json({ ok:false, error:"invalid_action" }, 400);
  }

  const [rosterRes, rulesRes, prefsRes, accessRes] = await Promise.all([
    ops.from("team_roster").select("person,role,access_level,email,clickup_user,is_former,updated_at").order("is_former").order("role").order("person"),
    ops.from("dashboard_view_permissions").select("view_key,scope_type,scope_value,allowed,note,updated_at"),
    ops.from("user_preferences").select("user_key,collaborator_person,email,name"),
    ops.from("access_requests").select("user_key,person,kind,status,requested_at,decided_at").order("requested_at",{ascending:false}),
  ]);
  if (rosterRes.error || rulesRes.error) return json({ ok:false, error:"load_failed" }, 500);

  const roster = rosterRes.data || [];
  const rules = rulesRes.data || [];
  const prefs = prefsRes.data || [];
  const access = accessRes.data || [];

  const authUsers:any[] = [];
  for (let page=1; page<=10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage:100 });
    if (error) break;
    authUsers.push(...data.users);
    if (data.users.length < 100) break;
  }
  const authByEmail = new Map(authUsers.map((u:any) => [String(u.email || "").toLowerCase(), u]));
  const prefByPerson = new Map(prefs.filter((p:any) => p.collaborator_person).map((p:any) => [p.collaborator_person,p]));

  const roleRules = new Map<string,Map<string,boolean>>();
  const personRules = new Map<string,Map<string,boolean>>();
  for (const rule of rules as any[]) {
    const target = rule.scope_type === "ROLE" ? roleRules : personRules;
    const map = target.get(rule.scope_value) || new Map<string,boolean>();
    map.set(rule.view_key, Boolean(rule.allowed));
    target.set(rule.scope_value, map);
  }

  const profiles = roster.map((row:any) => {
    const prefRow:any = prefByPerson.get(row.person) || null;
    const userKey = prefRow?.user_key || null;
    const roleMap = roleRules.get(row.role) || new Map<string,boolean>();
    const personMap = personRules.get(row.person) || new Map<string,boolean>();
    const email = String(row.email || prefRow?.email || "").toLowerCase();
    const authUser:any = email ? authByEmail.get(email) : null;
    const approvals = access.filter((a:any) => userKey && a.user_key === userKey && a.status === "APPROVED");
    const locked = row.person === "Adler Furtado";
    return {
      person:row.person, role:row.role, access_level:row.access_level, email:row.email,
      clickup_user:row.clickup_user, is_former:row.is_former, updated_at:row.updated_at,
      user_key:userKey,
      account_approved: locked || approvals.some((a:any) => a.kind === "SIGNUP"),
      elevated: locked || approvals.some((a:any) => a.kind === "ELEVATION"),
      auth:{
        exists:Boolean(authUser), user_id:authUser?.id || null,
        last_sign_in_at:authUser?.last_sign_in_at || null,
        email_confirmed_at:authUser?.email_confirmed_at || null,
      },
      system_locked:locked,
      views:ALL_VIEWS.map((key) => {
        const hasPerson = personMap.has(key);
        const roleAllowed = roleMap.get(key) ?? false;
        const allowed = locked ? true : (hasPerson ? Boolean(personMap.get(key)) : roleAllowed);
        return {
          key, label:VIEW_LABELS[key] || key, allowed,
          source: locked ? "SYSTEM" : (hasPerson ? "PERSON" : "ROLE"),
          role_allowed:roleAllowed,
          person_override:hasPerson ? Boolean(personMap.get(key)) : null,
        };
      }),
    };
  });

  return json({
    ok:true,
    actor:{ person:"Adler Furtado", central_brain:true },
    profiles,
    roles:["GT","CS","DESIGN","AI","MGMT","COMMERCIAL"],
    access_levels:["FULL","WALLET_ONLY","RESTRICTED"],
    generated_at:new Date().toISOString(),
  });
});
