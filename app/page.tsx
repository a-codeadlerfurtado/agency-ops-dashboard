"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-dashboard-api`;
const CLICKUP_API_URL = `${SUPABASE_URL}/functions/v1/clickup-sync-api`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Row = Record<string, any>;
type TeamMember = {
  person: string;
  role: "GT" | "CS" | "DESIGN" | "AI" | "MGMT" | "UNASSIGNED" | "FORMER";
  in_roster: boolean;
  is_former: boolean;
  former_reason: string | null;
  clickup_user: string | null;
  missing_clickup_link: boolean;
  clients_active: number;
  clients_onboarding: number;
  tasks_done: number;
  tasks_open: number;
  tasks_overdue: number;
  tasks_done_30d: number;
  clients_touched: number;
  tasks_created_total: number;
  tasks_created_30d: number;
  portfolio: Array<{ client_id: string; display_name: string; priority: "ATTENTION" | "FOLLOW_UP" | "OK" | "DATA_INCOMPLETE" | "UNDETERMINED" | null; lifecycle: "ACTIVE" | "ONBOARDING"; next_step: string | null }>;
};
type HomeData = {
  kpis: Row;
  clients: Row[];
  alerts: Row[];
  commitments?: Row[];
  conversations?: Row[];
  media: Row;
  health: Row;
  operations?: Row;
  clickup?: Row;
  campaigns?: Row[];
  notifications?: Row[];
  preclients?: Row[];
  won_events?: Row[];
  audit_runs?: Row[];
  audit_issues?: Row[];
  preferences?: Row;
  integration_health?: Row[];
  team?: TeamMember[];
  unassigned_clients?: Row[];
  stage_labels?: Record<string, string>;
  profile?: Row;
  access_requests_pending?: Row[];
  generated_at: string;
};

type View = "overview" | "focus" | "clients" | "onboarding" | "campaigns" | "preclients" | "conversations" | "team" | "clickup" | "evidence" | "audit" | "alerts";

const pt: Record<string,string> = { ATTENTION:"Atenção",FOLLOW_UP:"Acompanhamento",UNDETERMINED:"Indeterminado",DATA_INCOMPLETE:"Dados incompletos",OK:"OK",ACTIVE:"Ativo",ONBOARDING:"Onboarding",CHURNED:"Churned",COMPLETE:"Completa",PARTIAL:"Parcial",INCOMPLETE:"Incompleta",SUCCESS:"Sucesso",ERROR:"Erro",RUNNING:"Em execução",OPEN:"Aberto",COMPLETED:"Concluído",ABORTED:"Encerrado",CRITICAL:"Crítico",HIGH:"Alto",MEDIUM:"Médio",LOW:"Baixo",CONNECTED:"Conectado",CONECTADO:"Conectado" };

const priorityRank: Record<string, number> = {
  ATTENTION: 0,
  FOLLOW_UP: 1,
  UNDETERMINED: 2,
  DATA_INCOMPLETE: 3,
  OK: 4,
};

function formatNumber(value: unknown, digits = 1) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(value || 0));
}

function formatMoney(value: unknown) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatDate(value: unknown) {
  if (!value) return "sem registro";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(String(value)));
}

function relativeDate(value: unknown) {
  if (!value) return "sem prazo";
  const days = Math.ceil((new Date(String(value)).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return `${Math.abs(days)}d atrasado`;
  if (days === 0) return "vence hoje";
  return `em ${days}d`;
}

function daysSince(value: unknown) {
  if (!value) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(String(value)).getTime()) / 86_400_000));
}

function healthScore(client: Row) {
  if (client.health?.score != null) return Math.round(Number(client.health.score));
  let score = 100;
  if (client.priority === "ATTENTION") score -= 42;
  if (client.priority === "FOLLOW_UP") score -= 22;
  if (["DATA_INCOMPLETE", "UNDETERMINED"].includes(client.priority)) score -= 16;
  score -= Math.min(24, Number(client.overdue_commitments || 0) * 8);
  score -= Math.min(18, Number(client.open_complaints || 0) * 9);
  if (client.data_coverage !== "COMPLETE") score -= 10;
  return Math.max(0, score);
}

function text(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}

function initials(value: unknown) {
  return String(value || "CO").trim().split(/\s+/).map((part) => part[0]).slice(0,2).join("").toUpperCase();
}

async function api(view: string, token: string, params: Record<string, string> = {}) {
  const url = new URL(API_URL);
  url.searchParams.set("view", view);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function apiPost(view: string, token: string, body: Row = {}) {
  const response = await fetch(`${API_URL}?view=${encodeURIComponent(view)}`, { method:"POST", headers:{Authorization:`Bearer ${token}`,"content-type":"application/json"}, body:JSON.stringify(body) });
  if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
  return response.json();
}

async function clickupAction(action: "register" | "sync", token: string) {
  if (action === "register") {
    const response = await fetch(`${CLICKUP_API_URL}?action=register`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || body.error || `ClickUp ${response.status}`);
    return body;
  }
  let pageStart = 0;
  const totals = { tasks_seen: 0, tasks_upserted: 0, tasks_closed: 0 };
  for (let batch = 0; batch < 100; batch++) {
    const response = await fetch(`${CLICKUP_API_URL}?action=sync&since_days=180&page_start=${pageStart}&max_pages=5`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || body.error || `ClickUp ${response.status}`);
    totals.tasks_seen += Number(body.tasks_seen || 0);
    totals.tasks_upserted += Number(body.tasks_upserted || 0);
    totals.tasks_closed += Number(body.tasks_closed || 0);
    if (body.next_page == null) return { ...body, ...totals };
    pageStart = Number(body.next_page);
  }
  throw new Error("A importação atingiu o limite de páginas; tente novamente para continuar.");
}

function Chip({ value }: { value: unknown }) {
  const raw = text(value);
  return <span className={`chip ${raw}`}>{pt[raw] || raw.replaceAll("_", " ")}</span>;
}

function Metric({ label, value, tone = "", hint = "" }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <article className="card metric">
      <div className="label">{label}</div>
      <div className={`value ${tone}`}>{value}</div>
      <div className="hint">{hint}</div>
    </article>
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [collaborator, setCollaborator] = useState("");
  const [roster, setRoster] = useState<Row[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (mode !== "signup") return;
    setRosterLoading(true);
    fetch(`${API_URL}?view=roster`, { cache: "no-store" })
      .then((response) => response.json())
      .then((json) => setRoster(json.roster || []))
      .catch(() => setRoster([]))
      .finally(() => setRosterLoading(false));
  }, [mode]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      if (mode === "signup") {
        if (!collaborator) throw new Error("Selecione qual colaborador da empresa você é.");
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { name: name.trim(), full_name: name.trim(), collaborator_person: collaborator } } });
        if (error) throw error;
        if (!data.session) setMessage("Cadastro criado. Confirme seu e-mail para entrar.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Não foi possível autenticar."); }
    finally { setBusy(false); }
  }

  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><div className="logo">A</div><div><span className="eyebrow">AGENCY OPS</span><h1>Central de Operações</h1><p>Acesse seu perfil para continuar.</p></div></div><div className="auth-tabs"><button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setMessage(""); }}>Entrar</button><button type="button" className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setMessage(""); }}>Criar conta</button></div><form onSubmit={submit}>{mode === "signup" && <label>Nome completo<input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Seu nome" /></label>}{mode === "signup" && <label>Qual colaborador da empresa você é?<select required value={collaborator} onChange={(event) => setCollaborator(event.target.value)}><option value="">{rosterLoading ? "Carregando…" : "Selecione…"}</option>{roster.map((person) => <option key={person.person} value={person.person}>{person.person}</option>)}</select>{!rosterLoading && !roster.length && <small className="auth-hint">Todos os colaboradores já têm conta. Fale com o Adler se precisar de acesso.</small>}</label>}<label>E-mail<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@empresa.com" /></label><label>Senha<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mínimo de 6 caracteres" /></label>{message && <p className="auth-message" role="status">{message}</p>}<button className="auth-submit" disabled={busy}>{busy ? "Processando…" : mode === "login" ? "Entrar no dashboard" : "Criar minha conta"}</button></form></section></main>;
}

