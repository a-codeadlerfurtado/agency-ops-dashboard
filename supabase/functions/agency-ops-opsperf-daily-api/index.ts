import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,OPTIONS",
};

const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const opsDay = (date = new Date()) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(date);

const avg = (values: number[]) => values.length
  ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1))
  : null;

const validDay = (value: string | null) => Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));

function dayBounds(day: string) {
  const start = new Date(`${day}T00:00:00-03:00`);
  const end = new Date(start.getTime() + 86_400_000);
  return { start: start.toISOString(), end: end.toISOString() };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return respond({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return respond({ ok: false, error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ ok: false, error: "unauthorized" }, 401);

  const auth = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await auth.auth.getUser();
  if (!userData?.user) return respond({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences")
    .select("collaborator_person")
    .eq("user_key", userData.user.id)
    .maybeSingle();

  if (pref?.collaborator_person !== "Adler Furtado") return respond({ ok: false, error: "forbidden" }, 403);

  const url = new URL(req.url);
  const requestedDay = url.searchParams.get("date");
  const day = validDay(requestedDay) ? requestedDay! : opsDay();
  const { start, end } = dayBounds(day);

  const [rosterRes, activityRes, taskRes, csRes] = await Promise.all([
    ops.from("team_roster").select("person,role").eq("is_former", false).order("person"),
    ops.from("op_perf_daily_activity").select("person,role,activity_date,source,events").eq("activity_date", day),
    ops.from("op_perf_task_facts")
      .select("person,role,task_id,task_name,list_name,date_closed,is_adjustment,hours_to_close,on_time")
      .eq("completed", true)
      .gte("date_closed", start)
      .lt("date_closed", end)
      .limit(3000),
    ops.from("op_perf_cs_response_times")
      .select("cs_person,response_minutes,client_msg_at,reply_at")
      .gte("client_msg_at", start)
      .lt("client_msg_at", end)
      .limit(3000),
  ]);

  const firstError = [rosterRes, activityRes, taskRes, csRes].find((result) => result.error)?.error;
  if (firstError) return respond({ ok: false, error: "query_failed", detail: firstError.message }, 500);

  const roster = rosterRes.data ?? [];
  const activity = activityRes.data ?? [];
  const tasks = taskRes.data ?? [];
  const csRows = (csRes.data ?? []).filter((row: any) => {
    const value = Number(row.response_minutes);
    return Number.isFinite(value) && value >= 0 && value < 60 * 24 * 3;
  });

  const byPerson = new Map<string, any>();
  for (const person of roster) {
    byPerson.set(person.person, {
      person: person.person,
      role: person.role,
      totalActivity: 0,
      sourceCounts: {} as Record<string, number>,
      tasks: [] as any[],
      onTime: 0,
      onTimeTotal: 0,
      novoHours: [] as number[],
      ajusteHours: [] as number[],
      csResponseMinutes: [] as number[],
    });
  }

  for (const row of activity) {
    const bucket = byPerson.get(row.person);
    if (!bucket) continue;
    const events = Number(row.events ?? 0);
    bucket.totalActivity += events;
    bucket.sourceCounts[row.source] = (bucket.sourceCounts[row.source] ?? 0) + events;
  }

  for (const row of tasks) {
    const bucket = byPerson.get(row.person);
    if (!bucket) continue;
    bucket.tasks.push(row);
    if (row.on_time !== null && row.on_time !== undefined) {
      bucket.onTimeTotal += 1;
      if (row.on_time) bucket.onTime += 1;
    }
    const hours = Number(row.hours_to_close);
    if (Number.isFinite(hours) && hours >= 0) {
      (row.is_adjustment ? bucket.ajusteHours : bucket.novoHours).push(hours);
    }
  }

  for (const row of csRows) {
    const bucket = byPerson.get(row.cs_person);
    if (!bucket) continue;
    bucket.csResponseMinutes.push(Number(row.response_minutes));
  }

  const people = [...byPerson.values()].map((bucket) => ({
    person: bucket.person,
    role: bucket.role,
    total_activity: bucket.totalActivity,
    tasks_completed: bucket.tasks.length,
    task_log_entries: Number(bucket.sourceCounts.task_log ?? 0),
    adjustments: Number(bucket.sourceCounts.client_adjustment ?? 0),
    clickup_closed_events: Number(bucket.sourceCounts.clickup_task_closed ?? 0),
    other_events: Object.entries(bucket.sourceCounts)
      .filter(([source]) => !["task_log", "client_adjustment", "clickup_task_closed"].includes(source))
      .reduce((sum, [, count]) => sum + Number(count ?? 0), 0),
    on_time_rate: bucket.onTimeTotal ? Number((100 * bucket.onTime / bucket.onTimeTotal).toFixed(1)) : null,
    avg_hours_novo: avg(bucket.novoHours),
    avg_hours_ajuste: avg(bucket.ajusteHours),
    creatives_novo: bucket.novoHours.length,
    creatives_ajuste: bucket.ajusteHours.length,
    avg_cs_response_minutes: avg(bucket.csResponseMinutes),
    cs_replies: bucket.csResponseMinutes.length,
    completed_tasks: bucket.tasks.slice(0, 8).map((task: any) => ({
      task_id: task.task_id,
      task_name: task.task_name,
      list_name: task.list_name,
      date_closed: task.date_closed,
      on_time: task.on_time,
    })),
    sources: bucket.sourceCounts,
  })).sort((a, b) => b.total_activity - a.total_activity || b.tasks_completed - a.tasks_completed || a.person.localeCompare(b.person, "pt-BR"));

  const activePeople = people.filter((row) => row.total_activity > 0 || row.tasks_completed > 0 || row.cs_replies > 0);
  const summary = {
    team_members: people.length,
    people_with_activity: activePeople.length,
    total_activity: people.reduce((sum, row) => sum + row.total_activity, 0),
    tasks_completed: people.reduce((sum, row) => sum + row.tasks_completed, 0),
    task_log_entries: people.reduce((sum, row) => sum + row.task_log_entries, 0),
    adjustments: people.reduce((sum, row) => sum + row.adjustments, 0),
    cs_replies: people.reduce((sum, row) => sum + row.cs_replies, 0),
  };

  return respond({
    ok: true,
    date: day,
    timezone: "America/Sao_Paulo",
    summary,
    people,
    generated_at: new Date().toISOString(),
  });
});
