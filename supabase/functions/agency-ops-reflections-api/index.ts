import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const CATEGORIES = ["FILOSOFIA","BIBLIA","LIDERANCA_NEGOCIOS","CIENCIA_CRIATIVIDADE","LITERATURA_HISTORIA","CULTURA_BRASILEIRA"] as const;
const CATEGORY_SET = new Set<string>(CATEGORIES);
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const clean = (value: unknown) => String(value ?? "").trim();

function saoPauloDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}
function dayIndex(date: string) {
  const [y,m,d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function hash(input: string) {
  let value = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    value ^= input.charCodeAt(i);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}
function audienceMatches(row: Row, person: string, role: string) {
  const roles = Array.isArray(row.target_roles) ? row.target_roles.map((v: unknown) => clean(v).toUpperCase()) : [];
  const people = Array.isArray(row.target_people) ? row.target_people.map(clean) : [];
  if (!roles.length && !people.length) return true;
  return roles.includes(role.toUpperCase()) || people.includes(person);
}
function chooseDaily(rows: Row[], today: string, person: string, role: string) {
  const eligible = rows.filter((row) => row.active && row.verified && !row.deleted_at && audienceMatches(row, person, role));
  const exact = eligible.filter((row) => row.scheduled_date === today);
  if (exact.length) return [...exact].sort((a,b) => Number(a.priority ?? 100) - Number(b.priority ?? 100) || String(a.id).localeCompare(String(b.id)))[0];

  const annual = eligible.filter((row) => row.recurs_annually && row.scheduled_date && String(row.scheduled_date).slice(5) === today.slice(5));
  if (annual.length) return [...annual].sort((a,b) => Number(a.priority ?? 100) - Number(b.priority ?? 100) || String(a.id).localeCompare(String(b.id)))[0];

  const general = eligible.filter((row) => !row.scheduled_date);
  if (!general.length) return null;
  const availableCategories = CATEGORIES.filter((category) => general.some((row) => row.category === category));
  if (!availableCategories.length) return null;
  const category = availableCategories[Math.abs(dayIndex(today)) % availableCategories.length];
  const pool = general.filter((row) => row.category === category)
    .sort((a,b) => Number(a.priority ?? 100) - Number(b.priority ?? 100) || String(a.id).localeCompare(String(b.id)));
  return pool[hash(today) % pool.length] || null;
}

async function identify(req: Request) {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const authHeader = req.headers.get("Authorization") || "";
  if (!url || !anon || !service || !authHeader.startsWith("Bearer ")) return null;

  const auth = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData?.user) return null;

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref, error: prefError } = await ops.from("user_preferences")
    .select("user_key,name,role,collaborator_person,metadata")
    .eq("user_key", userData.user.id)
    .maybeSingle();
  if (prefError || !pref) return null;

  const person = clean(pref.collaborator_person || pref.name);
  const { data: roster } = person
    ? await ops.from("team_roster").select("person,role,access_level,is_former").eq("person", person).maybeSingle()
    : { data: null };
  const role = clean(roster?.role || pref.role).toUpperCase();
  const canManage = Boolean(roster && roster.is_former === false && role === "MGMT");
  return { user: userData.user, db, ops, pref, person, role, canManage };
}

async function loadDaily(ctx: any) {
  const today = saoPauloDate();
  const { data: rows, error } = await ctx.ops.from("daily_reflections")
    .select("*")
    .eq("active", true)
    .eq("verified", true)
    .is("deleted_at", null);
  if (error) throw error;
  const reflection = chooseDaily(rows || [], today, ctx.person, ctx.role);
  return {
    ok: true,
    server_date: today,
    timezone: "America/Sao_Paulo",
    hidden: ctx.pref?.metadata?.daily_reflection_hidden === true,
    can_manage: ctx.canManage,
    reflection,
  };
}