export default function Dashboard() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [data, setData] = useState<HomeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [view, setView] = useState<View>("overview");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [opsQuestion, setOpsQuestion] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lifecycleFilter, setLifecycleFilter] = useState("ACTIVE");
  const [campaignFilter, setCampaignFilter] = useState("ACTIVE");
  const [commandOpen, setCommandOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<Row | null>(null);
  const [toastLeaving, setToastLeaving] = useState(false);
  const [win, setWin] = useState<Row | null>(null);
  const loadedRef = useRef(false);
  const lastNotificationRef = useRef<string | null>(null);
  const preferencesRef = useRef<Row>({});

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: current } }) => { setSession(current); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, current) => { setSession(current); setAuthReady(true); if (!current) { setData(null); loadedRef.current = false; } });
    return () => subscription.unsubscribe();
  }, []);

  const playTone = useCallback((kind: "pop" | "win") => {
    const prefs = preferencesRef.current;
    if (prefs.sounds_enabled === false || (kind === "win" && prefs.win_sound_enabled === false)) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const notes = kind === "win" ? [523,659,784] : [620,820];
      notes.forEach((frequency,index) => { const osc=ctx.createOscillator(); const gain=ctx.createGain(); osc.type="sine"; osc.frequency.value=frequency; gain.gain.setValueAtTime(0,ctx.currentTime); gain.gain.linearRampToValueAtTime(kind === "win" ? .07 : .045,ctx.currentTime+index*.11+.015); gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+index*.11+(kind === "win" ? .42 : .18)); osc.connect(gain).connect(ctx.destination); osc.start(ctx.currentTime+index*.11); osc.stop(ctx.currentTime+index*.11+(kind === "win" ? .45 : .2)); });
    } catch { /* áudio nunca interrompe a interface */ }
  }, []);

  const load = useCallback(async () => {
    if (!session?.access_token) return;
    if (!loadedRef.current) setLoading(true);
    setError("");
    try {
      const next = await api("home", session.access_token);
      preferencesRef.current = next.preferences || {};
      const newest = next.notifications?.[0];
      if (loadedRef.current && newest?.id && newest.id !== lastNotificationRef.current) {
        setToast(newest);
        if (newest.type === "CLIENT_WON") { setWin(newest); playTone("win"); } else playTone("pop");
      }
      lastNotificationRef.current = newest?.id || null;
      setData(next);
      loadedRef.current = true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha desconhecida");
    } finally {
      setLoading(false);
    }
  }, [playTone, session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    load();
    const timer = window.setInterval(load, 30_000);
    const onVisibility = () => {
      if (!document.hidden) load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, session?.access_token]);

  useEffect(() => {
    if (!toast) { setToastLeaving(false); return; }
    setToastLeaving(false);
    const fadeTimer = window.setTimeout(() => setToastLeaving(true), 4500);
    const removeTimer = window.setTimeout(() => setToast(null), 5000);
    return () => { window.clearTimeout(fadeTimer); window.clearTimeout(removeTimer); };
  }, [toast]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSelected(null); setCommandOpen(false); setProfileOpen(false); setNotificationsOpen(false); setSettingsOpen(false); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setCommandOpen(true); }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);

  useEffect(() => {
    const saved = window.localStorage.getItem("ops-theme");
    if (saved === "light") setTheme("light");
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("ops-theme", theme);
  }, [theme]);

  const clients = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return (data?.clients || [])
      .filter((client) => {
        const haystack = [client.display_name, client.cs_owner, client.gt_owner, client.current_subject, client.next_step]
          .join(" ")
          .toLocaleLowerCase("pt-BR");
        const lifecycleOk = lifecycleFilter === "ALL" || (lifecycleFilter === "ACTIVE" ? ["ACTIVE","ONBOARDING"].includes(client.lifecycle) : client.lifecycle === lifecycleFilter);
        return lifecycleOk && (!needle || haystack.includes(needle)) && (filter === "ALL" || client.priority === filter);
      })
      .sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) || text(a.display_name).localeCompare(text(b.display_name)));
  }, [data, query, filter, lifecycleFilter]);

  async function requestAccess() {
    if (!session?.access_token) return;
    try { await apiPost("access-request", session.access_token, {}); await load(); } catch { /* ignore */ }
  }

  async function decideAccessRequest(id: string, decision: "APPROVED" | "DENIED") {
    if (!session?.access_token) return;
    await apiPost("access-request-decide", session.access_token, { id, decision });
    await load();
  }

  async function openClient(clientId: string) {
    if (!session?.access_token) return;
    setSelected({ display_name: "Carregando…" });
    setDetailLoading(true);
    try {
      setSelected(await api("client", session.access_token, { id: clientId }));
    } catch (caught) {
      setSelected({ error: caught instanceof Error ? caught.message : "Falha ao carregar cliente" });
    } finally {
      setDetailLoading(false);
    }
  }

  const kpis = data?.kpis || {};
  const media = data?.media || {};
  const health = data?.health || {};
  const failedJobs = (health.failed_jobs_24h || []).length;
  const notion = health.latest_notion_sync;
  const allClients = data?.clients || [];
  const activeClients = useMemo(() => allClients.filter((client) => ["ACTIVE","ONBOARDING"].includes(client.lifecycle)), [data]);
  const actionClients = useMemo(() => activeClients
    .filter((client) => ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(client.priority) || client.next_step)
    .sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9)), [data]);
  const onboardingGroups = useMemo(() => {
    const groups = new Map<string, Row[]>();
    activeClients.filter((client) => client.lifecycle === "ONBOARDING" || client.onboarding_status === "OPEN").forEach((client) => {
      const stage = text(client.onboarding_stage || client.onboarding_status || "SEM ETAPA");
      groups.set(stage, [...(groups.get(stage) || []), client]);
    });
    return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [activeClients]);
  const unread = (data?.notifications || []).filter((item) => !item.read_at).length;
  const filteredCampaigns = (data?.campaigns || []).filter((row) => campaignFilter === "ALL" || (campaignFilter === "ACTIVE" ? ["ACTIVE","ONBOARDING"].includes(row.lifecycle) : row.lifecycle === campaignFilter));

  if (!authReady) return <div className="auth-loading"><span className="dot loading"/> Validando sessão…</div>;
  if (!session) return <AuthScreen />;

  return (
    <main className="shell">
      <header className="top">
        <div className="brand">
          <div className="logo">A</div>
          <div>
            <h1>Central de Operações</h1>
            <div className="subtitle">Clientes, onboarding, WhatsApp e mídia em um só lugar</div>
          </div>
        </div>
        <div className="live">
          <span className={`dot ${loading ? "loading" : error ? "error" : ""}`} />
          <span>{loading ? "Atualizando…" : error ? "Problema de sincronização" : "Sistemas sincronizados"}</span>
          <button className="command-trigger" onClick={() => setCommandOpen(true)}>⌕ Pesquisar <kbd>Ctrl K</kbd></button>
          <button className="icon-btn" onClick={() => setNotificationsOpen(!notificationsOpen)} aria-label="Notificações">♢{unread > 0 && <b>{unread}</b>}</button>
          <button className="btn" onClick={load}>Atualizar</button>
          <button className="theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Alternar tema">{theme === "dark" ? "☀" : "☾"}</button>
          <button className="profile-trigger" onClick={() => setProfileOpen(!profileOpen)}><span className="avatar small-avatar">{initials(data?.preferences?.name)}</span><span><b>{text(data?.preferences?.name || session.user.user_metadata?.name || session.user.email)}</b><small>{text(data?.preferences?.role || "Colaborador")}</small></span></button>
        </div>
      </header>

      <div className="source-banner"><span>O dashboard prioriza e diagnostica.</span> O ClickUp continua sendo a fonte oficial para executar e concluir tarefas.</div>

      <nav className="view-nav" aria-label="Visões do dashboard">
        {([
          ["overview", "Visão geral"], ["focus", "Foco do dia"], ["clients", "Clientes"], ["onboarding", "Onboarding"], ["campaigns", "Campanhas"], ["preclients", "Pré-clientes"], ["conversations", "Conversas"], ["team", "Equipe"], ["clickup", "ClickUp"], ["evidence", "Evidências"], ["audit", "Auditoria"], ["alerts", "Alertas"],
        ] as [View, string][]).map(([key, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{label}</button>)}
      </nav>

      {error && <div className="error-box">{error}</div>}

      <section className="grid kpis">
        <Metric label="Clientes ativos" value={formatNumber(kpis.active_clients)} tone="blue" hint="Ativos + onboarding" />
        <Metric label="Atenção agora" value={formatNumber(kpis.attention_now)} tone="red" hint="prioridade operacional" />
        <Metric label="Follow-up" value={formatNumber(kpis.follow_up)} tone="yellow" hint="ação em acompanhamento" />
        <Metric label="Operação OK" value={formatNumber(kpis.ok)} tone="green" hint="sem pendência crítica" />
        <Metric label="Compromissos vencidos" value={formatNumber(kpis.overdue_commitments)} tone={kpis.overdue_commitments ? "red" : "green"} hint="em aberto" />
        <Metric label="Alertas abertos" value={formatNumber(kpis.open_alerts)} tone={kpis.critical_alerts ? "red" : "yellow"} hint={`${formatNumber(kpis.critical_alerts)} críticos/altos`} />
      </section>

      {view === "focus" && <FocusCenter clients={actionClients} operations={data?.operations || {}} alerts={data?.alerts || []} openClient={openClient} />}
      {view === "clients" && <ClientPortfolio clients={clients} total={allClients.length} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} lifecycleFilter={lifecycleFilter} setLifecycleFilter={setLifecycleFilter} openClient={openClient} />}
      {view === "onboarding" && <OnboardingBoard groups={onboardingGroups} stageLabels={data?.stage_labels || {}} openClient={openClient} />}
      {view === "campaigns" && <CampaignCenter media={media} campaigns={filteredCampaigns} clients={allClients} campaignFilter={campaignFilter} setCampaignFilter={setCampaignFilter} openClient={openClient} />}
      {view === "preclients" && <PreClientCenter rows={data?.preclients || []} won={data?.won_events || []} />}
      {view === "conversations" && <ConversationCenter conversations={data?.conversations || []} clients={allClients} openClient={openClient} />}
      {view === "team" && <TeamCenter team={data?.team || []} teamMembers={Number(kpis.team_members || 0)} unassigned={data?.unassigned_clients || []} openClient={openClient} />}
      {view === "clickup" && <ClickUpCenter clickup={data?.clickup || {}} reload={load} token={session.access_token} />}
      {view === "evidence" && <EvidenceCenter clients={allClients} operations={data?.operations || {}} openClient={openClient} />}
      {view === "audit" && <AuditCenter runs={data?.audit_runs || []} issues={data?.audit_issues || []} />}
      {view === "alerts" && <AlertCenter alerts={data?.alerts || []} clients={allClients} openClient={openClient} />}

      {view === "overview" && <><SmartSearch question={opsQuestion} setQuestion={setOpsQuestion} clients={allClients} conversations={data?.conversations || []} commitments={data?.commitments || []} openClient={openClient} />
      <AttentionCenter clients={activeClients} operations={data?.operations || {}} preclients={data?.preclients || []} />
      <ExecutiveBrief clients={activeClients} onboardingGroups={onboardingGroups} stageLabels={data?.stage_labels || {}} openClient={openClient} />
      <section className="card section media-section">
        <div className="section-head">
          <div>
            <div className="section-title">Mídia · última carga disponível</div>
            <div className="subtitle">{media.latest_date ? `Referência: ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date(`${media.latest_date}T12:00:00`))}` : "Nenhuma métrica carregada"}</div>
          </div>
        </div>
        <div className="grid media-grid">
          <Metric label="Investimento" value={formatMoney(media.spend)} tone="blue" hint={`${formatNumber(media.accounts)} contas`} />
          <Metric label="Leads" value={formatNumber(media.leads)} tone="green" hint="última referência" />
          <Metric label="CPL" value={media.cpl == null ? "—" : formatMoney(media.cpl)} tone={media.cpl == null ? "" : "yellow"} hint="investimento ÷ leads" />
          <Metric label="CTR" value={media.ctr == null ? "—" : `${formatNumber(media.ctr)}%`} hint="cliques ÷ impressões" />
        </div>
        {media.is_stale && <div className="media-note">⚠ A fonte de mídia está desatualizada há {formatNumber(media.age_days)} dias. O dashboard exibirá a nova carga automaticamente assim que ela entrar.</div>}
      </section>

      <div className="grid split">
        <section className="card section">
          <div className="section-head">
            <div>
              <div className="section-title">Carteira operacional</div>
              <div className="subtitle">{clients.length} de {data?.clients?.length || 0} clientes</div>
            </div>
            <div className="toolbar">
              <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, responsável ou assunto" />
              <select className="control" value={filter} onChange={(event) => setFilter(event.target.value)}>
                <option value="ALL">Todas as prioridades</option>
                <option value="ATTENTION">Atenção</option><option value="FOLLOW_UP">Acompanhamento</option><option value="OK">OK</option><option value="UNDETERMINED">Indeterminado</option><option value="DATA_INCOMPLETE">Dados incompletos</option>
              </select>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Cliente</th><th>Prioridade</th><th>Próxima ação</th><th>Responsáveis</th><th>Cobertura</th></tr></thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.client_id} onClick={() => openClient(client.client_id)}>
                    <td><div className="name">{text(client.display_name)}</div><div className="small">{text(client.current_subject || client.summary_today)}</div></td>
                    <td><Chip value={client.priority} /></td>
                    <td><div>{text(client.next_step)}</div><div className="small">{text(client.action_owner)}{client.next_step_due ? ` · ${formatDate(client.next_step_due)}` : ""}</div></td>
                    <td><div>CS: {text(client.cs_owner)}</div><div className="small">GT: {text(client.gt_owner)} · Design: {text(client.designer_owner)}</div></td>
                    <td><Chip value={client.data_coverage} /></td>
                  </tr>
                ))}
                {!clients.length && <tr><td colSpan={5} className="empty">Nenhum cliente nesse filtro.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="stack">
          <section className="card section">
            <div className="section-head"><div className="section-title">Saúde das fontes</div></div>
            <div className="health">
              <Health name="WhatsApp" status={health.latest_whatsapp_message ? `Ativo · ${formatDate(health.latest_whatsapp_message.received_at)}` : "Sem mensagens"} tone="green" />
              <Health name="Automação" status={failedJobs ? `Falhas: ${failedJobs}` : "Rotinas executando normalmente"} tone={failedJobs ? "red" : "green"} />
              <Health name="Notion" status={notion ? `${text(notion.status).toUpperCase()} · ${formatDate(notion.finished_at || notion.started_at)}` : "Sem sincronização"} tone={notion && text(notion.status).toUpperCase() === "SUCCESS" ? "green" : "yellow"} />
              <Health name="Meta Ads" status={media.latest_date ? `${media.is_stale ? "Desatualizado" : "Atualizado"} · ${media.latest_date}` : "Sem carga"} tone={media.is_stale ? "yellow" : "green"} />
            </div>
          </section>
          <section className="card section">
            <div className="section-head"><div className="section-title">Alertas abertos</div><span className="chip">{data?.alerts?.length || 0}</span></div>
            {(data?.alerts || []).slice(0, 12).map((alert) => <div className="alert" key={alert.id}><Chip value={alert.severity} /><div className="alert-title">{text(alert.title)}</div><div className="small">{text(alert.description)}</div></div>)}
            {!data?.alerts?.length && <div className="empty">Nenhum alerta aberto.</div>}
          </section>
        </aside>
      </div></>}

      {selected && <ClientDrawer detail={selected} loading={detailLoading} close={() => setSelected(null)} />}
      {commandOpen && <GlobalCommand clients={allClients} tasks={data?.clickup?.recent_completed || []} preclients={data?.preclients || []} close={() => setCommandOpen(false)} openClient={openClient} />}
      {profileOpen && <ProfileMenu preferences={data?.preferences || {}} profile={data?.profile || {}} email={session.user.email || ""} settings={() => { setProfileOpen(false); setSettingsOpen(true); }} close={() => setProfileOpen(false)} signOut={() => supabase.auth.signOut()} requestAccess={requestAccess} />}
      {notificationsOpen && <NotificationCenter items={data?.notifications || []} close={() => setNotificationsOpen(false)} refresh={load} openClient={openClient} token={session.access_token} pendingRequests={data?.access_requests_pending || []} canDecide={Boolean(data?.profile?.can_decide_access_requests)} decide={decideAccessRequest} />}
      {settingsOpen && <SettingsModal preferences={data?.preferences || {}} close={() => setSettingsOpen(false)} refresh={load} token={session.access_token} pendingRequests={data?.access_requests_pending || []} canDecide={Boolean(data?.profile?.can_decide_access_requests)} decide={decideAccessRequest} />}
      {toast && <button className={`toast${toastLeaving ? " leaving" : ""}`} onClick={() => { if (toast.client_id) openClient(toast.client_id); setToast(null); }}><Chip value={toast.level}/><span><b>{text(toast.title)}</b><small>{text(toast.actor ? `${toast.actor}: ${toast.description}` : toast.description)}</small>{(toast.gestor || toast.carteira) && <small className="toast-meta">{text(toast.carteira || (toast.gestor ? `Gestor: ${toast.gestor}` : ""))}</small>}</span><i onClick={(event) => { event.stopPropagation(); setToast(null); }}>×</i></button>}
      {win && data?.preferences?.win_celebration_enabled !== false && <button className="win-pulse" onClick={() => { if (win.client_id) openClient(win.client_id); setWin(null); }}><small>NOVO CLIENTE</small><strong>{text(win.description)}</strong><span>Acabou de entrar para a operação</span></button>}
    </main>
  );
}

