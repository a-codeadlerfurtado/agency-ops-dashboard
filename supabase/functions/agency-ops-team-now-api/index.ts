import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const ACTIVE_WINDOW_MIN = 90;
const PROBABLE_WINDOW_MIN = 45;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const authorization = req.headers.get("Authorization") ?? "";
  if (!supabaseUrl || !anonKey || !serviceRole) return json({ ok: false, error: "server_configuration" }, 500);
  if (!authorization.startsWith("Bearer ")) return json({ ok: false, error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await auth.auth.getUser();
  if (authError || !authData?.user) return json({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", authData.user.id).maybeSingle();
  const person = String(pref?.collaborator_person || "").trim();
  if (person !== "Adler Furtado") return json({ ok: false, error: "forbidden" }, 403);

  const since = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const [rosterRes, eventsRes, clientsRes] = await Promise.all([
    ops.from("team_roster").select("person,role,is_former").eq("is_former", false).order("role").order("person"),
    ops.from("meeting_presence_events")
      .select("id,person,client_id,status,started_at,ended_at,source,confidence,topic,summary,transcript_id,updated_at,evidence")
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(250),
    ops.from("clients").select("id,display_name,lifecycle"),
  ]);
  if (rosterRes.error) return json({ ok: false, error: rosterRes.error.message }, 500);
  if (eventsRes.error) return json({ ok: false, error: eventsRes.error.message }, 500);
  if (clientsRes.error) return json({ ok: false, error: clientsRes.error.message }, 500);

  const latestByPerson = new Map<string, any>();
  for (const event of eventsRes.data ?? []) {
    const name = String(event.person || "").trim();
    if (name && !latestByPerson.has(name)) latestByPerson.set(name, event);
  }
  const clients = new Map((clientsRes.data ?? []).map((row: any) => [String(row.id), row]));
  const now = Date.now();

  const members = (rosterRes.data ?? []).map((member: any) => {
    const event = latestByPerson.get(String(member.person)) ?? null;
    if (!event?.started_at) return {
      person: member.person,
      role: member.role,
      presence: "AVAILABLE",
      presence_label: "Disponível",
      meeting: null,
    };

    const started = new Date(event.started_at).getTime();
    const ageMinutes = Number.isFinite(started) ? Math.max(0, Math.floor((now - started) / 60000)) : null;
    const rawStatus = String(event.status || "").toUpperCase();
    let presence = "AVAILABLE";
    let presenceLabel = "Disponível";

    if (!event.ended_at && rawStatus === "IN_PROGRESS" && ageMinutes !== null && ageMinutes <= ACTIVE_WINDOW_MIN) {
      presence = "IN_MEETING";
      presenceLabel = "Em reunião";
    } else if (!event.ended_at && rawStatus === "DETECTED" && ageMinutes !== null && ageMinutes <= PROBABLE_WINDOW_MIN) {
      presence = "PROBABLE";
      presenceLabel = "Provavelmente em reunião";
    }

    const client = event.client_id ? clients.get(String(event.client_id)) : null;
    return {
      person: member.person,
      role: member.role,
      presence,
      presence_label: presenceLabel,
      meeting: {
        id: event.id,
        status: rawStatus,
        started_at: event.started_at,
        ended_at: event.ended_at,
        age_minutes: ageMinutes,
        source: event.source,
        confidence: event.confidence == null ? null : Number(event.confidence),
        topic: event.topic,
        summary: event.summary,
        transcript_id: event.transcript_id,
        client_id: event.client_id,
        client_name: client?.display_name ?? null,
        context_available: rawStatus === "CONTEXT_AVAILABLE" || Boolean(event.transcript_id),
      },
    };
  }).sort((a: any, b: any) => {
    const rank: Record<string, number> = { IN_MEETING: 0, PROBABLE: 1, AVAILABLE: 2 };
    const d = (rank[a.presence] ?? 9) - (rank[b.presence] ?? 9);
    return d || String(a.person).localeCompare(String(b.person), "pt-BR");
  });

  return json({
    ok: true,
    scope: "ADLER_ONLY",
    rules: {
      active_window_minutes: ACTIVE_WINDOW_MIN,
      probable_window_minutes: PROBABLE_WINDOW_MIN,
      context_available_is_not_live_presence: true,
    },
    summary: {
      in_meeting: members.filter((row: any) => row.presence === "IN_MEETING").length,
      probable: members.filter((row: any) => row.presence === "PROBABLE").length,
      available: members.filter((row: any) => row.presence === "AVAILABLE").length,
      total: members.length,
    },
    members,
    generated_at: new Date().toISOString(),
  });
});
