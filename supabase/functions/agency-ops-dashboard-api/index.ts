import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,x-dashboard-key,authorization,apikey",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const number = (value: unknown) => Number(value ?? 0);
const value = <T>(result: any, fallback: T): T => result?.error ? fallback : (result?.data ?? fallback);
const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
// Nomes sinteticos gerados por testes automatizados (ex.: "LeadProposta-1785845578658-5d6j96").
const SYNTHETIC_NAME = /^[A-Za-z]+-\d{9,}-[a-z0-9]{4,8}$/;
// Abas do dashboard. A chave fixa do gestor (acesso legado, fora do quadro) recebe
// todas; quem entra por login recebe o que agency_ops.dashboard_view_permissions disser.
const ALL_VIEWS = ["overview","focus","clients","onboarding","campaigns","preclients","conversations","team","diary","clickup","evidence","audit","alerts"];
// Dia de operacao no fuso de Brasilia: task fechada as 22h e' de hoje, nao de amanha.
const opsDay = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

const aggregateMedia = (rows: any[]) => {
  const daily = rows.filter((row) => (row.granularity ?? "day") === "day");
  const dates = daily.map((row) => row.date).filter(Boolean).sort();
  const latestDate = dates.at(-1) ?? null;
  const latest = latestDate ? daily.filter((row) => row.date === latestDate) : [];
  const spend = latest.reduce((sum, row) => sum + number(row.spend), 0);
  const leads = latest.reduce((sum, row) => sum + number(row.leads), 0);
  const clicks = latest.reduce((sum, row) => sum + number(row.clicks), 0);
  const impressions = latest.reduce((sum, row) => sum + number(row.impressions), 0);
  const ageDays = latestDate ? Math.max(0, Math.floor((Date.now() - new Date(`${latestDate}T23:59:59Z`).getTime()) / 86400000)) : null;
  return { latest_date: latestDate, age_days: ageDays, is_stale: ageDays === null || ageDays > 2, accounts: new Set(latest.map((row) => row.account_key).filter(Boolean)).size, clients_with_media: new Set(latest.map((row) => row.client_id).filter(Boolean)).size, spend: Number(spend.toFixed(2)), leads, impressions, clicks, ctr: impressions ? Number((clicks / impressions * 100).toFixed(2)) : null, cpc: clicks ? Number((spend / clicks).toFixed(2)) : null, cpl: leads ? Number((spend / leads).toFixed(2)) : null };
};
const aggregateTaskLog = (rows: any[]) => {
  const byCategory: Record<string, number> = {};
  const byCollaborator: Record<string, { total: number; by_category: Record<string, number> }> = {};
  for (const row of rows) {
    byCategory[row.category] = (byCategory[row.category] ?? 0) + 1;
    const bucket = byCollaborator[row.collaborator_name] ?? { total: 0, by_category: {} };
    bucket.total += 1;
    bucket.by_category[row.category] = (bucket.by_category[row.category] ?? 0) + 1;
    byCollaborator[row.collaborator_name] = bucket;
  }
  return { total: rows.length, by_category: byCategory, by_collaborator: byCollaborator, recent: rows.slice(0, 100) };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!['GET','POST'].includes(req.method)) return respond({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const url = new URL(req.url);
  const view = url.searchParams.get("view") ?? "home";

  // ---- view=roster e publico (necessario para o dropdown de cadastro, antes do login existir).
  // Lista apenas colaboradores ativos que ainda nao foram reivindicados por nenhum login.
  if (req.method === "GET" && view === "roster") {
    const [{ data: rosterRows }, { data: claimedRows }] = await Promise.all([
      ops.from("team_roster").select("person,role").eq("is_former", false).order("person"),
      ops.from("user_preferences").select("collaborator_person").not("collaborator_person", "is", null),
    ]);
    const claimed = new Set((claimedRows ?? []).map((row: any) => row.collaborator_person));
    const available = (rosterRows ?? []).filter((row: any) => !claimed.has(row.person));
    return respond({ roster: available });
  }

  // ---- Autenticacao: aceita a chave fixa do dashboard (uso atual, mantido para nao
  // quebrar o front-end existente) OU um login de colaborador via Supabase Auth (novo).
  // Quando autenticado por login, currentUserKey passa a ser o id do proprio usuario,
  // e cada um ve/edita seu proprio perfil em vez do perfil fixo "adler-furtado".
  let currentUserKey = "adler-furtado";
  let authenticated = false;
  let viaLogin = false;

  const suppliedKey = req.headers.get("x-dashboard-key") ?? "";
  if (suppliedKey.length >= 40) {
    const keyHash = await sha256(suppliedKey);
    const { data: apiKey } = await ops.from("dashboard_api_keys").select("active,expires_at").eq("key_hash", keyHash).maybeSingle();
    if (apiKey?.active && !(apiKey.expires_at && new Date(apiKey.expires_at) <= new Date())) {
      authenticated = true;
      await ops.from("dashboard_api_keys").update({ last_used_at: new Date().toISOString() }).eq("key_hash", keyHash);
    }
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authenticated && authHeader.startsWith("Bearer ")) {
    const authClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await authClient.auth.getUser();
    if (userData?.user) {
      authenticated = true;
      viaLogin = true;
      currentUserKey = userData.user.id;
    }
  }

  if (!authenticated) return respond({ error: "unauthorized" }, 401);

  // ---- Perfil de permissoes: chave fixa = acesso total (comportamento legado, usado pelo
  // Adler). Login = resolvido via user_preferences.collaborator_person -> team_roster.
  type AccessLevel = "FULL" | "WALLET_ONLY" | "RESTRICTED";
  let profilePerson: string | null = null;
  let profileRole: string | null = null;
  let profileClickupUser: string | null = null;
  let accessLevel: AccessLevel = "FULL";
  let elevated = false;
  // Chave fixa do dashboard e' o acesso legado do gestor: nao passa por aprovacao.
  let accountApproved = true;

  if (viaLogin) {
    accessLevel = "RESTRICTED";
    const { data: prefRow } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", currentUserKey).maybeSingle();
    const collaboratorPerson = prefRow?.collaborator_person ?? null;
    if (collaboratorPerson) {
      const { data: rosterRow } = await ops.from("team_roster").select("person,role,access_level,clickup_user").eq("person", collaboratorPerson).eq("is_former", false).maybeSingle();
      if (rosterRow) {
        profilePerson = rosterRow.person;
        profileRole = rosterRow.role;
        profileClickupUser = rosterRow.clickup_user;
        accessLevel = (rosterRow.access_level as AccessLevel) ?? "RESTRICTED";
      }
    }
    // Duas aprovacoes distintas, nunca a mesma:
    //   SIGNUP    libera a CONTA (sem ela o login existe mas nao ve nada)
    //   ELEVATION libera acesso ALEM do papel
    const { data: decisions } = await ops.from("access_requests")
      .select("kind,status").eq("user_key", currentUserKey).eq("status", "APPROVED");
    const approvals = decisions ?? [];
    accountApproved = approvals.some((row: any) => row.kind === "SIGNUP");
    if (accessLevel === "RESTRICTED" && approvals.some((row: any) => row.kind === "ELEVATION")) elevated = true;
  }

  const isFull = accessLevel === "FULL" || elevated;
  const isWalletOnly = accessLevel === "WALLET_ONLY" && !elevated;
  const isRestrictedBase = accessLevel === "RESTRICTED" && !elevated;
  // Conta travada: ou o cadastro ainda nao foi aprovado pelo gestor, ou o login nao
  // esta vinculado a ninguem do quadro. Nos dois casos a pessoa nao ve dado nenhum.
  // Sem isso ela cairia em RESTRICTED, que nao filtra carteira - so WALLET_ONLY filtra -
  // e enxergaria os 155 clientes com nome, prioridade e proxima acao.
  const isLocked = viaLogin && (!accountApproved || (!profilePerson && !elevated));
  const canDecideAccessRequests = isFull && (!viaLogin || profileRole === "MGMT");

  // ---- Quais ABAS a pessoa abre. Pergunta separada de QUANTO DADO ela alcanca:
  // access_level continua governando o escopo (carteira x base inteira), enquanto a
  // lista de abas vem de agency_ops.dashboard_view_permissions. Sem essa separacao,
  // liberar Alertas para o CS obrigava a liberar Auditoria e Evidencias junto.
  // Conta travada enxerga so' a casca (overview) para conseguir pedir acesso.
  let allowedViews: string[] = ALL_VIEWS;
  if (viaLogin) {
    if (isLocked) {
      allowedViews = ["overview"];
    } else {
      const { data: viewRows } = await ops.rpc("dashboard_allowed_views", { p_person: profilePerson, p_role: profileRole });
      allowedViews = Array.isArray(viewRows) ? viewRows : [];
    }
  }
  const canView = (key: string) => allowedViews.includes(key);

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (view === "notifications-read") {
      let query = ops.from("platform_notifications").update({ read_at: new Date().toISOString() });
      if (body.id) query = query.eq("id", String(body.id)); else query = query.is("read_at", null);
      const result = await query.select("id");
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, updated: result.data?.length ?? 0 });
    }
    if (view === "preferences") {
      const allowed = ["theme","sounds_enabled","win_sound_enabled","win_celebration_enabled","notifications_enabled","animations_enabled","interface_density","name","role"];
      const patch = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
      const result = await ops.from("user_preferences").update({ ...patch, updated_at: new Date().toISOString() }).eq("user_key", currentUserKey).select().single();
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, preferences: result.data });
    }
    if (view === "access-request") {
      if (!viaLogin || !profilePerson) return respond({ error: "collaborator_required" }, 400);
      const { data: pending } = await ops.from("access_requests").select("id").eq("user_key", currentUserKey).eq("status", "PENDING").maybeSingle();
      if (pending) return respond({ ok: true, request: pending, already_pending: true });
      const result = await ops.from("access_requests").insert({ user_key: currentUserKey, person: profilePerson, status: "PENDING", note: typeof body.note === "string" ? body.note.slice(0, 500) : null }).select().single();
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, request: result.data });
    }
    if (view === "access-request-decide") {
      if (!canDecideAccessRequests) return respond({ error: "forbidden" }, 403);
      const id = String(body.id ?? "");
      const decision = body.decision === "APPROVED" ? "APPROVED" : body.decision === "DENIED" ? "DENIED" : null;
      if (!id || !decision) return respond({ error: "missing_fields" }, 400);
      const result = await ops.from("access_requests").update({ status: decision, decided_at: new Date().toISOString(), decided_by: profilePerson ?? "adler-furtado" }).eq("id", id).select().single();
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, request: result.data });
    }
    // ---- Diario de Ajustes. A tela existia e o botao "Registrar ajuste" respondia 404:
    // a rota nunca foi implementada aqui. Cliente e' validado contra o escopo da pessoa -
    // esconder o cliente no <select> nao e' seguranca.
    if (view === "adjustment-create") {
      if (isLocked) return respond({ error: "forbidden" }, 403);
      if (!canView("diary")) return respond({ error: "forbidden" }, 403);
      const clientId = String(body.client_id ?? "").trim();
      const descricao = typeof body.descricao === "string" ? body.descricao.trim() : "";
      if (!clientId || !descricao) return respond({ error: "missing_fields", required: ["client_id", "descricao"] }, 400);
      const { data: clientRow } = await ops.from("dashboard_client_overview").select("client_id,gt_owner").eq("client_id", clientId).maybeSingle();
      if (!clientRow) return respond({ error: "not_found" }, 404);
      if (isWalletOnly && clientRow.gt_owner !== profilePerson) return respond({ error: "forbidden" }, 403);
      const result = await ops.from("client_adjustments").insert({
        client_id: clientId,
        source: "diario_ajustes",
        tipo: typeof body.tipo === "string" ? body.tipo.slice(0, 120) : null,
        descricao: descricao.slice(0, 4000),
        metadata: { author_user_key: currentUserKey, author_name: profilePerson ?? null, origem: "dashboard" },
      }).select().single();
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, adjustment: result.data });
    }
    // ---- Registro de Tarefas. Mesmo caso: o front postava, a rota nao existia.
    // O id e' montado aqui porque task_log_entries.id e' text sem default (a chave vem
    // do app desktop que alimenta a mesma tabela) - o prefixo diz de onde o registro veio.
    if (view === "tasklog-create") {
      if (isLocked) return respond({ error: "forbidden" }, 403);
      if (!canView("diary")) return respond({ error: "forbidden" }, 403);
      const taskName = typeof body.task_name === "string" ? body.task_name.trim() : "";
      const category = typeof body.category === "string" ? body.category.trim() : "";
      if (!taskName || !category) return respond({ error: "missing_fields", required: ["category", "task_name"] }, 400);
      const taskDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.task_date ?? "")) ? String(body.task_date) : opsDay();
      const author = profilePerson ?? String(value(await ops.from("user_preferences").select("name").eq("user_key", currentUserKey).maybeSingle(), {} as any)?.name ?? "Colaborador");
      const result = await ops.from("task_log_entries").insert({
        id: `dash-${currentUserKey}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
        user_key: currentUserKey,
        collaborator_name: author,
        category: category.slice(0, 120),
        task_name: taskName.slice(0, 500),
        task_date: taskDate,
        created_at_client: new Date().toISOString(),
        source: "dashboard_diario",
      }).select().single();
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, entry: result.data });
    }
    if (view === "note-create") {
      // O texto do colaborador entra cru e inteiro. O vinculo com cliente e' um
      // palpite marcado como tal - nunca altera o que a pessoa escreveu.
      const texto = typeof body.body === "string" ? body.body.trim() : "";
      if (!texto) return respond({ error: "missing_fields", required: ["body"] }, 400);
      const { data, error } = await ops.rpc("ingest_ops_note", { p: {
        body: texto,
        author_user_key: currentUserKey,
        author_name: profilePerson ?? null,
        client_id: body.client_id ?? null,
        occurred_at: body.occurred_at ?? null,
      } });
      if (error) return respond({ error: "query_failed", detail: error.message }, 500);
      return respond(data);
    }
    if (view === "note-confirm") {
      // Confirmacao humana do cliente quando o palpite ficou ambiguo ou errado.
      const id = String(body.id ?? "");
      if (!id) return respond({ error: "missing_fields", required: ["id"] }, 400);
      const clientId = body.client_id ? String(body.client_id) : null;
      const result = await ops.from("ops_notes").update({
        client_id: clientId,
        match_status: clientId ? "MANUAL" : "UNMATCHED",
        match_confidence: clientId ? 1 : null,
        confirmado_em: new Date().toISOString(),
        confirmado_por: profilePerson ?? currentUserKey,
      }).eq("id", id).select().single();
      if (result.error) return respond({ error: "query_failed", detail: result.error.message }, 500);
      return respond({ ok: true, note: result.data });
    }
    return respond({ error: "unknown_action" }, 404);
  }

  // ---- Produtividade do ClickUp por periodo (aba ClickUp). Rota que o front ja' chamava
  // e que nao existia: a chamada caia no payload de "home" e a tela mostrava zero.
  // Quem nao ve o ClickUp inteiro so' consegue puxar a propria linha.
  if (view === "clickup-range") {
    if (isLocked || !canView("clickup")) return respond({ error: "forbidden" }, 403);
    const isDay = (raw: string | null) => Boolean(raw && /^\d{4}-\d{2}-\d{2}$/.test(raw));
    const untilParam = url.searchParams.get("until");
    const sinceParam = url.searchParams.get("since");
    const until = isDay(untilParam) ? untilParam! : opsDay();
    const since = isDay(sinceParam) ? sinceParam! : opsDay(new Date(Date.now() - 29 * 86400000));
    const requested = (url.searchParams.get("people") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    // isFull ve todo mundo; os demais ficam presos a propria conta do ClickUp,
    // independente do que o parametro people pedir.
    const people = isFull ? requested : [profileClickupUser ?? "__sem_vinculo__"];
    const { data, error } = await ops.rpc("clickup_range_report", { p_since: since, p_until: until, p_people: people.length ? people : null });
    if (error) return respond({ error: "query_failed", detail: error.message }, 500);
    return respond({ ...(data ?? {}), scoped: !isFull, generated_at: new Date().toISOString() });
  }

  if (view === "client") {
    const clientId = url.searchParams.get("id");
    if (!clientId) return respond({ error: "missing_client_id" }, 400);
    const core = await Promise.all([
      ops.from("dashboard_client_overview").select("*").eq("client_id", clientId).maybeSingle(),
      ops.from("conversation_state").select("*").eq("client_id", clientId).order("updated_at", { ascending: false }),
      ops.from("operational_alerts").select("*").eq("client_id", clientId).order("last_detected_at", { ascending: false }).limit(50),
      ops.from("commitments").select("*").eq("client_id", clientId).order("created_at", { ascending: false }).limit(50),
    ]);
    if (core[0].error) return respond({ error: "query_failed", detail: core[0].error.message }, 500);
    const clientRow: any = core[0].data;
    if (!clientRow) return respond({ error: "not_found" }, 404);
    if (isWalletOnly && clientRow.gt_owner !== profilePerson) return respond({ error: "forbidden" }, 403);
    // core fica antes de proposito: e' ele que carrega a checagem de permissao
    // (cliente inexistente ou de carteira alheia para'm aqui). Ja' context e history
    // nao dependem um do outro e passam a rodar juntos.
    const [context, history] = await Promise.all([
      Promise.all([
      ops.from("notion_briefing_pages").select("notion_page_id,title,page_url,sync_status,match_status,extracted_profile,last_fetched_at").eq("client_id", clientId).order("updated_at", { ascending: false }),
      ops.from("client_daily_summary").select("*").eq("client_id", clientId).order("summary_date", { ascending: false }).limit(30),
      ops.from("media_metrics_daily").select("*").eq("client_id", clientId).order("date", { ascending: false }).limit(180),
      ops.from("client_timeline").select("*").eq("client_id", clientId).order("at", { ascending: false }).limit(100),
      ]),
      Promise.all([
      ops.from("client_health_scores").select("*").eq("client_id", clientId).order("date", { ascending: false }).limit(90),
      ops.from("client_integrations").select("*").eq("client_id", clientId),
      ops.from("clickup_tasks").select("task_id,name,status,is_closed,date_created,date_closed,due_date,list_name,url,last_synced_at").eq("client_id", clientId).order("date_updated", { ascending: false }).limit(100),
      ops.from("onboarding_cases").select("*,onboarding_stages(*)").eq("client_id", clientId).order("created_at", { ascending: false }).limit(3),
      ops.from("client_lifecycle_events").select("*").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(100),
      ops.from("client_won_events").select("*").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(20),
      ops.from("ops_notes").select("*").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(50),
      ]),
    ]);
    const results = [...core, ...context, ...history];
    // Codinome da carteira: o drawer mostra "Carteira Bravo", nao o nome do gestor.
    const { data: walletRow } = await ops.from("wallet_registry").select("carteira").eq("gt_owner", clientRow.gt_owner ?? "").maybeSingle();
    return respond({ client: { ...(results[0].data as any), carteira: walletRow?.carteira ?? null }, conversations: value(results[1], []), alerts: value(results[2], []), commitments: value(results[3], []), briefings: value(results[4], []), daily_summaries: value(results[5], []), media: value(results[6], []), timeline: value(results[7], []), health_history: value(results[8], []), integrations: value(results[9], []), clickup_tasks: value(results[10], []), onboarding_cases: value(results[11], []), lifecycle_events: value(results[12], []), won_events: value(results[13], []), ops_notes: value(results[14], []), generated_at: new Date().toISOString() });
  }

  // Os seis grupos nao dependem uns dos outros, mas rodavam em serie: cada await
  // esperava o grupo anterior terminar. O tempo da resposta era a soma dos seis.
  // Agora disparam juntos e a espera passa a ser a do grupo mais lento.
  const [core, sources, operationsData, clickupData, platformData, teamData] = await Promise.all([
    Promise.all([
    ops.from("dashboard_client_overview").select("*").limit(300),
    ops.from("operational_alerts").select("*").eq("status", "OPEN").limit(500),
    ops.from("commitments").select("*").in("status", ["OPEN", "IN_PROGRESS"]).limit(500),
    ops.from("conversation_state").select("*").limit(500),
    ]),
    Promise.all([
    ops.from("notion_briefing_pages").select("notion_page_id,client_id,match_status,sync_status,updated_at").limit(500),
    ops.from("notion_briefing_sync_runs").select("*").order("started_at", { ascending: false }).limit(1),
    ops.from("job_runs").select("job_name,status,started_at,finished_at,error").order("started_at", { ascending: false }).limit(40),
    ops.from("conversation_processing_queue").select("chat_id,status,dirty_since,last_error").limit(500),
    ]),
    Promise.all([
    ops.from("whatsapp_messages").select("id,event_at,received_at,chat_id").order("id", { ascending: false }).limit(1),
    ops.from("media_metrics_daily").select("*").order("date", { ascending: false }).limit(3000),
    ops.from("employee_capacity").select("*").order("date", { ascending: false }).limit(300),
    ops.from("client_health_scores").select("*").order("date", { ascending: false }).limit(1000),
    ]),
    Promise.all([
    ops.from("clickup_productivity_30d").select("*").order("tasks_done", { ascending: false }),
    ops.from("clickup_productivity_daily").select("*").gte("date", new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)).order("date", { ascending: true }),
    ops.from("clickup_tasks").select("task_id,name,status,date_closed,due_date,list_name,client_id,url,clickup_task_assignees(user_id,username,email)", { count: "exact" }).eq("is_closed", true).order("date_closed", { ascending: false }).limit(100),
    ops.from("clickup_sync_runs").select("*").order("started_at", { ascending: false }).limit(1),
    ops.rpc("get_clickup_config"),
    ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).not("client_id", "is", null),
    ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).eq("client_match_status", "UNMATCHED"),
    ops.from("clickup_tasks").select("task_id", { count: "exact", head: true }).eq("client_match_status", "NO_LABEL"),
    ops.from("clickup_client_label_audit").select("client_label,task_count,status").eq("status", "UNMATCHED").order("task_count", { ascending: false }).limit(30),
    ]),
    Promise.all([
    ops.from("platform_notifications").select("*").order("occurred_at", { ascending: false }).limit(100),
    ops.from("crm_preclients").select("*").order("updated_at", { ascending: false }).limit(200),
    ops.from("client_won_events").select("*").order("occurred_at", { ascending: false }).limit(100),
    ops.from("data_audit_runs").select("*").order("started_at", { ascending: false }).limit(2),
    ops.from("data_audit_issues").select("id,severity,category,issue_code,entity_type,entity_id,resolution_status,explanation,created_at").order("created_at", { ascending: false }).limit(100),
    ops.from("user_preferences").select("*").eq("user_key", currentUserKey).maybeSingle(),
    ops.from("automation_health").select("*").order("updated_at", { ascending: false }),
    ops.from("task_log_entries").select("id,user_key,category,collaborator_name,task_name,task_date,synced_at").is("deleted_at", null).order("task_date", { ascending: false }).limit(3000),
    ops.from("client_adjustments").select("id,client_id,source,tipo,descricao,occurred_at,metadata").order("occurred_at", { ascending: false }).limit(300),
    ]),
    Promise.all([
    ops.from("team_roster").select("*").eq("is_former", false).order("person"),
    ops.from("team_former_members").select("*").order("left_at", { ascending: false }),
    // Quadro de pessoal + produtividade ClickUp, agregado em SQL (agency_ops.team_overview).
    ops.from("team_overview").select("*").order("role_order", { ascending: true }).order("tasks_done", { ascending: false }),
    ops.from("onboarding_stage_definitions").select("code,label").order("ordem"),
    canDecideAccessRequests ? ops.from("access_requests").select("*,team_roster(role)").eq("status", "PENDING").order("requested_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
    ops.from("access_requests").select("*").eq("user_key", currentUserKey).order("requested_at", { ascending: false }).limit(1),
    ops.from("whatsapp_chat_registry").select("chat_id,chat_name,message_count,last_seen_at").limit(500),
    // Carteira de Clientes: metricas vivas, serie mensal, transicoes e auditoria.
    ops.from("portfolio_live").select("*"),
    ops.from("portfolio_timeline").select("*").order("month", { ascending: false }),
    ops.from("portfolio_client_status").select("*"),
    ops.from("portfolio_tenure_distribution").select("*"),
    ops.from("portfolio_audit_log").select("*").order("occurred_at", { ascending: false }).limit(100),
    ops.from("client_churn_log").select("*").order("saida", { ascending: false }).limit(200),
    ops.from("portfolio_survival").select("*").order("ordem"),
    ops.from("portfolio_gt_retention").select("*"),
    // Serie longa reconstruida do dado bruto: alcanca janeiro/2026, que o relatorio nao cobre.
    ops.from("portfolio_monthly_computed").select("*").gte("month", "2026-01-01").order("month"),
    // Sinal operacional: cliente que parou de gerar task parou de ser atendido.
    ops.from("portfolio_operational_signal").select("*"),
    // Codinome das carteiras (Alfa, Bravo, Charlie...). O nome do gestor deixa de ser
    // o nome da carteira: troca de GT nao renomeia a carteira.
    ops.from("wallet_overview").select("*").order("ordem"),
    ]),
  ]);

  const results = [...core, ...sources, ...operationsData, ...clickupData];
  if (results[0].error) return respond({ error: "query_failed", detail: results[0].error.message }, 500);

  const allClients: any[] = value(results[0], []);
  // ---- Escopo por carteira: GT (WALLET_ONLY) so enxerga clientes cujo gt_owner e o proprio.
  // CS restrito e perfis FULL nao tem restricao de carteira (mas team/produtividade e' filtrado a parte).
  const walletSet = isLocked
    ? new Set<string>()
    : isWalletOnly ? new Set(allClients.filter((row) => row.gt_owner === profilePerson).map((row) => row.client_id)) : null;
  const inScope = (clientId: string | null) => !walletSet || (clientId && walletSet.has(clientId));

  const clients = walletSet ? allClients.filter((row) => walletSet.has(row.client_id)) : allClients;
  const activeClients = clients.filter((row) => ["ACTIVE", "ONBOARDING"].includes(row.lifecycle));
  const activeIds = new Set(activeClients.map((row) => row.client_id));
  const alerts: any[] = value(results[1], []).filter((row: any) => inScope(row.client_id));
  const commitments: any[] = value(results[2], []).filter((row: any) => inScope(row.client_id));
  const conversations: any[] = value(results[3], []).filter((row: any) => inScope(row.client_id));
  const briefings: any[] = value(results[4], []).filter((row: any) => inScope(row.client_id));
  const jobs: any[] = value(results[6], []);
  const queue: any[] = value(results[7], []);
  const mediaRows: any[] = value(results[9], []).filter((row: any) => inScope(row.client_id));
  const activeMediaRows = mediaRows.filter((row) => row.client_id && activeIds.has(row.client_id));
  const latestHealthByClient = new Map<string, any>();
  for (const row of value<any[]>(results[11], [])) if (!latestHealthByClient.has(row.client_id)) latestHealthByClient.set(row.client_id, row);
  const wallets = value<any[]>(teamData[17], []);
  const walletByOwner = new Map(wallets.map((row: any) => [row.gt_owner, row.carteira]));
  const walletName = (owner: unknown) => walletByOwner.get(String(owner ?? "")) ?? null;
  const enrichedClients = clients.map((client) => ({ ...client, carteira: walletName(client.gt_owner), health: latestHealthByClient.get(client.client_id) ?? null }));
  const count = (fn: (row: any) => boolean) => activeClients.filter(fn).length;
  const severity: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const now = new Date();
  const overdue = commitments.filter((row) => row.due_at && new Date(row.due_at) < now);
  const bottlenecks = activeClients.reduce((acc: Record<string, number>, row: any) => { const key = row.waiting_direction || row.onboarding_blocked_by || "NO_BLOCKER"; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {});
  const evidenceReview = activeClients.filter((row) => row.needs_semantic_review || ["PARTIAL", "INCOMPLETE"].includes(row.data_coverage));
  const clientNames = new Map(clients.map((row) => [row.client_id, row.display_name]));
  const clientLifecycles = new Map(clients.map((row) => [row.client_id, row.lifecycle]));
  const clientMeta = new Map(allClients.map((row) => [row.client_id, row]));
  const mediaGroups = new Map<string, any[]>();
  for (const row of mediaRows) {
    const key = `${row.client_id ?? "unlinked"}:${row.account_key ?? "unknown"}`;
    mediaGroups.set(key, [...(mediaGroups.get(key) ?? []), row]);
  }
  const campaigns = [...mediaGroups.values()].map((rows) => {
    const latestDate = rows.map((row) => row.date).filter(Boolean).sort().at(-1) ?? null;
    const latest = rows.filter((row) => row.date === latestDate);
    const spend = latest.reduce((sum, row) => sum + number(row.spend), 0);
    const leads = latest.reduce((sum, row) => sum + number(row.leads), 0);
    const clicks = latest.reduce((sum, row) => sum + number(row.clicks), 0);
    const impressions = latest.reduce((sum, row) => sum + number(row.impressions), 0);
    const ageDays = latestDate ? Math.floor((Date.now() - new Date(`${latestDate}T23:59:59Z`).getTime()) / 86400000) : null;
    return { client_id: latest[0]?.client_id ?? null, display_name: clientNames.get(latest[0]?.client_id) ?? null, lifecycle: clientLifecycles.get(latest[0]?.client_id) ?? "UNLINKED", account_key: latest[0]?.account_key ?? null, latest_date: latestDate, age_days: ageDays, is_stale: ageDays === null || ageDays > 2, spend: Number(spend.toFixed(2)), leads, clicks, impressions, cpl: leads ? Number((spend / leads).toFixed(2)) : null, ctr: impressions ? Number((clicks / impressions * 100).toFixed(2)) : null, campaign_count: latest.reduce((sum, row) => sum + number(row.campaign_count), 0) };
  }).sort((a, b) => b.spend - a.spend);

  const lastClickupSync = value<any[]>(results[15], [])[0] ?? null;
  const clickupConfig: any = value(results[16], {});
  const totalClickup = results[14].count ?? 0;
  const matchedClickup = results[17].count ?? 0;

  // ---- Time (produtividade): visivel por completo apenas para perfis FULL. GT (carteira)
  // e CS restrito (sem elevacao) enxergam somente a propria linha.
  //
  // IMPORTANTE: o quadro de pessoal vem de agency_ops.team_overview, NAO de team_roster.
  // team_roster e' a tabela de PERMISSAO (quem tem login e com qual nivel) e tem 6 linhas;
  // o quadro real tem 10. Usa-la como fonte escondia da aba Equipe quem nao tem login -
  // inclusive o Vitor Hugo (maior produtor de tasks da agencia) e todo o time de Design.
  // A contagem de tasks tambem passa a vir agregada em SQL: antes era calculada em JS
  // sobre um fetch de clickup_tasks que o teto de linhas do PostgREST truncava, gerando
  // tasks_done menor que tasks_done_30d (impossivel, pois 30d e' subconjunto do total).
  const stageDefs = value<any[]>(teamData[3], []);
  const stageLabels = Object.fromEntries(stageDefs.map((row: any) => [row.code, row.label]));
  const accessByPerson = new Map(value<any[]>(teamData[0], []).map((row: any) => [norm(row.person), row.access_level]));
  const fullTeam = value<any[]>(teamData[2], []).map((member: any) => ({
    ...member,
    access_level: accessByPerson.get(norm(member.person)) ?? null,
    carteira: member.role === "GT" ? walletName(member.person) : null,
    portfolio: member.role === "GT"
      ? allClients
          .filter((row) => row.gt_owner === member.person && ["ACTIVE", "ONBOARDING"].includes(row.lifecycle))
          .map((row) => ({ client_id: row.client_id, display_name: row.display_name, priority: row.priority, lifecycle: row.lifecycle, next_step: row.next_step, data_coverage: row.data_coverage }))
      : [],
  }));
  // Quadro de pessoal: so' chega a quem tem a aba Equipe. Quem nao tem enxerga a
  // propria linha (usada pelos contadores), nunca a produtividade dos colegas.
  const team = canView("team") && isFull ? fullTeam : fullTeam.filter((row) => row.person === profilePerson);

  // Clientes ativos/onboarding sem gestor de trafego. Sao carteira de ninguem: nao
  // aparecem em nenhum card da aba Equipe e por isso passavam despercebidos.
  const unassignedClients = isFull
    ? allClients
        .filter((row) => ["ACTIVE", "ONBOARDING"].includes(row.lifecycle) && !String(row.gt_owner ?? "").trim())
        .map((row) => ({ client_id: row.client_id, display_name: row.display_name, lifecycle: row.lifecycle, priority: row.priority, entrada: row.entrada, client_days: row.client_days }))
        .sort((a, b) => String(a.display_name ?? "").localeCompare(String(b.display_name ?? ""), "pt-BR"))
    : [];

  const rawProductivity30 = value<any[]>(results[12], []);
  const rawProductivityDaily = value<any[]>(results[13], []);
  const rawRecentCompleted = value<any[]>(results[14], []);
  const clickupScoped = isFull;
  const productivity30 = clickupScoped ? rawProductivity30 : rawProductivity30.filter((row) => norm(row.person) === norm(profileClickupUser));
  const productivityDaily = clickupScoped ? rawProductivityDaily : rawProductivityDaily.filter((row) => norm(row.person) === norm(profileClickupUser));
  const recentCompleted = clickupScoped ? rawRecentCompleted : rawRecentCompleted.filter((row: any) => (row.clickup_task_assignees ?? []).some((a: any) => norm(a.username) === norm(profileClickupUser)));

  // ---- Pre-clientes: filtra registros sinteticos de teste e, para carteiras (GT), oculta a
  // aba inteira (nao e' area de trabalho de gestor de trafego).
  const preclientsRaw = value<any[]>(platformData[1], []).filter((row) => !SYNTHETIC_NAME.test(String(row.name ?? "").trim()) && !SYNTHETIC_NAME.test(String(row.company ?? "").trim()));
  const preclients = isWalletOnly ? [] : preclientsRaw;

  // ---- Notificacoes: enriquecidas com gestor/carteira do cliente e escopadas por carteira.
  const notifications = value<any[]>(platformData[0], [])
    .filter((row) => inScope(row.client_id))
    .map((row) => {
      const meta = row.client_id ? clientMeta.get(row.client_id) : null;
      return { ...row, client_display_name: meta?.display_name ?? null, gestor: meta?.gt_owner ?? null, cs_owner: meta?.cs_owner ?? null, carteira: walletName(meta?.gt_owner) };
    });

  // 70 das 191 conversas nao tem client_id e apareciam com o chat_id cru na tela.
  // O nome do grupo existe em whatsapp_chat_registry para todas elas.
  const chatMeta = new Map(value<any[]>(teamData[6], []).map((row: any) => [row.chat_id, row]));
  const conversationsEnriched = conversations.map((row: any) => {
    const meta = chatMeta.get(row.chat_id);
    return { ...row, chat_name: meta?.chat_name ?? null, message_count: meta?.message_count ?? null, last_seen_at: meta?.last_seen_at ?? null };
  });

  // ---- Carteira de Clientes. Replica o relatorio de 14/08/2026 sobre dado vivo.
  // Restrito a perfis FULL: expoe inadimplencia, juridico e churn previsto da base inteira.
  const pfLive = value<any[]>(teamData[7], []);
  const pfTimeline = value<any[]>(teamData[8], []);
  const pfClients = value<any[]>(teamData[9], []);
  const pfTenure = value<any[]>(teamData[10], []);
  const pfAudit = value<any[]>(teamData[11], []);
  const pfChurn = value<any[]>(teamData[12], []);
  const somaSetores = (campo: string) => pfLive.reduce((total, row: any) => total + number(row[campo]), 0);
  const portfolio = isFull ? {
    reference: new Date().toISOString().slice(0, 10),
    total_active: somaSetores("active_clients"),
    sectors: pfLive,
    status_summary: {
      inadimplentes: somaSetores("inadimplentes"),
      juridico: somaSetores("juridico"),
      churn_previsto: somaSetores("churn_previsto"),
    },
    // "Proximas transicoes": clientes a <=10 dias de mudar de faixa, o limiar do relatorio.
    transitions: pfClients
      .filter((row: any) => row.urgencia === "urgente")
      .sort((a: any, b: any) => number(a.dias_para_proxima) - number(b.dias_para_proxima)),
    clients: pfClients,
    tenure_distribution: pfTenure,
    timeline: pfTimeline,
    churns: pfChurn,
    audit: pfAudit,
    // Curva de sobrevivencia: risco por faixa de idade, nao distribuicao dos churns.
    survival: value<any[]>(teamData[13], []),
    gt_retention: value<any[]>(teamData[14], []),
    long_series: value<any[]>(teamData[15], []),
    operational_signal: value<any[]>(teamData[16], []).filter((row: any) => row.sinal !== "ativo" && row.sinal !== "churned"),
    signal_summary: value<any[]>(teamData[16], [])
      .filter((row: any) => ["ACTIVE","ONBOARDING"].includes(row.lifecycle))
      .reduce((acc: any, row: any) => { acc[row.sinal] = (acc[row.sinal] ?? 0) + 1; return acc; }, {}),
  } : null;

  const wonEvents = value<any[]>(platformData[2], []).filter((row) => inScope(row.client_id));
  const preferencesRow = value(platformData[5], {});
  const myAccessRequest = value<any[]>(teamData[5], [])[0] ?? null;

  // ---- Diario. Antes o registro de tarefas so' voltava para perfis FULL, entao a aba
  // Diario de quem nao e' FULL mostrava a propria lista sempre vazia. Agora sempre volta:
  // FULL ve a equipe, os demais veem o que eles mesmos escreveram - que e' o que a tela
  // ja' prometia no titulo ("Minhas ultimas tarefas").
  const taskLogRows = value<any[]>(platformData[7], []);
  const taskLog = aggregateTaskLog(isFull ? taskLogRows : taskLogRows.filter((row: any) => row.user_key === currentUserKey));
  const adjustments = value<any[]>(platformData[8], [])
    .filter((row: any) => inScope(row.client_id))
    .map((row: any) => ({ ...row, client_display_name: row.client_id ? (clientMeta.get(row.client_id)?.display_name ?? null) : null }));

  return respond({
    kpis: { active_clients: activeClients.length, churned_clients: clients.filter((row) => row.lifecycle === "CHURNED").length, onboarding_clients: clients.filter((row) => row.lifecycle === "ONBOARDING").length, operation_clients: clients.filter((row) => row.lifecycle === "ACTIVE").length, attention_now: count((row) => row.priority === "ATTENTION"), follow_up: count((row) => row.priority === "FOLLOW_UP"), ok: count((row) => row.priority === "OK"), undetermined: count((row) => row.priority === "UNDETERMINED"), data_incomplete: count((row) => row.priority === "DATA_INCOMPLETE"), client_waiting_agency: count((row) => row.waiting_direction === "CLIENT_WAITING_AGENCY"), agency_waiting_client: count((row) => row.waiting_direction === "AGENCY_WAITING_CLIENT"), overdue_commitments: overdue.filter((row) => !row.client_id || activeIds.has(row.client_id)).length, open_alerts: alerts.filter((row) => !row.client_id || activeIds.has(row.client_id)).length, critical_alerts: alerts.filter((row) => (!row.client_id || activeIds.has(row.client_id)) && ["CRITICAL", "HIGH"].includes(row.severity)).length, semantic_review: conversations.filter((row) => row.needs_semantic_review && (!row.client_id || activeIds.has(row.client_id))).length, briefing_pages: briefings.length, briefing_pending: briefings.filter((row) => row.sync_status === "DISCOVERED").length, briefing_unlinked: briefings.filter((row) => !row.client_id).length, queue_pending: isFull ? queue.filter((row) => row.status === "PENDING").length : 0, queue_errors: isFull ? queue.filter((row) => row.status === "ERROR").length : 0, team_members: team.filter((row) => row.in_roster).length, clients_unassigned: unassignedClients.length, team_unassigned: team.filter((row) => !row.in_roster && !row.is_former).length },
    clients: enrichedClients, campaigns,
    alerts: alerts.sort((a, b) => (severity[a.severity] ?? 9) - (severity[b.severity] ?? 9)).slice(0, 100),
    commitments, conversations: conversationsEnriched, media: aggregateMedia(activeMediaRows),
    operations: {
      // Enriquecidas: 70 das 191 conversas nao tem client_id e a fila do Foco do dia
      // mostrava o chat_id cru no lugar do nome do grupo.
      sla: { waiting_agency: conversationsEnriched.filter((row: any) => row.waiting_for_agency), waiting_client: conversationsEnriched.filter((row: any) => row.waiting_for_client), overdue_commitments: overdue },
      bottlenecks,
      // Evidencias e' tela de gestao: quem nao tem a aba tambem nao recebe o dado.
      evidence_review: canView("evidence") ? evidenceReview.slice(0, 100) : [],
      employee_capacity: isFull ? value(results[10], []) : [],
      task_log: taskLog,
    },
    adjustments,
    clickup: isFull ? { productivity_30d: productivity30, productivity_daily: productivityDaily, recent_completed: recentCompleted, total_completed: totalClickup, last_sync: lastClickupSync, configured: Boolean(clickupConfig?.token && clickupConfig?.team_id), webhook_configured: Boolean(clickupConfig?.webhook_secret), indexing: { matched: matchedClickup, match_rate: totalClickup ? Number((100 * matchedClickup / totalClickup).toFixed(1)) : 0, unmatched_label: results[18].count ?? 0, without_label: results[19].count ?? 0, unmatched_labels: value(results[20], []) } } : { productivity_30d: productivity30, productivity_daily: productivityDaily, recent_completed: recentCompleted, total_completed: recentCompleted.length, last_sync: null, configured: null, webhook_configured: null, indexing: null },
    coverage: { complete: count((row) => row.data_coverage === "COMPLETE"), partial: count((row) => row.data_coverage === "PARTIAL"), incomplete: count((row) => row.data_coverage === "INCOMPLETE") },
    notifications, preclients: canView("preclients") ? preclients : [], won_events: wonEvents,
    audit_runs: canView("audit") ? value(platformData[3], []) : [], audit_issues: canView("audit") ? value(platformData[4], []) : [],
    preferences: { ...preferencesRow, my_access_request: myAccessRequest },
    integration_health: isFull ? value(platformData[6], []) : [],
    team, unassigned_clients: canView("team") ? unassignedClients : [],
    // Quem opera uma carteira ve o codinome dela; quem ve o quadro inteiro ve todas.
    wallets: canView("team") ? wallets : [],
    portfolio: canView("clients") ? portfolio : null, stage_labels: stageLabels,
    // Quem nao decide nao precisa da fila: o gate era isFull, entao todo perfil de
    // acesso total recebia os nomes de quem esta esperando aprovacao sem poder aprovar.
    access_requests_pending: canDecideAccessRequests ? value(teamData[4], []) : [],
    profile: { person: profilePerson, role: profileRole, access_level: accessLevel, elevated, can_decide_access_requests: canDecideAccessRequests, locked: isLocked, account_approved: accountApproved, views: allowedViews, carteira: walletName(profilePerson) },
    health: isFull ? { latest_whatsapp_message: value<any[]>(results[8], [])[0] ?? null, latest_notion_sync: value<any[]>(results[5], [])[0] ?? null, failed_jobs_24h: jobs.filter((row) => row.status === "ERROR" && new Date(row.started_at) > new Date(Date.now() - 86400000)), last_jobs: jobs.slice(0, 10) } : { latest_whatsapp_message: null, latest_notion_sync: null, failed_jobs_24h: [], last_jobs: [] },
    auth_mode: currentUserKey === "adler-furtado" && suppliedKey.length >= 40 ? "dashboard_key" : "login",
    generated_at: new Date().toISOString(),
  });
});