function ExecutiveBrief({ clients, onboardingGroups, stageLabels, openClient }: { clients: Row[]; onboardingGroups: [string, Row[]][]; stageLabels: Record<string, string>; openClient: (id: string) => void }) {
  const counts = {
    attention: clients.filter((c) => c.priority === "ATTENTION").length,
    follow: clients.filter((c) => c.priority === "FOLLOW_UP").length,
    incomplete: clients.filter((c) => ["DATA_INCOMPLETE", "UNDETERMINED"].includes(c.priority)).length,
    ok: clients.filter((c) => c.priority === "OK").length,
  };
  const total = Math.max(clients.length, 1);
  const risk = [...clients].sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9)).slice(0, 6);
  const onboardingTotal = onboardingGroups.reduce((sum, [, rows]) => sum + rows.length, 0);
  const headline = counts.attention
    ? `${counts.attention} cliente${counts.attention > 1 ? "s" : ""} exige${counts.attention > 1 ? "m" : ""} ação imediata.`
    : counts.follow ? `A carteira está estável, com ${counts.follow} follow-up${counts.follow > 1 ? "s" : ""} em acompanhamento.`
    : "A carteira está estável e sem prioridade crítica registrada.";
  return <section className="executive-grid">
    <article className="card executive-story"><div className="eyebrow">Leitura executiva · agora</div><h2>{headline}</h2><p>{counts.incomplete ? `${counts.incomplete} registros ainda têm cobertura incompleta e podem limitar o diagnóstico.` : "A cobertura atual permite uma leitura consistente da operação."}</p><div className="method"><span>i</span><div><b>Como é calculado</b><small>Prioridade, cobertura, compromissos e alertas consolidados pelo motor operacional.</small></div></div></article>
    <article className="card portfolio-health"><div className="panel-heading"><div><span className="eyebrow">Saúde da carteira</span><h3>Distribuição operacional</h3></div><b>{Math.round((counts.ok / total) * 100)}% OK</b></div><div className="health-rail" aria-label="Distribuição de saúde"><i className="r-attention" style={{width:`${counts.attention / total * 100}%`}}/><i className="r-follow" style={{width:`${counts.follow / total * 100}%`}}/><i className="r-incomplete" style={{width:`${counts.incomplete / total * 100}%`}}/><i className="r-ok" style={{width:`${counts.ok / total * 100}%`}}/></div><div className="rail-legend"><span><i className="r-attention"/>Atenção <b>{counts.attention}</b></span><span><i className="r-follow"/>Follow-up <b>{counts.follow}</b></span><span><i className="r-incomplete"/>Dados <b>{counts.incomplete}</b></span><span><i className="r-ok"/>OK <b>{counts.ok}</b></span></div></article>
    <article className="card risk-watch"><div className="panel-heading"><div><span className="eyebrow">Prioridades</span><h3>Quem olhar primeiro</h3></div><span className="counter">{risk.length}</span></div>{risk.map((client, index) => <button key={client.client_id} onClick={() => openClient(client.client_id)}><span className="rank">{String(index + 1).padStart(2,"0")}</span><span><b>{text(client.display_name)}</b><small>{text(client.next_step || client.current_subject)}</small></span><Chip value={client.priority}/></button>)}</article>
    <article className="card compact-funnel"><div className="panel-heading"><div><span className="eyebrow">Onboarding</span><h3>Distribuição por etapa</h3></div><b>{onboardingTotal}</b></div>{onboardingGroups.slice(0, 6).map(([stage, rows]) => <div className="funnel-row" key={stage}><span>{stageLabels[stage] || stage.replaceAll("_"," ")}</span><div><i style={{width:`${Math.max(4, rows.length / Math.max(onboardingTotal,1) * 100)}%`}}/></div><b>{rows.length}</b></div>)}</article>
  </section>;
}

function SmartSearch({ question, setQuestion, clients, conversations, commitments, openClient }: { question: string; setQuestion: (value: string) => void; clients: Row[]; conversations: Row[]; commitments: Row[]; openClient: (id: string) => void }) {
  const needle = question.toLocaleLowerCase("pt-BR").trim();
  const matched = useMemo(() => {
    if (!needle) return [];
    const waitingIds = new Set(conversations.filter((row) => row.waiting_for_agency).map((row) => row.client_id));
    const overdueIds = new Set(commitments.filter((row) => row.due_at && new Date(row.due_at) < new Date()).map((row) => row.client_id));
    return clients.filter((client) => {
      const hay = [client.display_name, client.cs_owner, client.gt_owner, client.designer_owner, client.current_subject, client.summary_today, client.next_step, client.onboarding_stage].join(" ").toLocaleLowerCase("pt-BR");
      if (needle.includes("atras") || needle.includes("vencid")) return overdueIds.has(client.client_id) || Number(client.overdue_commitments) > 0;
      if (needle.includes("resposta") || needle.includes("esperando agência")) return waitingIds.has(client.client_id) || client.waiting_direction === "CLIENT_WAITING_AGENCY";
      if (needle.includes("onboarding")) return client.lifecycle === "ONBOARDING" || client.onboarding_status === "OPEN";
      if (needle.includes("campanha") || needle.includes("mídia") || needle.includes("midia")) return Boolean(client.media_account_key || client.meta_bm) || hay.includes("campanha") || hay.includes("mídia");
      if (needle.includes("reclama")) return Number(client.open_complaints || 0) > 0 || hay.includes("reclama");
      if (needle.includes("dados") || needle.includes("evidência") || needle.includes("evidencia")) return client.data_coverage !== "COMPLETE" || client.needs_semantic_review;
      return hay.includes(needle);
    }).slice(0, 12);
  }, [needle, clients, conversations, commitments]);
  return <section className="smart-search card"><div className="smart-mark">✦</div><div className="smart-main"><span className="eyebrow">Busca operacional inteligente</span><div className="smart-input"><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Pergunte: quem está atrasado, em onboarding ou esperando resposta?" />{question && <button onClick={() => setQuestion("")}>×</button>}</div>{!question && <div className="prompt-chips">{["Quem está atrasado?", "Onboardings em andamento", "Clientes esperando resposta", "Problemas de campanha"].map((item) => <button key={item} onClick={() => setQuestion(item)}>{item}</button>)}</div>}{question && <div className="smart-results"><small>{matched.length ? `${matched.length} resultado(s) encontrado(s)` : "Nenhum cliente corresponde aos sinais atuais."}</small>{matched.map((client) => <button key={client.client_id} onClick={() => openClient(client.client_id)}><span><b>{text(client.display_name)}</b><small>{text(client.next_step || client.current_subject)}</small></span><Chip value={client.priority} /></button>)}</div>}</div></section>;
}

