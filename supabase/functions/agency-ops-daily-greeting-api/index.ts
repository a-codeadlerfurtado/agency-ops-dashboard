import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

const AUDIO_VERSION = "20260822-full-v5-22s";
const AUDIO_DURATION_SECONDS = 22.77;

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function saoPauloToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await auth.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return respond({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences")
      .select("name,role,collaborator_person")
      .eq("user_key", user.id)
      .maybeSingle(),
    ops.from("access_requests")
      .select("id")
      .eq("user_key", user.id)
      .eq("kind", "SIGNUP")
      .eq("status", "APPROVED")
      .limit(1),
  ]);

  if (!(approvals ?? []).length) return respond({ error: "forbidden" }, 403);

  const person = String(pref?.collaborator_person || pref?.name || user.user_metadata?.name || user.email?.split("@")[0] || "Equipe").trim();
  const role = String(pref?.role || "").trim();
  const firstName = person.split(/\s+/)[0] || "Equipe";
  const today = saoPauloToday();
  const normalMonday = today.weekday === "Monday";
  const adlerTest = person === "Adler Furtado";
  const forceAudio = normalMonday || adlerTest;
  const loginAt = String(user.last_sign_in_at || user.updated_at || "");

  if (adlerTest) {
    const { data: existing, error: existingError } = await ops.from("daily_user_greetings")
      .select("user_key,greeting_date,shown_at,metadata")
      .eq("user_key", user.id)
      .eq("greeting_date", today.date)
      .maybeSingle();
    if (existingError) return respond({ error: "query_failed", detail: existingError.message }, 500);

    const previousLoginAt = String(existing?.metadata?.adler_test_login_at || "");
    if (existing && previousLoginAt === loginAt && loginAt) {
      return respond({ ok: true, show: false, date: today.date, already_shown_for_login: true, test_mode: "ADLER_EVERY_LOGIN" });
    }

    const metadata = {
      ...(existing?.metadata || {}),
      timezone: "America/Sao_Paulo",
      source: "dashboard_first_daily_access",
      test_mode: "ADLER_EVERY_LOGIN",
      adler_test_login_at: loginAt,
      audio_version: AUDIO_VERSION,
      audio_duration_seconds: AUDIO_DURATION_SECONDS,
    };

    const { error: writeError } = await ops.from("daily_user_greetings").upsert({
      user_key: user.id,
      greeting_date: today.date,
      person,
      role,
      shown_at: new Date().toISOString(),
      is_monday: true,
      audio_expected: true,
      metadata,
    }, { onConflict: "user_key,greeting_date" });
    if (writeError) return respond({ error: "claim_failed", detail: writeError.message }, 500);

    return respond({
      ok: true,
      show: true,
      date: today.date,
      weekday: today.weekday,
      is_monday: true,
      person,
      first_name: firstName,
      role,
      audio_duration_seconds: AUDIO_DURATION_SECONDS,
      audio_version: AUDIO_VERSION,
      test_mode: "ADLER_EVERY_LOGIN",
      login_at: loginAt,
    });
  }

  const { data: inserted, error: insertError } = await ops.from("daily_user_greetings")
    .insert({
      user_key: user.id,
      greeting_date: today.date,
      person,
      role,
      is_monday: normalMonday,
      audio_expected: normalMonday,
      metadata: {
        timezone: "America/Sao_Paulo",
        source: "dashboard_first_daily_access",
        audio_version: forceAudio ? AUDIO_VERSION : null,
        audio_duration_seconds: forceAudio ? AUDIO_DURATION_SECONDS : null,
      },
    })
    .select("user_key,greeting_date,shown_at,is_monday")
    .maybeSingle();

  if (insertError) {
    if (String((insertError as any).code || "") === "23505") {
      return respond({ ok: true, show: false, date: today.date, already_shown: true });
    }
    return respond({ error: "claim_failed", detail: insertError.message }, 500);
  }

  return respond({
    ok: true,
    show: Boolean(inserted),
    date: today.date,
    weekday: today.weekday,
    is_monday: normalMonday,
    person,
    first_name: firstName,
    role,
    audio_duration_seconds: forceAudio ? AUDIO_DURATION_SECONDS : null,
    audio_version: forceAudio ? AUDIO_VERSION : null,
  });
});
