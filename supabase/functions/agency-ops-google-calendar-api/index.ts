import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET") || "";
const WORKER_TOKEN_SHA256 = "48a435ee5c28bb73b44aeacfb8308da0f115979eda14ec9616fce4f493a5515a";
const REDIRECT_URI = Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI") || `${SUPABASE_URL}/functions/v1/agency-ops-google-calendar-api`;
const DASHBOARD_URL = Deno.env.get("MEETING_DASHBOARD_URL") || "https://agency-ops-dashboard.lakassessoriadigital.workers.dev";
const SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/calendar.events"];
const ops = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false }, db: { schema: "agency_ops" } });
const sleep = (ms:number) => new Promise((r) => setTimeout(r, ms));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type,x-agency-worker-token", "access-control-allow-methods": "GET,POST,OPTIONS" } });
}
function clean(v: unknown, n = 300) { return String(v ?? "").trim().slice(0, n); }
function b64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, ""); }
function randomToken(size = 32) { const b = new Uint8Array(size); crypto.getRandomValues(b); return b64url(b); }
async function sha256(v: string) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)); return [...new Uint8Array(d)].map((b)=>b.toString(16).padStart(2,"0")).join(""); }
async function pkceChallenge(v: string) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)); return b64url(new Uint8Array(d)); }
async function dashboardPerson(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  const auth = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data } = await auth.auth.getUser();
  if (!data?.user?.id) return null;
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person,name").eq("user_key", data.user.id).maybeSingle();
  const person = clean(pref?.collaborator_person || pref?.name, 160);
  if (!person) return null;
  const { data: roster } = await ops.from("team_roster").select("person,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  return roster ? person : null;
}
async function workerAuthorized(req: Request) {
  const token = req.headers.get("x-agency-worker-token") || "";
  return token.length >= 32 && await sha256(token) === WORKER_TOKEN_SHA256;
}
async function secret(id: string | null | undefined) {
  if (!id) return "";
  const { data, error } = await ops.rpc("get_meeting_integration_secret", { p_secret_id: id });
  if (error) throw error;
  return clean(data, 10000);
}
async function setSecret(accountId: string, kind: string, value: string) {
  const { data, error } = await ops.rpc("set_meeting_integration_secret", { p_account_id: accountId, p_kind: kind, p_value: value });
  if (error) throw error;
  return String(data);
}
function googleConfigured() { return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET); }
async function startOauth(req: Request) {
  const person = await dashboardPerson(req);
  if (!person) return json({ error: "unauthorized" }, 401);
  if (!googleConfigured()) return json({ error: "google_oauth_not_configured" }, 503);
  const { data: row, error } = await ops.from("meeting_integration_accounts").upsert({ owner_person: person, provider_key: "GOOGLE_WORKSPACE", account_slot: "primary", status: "CONNECTING", updated_at: new Date().toISOString() }, { onConflict: "owner_person,provider_key,account_slot" }).select("id").single();
  if (error) throw error;
  const state = randomToken(32);
  const verifier = randomToken(48);
  const verifierSecret = await setSecret(row.id, "pkce", verifier);
  const stateHash = await sha256(state);
  const { error: stateError } = await ops.from("meeting_oauth_states").insert({ owner_person: person, provider_key: "GOOGLE_WORKSPACE", state_hash: stateHash, code_verifier_secret_id: verifierSecret, redirect_uri: REDIRECT_URI, requested_scopes: SCOPES, expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });
  if (stateError) throw stateError;
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SCOPES.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", await pkceChallenge(verifier));
  u.searchParams.set("code_challenge_method", "S256");
  return json({ ok: true, url: u.toString(), person });
}
async function oauthCallback(url: URL) {
  const code = clean(url.searchParams.get("code"), 2000);
  const state = clean(url.searchParams.get("state"), 2000);
  if (!code || !state) return new Response("OAuth inválido", { status: 400 });
  const stateHash = await sha256(state);
  const { data: st } = await ops.from("meeting_oauth_states").select("*").eq("state_hash", stateHash).is("used_at", null).gt("expires_at", new Date().toISOString()).maybeSingle();
  if (!st) return new Response("OAuth expirado ou já utilizado", { status: 400 });
  const verifier = await secret(st.code_verifier_secret_id);
  const form = new URLSearchParams({ code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: st.redirect_uri, grant_type: "authorization_code", code_verifier: verifier });
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const token = await tokenRes.json();
  if (!tokenRes.ok || !token.access_token) return new Response("Falha ao conectar Google", { status: 400 });
  const userRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token.access_token}` } });
  const user = await userRes.json();
  const { data: account, error } = await ops.from("meeting_integration_accounts").upsert({ owner_person: st.owner_person, provider_key: "GOOGLE_WORKSPACE", account_slot: "primary", external_account_id: clean(user.sub, 300), account_email: clean(user.email, 320), display_name: clean(user.name, 200), status: "ACTIVE", granted_scopes: String(token.scope || "").split(" ").filter(Boolean), enabled_capabilities: ["CALENDAR_WRITE","MEET_CONTEXT"], token_expires_at: new Date(Date.now() + Number(token.expires_in || 3600) * 1000).toISOString(), last_error: null, updated_at: new Date().toISOString() }, { onConflict: "owner_person,provider_key,account_slot" }).select("*").single();
  if (error) throw error;
  const accessId = await setSecret(account.id, "access", String(token.access_token));
  let refreshId = account.refresh_secret_id;
  if (token.refresh_token) refreshId = await setSecret(account.id, "refresh", String(token.refresh_token));
  await ops.from("meeting_integration_accounts").update({ access_secret_id: accessId, refresh_secret_id: refreshId, status: "ACTIVE", updated_at: new Date().toISOString() }).eq("id", account.id);
  await ops.from("meeting_oauth_states").update({ used_at: new Date().toISOString() }).eq("id", st.id);
  return new Response(`<html><body style="font-family:system-ui;padding:32px"><h2>Google conectado ✓</h2><p>${clean(user.email,320)}</p><p>Você pode fechar esta janela.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