function FocusCenter({ clients, operations, alerts, openClient }: { clients: Row[]; operations: Row; alerts: Row[]; openClient: (id: string) => void }) {
  const overdue = operations.sla?.overdue_commitments || [];
  const waiting = operations.sla?.waiting_agency || [];
  const summary = `${clients.filter((c) => c.priority === "ATTENTION").length} prioridades imediatas, ${overdue.length} compromissos vencidos, ${waiting.length} conversas esperando a agência e ${alerts.filter((a) => ["CRITICAL", "HIGH"].includes(a.severity)).length} alertas críticos/altos.`;
  return <section className="workspace"><div className="daily-brief card"><div><span className="eyebrow">Briefing automático</span><h2>O que merece atenção hoje</h2><p>{summary}</p></div><button onClick={() => navigator.clipboard?.writeText(`Resumo operacional: ${summary}`)}>Copiar resumo</button></div><ActionInbox clients={clients} openClient={openClient} /><div className="triage-grid"><section className="card section"><div className="section-title">SLA · esperando a agência</div>{waiting.slice(0, 15).map((row: Row) => <button className="triage-row" key={row.chat_id} onClick={() => row.client_id && openClient(row.client_id)}><span><b>{text(row.last_summary || row.open_question || row.chat_id)}</b><small>Desde {formatDate(row.waiting_since)}</small></span><Chip value={row.sla_level || row.conversation_status} /></button>)}{!waiting.length && <div className="empty compact">Nenhuma conversa aguardando a equipe.</div>}</section><section className="card section"><div className="section-title">Compromissos vencidos</div>{overdue.slice(0, 15).map((row: Row) => <button className="triage-row" key={row.id} onClick={() => row.client_id && openClient(row.client_id)}><span><b>{text(row.descricao || row.title)}</b><small>{text(row.owner)} · {relativeDate(row.due_at)}</small></span><Chip value="ATRASADO" /></button>)}{!overdue.length && <div className="empty compact">Nenhum compromisso vencido.</div>}</section></div></section>;
}

function ClientPortfolio({ clients, total, query, setQuery, filter, setFilter, lifecycleFilter, setLifecycleFilter, openClient }: { clients: Row[]; total: number; query: string; setQuery: (value: string) => void; filter: string; setFilter: (value: string) => void; lifecycleFilter:string; setLifecycleFilter:(value:string)=>void; openClient: (id: string) => void }) {
  return <section className="workspace"><div className="workspace-head"><div><h2>Carteira completa</h2><p>Saúde, tempo como cliente, responsáveis e próxima ação.</p></div><span className="counter">{clients.length} de {total}</span></div><section className="card section"><div className="toolbar portfolio-tools"><input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou responsável" /><select className="control" value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value)}><option value="ACTIVE">Ativos</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option></select><select className="control" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="ALL">Todas as prioridades</option><option value="ATTENTION">Atenção</option><option value="FOLLOW_UP">Acompanhamento</option><option value="OK">OK</option><option value="UNDETERMINED">Indeterminado</option><option value="DATA_INCOMPLETE">Dados incompletos</option></select></div><div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Status</th><th>Saúde</th><th>Tempo como cliente</th><th>Próxima ação</th><th>Responsável</th></tr></thead><tbody>{clients.map((client) => { const score = healthScore(client); return <tr key={client.client_id} onClick={() => openClient(client.client_id)}><td><div className="name">{text(client.display_name)}</div><div className="small">{text(client.current_subject)}</div></td><td><Chip value={client.lifecycle}/></td><td><div className="score"><b>{score}</b><i><span style={{width:`${score}%`}} /></i></div></td><td>{client.entrada ? <><div>{formatNumber(client.client_days,0)} dias</div><div className="small">desde {new Intl.DateTimeFormat("pt-BR").format(new Date(`${client.entrada}T12:00:00`))}</div></> : "Revisão manual"}</td><td>{client.lifecycle === "CHURNED" ? "Histórico encerrado" : text(client.next_step)}<div className="small">{client.lifecycle === "CHURNED" ? "Sem alerta operacional" : relativeDate(client.next_step_due)}</div></td><td>{text(client.action_owner || client.cs_owner)}</td></tr>; })}{!clients.length && <tr><td colSpan={6} className="empty">Nenhum cliente nesse filtro.</td></tr>}</tbody></table></div></section></section>;
}

function CampaignCenter({ media, campaigns, clients, campaignFilter, setCampaignFilter, openClient }: { media: Row; campaigns: Row[]; clients: Row[]; campaignFilter:string; setCampaignFilter:(value:string)=>void; openClient: (id: string) => void }) {
  const clientById = new Map(clients.map((client) => [client.client_id, client]));
  const visibleClients=clients.filter((client)=>campaignFilter==="ALL"||(campaignFilter==="ACTIVE"?["ACTIVE","ONBOARDING"].includes(client.lifecycle):client.lifecycle===campaignFilter));
  return <section className="workspace"><div className="filter-tabs"><button className={campaignFilter==="ACTIVE"?"active":""} onClick={()=>setCampaignFilter("ACTIVE")}>Ativos</button><button className={campaignFilter==="CHURNED"?"active":""} onClick={()=>setCampaignFilter("CHURNED")}>Churned</button><button className={campaignFilter==="ALL"?"active":""} onClick={()=>setCampaignFilter("ALL")}>Todos</button></div><MediaCenter media={media} clients={visibleClients} openClient={openClient} />{campaigns.length > 0 && <section className="card section"><div className="section-head"><div><div className="section-title">Diagnóstico por cliente</div><div className="subtitle">Volume, eficiência e atualidade da última carga</div></div></div><div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Status</th><th>Investimento</th><th>Leads</th><th>CPL</th><th>Diagnóstico</th></tr></thead><tbody>{campaigns.map((row) => <tr key={`${row.client_id}-${row.account_key}`} onClick={() => row.client_id && openClient(row.client_id)}><td><b>{text(row.display_name || clientById.get(row.client_id)?.display_name || row.account_key)}</b><div className="small">{text(row.latest_date)}</div></td><td><Chip value={row.lifecycle}/></td><td>{formatMoney(row.spend)}</td><td>{formatNumber(row.leads)}</td><td>{row.cpl == null ? "—" : formatMoney(row.cpl)}</td><td><CampaignDiagnosis row={row} /></td></tr>)}</tbody></table></div></section>}{!campaigns.length&&<div className="card empty">Nenhuma campanha neste filtro.</div>}</section>;
}

function CampaignDiagnosis({ row }: { row: Row }) {
  if (row.is_stale) return <Chip value="DADOS DESATUALIZADOS" />;
  if (Number(row.spend) > 0 && Number(row.leads) === 0) return <Chip value="SEM LEADS" />;
  if (row.ctr != null && Number(row.ctr) < .8) return <Chip value="REVISAR CRIATIVO" />;
  return <Chip value="MONITORAR" />;
}

function ConversationCenter({ conversations, clients, openClient }: { conversations: Row[]; clients: Row[]; openClient: (id: string) => void }) {
  const clientById = new Map(clients.map((client) => [client.client_id, client]));
  // 70 das 191 conversas nao tem cliente vinculado; o nome do grupo vem do registro do WhatsApp.
  const label = (row: Row) => text(clientById.get(row.client_id)?.display_name || row.chat_name || row.chat_id);
  // updated_at e' identico em todas as linhas (o job reescreve o lote inteiro), entao
  // nao serve para ordenar. Usamos o tempo de espera real.
  const since = (row: Row) => new Date(row.waiting_since || row.last_client_message_at || row.last_team_message_at || 0).getTime();
  const elapsed = (iso?: string | null) => {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return null;
    const h = Math.floor(ms / 3600000);
    if (h < 1) return `há ${Math.max(1, Math.floor(ms / 60000))}min`;
    if (h < 48) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  };
  const byOldest = (a: Row, b: Row) => since(a) - since(b);

  const waitingAgency = conversations.filter((row) => row.waiting_for_agency).sort(byOldest);
  const waitingClient = conversations.filter((row) => row.waiting_for_client && !row.waiting_for_agency).sort(byOldest);
  const questions = conversations.filter((row) => row.open_question && !row.waiting_for_agency).sort(byOldest);
  const unlinked = conversations.filter((row) => !row.client_id);
  const idle = conversations.filter((row) => !row.waiting_for_agency && !row.waiting_for_client && !row.open_question);

  const Row_ = ({ row, tone, note }: { row: Row; tone: string; note?: string | null }) =>
    <button key={row.chat_id} onClick={() => row.client_id && openClient(row.client_id)} disabled={!row.client_id}>
      <span className={`conversation-signal ${tone}`} />
      <div>
        <strong>{label(row)}</strong>
        <p>{text(row.open_question || row.last_summary || row.last_intent || "Sem pergunta em aberto")}</p>
        <small>{note || text(row.conversation_status)}{row.message_count ? ` · ${row.message_count} mensagens` : ""}</small>
      </div>
      <Chip value={row.sla_level || row.conversation_status} />
    </button>;

  return <section className="workspace conversation-center">
    <div className="workspace-head">
      <div><h2>Fila de conversas</h2><p>O que precisa de resposta agora, e quem está esperando quem.</p></div>
      <span className="counter">{conversations.length} conversas</span>
    </div>

    <div className="grid conversation-kpis">
      <article className="card metric"><div className="label">Esperando você</div><div className={`value ${waitingAgency.length ? "red" : "green"}`}>{waitingAgency.length}</div><div className="hint">cliente aguarda resposta</div></article>
      <article className="card metric"><div className="label">Aguardando cliente</div><div className="value yellow">{waitingClient.length}</div><div className="hint">bola com o cliente</div></article>
      <article className="card metric"><div className="label">Perguntas em aberto</div><div className="value blue">{questions.length}</div><div className="hint">sem resposta registrada</div></article>
      <article className="card metric"><div className="label">Não vinculadas</div><div className="value">{unlinked.length}</div><div className="hint">sem cliente no cadastro</div></article>
    </div>

    <section className="card conversation-block urgent">
      <div className="conversation-block-head"><b>Responder agora</b><span>{waitingAgency.length}</span></div>
      <div className="conversation-list">
        {waitingAgency.map((row) => <Row_ key={row.chat_id} row={row} tone="danger" note={elapsed(row.waiting_since) ? `Esperando ${elapsed(row.waiting_since)}` : "Cliente esperando a agência"} />)}
        {!waitingAgency.length && <div className="empty">Nada pendente com a agência.</div>}
      </div>
    </section>

    <details className="card conversation-block" open>
      <summary><b>Aguardando o cliente</b><span>{waitingClient.length}</span></summary>
      <div className="conversation-list">
        {waitingClient.map((row) => <Row_ key={row.chat_id} row={row} tone="warn" note={elapsed(row.last_team_message_at) ? `Cobrado ${elapsed(row.last_team_message_at)}` : "Agência esperando o cliente"} />)}
        {!waitingClient.length && <div className="empty">Ninguém pendente do lado do cliente.</div>}
      </div>
    </details>

    <details className="card conversation-block">
      <summary><b>Perguntas em aberto</b><span>{questions.length}</span></summary>
      <div className="conversation-list">
        {questions.map((row) => <Row_ key={row.chat_id} row={row} tone="" note={elapsed(row.last_client_message_at)} />)}
        {!questions.length && <div className="empty">Nenhuma pergunta em aberto.</div>}
      </div>
    </details>

    <details className="card conversation-block">
      <summary><b>Não vinculadas a cliente</b><span>{unlinked.length}</span></summary>
      <p className="conversation-note">Grupos do WhatsApp sem cliente correspondente no cadastro. O nome vem do registro de chats; vincular é feito na aba Clientes.</p>
      <div className="conversation-list">
        {unlinked.map((row) => <Row_ key={row.chat_id} row={row} tone="" note="Sem cliente vinculado" />)}
        {!unlinked.length && <div className="empty">Todas as conversas estão vinculadas.</div>}
      </div>
    </details>

    <details className="card conversation-block">
      <summary><b>Sem pendência</b><span>{idle.length}</span></summary>
      <div className="conversation-list">
        {idle.map((row) => <Row_ key={row.chat_id} row={row} tone="" note={text(row.conversation_status)} />)}
        {!idle.length && <div className="empty">Nenhuma conversa parada.</div>}
      </div>
    </details>
  </section>;
}