async function loadManager(ctx: any) {
  if (!ctx.canManage) return reply({ error: "not_found" }, 404);
  const [{ data: rows, error }, { data: roster, error: rosterError }] = await Promise.all([
    ctx.ops.from("daily_reflections").select("*").order("deleted_at", { ascending: true, nullsFirst: true }).order("created_at", { ascending: false }),
    ctx.ops.from("team_roster").select("person,role").eq("is_former", false).order("person"),
  ]);
  if (error) throw error;
  if (rosterError) throw rosterError;
  return reply({
    ok: true,
    categories: CATEGORIES,
    roles: [...new Set((roster || []).map((row: Row) => clean(row.role)).filter(Boolean))].sort(),
    people: (roster || []).map((row: Row) => clean(row.person)).filter(Boolean),
    reflections: rows || [],
    server_date: saoPauloDate(),
  });
}

function normalizeQuote(body: Row) {
  const quoteText = clean(body.quote_text);
  const author = clean(body.author);
  const category = clean(body.category).toUpperCase();
  if (quoteText.length < 3 || quoteText.length > 420) throw new Error("quote_length");
  if (author.length < 2 || author.length > 120) throw new Error("author_invalid");
  if (!CATEGORY_SET.has(category)) throw new Error("category_invalid");

  const scheduled = clean(body.scheduled_date);
  if (scheduled && !/^\d{4}-\d{2}-\d{2}$/.test(scheduled)) throw new Error("scheduled_date_invalid");
  const strings = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))].slice(0, 100) : [];
  return {
    quote_text: quoteText,
    author,
    source_reference: clean(body.source_reference) || null,
    source_url: clean(body.source_url) || null,
    category,
    verified: body.verified === true,
    active: body.active !== false,
    scheduled_date: scheduled || null,
    recurs_annually: body.recurs_annually === true,
    target_roles: strings(body.target_roles),
    target_people: strings(body.target_people),
    priority: Math.min(1000, Math.max(0, Number.isFinite(Number(body.priority)) ? Number(body.priority) : 100)),
    notes: clean(body.notes) || null,
    updated_at: new Date().toISOString(),
  };
}

async function setHidden(ctx: any, hidden: boolean) {
  const metadata = { ...(ctx.pref?.metadata || {}), daily_reflection_hidden: hidden };
  const { error } = await ctx.ops.from("user_preferences").update({ metadata, updated_at: new Date().toISOString() }).eq("user_key", ctx.user.id);
  if (error) throw error;
  return reply({ ok: true, hidden });
}

async function saveQuote(ctx: any, body: Row) {
  if (!ctx.canManage) return reply({ error: "not_found" }, 404);
  const row = { ...normalizeQuote(body), updated_by: ctx.user.id, deleted_at: null };
  const id = clean(body.id);
  if (id) {
    const { data, error } = await ctx.ops.from("daily_reflections").update(row).eq("id", id).select("*").maybeSingle();
    if (error) throw error;
    if (!data) return reply({ error: "reflection_not_found" }, 404);
    return reply({ ok: true, reflection: data });
  }
  const { data, error } = await ctx.ops.from("daily_reflections")
    .insert({ ...row, created_by: ctx.user.id })
    .select("*")
    .single();
  if (error) throw error;
  return reply({ ok: true, reflection: data }, 201);
}

async function removeQuote(ctx: any, id: string) {
  if (!ctx.canManage) return reply({ error: "not_found" }, 404);
  if (!id) return reply({ error: "id_required" }, 400);
  const now = new Date().toISOString();
  const { data, error } = await ctx.ops.from("daily_reflections")
    .update({ active: false, deleted_at: now, updated_at: now, updated_by: ctx.user.id })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw error;
  if (!data) return reply({ error: "reflection_not_found" }, 404);
  return reply({ ok: true, id });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!["GET","POST"].includes(req.method)) return reply({ error: "method_not_allowed" }, 405);
  try {
    const ctx = await identify(req);
    if (!ctx) return reply({ error: "unauthorized" }, 401);

    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.get("manage") === "1") return await loadManager(ctx);
      return reply(await loadDaily(ctx));
    }

    const body = await req.json().catch(() => ({})) as Row;
    const action = clean(body.action);
    if (action === "set_hidden") return await setHidden(ctx, body.hidden === true);
    if (action === "save_quote") return await saveQuote(ctx, body);
    if (action === "remove_quote") return await removeQuote(ctx, clean(body.id));
    return reply({ error: "invalid_action" }, 400);
  } catch (error) {
    console.error("[daily-reflections]", error);
    return reply({ error: "daily_reflections_failed", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