async function accessTokenFor(account: any) {
  const expires = account.token_expires_at ? new Date(account.token_expires_at).getTime() : 0;
  if (account.access_secret_id && expires > Date.now() + 60_000) return await secret(account.access_secret_id);
  const refresh = await secret(account.refresh_secret_id);
  if (!refresh) throw new Error("google_reconnect_required");
  const form = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const body = await res.json();
  if (!res.ok || !body.access_token) throw new Error("google_refresh_failed");
  const accessId = await setSecret(account.id, "access", String(body.access_token));
  await ops.from("meeting_integration_accounts").update({ access_secret_id: accessId, token_expires_at: new Date(Date.now() + Number(body.expires_in || 3600) * 1000).toISOString(), status: "ACTIVE", last_error: null, updated_at: new Date().toISOString() }).eq("id", account.id);
  return String(body.access_token);
}
async function resolveAttendees(names: string[], emails: string[]) {
  const found = new Set(emails.map((x)=>clean(x,320).toLowerCase()).filter((x)=>x.includes("@")));
  const unresolved: string[] = [];
  for (const raw of names.slice(0,20)) {
    const name = clean(raw,160);
    if (!name) continue;
    const { data: team } = await ops.from("team_identity_map").select("person,email").ilike("person", `%${name}%`).not("email","is",null).limit(2);
    if (team?.length === 1 && team[0].email) { found.add(String(team[0].email).toLowerCase()); continue; }
    const { data: participant } = await ops.from("meeting_capture_participants").select("display_name,email").ilike("display_name", `%${name}%`).not("email","is",null).order("updated_at", { ascending: false }).limit(2);
    if (participant?.length === 1 && participant[0].email) found.add(String(participant[0].email).toLowerCase()); else unresolved.push(name);
  }
  return { emails: [...found], unresolved };
}
async function googleAccount(ownerRaw: unknown) {
  if (!googleConfigured()) throw Object.assign(new Error("google_oauth_not_configured"), { status: 503 });
  const owner = clean(ownerRaw, 160);
  if (!owner) throw Object.assign(new Error("owner_person_required"), { status: 400 });
  const { data: account } = await ops.from("meeting_integration_accounts").select("*").eq("owner_person", owner).eq("provider_key", "GOOGLE_WORKSPACE").eq("account_slot", "primary").eq("status", "ACTIVE").maybeSingle();
  if (!account) throw Object.assign(new Error("google_not_connected"), { status: 409, needs_google: true });
  return { owner, account, access: await accessTokenFor(account) };
}
function eventTimes(body: any) {
  const start = new Date(String(body.start_time || ""));
  const end = new Date(String(body.end_time || ""));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw Object.assign(new Error("invalid_time"), { status: 400 });
  return { start, end };
}
async function eventResult(event: any, account: any, resolved = { emails: [] as string[], unresolved: [] as string[] }) {
  const meetUrl = event?.hangoutLink || event?.conferenceData?.entryPoints?.find((x:any)=>x.entryPointType === "video")?.uri || null;
  return { ok: true, event_id: event?.id || null, html_link: event?.htmlLink || null, meet_url: meetUrl, organizer_email: account?.account_email || null, attendee_emails: resolved.emails, unresolved_attendees: resolved.unresolved, start_time: event?.start?.dateTime || null, end_time: event?.end?.dateTime || null, title: event?.summary || null };
}
async function createEvent(body: any) {
  try {
    const { account, access } = await googleAccount(body.owner_person);
    const { start, end } = eventTimes(body);
    const resolved = await resolveAttendees(Array.isArray(body.attendee_names) ? body.attendee_names : [], Array.isArray(body.attendee_emails) ? body.attendee_emails : []);
    const payload = { summary: clean(body.title, 300) || "Reunião", description: clean(body.description, 5000) || undefined, start: { dateTime: start.toISOString(), timeZone: "America/Sao_Paulo" }, end: { dateTime: end.toISOString(), timeZone: "America/Sao_Paulo" }, attendees: resolved.emails.map((email)=>({ email })), conferenceData: { createRequest: { requestId: `li-${crypto.randomUUID()}` } } };
    const insert = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", { method: "POST", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
    let event = await insert.json();
    if (!insert.ok) throw Object.assign(new Error(`google_calendar_${insert.status}:${JSON.stringify(event).slice(0,500)}`), { status: insert.status });
    for (let i=0; i<3 && !event.hangoutLink; i++) { await sleep(500); const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(event.id)}?conferenceDataVersion=1`, { headers: { authorization: `Bearer ${access}` } }); if (r.ok) event = await r.json(); }
    return json(await eventResult(event, account, resolved));
  } catch (e:any) { return json({ error: clean(e?.message || e,1000), needs_google: Boolean(e?.needs_google) }, Number(e?.status || 500)); }
}
async function updateEvent(body: any) {
  try {
    const eventId = clean(body.event_id, 500);
    if (!eventId) return json({ error: "event_id_required" }, 400);
    const { account, access } = await googleAccount(body.owner_person);
    const { start, end } = eventTimes(body);
    const resolved = await resolveAttendees(Array.isArray(body.attendee_names) ? body.attendee_names : [], Array.isArray(body.attendee_emails) ? body.attendee_emails : []);
    const payload = { summary: clean(body.title, 300) || "Reunião", description: clean(body.description, 5000) || undefined, start: { dateTime: start.toISOString(), timeZone: "America/Sao_Paulo" }, end: { dateTime: end.toISOString(), timeZone: "America/Sao_Paulo" }, attendees: resolved.emails.map((email)=>({ email })) };
    const patch = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?conferenceDataVersion=1&sendUpdates=all`, { method: "PATCH", headers: { authorization: `Bearer ${access}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
    const event = await patch.json();
    if (!patch.ok) throw Object.assign(new Error(`google_calendar_${patch.status}:${JSON.stringify(event).slice(0,500)}`), { status: patch.status });
    return json(await eventResult(event, account, resolved));
  } catch (e:any) { return json({ error: clean(e?.message || e,1000), needs_google: Boolean(e?.needs_google) }, Number(e?.status || 500)); }
}
async function cancelEvent(body: any) {
  try {
    const eventId = clean(body.event_id, 500);
    if (!eventId) return json({ error: "event_id_required" }, 400);
    const { account, access } = await googleAccount(body.owner_person);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE", headers: { authorization: `Bearer ${access}` } });
    if (!res.ok && res.status !== 404 && res.status !== 410) throw Object.assign(new Error(`google_calendar_${res.status}:${(await res.text()).slice(0,500)}`), { status: res.status });
    return json({ ok: true, cancelled: true, event_id: eventId, organizer_email: account.account_email, already_absent: res.status === 404 || res.status === 410 });
  } catch (e:any) { return json({ error: clean(e?.message || e,1000), needs_google: Boolean(e?.needs_google) }, Number(e?.status || 500)); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: json({}).headers });
  const url = new URL(req.url);
  if (req.method === "GET" && url.searchParams.has("code")) {
    if (!googleConfigured()) return new Response("Google OAuth ainda não configurado", { status: 503 });
    try { return await oauthCallback(url); } catch (e) { return new Response(`Falha no OAuth: ${clean(e instanceof Error ? e.message : e, 300)}`, { status: 500 }); }
  }
  if (req.method === "GET") return json({ ok: true, service: "agency-ops-google-calendar-api", google_configured: googleConfigured(), redirect_uri: REDIRECT_URI });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await req.json().catch(()=>({}));
    const action = clean(body.action, 80).toLowerCase();
    if (action === "start_oauth") return await startOauth(req);
    if (action === "status") {
      const person = await dashboardPerson(req); if (!person) return json({ error: "unauthorized" }, 401);
      const { data } = await ops.from("meeting_integration_accounts").select("account_email,display_name,status,granted_scopes,token_expires_at,last_error").eq("owner_person", person).eq("provider_key", "GOOGLE_WORKSPACE").eq("account_slot", "primary").maybeSingle();
      return json({ ok: true, google_configured: googleConfigured(), account: data || null });
    }
    if (["create_event","update_event","cancel_event"].includes(action)) {
      if (!(await workerAuthorized(req))) return json({ error: "unauthorized" }, 401);
      if (action === "create_event") return await createEvent(body);
      if (action === "update_event") return await updateEvent(body);
      return await cancelEvent(body);
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error("google-calendar-api", e);
    return json({ error: clean(e instanceof Error ? e.message : e, 1000) || "internal_error" }, 500);
  }
});