function TeamCenter({ team, teamMembers, unassigned, openClient }: { team: TeamMember[]; teamMembers: number; unassigned: Row[]; openClient: (id: string) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const active = team.filter((member) => member.in_roster && !member.is_former);
  const unregistered = team.filter((member) => !member.in_roster && !member.is_former);
  const former = team.filter((member) => member.is_former);
  const sections: Array<{ role: TeamMember["role"]; title: string }> = [
    { role: "GT", title: "Gestores de Tráfego" }, { role: "CS", title: "Customer Success" }, { role: "DESIGN", title: "Design" }, { role: "AI", title: "Inteligência Artificial" }, { role: "MGMT", title: "Gestão" },
  ];
  const roleLabel: Record<TeamMember["role"], string> = { GT:"Gestor de Tráfego", CS:"Customer Success", DESIGN:"Design", AI:"Head de IA", MGMT:"Gestão", UNASSIGNED:"Sem cadastro", FORMER:"Desligado" };
  const portfolioRank: Record<string, number> = { ATTENTION:0, FOLLOW_UP:1, DATA_INCOMPLETE:2, OK:3, UNDETERMINED:4 };
  function toggle(member: TeamMember) {
    if (member.role !== "GT" || member.portfolio.length === 0) return;
    setExpanded((current) => current === member.person ? null : member.person);
  }
  return <section className="workspace team-center">
    <div className="workspace-head"><div><h2>Capacidade da equipe</h2><p>Quadro completo, volume de tarefas e carteira dos gestores.</p></div><span className="counter">{teamMembers} pessoas</span></div>
    {sections.map(({ role, title }) => { const members = active.filter((member) => member.role === role); return <section className="team-role" key={role} aria-labelledby={`team-${role}`}><div className="team-role-head"><h3 id={`team-${role}`}>{title}</h3><span>{members.length}</span></div><div className="team-grid">{members.map((member) => {
      const canExpand = member.role === "GT" && member.portfolio.length > 0;
      const isExpanded = canExpand && expanded === member.person;
      const portfolio = [...member.portfolio].sort((a,b) => (portfolioRank[a.priority || "UNDETERMINED"] ?? 4) - (portfolioRank[b.priority || "UNDETERMINED"] ?? 4));
      return <article className={`card person-card ${canExpand ? "expandable" : ""}`} key={member.person}><div className="person-card-main" role={canExpand ? "button" : undefined} tabIndex={canExpand ? 0 : undefined} aria-expanded={canExpand ? isExpanded : undefined} onClick={() => toggle(member)} onKeyDown={(event) => { if (canExpand && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggle(member); } }}><div className="person-head"><div className="avatar">{member.person.split(" ").map((part) => part[0]).slice(0,2).join("")}</div><div><b>{member.person}</b><small>{roleLabel[member.role]}</small></div>{canExpand && <span className="expand-indicator" aria-hidden="true">{isExpanded ? "−" : "+"}</span>}</div><div className={`person-stats${member.role === "CS" ? " cs" : ""}`}>{member.role === "CS" ? <><span className="hero"><b>{formatNumber(member.tasks_created_total,0)}</b><small>Criadas</small></span><span><b>{formatNumber(member.tasks_created_30d,0)}</b><small>Criadas 30d</small></span><span><b>{formatNumber(member.tasks_done,0)}</b><small>Concluídas</small></span><span><b className={member.tasks_overdue > 0 ? "red" : ""}>{formatNumber(member.tasks_overdue,0)}</b><small>Atrasadas</small></span></> : <><span><b>{formatNumber(member.tasks_done,0)}</b><small>Concluídas</small></span><span><b>{formatNumber(member.tasks_open,0)}</b><small>Em aberto</small></span><span><b className={member.tasks_overdue > 0 ? "red" : ""}>{formatNumber(member.tasks_overdue,0)}</b><small>Atrasadas</small></span><span><b>{formatNumber(member.tasks_done_30d,0)}</b><small>30 dias</small></span></>}</div><div className="person-badges">{member.role === "GT" && member.portfolio.length === 0 && <span className="team-badge info">Opera por tarefa, sem carteira</span>}{member.missing_clickup_link && <span className="team-badge warning">Sem conta ClickUp vinculada</span>}</div></div>{isExpanded && <div className="person-portfolio"><div className="portfolio-summary"><b>{member.portfolio.length} clientes</b><small>{member.clients_onboarding} em onboarding</small></div>{portfolio.map((client) => <button key={client.client_id} onClick={() => openClient(client.client_id)}><span><b>{client.display_name}</b>{client.lifecycle === "ONBOARDING" && <small>Onboarding</small>}</span><Chip value={client.priority || "UNDETERMINED"}/></button>)}</div>}</article>;
    })}</div>{role === "GT" && unassigned.length > 0 && <div className="unassigned-warning"><div className="unassigned-head"><b>Cliente{unassigned.length > 1 ? "s" : ""} não distribuído{unassigned.length > 1 ? "s" : ""}</b><span>{unassigned.length}</span></div><p>Ativos sem gestor de tráfego atribuído. Não aparecem em nenhuma carteira acima.</p><div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Situação</th><th>Prioridade</th><th>Dias de casa</th></tr></thead><tbody>{unassigned.map((client) => <tr key={client.client_id} onClick={() => openClient(client.client_id)}><td><b>{text(client.display_name)}</b></td><td>{client.lifecycle === "ONBOARDING" ? "Onboarding" : "Ativo"}</td><td><Chip value={client.priority || "UNDETERMINED"}/></td><td>{client.client_days != null ? `${client.client_days}d` : "—"}</td></tr>)}</tbody></table></div></div>}</section>; })}
    <details className="card team-secondary"><summary>Sem cadastro no quadro <span>{unregistered.length}</span></summary><div className="table-wrap"><table><thead><tr><th>Nome</th><th>Concluídas</th><th>30 dias</th><th>Clientes tocados</th></tr></thead><tbody>{unregistered.map((member) => <tr key={member.person} className={member.tasks_done_30d === 0 ? "inactive-member" : ""}><td><b>{member.person}</b>{member.tasks_done_30d === 0 && <span className="inactive-label">Inativo</span>}</td><td>{formatNumber(member.tasks_done,0)}</td><td>{formatNumber(member.tasks_done_30d,0)}</td><td>{formatNumber(member.clients_touched,0)}</td></tr>)}</tbody></table></div></details>
    <details className="card team-secondary"><summary>Desligados <span>{former.length}</span></summary><div className="former-list">{former.map((member) => <div key={member.person}><span><b>{member.person}</b><small>{roleLabel[member.role]}</small></span><p>{member.former_reason || "Motivo não informado"}</p></div>)}</div></details>
  </section>;
}

function ClickUpCenter({ clickup, reload, token }: { clickup: Row; reload: () => Promise<void>; token: string }) {
  const productivity = clickup.productivity_30d || [];
  const recent = clickup.recent_completed || [];
  const indexing = clickup.indexing || {};
  const unmatchedLabels = indexing.unmatched_labels || [];
  const connected = Boolean(clickup.configured || clickup.last_sync || clickup.total_completed || productivity.length);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [collabFilter, setCollabFilter] = useState("ALL");
  const collaborators = useMemo(() => {
    const names = new Set<string>();
    productivity.forEach((row: Row) => row.person && names.add(row.person));
    recent.forEach((task: Row) => (Array.isArray(task.clickup_task_assignees) ? task.clickup_task_assignees : []).forEach((person: Row) => { const label = person.username || person.email; if (label) names.add(label); }));
    return [...names].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [productivity, recent]);
  const filteredProductivity = collabFilter === "ALL" ? productivity : productivity.filter((row: Row) => row.person === collabFilter);
  const filteredRecent = collabFilter === "ALL" ? recent : recent.filter((task: Row) => (Array.isArray(task.clickup_task_assignees) ? task.clickup_task_assignees : []).some((person: Row) => (person.username || person.email) === collabFilter));
  async function run(action: "register" | "sync") { setBusy(action); setMessage(""); try { const result = await clickupAction(action, token); setMessage(action === "register" ? "Webhook ativado com sucesso." : `${result.tasks_upserted || 0} tarefas importadas.`); await reload(); } catch (error) { setMessage(error instanceof Error ? error.message : "Falha na integração"); } finally { setBusy(""); } }
  return <section className="workspace">
    <div className="workspace-head"><div><h2>Produtividade no ClickUp</h2><p>Tarefas finalizadas são espelhadas no Supabase; a execução continua no ClickUp.</p></div><div className="clickup-actions"><Chip value={connected ? "CONECTADO" : "AGUARDANDO TOKEN"}/>{collaborators.length > 0 && <select className="control" value={collabFilter} onChange={(event) => setCollabFilter(event.target.value)}><option value="ALL">Todos os colaboradores</option>{collaborators.map((name) => <option key={name} value={name}>{name}</option>)}</select>}{clickup.configured && !clickup.webhook_configured && <button disabled={Boolean(busy)} onClick={() => run("register")}>{busy === "register" ? "Ativando…" : "Ativar tempo real"}</button>}{clickup.configured && <button disabled={Boolean(busy)} onClick={() => run("sync")}>{busy === "sync" ? "Importando…" : "Atualizar dados"}</button>}</div></div>
    {message && <div className="action-message">{message}</div>}
    <div className="grid clickup-kpis">
      <Metric label="Concluídas registradas" value={formatNumber(clickup.total_completed)} tone="green" hint="desde janeiro de 2026"/>
      <Metric label="Indexadas por cliente" value={indexing.matched == null ? "—" : `${formatNumber(indexing.matched)} · ${formatNumber(indexing.match_rate)}%`} tone="blue" hint={indexing.unmatched_label == null ? "acesso restrito" : `${formatNumber(indexing.unmatched_label)} rótulos pendentes`}/>
      <Metric label="Pessoas com entregas" value={formatNumber(productivity.length)} tone="blue" hint="últimos 30 dias"/>
      <Metric label="Última sincronização" value={clickup.last_sync ? text(clickup.last_sync.status) : "—"} tone={clickup.last_sync?.status === "SUCCESS" ? "green" : "yellow"} hint={formatDate(clickup.last_sync?.finished_at || clickup.last_sync?.started_at)}/>
    </div>
    {!connected && <div className="connection-note"><b>A ponte e o banco já estão prontos.</b><p>Falta configurar o token da API e o ID do Workspace ClickUp. O segredo do webhook será criado e guardado automaticamente ao ativar o tempo real.</p></div>}
    <div className="grid clickup-split">
      <section className="card section"><div className="section-title">Produção por pessoa · 30 dias{collabFilter !== "ALL" && ` · ${collabFilter}`}</div>{filteredProductivity.map((row: Row, index: number) => <div className="productivity-row" key={row.user_id}><span className="rank">{String(index+1).padStart(2,"0")}</span><div><b>{text(row.person)}</b><small>{formatNumber(row.tracked_hours)}h registradas · {row.on_time_pct == null ? "SLA sem base" : `${formatNumber(row.on_time_pct)}% no prazo`}</small></div><strong>{formatNumber(row.tasks_done)}</strong></div>)}{!filteredProductivity.length && <div className="empty">{productivity.length ? "Nenhum resultado para esse colaborador." : "Os indicadores aparecerão após a primeira sincronização."}</div>}</section>
      <section className="card section"><div className="section-title">Últimas tarefas concluídas{collabFilter !== "ALL" && ` · ${collabFilter}`}</div><div className="table-wrap"><table className="completed-table"><thead><tr><th>Tarefa</th><th>Colaborador</th><th>Lista e conclusão</th><th>Status</th></tr></thead><tbody>{filteredRecent.slice(0,20).map((task: Row) => { const assignees = Array.isArray(task.clickup_task_assignees) ? task.clickup_task_assignees : []; const collaboratorsLabel = assignees.map((person: Row) => person.username || person.email).filter(Boolean).join(", ") || "Não atribuído"; return <tr key={task.task_id}><td><a href={task.url || undefined} target="_blank" rel="noreferrer"><b>{text(task.name)}</b></a></td><td>{collaboratorsLabel}</td><td>{text(task.list_name)}<div className="small">{formatDate(task.date_closed)}</div></td><td><Chip value={task.status}/></td></tr>; })}{!filteredRecent.length && <tr><td colSpan={4} className="empty">{recent.length ? "Nenhuma tarefa desse colaborador." : "Nenhuma tarefa importada ainda."}</td></tr>}</tbody></table></div></section>
    </div>
    {unmatchedLabels.length > 0 && <section className="card section"><div className="section-title">Rótulos sem correspondência na base de clientes</div>{unmatchedLabels.slice(0,20).map((row: Row, index: number) => <div className="productivity-row" key={`${row.client_label}-${index}`}><span className="rank">{String(index+1).padStart(2,"0")}</span><div><b>[{text(row.client_label)}]</b><small>Requer cliente cadastrado ou confirmação de equivalência</small></div><strong>{formatNumber(row.task_count)}</strong></div>)}</section>}
  </section>;
}

function EvidenceCenter({ clients, operations, openClient }: { clients: Row[]; operations: Row; openClient: (id: string) => void }) {
  const review = operations.evidence_review || clients.filter((client) => client.data_coverage !== "COMPLETE" || client.needs_semantic_review);
  return <section className="workspace"><div className="workspace-head"><div><h2>Central de evidências</h2><p>Conclusões rastreáveis, cobertura da informação e pontos que precisam de revisão humana.</p></div><span className="counter">{review.length} revisões</span></div><div className="evidence-grid">{review.map((client: Row) => <button className="card evidence-card" key={client.client_id} onClick={() => openClient(client.client_id)}><div><strong>{text(client.display_name)}</strong><Chip value={client.data_coverage}/></div><p>{text(client.summary_today || client.current_subject)}</p><small>Confiança: {client.confidence == null ? "não calculada" : `${Math.round(Number(client.confidence)*100)}%`} · {client.needs_semantic_review ? "revisão semântica necessária" : "cobertura incompleta"}</small></button>)}{!review.length && <div className="card empty">Toda a carteira está com cobertura completa.</div>}</div></section>;
}

function ActionInbox({ clients, openClient }: { clients: Row[]; openClient: (id: string) => void }) {
  const buckets = [
    ["Agora", clients.filter((c) => c.priority === "ATTENTION")],
    ["Acompanhar", clients.filter((c) => c.priority === "FOLLOW_UP")],
    ["Completar dados", clients.filter((c) => c.priority === "DATA_INCOMPLETE")],
    ["Demais próximas ações", clients.filter((c) => !["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(c.priority)).slice(0, 20)],
  ] as [string, Row[]][];
  return <section className="workspace"><div className="workspace-head"><div><h2>Caixa de ação</h2><p>Prioridades consolidadas. A execução e a baixa continuam no ClickUp.</p></div><span className="counter">{clients.length} itens</span></div><div className="action-columns">{buckets.map(([title, rows]) => <section className="card lane" key={title}><div className="lane-head"><b>{title}</b><span>{rows.length}</span></div>{rows.slice(0, 30).map((client) => <button className="action-card" key={client.client_id} onClick={() => openClient(client.client_id)}><div><strong>{text(client.display_name)}</strong><Chip value={client.priority} /></div><p>{text(client.next_step)}</p><small>{text(client.action_owner)} · {relativeDate(client.next_step_due)}</small></button>)}{!rows.length && <div className="empty compact">Tudo limpo por aqui.</div>}</section>)}</div></section>;
}

function OnboardingBoard({ groups, stageLabels, openClient }: { groups: [string, Row[]][]; stageLabels: Record<string, string>; openClient: (id: string) => void }) {
  const total = groups.reduce((sum, [, rows]) => sum + rows.length, 0);
  return <section className="workspace"><div className="workspace-head"><div><h2>Funil de onboarding</h2><p>Leitura automática do progresso; tarefas e responsáveis permanecem no ClickUp.</p></div><span className="counter">{total} clientes</span></div><div className="funnel">{groups.map(([stage, rows]) => <section className="card stage" key={stage}><div className="stage-title"><span>{stageLabels[stage] || stage.replaceAll("_", " ")}</span><b>{rows.length}</b></div><div className="stage-bar"><i style={{ width: `${Math.max(8, (rows.length / Math.max(total, 1)) * 100)}%` }} /></div>{rows.slice(0, 20).map((client) => { const age = daysSince(client.entrada); const estimate = age == null ? null : Math.max(0, 21-age); return <button key={client.client_id} onClick={() => openClient(client.client_id)}><strong>{text(client.display_name)}</strong><span><Chip value={client.onboarding_risk || client.priority} /></span><small>{text(client.onboarding_next_action || client.next_step)}</small><small className="onboarding-age">Entrada: {client.entrada ? new Intl.DateTimeFormat("pt-BR").format(new Date(`${client.entrada}T12:00:00`)) : "sem data"}{client.onboarding_status === "OPEN" && estimate != null ? ` · janela estimada: ${estimate}d` : ""}</small></button>; })}</section>)}</div></section>;
}

function MediaCenter({ media, clients, openClient }: { media: Row; clients: Row[]; openClient: (id: string) => void }) {
  const diagnosis = media.is_stale ? "A carga está desatualizada. Evite decisões de otimização até a próxima sincronização." : media.leads > 0 ? `Cada lead custou ${formatMoney(media.cpl)} na última referência.` : "Não há leads registrados na última referência.";
  const mediaClients = clients.filter((c) => c.media_account_key || c.media_account_id || String(c.current_subject || "").toLowerCase().includes("mídia"));
  return <section className="workspace"><div className="workspace-head"><div><h2>Central de Anúncios</h2><p>Diagnóstico operacional sem substituir o gerenciador de anúncios.</p></div><Chip value={media.is_stale ? "DESATUALIZADO" : "ATUALIZADO"} /></div><div className="grid media-grid standalone"><Metric label="Investimento" value={formatMoney(media.spend)} tone="blue" hint={`${formatNumber(media.accounts)} contas`} /><Metric label="Leads" value={formatNumber(media.leads)} tone="green" hint="última referência" /><Metric label="CPL" value={media.cpl == null ? "—" : formatMoney(media.cpl)} tone="yellow" hint="investimento ÷ leads" /><Metric label="CTR" value={media.ctr == null ? "—" : `${formatNumber(media.ctr)}%`} hint="cliques ÷ impressões" /></div><div className={`diagnosis ${media.is_stale ? "warn" : ""}`}><b>Diagnóstico automático</b><p>{diagnosis}</p><small>Referência: {text(media.latest_date)} · atualiza quando uma nova carga entrar</small></div>{mediaClients.length > 0 && <section className="card section"><div className="section-title">Clientes com contexto de mídia</div><div className="client-pills">{mediaClients.map((client) => <button key={client.client_id} onClick={() => openClient(client.client_id)}>{text(client.display_name)} <Chip value={client.priority} /></button>)}</div></section>}</section>;
}

function AlertCenter({ alerts, clients, openClient }: { alerts: Row[]; clients: Row[]; openClient: (id: string) => void }) {
  const clientById = new Map(clients.map((client) => [client.client_id, client]));
  return <section className="workspace"><div className="workspace-head"><div><h2>Central de alertas</h2><p>Sinais agrupados para investigação; ações corretivas seguem no ClickUp.</p></div><span className="counter">{alerts.length} abertos</span></div><section className="card alert-list">{alerts.map((alert) => { const client = clientById.get(alert.client_id); return <button key={alert.id} onClick={() => client && openClient(client.client_id)} disabled={!client}><Chip value={alert.severity} /><div><strong>{text(alert.title)}</strong><p>{text(alert.description)}</p><small>{client ? text(client.display_name) : "Alerta geral"} · {formatDate(alert.created_at)}</small></div><span className="arrow">→</span></button>; })}{!alerts.length && <div className="empty">Nenhum alerta aberto.</div>}</section></section>;
}

function Health({ name, status, tone }: { name: string; status: string; tone: string }) {
  return <div className="health-item"><div className="health-name"><span className={tone}>●</span> {name}</div><div className="health-status">{status}</div></div>;
}

function AttentionCenter({clients,operations,preclients}:{clients:Row[];operations:Row;preclients:Row[]}) {
  const critical=clients.filter((c)=>c.priority==="ATTENTION").length;
  const noAction=clients.filter((c)=>!c.next_step).length;
  const stalled=clients.filter((c)=>c.lifecycle==="ONBOARDING"&&(daysSince(c.last_activity_at)||0)>3).length;
  const waiting=operations.sla?.waiting_agency?.length||0;
  const hot=preclients.filter((p)=>["proposta","negociacao","pre-assinatura","pré-assinatura"].includes(String(p.stage).toLowerCase())).length;
  return <section className="attention-box card"><div><span className="eyebrow">Precisa da minha atenção</span><h2>A operação em cinco sinais</h2></div><div className="attention-grid"><span className="critical"><b>{critical}</b> clientes críticos</span><span className="warn"><b>{noAction}</b> sem próxima ação</span><span><b>{stalled}</b> onboardings parados</span><span><b>{waiting}</b> conversas aguardando</span><span className="success"><b>{hot}</b> pré-clientes avançados</span></div></section>;
}

function PreClientCenter({rows,won}:{rows:Row[];won:Row[]}) {
  return <section className="workspace"><div className="workspace-head"><div><h2>Pré-clientes</h2><p>Oportunidades avançadas do CRM Comercial antes de entrarem na operação.</p></div><span className="counter">{rows.length} oportunidades</span></div><div className="grid clickup-kpis"><Metric label="Em proposta" value={formatNumber(rows.filter(r=>r.stage==="proposta").length)} tone="blue" hint="proposta enviada"/><Metric label="Em negociação" value={formatNumber(rows.filter(r=>r.stage==="negociacao").length)} tone="yellow" hint="acompanhamento comercial"/><Metric label="Fechamentos detectados" value={formatNumber(won.length)} tone="green" hint="deduplicados pelo CRM"/><Metric label="Valor em aberto" value={formatMoney(rows.reduce((s,r)=>s+Number(r.estimated_value||0),0))} tone="blue" hint="valor estimado"/></div><section className="card section"><div className="table-wrap"><table><thead><tr><th>Empresa</th><th>Etapa</th><th>Tempo</th><th>Valor</th><th>Última interação</th><th>Próxima ação</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><b>{text(row.company||row.name)}</b><div className="small">{text(row.source)}</div></td><td><Chip value={String(row.stage).toUpperCase()}/></td><td>{formatNumber(row.days_in_stage,0)} dias</td><td>{formatMoney(row.estimated_value)}</td><td>{formatDate(row.last_interaction||row.updated_at)}</td><td>{text(row.next_action)}<div className="small">{formatDate(row.next_action_at)}</div></td></tr>)}</tbody></table></div></section></section>;
}

function AuditCenter({runs,issues}:{runs:Row[];issues:Row[]}) {
  const run=runs[0]||{};
  return <section className="workspace"><div className="workspace-head"><div><h2>Confiabilidade dos dados</h2><p>Auditoria rastreável da base, relacionamentos e métricas derivadas.</p></div><Chip value={run.status}/></div><div className="grid clickup-kpis"><Metric label="Registros analisados" value={formatNumber(run.records_analyzed,0)} tone="blue" hint="base operacional e CRM"/><Metric label="Inconsistências" value={formatNumber(run.issues_found,0)} tone="yellow" hint="registradas com origem"/><Metric label="Correções seguras" value={formatNumber(run.issues_corrected,0)} tone="green" hint="sem inventar evidências"/><Metric label="Revisão manual" value={formatNumber(run.manual_review,0)} tone="red" hint="conflitos preservados"/></div><section className="card section"><div className="section-head"><div><div className="section-title">Relatório de inconsistências</div><div className="subtitle">Último recálculo: {formatDate(run.completed_at||run.started_at)}</div></div></div>{issues.map(issue=><div className="audit-row" key={issue.id}><Chip value={issue.severity}/><div><b>{issue.category} · {issue.issue_code.replaceAll("_"," ")}</b><small>{issue.explanation}</small></div><Chip value={issue.resolution_status==="MANUAL_REVIEW"?"REVISÃO MANUAL":issue.resolution_status}/></div>)}</section></section>;
}

function GlobalCommand({clients,tasks,preclients,close,openClient}:{clients:Row[];tasks:Row[];preclients:Row[];close:()=>void;openClient:(id:string)=>void}) {
  const [search,setSearch]=useState(""); const needle=search.toLowerCase().trim();
  const clientRows=needle?clients.filter(c=>[c.display_name,c.cs_owner,c.gt_owner,c.current_subject,c.next_step].join(" ").toLowerCase().includes(needle)).slice(0,8):clients.slice(0,5);
  const taskRows=needle?tasks.filter(t=>[t.name,t.list_name,t.status].join(" ").toLowerCase().includes(needle)).slice(0,5):[];
  const leadRows=needle?preclients.filter(p=>[p.name,p.company,p.stage].join(" ").toLowerCase().includes(needle)).slice(0,5):[];
  return <><div className="overlay open" onClick={close}/><section className="command-modal"><div className="command-input"><span>⌕</span><input autoFocus value={search} onChange={e=>setSearch(e.target.value)} placeholder="Pesquisar cliente, tarefa, responsável, campanha ou pré-cliente"/><kbd>Esc</kbd></div><div className="command-results"><small>CLIENTES</small>{clientRows.map(c=><button key={c.client_id} onClick={()=>{openClient(c.client_id);close();}}><span><b>{c.display_name}</b><small>{pt[c.lifecycle]||c.lifecycle} · CS {text(c.cs_owner)} · GT {text(c.gt_owner)} · {text(c.next_step)}</small></span><Chip value={c.priority}/></button>)}{taskRows.length>0&&<small>TAREFAS</small>}{taskRows.map(t=><a key={t.task_id} href={t.url} target="_blank" rel="noreferrer"><span><b>{t.name}</b><small>{t.list_name} · {formatDate(t.date_closed)}</small></span><Chip value={t.status}/></a>)}{leadRows.length>0&&<small>PRÉ-CLIENTES</small>}{leadRows.map(p=><button key={p.id}><span><b>{p.company||p.name}</b><small>{p.stage} · {formatMoney(p.estimated_value)}</small></span></button>)}</div></section></>;
}

function ProfileMenu({preferences,profile,email,settings,close,signOut,requestAccess}:{preferences:Row;profile:Row;email:string;settings:()=>void;close:()=>void;signOut:()=>Promise<unknown>;requestAccess:()=>Promise<void>}) {
  const name=preferences.name||email;
  const showRequest = profile?.access_level === "RESTRICTED" && !profile?.elevated;
  const pending = preferences?.my_access_request?.status === "PENDING";
  const [asking, setAsking] = useState(false);
  async function ask() { setAsking(true); try { await requestAccess(); } finally { setAsking(false); } }
  return <div className="profile-menu"><div className="profile-card"><span className="avatar">{initials(name)}</span><div><b>{text(name)}</b><small>{text(preferences.role||"Colaborador")}</small></div></div>
    {showRequest && <button className="request-access" disabled={pending || asking} onClick={ask}>{pending ? "Solicitação enviada — aguardando Adler" : asking ? "Enviando…" : "Solicitar acesso completo"}</button>}
    <button onClick={settings}>Meu perfil</button><button onClick={settings}>Configurações</button><button onClick={settings}>Preferências</button><button onClick={close}>Notificações</button><button className="muted" onClick={() => signOut()}>Sair</button></div>;
}

function NotificationCenter({items,close,refresh,openClient,token,pendingRequests,canDecide,decide}:{items:Row[];close:()=>void;refresh:()=>Promise<void>;openClient:(id:string)=>void;token:string;pendingRequests:Row[];canDecide:boolean;decide:(id:string,decision:"APPROVED"|"DENIED")=>Promise<void>}) {
  const [deciding,setDeciding]=useState<string|null>(null);
  async function read(id?:string){await apiPost("notifications-read",token,id?{id}:{});await refresh();}
  // Solicitacoes de acesso ainda pendentes viram acao inline: aprovar aqui ja libera o colaborador.
  const pendingIds=new Set(pendingRequests.map((request)=>String(request.id)));
  async function act(requestId:string,decision:"APPROVED"|"DENIED"){
    setDeciding(requestId);
    try{await decide(requestId,decision);}finally{setDeciding(null);}
  }
  return <div className="notification-panel"><div className="panel-heading"><div><span className="eyebrow">Central de Notificações</span><h3>Atualizações da operação</h3></div><button onClick={close}>×</button></div><button className="mark-read" onClick={()=>read()}>Marcar todas como lidas</button><div className="notification-list">{items.map(item=>{
    const requestId=item.metadata?.access_request_id?String(item.metadata.access_request_id):null;
    if(canDecide&&requestId&&pendingIds.has(requestId)) return <div className={`notification-action${item.read_at?"":" unread"}`} key={item.id}><Chip value={item.level}/><span><b>{text(item.title)}</b><small>{text(item.description)} · {formatDate(item.occurred_at)}</small></span><span className="access-request-actions"><button disabled={deciding===requestId} onClick={()=>act(requestId,"APPROVED")}>Aprovar</button><button className="muted" disabled={deciding===requestId} onClick={()=>act(requestId,"DENIED")}>Recusar</button></span></div>;
    return <button className={item.read_at?"":"unread"} key={item.id} onClick={()=>{read(item.id);if(item.client_id)openClient(item.client_id);}}><Chip value={item.level}/><span><b>{item.title}</b><small>{text(item.actor ? `${item.actor}: ${item.description}` : item.description)} · {formatDate(item.occurred_at)}</small>{(item.gestor || item.carteira) && <small className="notification-owner">{text(item.carteira || (item.gestor ? `Gestor: ${item.gestor}` : ""))}</small>}</span></button>;
  })}{!items.length&&<div className="empty">Nenhuma notificação.</div>}</div></div>;
}

function SettingsModal({preferences,close,refresh,token,pendingRequests,canDecide,decide}:{preferences:Row;close:()=>void;refresh:()=>Promise<void>;token:string;pendingRequests:Row[];canDecide:boolean;decide:(id:string,decision:"APPROVED"|"DENIED")=>Promise<void>}) {
  const [prefs,setPrefs]=useState<Row>(preferences); const toggle=(key:string)=>setPrefs((p:Row)=>({...p,[key]:p[key]===false}));
  const [deciding,setDeciding]=useState<string>("");
  async function save(){await apiPost("preferences",token,prefs);await refresh();close();}
  async function act(id:string,decision:"APPROVED"|"DENIED"){setDeciding(id);try{await decide(id,decision);}finally{setDeciding("");}}
  return <><div className="overlay open" onClick={close}/><section className="settings-modal"><div className="panel-heading"><div><span className="eyebrow">Configurações</span><h2>Conta e preferências</h2></div><button onClick={close}>×</button></div><div className="settings-grid"><div><h3>Conta</h3><label>Nome<input value={preferences.name||"Colaborador"} disabled/></label><label>Cargo<input value={preferences.role||"Colaborador"} disabled/></label></div><div><h3>Notificações</h3>{[["sounds_enabled","Som das notificações"],["win_sound_enabled","Som de novo cliente"],["win_celebration_enabled","Celebração de novo cliente"],["notifications_enabled","Notificações"],["animations_enabled","Animações"]].map(([key,label])=><button className="setting-toggle" key={key} onClick={()=>toggle(key)}><span>{label}</span><i className={prefs[key]===false?"":"on"}/></button>)}</div><div><h3>Integrações</h3>{["ClickUp","CRM Comercial","Supabase","WhatsApp","Meta Ads","Google Ads","Make","n8n","Notion"].map(name=><p className="integration-line" key={name}><span>{name}</span><small>{["ClickUp","CRM Comercial","Supabase","WhatsApp","Meta Ads","Notion"].includes(name)?"Configurado":"Preparado"}</small></p>)}</div><div><h3>Usuários e permissões</h3>{canDecide ? <div className="access-requests">{pendingRequests.length ? pendingRequests.map((request)=><div className="access-request-row" key={request.id}><span><b>{text(request.person)}</b><small>Solicitado em {formatDate(request.requested_at)}{request.note ? ` · ${request.note}` : ""}</small></span><span className="access-request-actions"><button disabled={deciding===request.id} onClick={()=>act(request.id,"APPROVED")}>Aprovar</button><button className="muted" disabled={deciding===request.id} onClick={()=>act(request.id,"DENIED")}>Recusar</button></span></div>) : <p className="small">Nenhuma solicitação de acesso pendente.</p>}</div> : <p className="small">Administrador · Operações · CS · GT · Designer · Comercial · Visualizador</p>}</div></div><div className="modal-actions"><button onClick={close}>Cancelar</button><button className="primary" onClick={save}>Salvar alterações</button></div></section></>;
}

function ClientDrawer({ detail, loading, close }: { detail: Row; loading: boolean; close: () => void }) {
  const client = detail.client || detail;
  const media = detail.media || [];
  const conversations = (detail.conversations || []).slice(0, 8);
  const alerts = (detail.alerts || []).slice(0, 8);
  const commitments = (detail.commitments || []).slice(0, 8);
  const briefings = (detail.briefings || []).slice(0, 6);
  const clickupTasks = (detail.clickup_tasks || []).slice(0, 20);
  const healthHistory = (detail.health_history || []).slice(0, 30);
  const evidence = client.evidence || detail.daily_summaries?.[0]?.evidence || [];
  const timeline = [
    ...(detail.timeline || []).map((row: Row) => ({ at: row.at, kind: text(row.event_type), title: row.detail, tone: row.source })),
    ...(detail.lifecycle_events || []).map((row: Row) => ({ at: row.occurred_at, kind: text(row.event_type), title: row.detail, tone: row.source })),
    ...(detail.won_events || []).map((row: Row) => ({ at: row.occurred_at, kind: "Cliente fechado", title: `Origem: ${row.initial_source}`, tone: row.confidence })),
    ...alerts.map((row: Row) => ({ at: row.created_at || row.updated_at, kind: "Alerta", title: row.title, tone: row.severity })),
    ...commitments.map((row: Row) => ({ at: row.due_at || row.created_at, kind: "Compromisso", title: row.title || row.description, tone: row.status })),
    ...conversations.map((row: Row) => ({ at: row.updated_at, kind: "Conversa", title: row.summary || row.current_subject, tone: row.conversation_status })),
  ].filter((row) => row.at).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 14);
  return (
    <>
      <div className="overlay open" onClick={close} />
      <aside className="drawer open">
        <div className="drawer-head"><div><div className="label">Visão do cliente</div><h2>{text(client.display_name)}</h2></div><button className="close" onClick={close}>×</button></div>
        <div className="drawer-body">
          {detail.error ? <div className="error-box">{text(detail.error)}</div> : loading ? <div className="empty">Buscando visão completa…</div> : (
            <div className="detail-grid">
              <Detail title="Resumo do cliente"><p><Chip value={client.lifecycle} /> <Chip value={client.priority} /> <Chip value={client.data_coverage} /></p><p><b>Etapa:</b> {text(client.onboarding_stage || (client.lifecycle === "ACTIVE" ? "Operação recorrente" : client.lifecycle))}</p><p><b>CS:</b> {text(client.cs_owner)} · <b>GT:</b> {text(client.gt_owner)}</p><p><b>Data de entrada:</b> {client.entrada ? new Intl.DateTimeFormat("pt-BR").format(new Date(`${client.entrada}T12:00:00`)) : "Revisão manual necessária"}</p>{client.lifecycle === "CHURNED" && <p><b>Data do churn:</b> {client.saida ? new Intl.DateTimeFormat("pt-BR").format(new Date(`${client.saida}T12:00:00`)) : "Revisão manual necessária"}</p>}<p><b>Tempo como cliente:</b> {client.client_days == null ? "Revisão manual necessária" : `${formatNumber(client.client_days,0)} dias`}</p><p><b>Última atividade:</b> {formatDate(client.last_activity_at)}</p><p><b>Campanhas:</b> {formatNumber(client.campaigns,0)} · <b>Alertas:</b> {formatNumber(client.alerts_count,0)}</p><p><b>Resumo:</b> {text(client.summary_today)}</p></Detail>
              <Detail title="Próxima ação"><p><b>{text(client.next_step)}</b></p><p>Responsável: {text(client.action_owner)}</p><p>Prazo: {formatDate(client.next_step_due)}</p></Detail>
              <Detail title="Onboarding"><p><Chip value={client.onboarding_status} /></p><p>Etapa: {text(client.onboarding_stage)}</p><p>Risco: {text(client.onboarding_risk)}</p><p>Próximo passo: {text(client.onboarding_next_action)}</p></Detail>
              <Detail title="Responsáveis"><p>CS: {text(client.cs_owner)}</p><p>GT: {text(client.gt_owner)}</p><p>Design: {text(client.designer_owner)}</p></Detail>
              <Detail title="Linha do tempo" full>{timeline.length ? <div className="timeline">{timeline.map((event, index) => <div className="timeline-event" key={`${event.kind}-${event.at}-${index}`}><i /><div><small>{formatDate(event.at)} · {event.kind}</small><p>{text(event.title)}</p></div><Chip value={event.tone} /></div>)}</div> : <p className="small">Ainda não há eventos datados para consolidar.</p>}</Detail>
              <Detail title="Evidências e confiança" full><p><b>Cobertura:</b> <Chip value={client.data_coverage} /> · <b>Confiança:</b> {client.confidence == null ? "não calculada" : `${Math.round(Number(client.confidence)*100)}%`}</p>{Array.isArray(evidence) && evidence.length ? evidence.slice(0,12).map((item: any,index: number) => <p key={index}>• {text(item?.text || item?.detail || item)}</p>) : <p className="small">Nenhuma evidência estruturada disponível neste snapshot.</p>}</Detail>
              <Detail title="Saúde histórica">{healthHistory.length ? healthHistory.slice(0,10).map((row: Row) => <p key={row.id || row.date}><b>{text(row.date)}</b> · {formatNumber(row.score)} pontos · <Chip value={row.band}/></p>) : <p className="small">Sem histórico calculado.</p>}</Detail>
              <Detail title="ClickUp">{clickupTasks.length ? clickupTasks.map((row: Row) => <p key={row.task_id}>{row.url ? <a target="_blank" rel="noreferrer" href={row.url}>{text(row.name)}</a> : text(row.name)} · <Chip value={row.status}/> · {formatDate(row.date_closed || row.date_created)}</p>) : <p className="small">Nenhuma tarefa vinculada ainda.</p>}</Detail>
              <Detail title="Mídia" full>{media.length ? media.slice(0, 12).map((row: Row, index: number) => <p key={`${row.account_key}-${row.date}-${index}`}><b>{text(row.date)}</b> · {formatMoney(row.spend)} · {formatNumber(row.leads)} leads · CPL {row.cpl == null ? "—" : formatMoney(row.cpl)} · {text(row.account_key)}</p>) : <p className="small">Sem mídia vinculada.</p>}</Detail>
              <Detail title="Conversas recentes" full>{conversations.length ? conversations.map((row: Row) => <p key={row.chat_id}><Chip value={row.conversation_status} /> {text(row.summary || row.current_subject || row.chat_id)} <span className="small">· {formatDate(row.updated_at)}</span></p>) : <p className="small">Sem conversas vinculadas.</p>}</Detail>
              <Detail title="Alertas">{alerts.length ? alerts.map((row: Row) => <p key={row.id}><Chip value={row.severity} /> {text(row.title)}</p>) : <p className="small">Sem alertas.</p>}</Detail>
              <Detail title="Compromissos">{commitments.length ? commitments.map((row: Row) => <p key={row.id}><Chip value={row.status} /> {text(row.title || row.description)} · {formatDate(row.due_at)}</p>) : <p className="small">Sem compromissos.</p>}</Detail>
              <Detail title="Briefing Notion" full>{briefings.length ? briefings.map((row: Row) => <p key={row.notion_page_id}><Chip value={row.sync_status} /> <a target="_blank" rel="noreferrer" href={row.page_url}>{text(row.title)}</a></p>) : <p className="small">Sem briefing vinculado.</p>}</Detail>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function Detail({ title, full = false, children }: { title: string; full?: boolean; children: React.ReactNode }) {
  return <section className={`detail-card ${full ? "full" : ""}`}><h3>{title}</h3>{children}</section>;
}
