"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { API_URL, CONTRACTS_API, DASHBOARD_CLIENT_VERSION, SUPABASE_ANON_KEY, SUPABASE_URL, BrandMark, Chip, Metric, api, apiPost, clickupAction, daysSince, formatDate, formatDay, formatMoney, formatNumber, healthScore, initials, priorityRank, taskCompletion, pt, relativeDate, supabase, text, useDialogFocus } from "./shared";
import type { HomeData, Row, TeamMember, View } from "./shared";
import { nextLabel } from "./material-triage-bridge";
import { TabHelp } from "./tab-help";
import { ViewErrorBoundary } from "./view-error-boundary";
import AdlerWalletManagement from "./adler-wallet-management";
import { PortfolioCenter } from "./views/portfolio";
import { DiaryCenter as StructuredDiaryCenter } from "./views/diary";
// A aba de contratos entra por import dinamico de proposito: assim o codigo da
// area privada so' e' baixado por quem o backend autorizou. Para os demais
// colaboradores ele nem chega ao navegador.
const ContractsCenter = lazy(() => import("./views/contracts").then((m) => ({ default: m.ContractsCenter })));
// Saude do cliente carrega sob demanda: nao e a tela inicial, e puxa a propria API.
const HealthCenter = lazy(() => import("./views/health").then((m) => ({ default: m.HealthCenter })));
const ClientContractSection = lazy(() => import("./views/contracts").then((m) => ({ default: m.ClientContractSection })));
const OpsPerfCenter = lazy(() => import("./views/opsperf").then((m) => ({ default: m.OpsPerfCenter })));
const CreativeCenter = lazy(() => import("./views/creative").then((m) => ({ default: m.CreativeCenter })));
const CapacityCenter = lazy(() => import("./views/capacity").then((m) => ({ default: m.CapacityCenter })));
const VideoScriptsCenter = lazy(() => import("./views/video-scripts").then((m) => ({ default: m.VideoScriptsCenter })));
const VideoAutomationCenter = lazy(() => import("./views/video-automation").then((m) => ({ default: m.VideoAutomationCenter })));
const CommercialFollowupCenter = lazy(() => import("./views/commercial-followup").then((m) => ({ default: m.CommercialFollowupCenter })));
const MATERIAL_TRIAGE_API = SUPABASE_URL + "/functions/v1/agency-ops-material-triage-api";

function materialTriageAge(item: Row, now = Date.now()) {
  const raw = item.metadata?.received_at || item.created_at;
  const at = raw ? new Date(raw).getTime() : now;
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  const severity = minutes >= 30 ? "critical" : minutes >= 15 ? "danger" : minutes >= 5 ? "warning" : "fresh";
  const label = minutes < 1 ? "Recebido agora" : minutes >= 30 ? `ESCALADO · ${minutes} min` : minutes >= 15 ? `URGENTE · ${minutes} min` : `Aguardando há ${minutes} min`;
  return { minutes, severity, label };
}

function materialTriageSummary(item: Row) {
  const meta = item.metadata || {};
  const kind = String(meta.triage_kind || "");
  if (kind === "PRODUCT_BRIEFING") return meta.entity_name ? `Briefing de produto · ${meta.entity_name}` : "Briefing de produto";
  if (kind === "PERSONA") return meta.entity_name ? `Persona · ${meta.entity_name}` : "Briefing de persona";
  const parts = [
    Number(meta.photo_count || 0) ? `${meta.photo_count} foto${Number(meta.photo_count) === 1 ? "" : "s"}` : "",
    Number(meta.video_count || 0) ? `${meta.video_count} vídeo${Number(meta.video_count) === 1 ? "" : "s"}` : "",
    Number(meta.document_count || 0) ? `${meta.document_count} arquivo${Number(meta.document_count) === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : `${Number(meta.item_count || 1)} material${Number(meta.item_count || 1) === 1 ? "" : "is"}`;
}

function materialTriageState(item: Row, now = Date.now()) {
  if (item.status === "IN_PROGRESS") {
    const started = new Date(item.metadata?.claimed_at || item.started_at || item.updated_at || item.created_at).getTime();
    const mins = Math.max(0, Math.floor((now - started) / 60000));
    return `${text(item.target_person || "Alguém")} assumiu${mins ? ` há ${mins} min` : " agora"}`;
  }
  if (item.status === "SNOOZED" && item.snoozed_until && new Date(item.snoozed_until).getTime() > now) {
    return `Adiado até ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(item.snoozed_until))}`;
  }
  return materialTriageAge(item, now).label;
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

  return <main className="auth-shell"><aside className="auth-aside"><div className="auth-aside-mark"><BrandMark /></div><div className="auth-aside-word"><b>Leonardo Imobi</b><span>Growth Imobiliário</span></div><p className="auth-aside-note">Clientes, onboarding, conversas e mídia em um só lugar.</p></aside><section className="auth-card"><div className="auth-head"><span className="eyebrow">Central de Operações</span><h1>{mode === "login" ? "Entre na operação" : "Crie seu acesso"}</h1><p>{mode === "login" ? "Acesse seu perfil para continuar." : "A conta é liberada após aprovação do Adler."}</p></div><div className="auth-tabs"><button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setMessage(""); }}>Entrar</button><button type="button" className={mode === "signup" ? "active" : ""} onClick={() => { setMode("signup"); setMessage(""); }}>Criar conta</button></div><form onSubmit={submit}>{mode === "signup" && <label>Nome completo<input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} placeholder="Seu nome" /></label>}{mode === "signup" && <label>Qual colaborador da empresa você é?<select required value={collaborator} onChange={(event) => setCollaborator(event.target.value)}><option value="">{rosterLoading ? "Carregando…" : "Selecione…"}</option>{roster.map((person) => <option key={person.person} value={person.person}>{person.person}</option>)}</select>{!rosterLoading && !roster.length && <small className="auth-hint">Todos os colaboradores já têm conta. Fale com o Adler se precisar de acesso.</small>}</label>}<label>E-mail<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="voce@empresa.com" /></label><label>Senha<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Mínimo de 6 caracteres" /></label>{message && <p className="auth-message" role="status">{message}</p>}<button className="auth-submit" disabled={busy}>{busy ? "Processando…" : mode === "login" ? "Entrar no dashboard" : "Criar minha conta"}</button></form></section></main>;
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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // Contratos sao ADLER ONLY. Quem autoriza e' o backend: o probe abaixo so'
  // recebe 200 se a API privada liberar; para qualquer outro usuario a rota
  // responde 404. Nada aqui revela que a area existe — nem o botao no menu, nem
  // um campo no payload compartilhado do dashboard.
  const [contractsAllowed, setContractsAllowed] = useState(false);
  const [contractsUnread, setContractsUnread] = useState(0);
  useEffect(() => { document.documentElement.style.setProperty("--sidenav-width", sidebarOpen ? "224px" : "58px"); }, [sidebarOpen]);
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [opsQuestion, setOpsQuestion] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lifecycleFilter, setLifecycleFilter] = useState("ACTIVE");
  const [campaignFilter, setCampaignFilter] = useState("ACTIVE");
  const [commandOpen, setCommandOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [walletManagementOpen, setWalletManagementOpen] = useState(false);
  const [walletManagementAllowed, setWalletManagementAllowed] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [workItemId, setWorkItemId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<Row | null>(null);
  const [toastLeaving, setToastLeaving] = useState(false);
  const [win, setWin] = useState<Row | null>(null);
  const loadedRef = useRef(false);
  const loadInFlightRef = useRef(false);
  const lastNotificationRef = useRef<string | null>(null);
  const briefingToastSeenRef = useRef<Set<string>>(new Set());
  const preferencesRef = useRef<Row>({});
  const [materialTriage, setMaterialTriage] = useState<Row[]>([]);
  const [triageBusy, setTriageBusy] = useState<string | null>(null);
  const [triageError, setTriageError] = useState("");
  const [triageNow, setTriageNow] = useState(Date.now());
  const triageLoadedRef = useRef(false);
  const triageLoadRef = useRef(false);
  const lastTriageSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: current } }) => { setSession(current); setAuthReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, current) => { setSession(current); setAuthReady(true); if (!current) { setData(null); loadedRef.current = false; } });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const token = session?.access_token;
    if (!token) { setContractsAllowed(false); return; }
    let active = true;
    fetch(`${CONTRACTS_API}?probe=1`, { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }, cache: "no-store" })
      .then(async (response) => {
        if (!active) return;
        setContractsAllowed(response.ok);
        // O probe devolve so' o contador; nenhum dado contratual trafega aqui.
        if (response.ok) { const corpo = await response.json().catch(() => null); setContractsUnread(Number(corpo?.unread || 0)); }
      })
      .catch(() => { if (active) { setContractsAllowed(false); setContractsUnread(0); } });
    return () => { active = false; };
  }, [session?.access_token]);

  // Se a autorizacao cair (troca de usuario, sessao expirada) a aba nao pode
  // continuar aberta na tela.
  useEffect(() => { if (!contractsAllowed) setView((current) => (current === "contracts" ? "overview" : current)); }, [contractsAllowed]);

  // ---- Menu lateral: quem decide quais abas existem e' o backend
  // (agency_ops.dashboard_view_permissions), nao esta lista. Antes o menu era igual para
  // todo mundo e a diferenca aparecia so' como tela vazia - o CS via "Auditoria" e
  // "Evidencias" para descobrir que nao tinha o dado. Enquanto o primeiro carregamento
  // nao chega, mostra so' o que nao depende de permissao.
  // A resposta chega a cada 30s com um array novo, mesmo sem mudanca de permissao.
  // A chave estavel evita recalcular o menu (e disparar o efeito abaixo) a cada carga.
  //
  // O ultimo menu conhecido fica no localStorage por dois motivos: (1) entre abrir a
  // pagina e a primeira resposta chegar sao alguns segundos em que o menu aparecia com
  // duas abas e depois pulava para treze; (2) se o backend sinalizar views_stale - ele
  // nao conseguiu resolver a permissao - o menu antigo vale mais que o minimo. O dado
  // continua barrado no servidor nos dois casos: isto aqui e' so' a casca.
  const cacheKey = `ops-views:${session?.user?.id ?? "anon"}`;
  const viewsFrescas = Array.isArray(data?.profile?.views) ? (data!.profile!.views as string[]) : null;
  const viewsStale = Boolean(data?.profile?.views_stale);
  useEffect(() => {
    if (!viewsFrescas || viewsStale) return;
    try { window.localStorage.setItem(cacheKey, viewsFrescas.join(",")); } catch { /* modo privado */ }
  }, [cacheKey, viewsFrescas?.join(","), viewsStale]);
  const viewsCache = useMemo(() => {
    try { return window.localStorage.getItem(cacheKey) || ""; } catch { return ""; }
  }, [cacheKey]);
  const viewsKey = viewsFrescas && !viewsStale ? viewsFrescas.join(",") : viewsCache;
  const allowedViews = useMemo(() => new Set<string>(viewsKey ? viewsKey.split(",") : ["overview", "focus"]), [viewsKey]);
  const navItems = useMemo(() => ([
    ["overview", "Visão geral"], ["focus", "Foco do dia"], ["work", "Central de Trabalho"], ["clients", "Clientes"], ["creative", "Central Criativa"], ["scripts" as View, "Produção de Roteiros"], ["videos" as View, "Vídeos Automáticos"], ["view-oncall" as View, "Acompanhamento Comercial"], ["health", "Saúde"], ["onboarding", "Onboarding"], ["campaigns", "Campanhas"], ["preclients", "Pré-clientes"], ["conversations", "Conversas"], ["team", "Equipe"], ["diary", "Diário"], ["clickup", "ClickUp"], ["evidence", "Evidências"], ["audit", "Auditoria"], ["alerts", "Alertas"], ["opsperf", "Desempenho OP"], ["capacity", "Capacidade"],
  ] as [View, string][]).filter(([key]) => allowedViews.has(key)), [allowedViews]);
  // Aba aberta que deixou de ser permitida volta para a primeira disponivel.
  useEffect(() => {
    if (!viewsKey) return;
    setView((current) => (current === "contracts" || allowedViews.has(current) ? current : (navItems[0]?.[0] ?? "overview")));
  }, [viewsKey, allowedViews, navItems]);
  const canSee = useCallback((key: View) => allowedViews.has(key), [allowedViews]);

  const briefingToastStorageKey = `ops-briefing-toast-seen-v1:${session?.user?.id ?? "anon"}`;
  useEffect(() => {
    if (!session?.user?.id) {
      briefingToastSeenRef.current = new Set();
      return;
    }
    try {
      briefingToastSeenRef.current = new Set(
        JSON.parse(window.localStorage.getItem(briefingToastStorageKey) || "[]"),
      );
    } catch {
      briefingToastSeenRef.current = new Set();
    }
  }, [briefingToastStorageKey, session?.user?.id]);

  const briefingToastKey = useCallback((item: Row | null | undefined) => {
    if (!item || String(item.type || "") !== "BRIEFING_CLIENT_UPDATE") return "";
    return String(item.event_key || item.id || "");
  }, []);

  const rememberBriefingToast = useCallback((item: Row | null | undefined) => {
    const key = briefingToastKey(item);
    if (!key) return;
    const seen = briefingToastSeenRef.current;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      window.localStorage.setItem(
        briefingToastStorageKey,
        JSON.stringify(Array.from(seen).slice(-500)),
      );
    } catch { /* modo privado */ }
  }, [briefingToastKey, briefingToastStorageKey]);

  const canShowToast = useCallback((item: Row | null | undefined) => {
    if (!item || item.type === "DAILY_LEAD_ALERT") return false;
    const key = briefingToastKey(item);
    return !key || !briefingToastSeenRef.current.has(key);
  }, [briefingToastKey]);

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
    if (!session?.access_token || loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    if (!loadedRef.current) setLoading(true);
    setError("");
    try {
      const isAdlerSession = session.user.id === "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476";
      const next = isAdlerSession
        ? await (async () => {
            const url = new URL(API_URL);
            url.searchParams.set("view", "home");
            url.searchParams.set("client", DASHBOARD_CLIENT_VERSION);
            const response = await fetch(url, {
              cache: "no-store",
              headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
              signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) throw new Error(`API ${response.status}: ${await response.text()}`);
            return response.json() as Promise<HomeData>;
          })()
        : await api("home", session.access_token);
      // Complemento de perfil: usa uma Edge Function pequena e autenticada para resolver
      // a identidade ClickUp por ID e enriquecer o payload sem depender de deploy da API geral.
      try {
        const profileResponse = await fetch(`${SUPABASE_URL}/functions/v1/agency-ops-profile-data-api`, {
          headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
          cache: "no-store",
        });
        if (profileResponse.ok) {
          const extra = await profileResponse.json();
          const gtByClient = new Map((extra.client_gt || []).map((row: Row) => [String(row.client_id), row.gt_owner ?? null]));
          next.clients = (next.clients || []).map((client: Row) => ({
            ...client,
            gt_owner: client.gt_owner ?? gtByClient.get(String(client.client_id)) ?? null,
          }));
          next.operations = {
            ...(next.operations || {}),
            personal_focus: extra.focus || next.operations?.personal_focus || null,
            design_focus: extra.profile?.role === "DESIGN" ? (extra.focus || next.operations?.design_focus || null) : next.operations?.design_focus,
          };
          next.profile = {
            ...(next.profile || {}),
            clickup_user_id: extra.profile?.clickup_user_id ?? next.profile?.clickup_user_id ?? null,
            clickup_user: extra.profile?.clickup_username ?? next.profile?.clickup_user ?? null,
          };
        }
      } catch { /* complemento nunca derruba a tela principal */ }
      preferencesRef.current = next.preferences || {};
      const newest = next.notifications?.[0];

      // No primeiro carregamento, tudo que já estava no feed de briefing é
      // histórico daquela sessão e não deve ressuscitar como toast.
      if (!loadedRef.current) {
        for (const item of next.notifications || []) {
          if (String(item?.type || "") === "BRIEFING_CLIENT_UPDATE") rememberBriefingToast(item);
        }
      }

      if (loadedRef.current && newest?.id && newest.id !== lastNotificationRef.current && canShowToast(newest)) {
        rememberBriefingToast(newest);
        setToast(newest);
        if (newest.type === "CLIENT_WON") { setWin(newest); playTone("win"); } else playTone("pop");
      }
      lastNotificationRef.current = newest?.id || null;
      setData(next);
      loadedRef.current = true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha desconhecida");
    } finally {
      loadInFlightRef.current = false;
      setLoading(false);
    }
  }, [canShowToast, playTone, rememberBriefingToast, session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    load();
    const timer = window.setInterval(load, 120_000);
    return () => window.clearInterval(timer);
  }, [load, session?.access_token]);

  // Atualiza??es de briefing precisam aparecer para todo mundo sem esperar o ciclo
  // pesado de 2 minutos da home. Consulta apenas o feed leve a cada 15s e mescla na
  // Central de Notifica??es, preservando a leitura individual de cada colaborador.
  useEffect(() => {
    if (!session?.access_token) return;
    let active = true;
    let inFlight = false;
    const poll = async () => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const feed = await api("notification-feed", session.access_token);
        if (!active || !Array.isArray(feed?.notifications)) return;
        const incoming: Row[] = feed.notifications;
        const newest = incoming[0];
        setData((current: any) => {
          if (!current) return current;
          const incomingIds = new Set(incoming.map((item) => String(item.id)));
          const currentById = new Map<string, Row>((current.notifications || []).map((item: Row) => [String(item.id), item]));
          const mergedIncoming = incoming.map((item) => ({ ...item, read_at: item.read_at ?? currentById.get(String(item.id))?.read_at ?? null }));
          const rest = (current.notifications || []).filter((item: Row) => !["BRIEFING_CLIENT_UPDATE","DAILY_LEAD_ALERT"].includes(String(item.type)) && !incomingIds.has(String(item.id)));
          return { ...current, notifications: [...mergedIncoming, ...rest].sort((a: Row, b: Row) => new Date(String(b.occurred_at || 0)).getTime() - new Date(String(a.occurred_at || 0)).getTime()) };
        });
        if (loadedRef.current && newest?.id && newest.id !== lastNotificationRef.current && canShowToast(newest)) {
          rememberBriefingToast(newest);
          setToast(newest);
          playTone("pop");
        }
        if (newest?.id) lastNotificationRef.current = newest.id;
      } catch {
        // O feed ? complementar; falha nele nunca derruba a opera??o principal.
      } finally {
        inFlight = false;
      }
    };
    poll();
    const timer = window.setInterval(poll, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [canShowToast, playTone, rememberBriefingToast, session?.access_token]);

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

  const isDesignRestricted = data?.profile?.role === "DESIGN";
  const isAdlerAccount = session?.user?.id === "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476";
  const isAdlerIdentity = Boolean(isAdlerAccount || data?.profile?.person === "Adler Furtado" || data?.preferences?.collaborator_person === "Adler Furtado" || data?.preferences?.name === "Adler Furtado");
  const canManageWallets = Boolean(walletManagementAllowed || isAdlerIdentity);
  const canMaterialTriage = Boolean(isAdlerIdentity || data?.profile?.role === "CS");

  useEffect(() => {
    let active = true;
    if (!session?.access_token) {
      setWalletManagementAllowed(false);
      return;
    }
    fetch(`${SUPABASE_URL}/functions/v1/agency-ops-wallet-management-api?probe=1`, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    }).then(async (response) => {
      const body = await response.json().catch(() => null);
      if (active) setWalletManagementAllowed(Boolean(response.ok && body?.ok));
    }).catch(() => {
      if (active) setWalletManagementAllowed(false);
    });
    return () => { active = false; };
  }, [session?.access_token]);
  const loadMaterialTriage = useCallback(async () => {
    if (!canMaterialTriage || !session?.access_token || triageLoadRef.current) return;
    triageLoadRef.current = true;
    try {
      const response = await fetch(MATERIAL_TRIAGE_API, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Triagem ${response.status}`);
      const body = await response.json();
      const items: Row[] = body.items || [];
      const newest = items[0];
      const signature = newest ? `${newest.id}:${newest.metadata?.item_count ?? 1}:${newest.updated_at ?? newest.created_at}` : null;
      if (triageLoadedRef.current && signature && signature !== lastTriageSignatureRef.current) playTone("pop");
      lastTriageSignatureRef.current = signature;
      triageLoadedRef.current = true;
      setMaterialTriage(items);
      setTriageError("");
    } catch (caught) {
      setTriageError(caught instanceof Error ? caught.message : "Falha ao atualizar triagem");
    } finally {
      triageLoadRef.current = false;
    }
  }, [canMaterialTriage, playTone, session?.access_token]);

  useEffect(() => {
    if (!canMaterialTriage || !session?.access_token || !session.user?.id) { setMaterialTriage([]); return; }
    void loadMaterialTriage();

    // Sem polling: escuta apenas o sinal minimo de triagem. Os dados reais
    // continuam vindo da Edge Function autorizada quando o sinal muda.
    let subscribedOnce = false;
    const channel = supabase
      .channel(`dashboard-material-triage:${session.user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "material_triage_signal" },
        () => void loadMaterialTriage(),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (subscribedOnce) void loadMaterialTriage();
          subscribedOnce = true;
        }
      });

    const onVisibility = () => {
      if (document.visibilityState === "visible") void loadMaterialTriage();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Apenas atualiza textos de idade localmente; zero request.
    const clock = window.setInterval(() => setTriageNow(Date.now()), 15_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(clock);
      void supabase.removeChannel(channel);
    };
  }, [canMaterialTriage, loadMaterialTriage, session?.access_token, session?.user?.id]);
  const isGtPortfolio = data?.profile?.role === "GT" && !data?.profile?.elevated;
  const clients = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    if (isDesignRestricted) {
      return (data?.clients || [])
        .filter((client) => !needle || [client.display_name, client.gt_owner].join(" ").toLocaleLowerCase("pt-BR").includes(needle))
        .sort((a, b) => text(a.display_name).localeCompare(text(b.display_name), "pt-BR"));
    }
    return (data?.clients || [])
      .filter((client) => {
        const haystack = [client.display_name, client.cs_owner, client.gt_owner, client.current_subject, client.next_step]
          .join(" ")
          .toLocaleLowerCase("pt-BR");
        const lifecycleOk = lifecycleFilter === "ALL" || (lifecycleFilter === "ACTIVE" ? ["ACTIVE","ONBOARDING"].includes(client.lifecycle) : client.lifecycle === lifecycleFilter);
        return lifecycleOk && (!needle || haystack.includes(needle)) && (filter === "ALL" || client.priority === filter);
      })
      .sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) || text(a.display_name).localeCompare(text(b.display_name)));
  }, [data, query, filter, lifecycleFilter, isDesignRestricted]);

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
    if (!session?.access_token || isDesignRestricted) return;
    setSelected({ display_name: "", carregando: true } as any);
    setDetailLoading(true);
    try {
      setSelected(await api("client", session.access_token, { id: clientId }));
    } catch (caught) {
      setSelected({ error: caught instanceof Error ? caught.message : "Falha ao carregar cliente" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function materialTriageAction(item: Row, action: "CLAIM" | "OPENED" | "SNOOZE" | "COMPLETE" | "RELEASE" | "ACKNOWLEDGE", extra: Row = {}) {
    if (!session?.access_token) return false;
    const busyKey = `${item.id}:${action}`;
    setTriageBusy(busyKey); setTriageError("");
    try {
      const response = await fetch(MATERIAL_TRIAGE_API, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" },
        body: JSON.stringify({ id: item.id, action, ...extra }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.claimed_by) throw new Error(`${body.claimed_by} já assumiu este material.`);
        throw new Error(body.detail || body.error || `Triagem ${response.status}`);
      }
      if (body.items) setMaterialTriage(body.items);
      else await loadMaterialTriage();
      return true;
    } catch (caught) {
      setTriageError(caught instanceof Error ? caught.message : "Não foi possível atualizar a triagem.");
      await loadMaterialTriage();
      return false;
    } finally { setTriageBusy(null); }
  }

  function dispatchTriageBriefing(item: Row) {
    const kind = String(item.metadata?.triage_kind || "");
    const entityType = kind === "PRODUCT_BRIEFING" ? "PRODUCT" : kind === "PERSONA" ? "PERSONA" : undefined;
    window.dispatchEvent(new CustomEvent("material-triage-open-briefing", { detail: {
      client_id: String(item.client_id || ""),
      tab: kind === "ASSET_BATCH" ? "materials" : entityType === "PERSONA" ? "personas" : "products",
      entity_type: entityType,
      entity_id: entityType ? String(item.metadata?.entity_id || "") : undefined,
    } }));
  }

  async function viewTriageMaterial(item: Row) {
    const ok = await materialTriageAction(item, "OPENED");
    if (ok) dispatchTriageBriefing(item);
  }

  async function continueTriageMaterial(item: Row) {
    const mine = item.status === "IN_PROGRESS" && (item.target_person === data?.profile?.person || isAdlerAccount);
    const ok = mine || await materialTriageAction(item, "CLAIM");
    if (!ok) return;
    const kind = String(item.metadata?.triage_kind || "");
    if (kind === "ASSET_BATCH" && canSee("creative")) setView("creative");
    else if (kind === "PRODUCT_BRIEFING" && canSee("scripts" as View)) setView("scripts" as View);
    else dispatchTriageBriefing(item);
  }

  const actionableMaterialTriage = materialTriage
    .filter((item) => item.status === "OPEN" || (item.status === "SNOOZED" && (!item.snoozed_until || new Date(item.snoozed_until).getTime() <= triageNow)))
    .sort((a, b) => new Date(a.metadata?.received_at || a.created_at || 0).getTime() - new Date(b.metadata?.received_at || b.created_at || 0).getTime());
  const materialTriageAlert = canMaterialTriage ? (actionableMaterialTriage[0] || null) : null;
  const kpis = data?.kpis || {};
  const media = data?.media || {};
  const health = data?.health || {};
  const failedJobs = (health.failed_jobs_24h || []).length;
  const notion = health.latest_notion_sync;
  const allClients = data?.clients || [];
  const activeClients = useMemo(() => isDesignRestricted ? allClients : allClients.filter((client) => ["ACTIVE","ONBOARDING"].includes(client.lifecycle)), [data, isDesignRestricted]);
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
  const todayOps = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const dailyLeadAlerts = useMemo(() => (data?.notifications || []).filter((item: Row) => item.type === "DAILY_LEAD_ALERT" && !item.read_at && String(item.metadata?.alert_date || "") === todayOps), [data?.notifications, todayOps]);
  const filteredCampaigns = (data?.campaigns || []).filter((row) => campaignFilter === "ALL" || (campaignFilter === "ACTIVE" ? ["ACTIVE","ONBOARDING"].includes(row.lifecycle) : row.lifecycle === campaignFilter));

  if (!authReady) return <div className="auth-loading"><span className="dot loading"/> Validando sessão…</div>;
  if (!session) return <AuthScreen />;

  return (
<>
    <main className={`shell ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"}`}>
      <TabHelp view={view} profile={data?.profile || {}} />
      <header className="top">
        <div className="brand">
          <div className="logo"><BrandMark /></div>
          <div>
            <span className="brand-name">Leonardo Imobi</span>
            <h1>{isGtPortfolio ? "Central do Gestor de Tráfego" : "Central de Operações"}</h1>
            <div className="subtitle">{isGtPortfolio ? `Sua carteira, campanhas e próximas ações em um só lugar${data?.profile?.carteira ? ` · Carteira ${data.profile.carteira}` : ""}` : "Clientes, onboarding, WhatsApp e mídia em um só lugar"}</div>
          </div>
        </div>
        <div className="live">
          <span className={`dot ${loading ? "loading" : error ? "error" : ""}`} />
          <span role="status" aria-live="polite">{loading ? "Atualizando…" : error ? "Problema de sincronização" : "Sistemas sincronizados"}</span>
          <button className="command-trigger" onClick={() => setCommandOpen(true)}>⌕ Pesquisar <kbd>Ctrl K</kbd></button>
          <button className="icon-btn" onClick={() => setNotificationsOpen(!notificationsOpen)} aria-label="Notificações">♢{unread > 0 && <b>{unread}</b>}</button>
          <button className="btn" onClick={load}>Atualizar</button>
          <button className="theme-btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Alternar tema">{theme === "dark" ? "☀" : "☾"}</button>
          <button className="profile-trigger" onClick={() => setProfileOpen(!profileOpen)}><span className="avatar small-avatar">{initials(data?.preferences?.name)}</span><span><b>{text(data?.preferences?.name || session.user.user_metadata?.name || session.user.email)}</b><small>{text(data?.profile?.carteira ? `Carteira ${data.profile.carteira}` : (data?.preferences?.role || "Colaborador"))}</small></span></button>
        </div>
      </header>

      <div className="source-banner"><span>O dashboard prioriza e diagnostica.</span> O ClickUp continua sendo a fonte oficial para executar e concluir tarefas.</div>

      <aside className={`side-nav${sidebarOpen ? " open" : ""}`} aria-label="Visões do dashboard">
        <button className="side-nav-toggle" onClick={() => setSidebarOpen((open) => !open)} aria-label={sidebarOpen ? "Recolher menu" : "Expandir menu"} title={sidebarOpen ? "Recolher menu" : "Expandir menu"}>{sidebarOpen ? "⟨" : "⟩"}</button>
        <div className="side-nav-items">
          {([
            ...navItems,
            ...(contractsAllowed ? [["contracts", "Contratos"]] : []),
          ] as [View, string][]).map(([key, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)} title={label}>{label}{key === "contracts" && contractsUnread > 0 && <span className="chip" style={{ marginLeft: 6 }}>{contractsUnread}</span>}</button>)}
          {isAdlerAccount && <a href="/wrapped" title="Wrapped mensal da agência">Wrapped</a>}
          {isAdlerAccount
            ? <a href="/ia" title="IA da agência">IA</a>
            : <button type="button" title="IA em desenvolvimento" onClick={() => window.alert("Esta função está em desenvolvimento pelo PAI DO OP.")}>IA (Beta)</button>}
        </div>
      </aside>

      {error && <div className="error-box">{error}</div>}

      {isDesignRestricted && view === "focus" && <DesignFocusMetrics focus={data?.operations?.design_focus || {}} loading={!data} />}
      {view === "overview" && !isDesignRestricted && <section className="grid kpis">
            <Metric label="Clientes ativos" value={formatNumber(kpis.active_clients)} tone="blue" hint="Ativos + onboarding" loading={!data} />
            <Metric label="Atenção agora" value={formatNumber(kpis.attention_now)} tone="red" hint="prioridade operacional" loading={!data} />
            <Metric label="Follow-up" value={formatNumber(kpis.follow_up)} tone="yellow" hint="ação em acompanhamento" loading={!data} />
            <Metric label="Operação OK" value={formatNumber(kpis.ok)} tone="green" hint="sem pendência crítica" loading={!data} />
            <Metric label="Compromissos vencidos" value={formatNumber(kpis.overdue_commitments)} tone={kpis.overdue_commitments ? "red" : "green"} hint="em aberto" loading={!data} />
            {data?.profile?.can_view_operational_alerts && <Metric label="Alertas abertos" value={formatNumber(kpis.open_alerts)} tone={kpis.critical_alerts ? "red" : "yellow"} hint={`${formatNumber(kpis.critical_alerts)} críticos/altos`} loading={!data} />}
          </section>}

      {view === "focus" && (isDesignRestricted
        ? <DesignFocusCenter focus={data?.operations?.design_focus || {}} />
        : <FocusCenter clients={actionClients} allClients={allClients} operations={data?.operations || {}} alerts={data?.alerts || []} openClient={openClient} />)}
      {view === "work" && canSee("work") && <WorkCenter token={session.access_token} clients={allClients} profile={data?.profile || {}} focusId={workItemId} clearFocus={() => setWorkItemId(null)} />}
      {view === "clients" && canSee("clients") && (isDesignRestricted
        ? <ClientPortfolio restricted clients={clients} total={allClients.length} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} lifecycleFilter={lifecycleFilter} setLifecycleFilter={setLifecycleFilter} openClient={openClient} />
        : <><PortfolioCenter portfolio={data?.portfolio || null} openClient={openClient} />
          <details className="card portfolio-fulllist"><summary>Lista completa de clientes <span>{allClients.length}</span></summary>
          <ClientPortfolio clients={clients} total={allClients.length} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} lifecycleFilter={lifecycleFilter} setLifecycleFilter={setLifecycleFilter} openClient={openClient} /></details></>)}
      {view === "creative" && canSee("creative") && <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando Central Criativa…</div>}><CreativeCenter token={session.access_token} /></Suspense>}
      {view === ("scripts" as View) && canSee("scripts" as View) && <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando Produção de Roteiros…</div>}><VideoScriptsCenter token={session.access_token} /></Suspense>}
      {view === ("videos" as View) && canSee("videos" as View) && <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando controles de vídeo…</div>}><VideoAutomationCenter token={session.access_token} /></Suspense>}
      {view === ("view-oncall" as View) && canSee("view-oncall" as View) && <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando plantões da View…</div>}><CommercialFollowupCenter token={session.access_token} /></Suspense>}
      {view === "onboarding" && canSee("onboarding") && <OnboardingBoard groups={onboardingGroups} stageLabels={data?.stage_labels || {}} openClient={openClient} />}
      {view === "campaigns" && canSee("campaigns") && <CampaignCenter media={media} campaigns={filteredCampaigns} clients={allClients} campaignFilter={campaignFilter} setCampaignFilter={setCampaignFilter} openClient={openClient} />}
      {view === "preclients" && canSee("preclients") && <PreClientCenter rows={data?.preclients || []} won={data?.won_events || []} />}
      {view === "conversations" && canSee("conversations") && <ConversationCenter conversations={data?.conversations || []} clients={allClients} openClient={openClient} />}
      {view === "health" && canSee("health") && <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando saúde dos clientes…</div>}><HealthCenter token={session.access_token} /></Suspense>}
      {view === "opsperf" && canSee("opsperf") && <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando desempenho...</div>}><OpsPerfCenter token={session.access_token} /></Suspense>}
      {view === "capacity" && canSee("capacity") && <ViewErrorBoundary titulo="Capacidade Operacional"><Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando capacidade operacional...</div>}><CapacityCenter token={session.access_token} /></Suspense></ViewErrorBoundary>}
      {view === "team" && canSee("team") && <TeamCenter team={data?.team || []} teamMembers={Number(kpis.team_members || 0)} unassigned={data?.unassigned_clients || []} openClient={openClient} />}
      {view === "diary" && canSee("diary") && <StructuredDiaryCenter clients={allClients} adjustments={data?.adjustments || []} taskLog={data?.operations?.task_log || {}} profile={data?.profile || {}} token={session.access_token} reload={load} />}
      {view === "clickup" && canSee("clickup") && <ClickUpCenter clickup={data?.clickup || {}} reload={load} token={session.access_token} />}
      {view === "evidence" && canSee("evidence") && <EvidenceCenter clients={allClients} operations={data?.operations || {}} openClient={openClient} />}
      {view === "audit" && canSee("audit") && <AuditCenter runs={data?.audit_runs || []} issues={data?.audit_issues || []} />}
      {view === "contracts" && contractsAllowed && <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando contratos…</div>}><ContractsCenter token={session.access_token} /></Suspense>}
      {view === "alerts" && canSee("alerts") && <AlertCenter alerts={data?.alerts || []} clients={allClients} profile={data?.profile || {}} token={session.access_token} canEscalate={canSee("work")} openClient={openClient} openWork={(id) => { setWorkItemId(id); setView("work"); }} />}

      {view === "overview" && isDesignRestricted && <><DesignFocusMetrics focus={data?.operations?.design_focus || {}} loading={!data} /><DesignFocusCenter focus={data?.operations?.design_focus || {}} /></>}
      {view === "overview" && !isDesignRestricted && <>{isGtPortfolio && <GtPortfolioOverview profile={data?.profile || {}} clients={activeClients} campaigns={filteredCampaigns} alerts={data?.alerts || []} commitments={data?.commitments || []} conversations={data?.conversations || []} openClient={openClient} setView={setView} />}
      {canMaterialTriage && <section className="card section material-triage-panel">
        <div className="section-head material-triage-head">
          <div><div className="section-title">🆕 Novos materiais aguardando ação</div><div className="subtitle">Triagem em tempo real · Adler + CS · atualização por evento</div></div>
          <div className="material-triage-head-actions"><span className="chip">{materialTriage.length} em triagem</span><button className="btn" onClick={() => void loadMaterialTriage()}>Atualizar</button></div>
        </div>
        {triageError && <div className="material-triage-error">{triageError}</div>}
        {!materialTriage.length ? <div className="material-triage-empty"><b>Tudo em dia.</b><span>Nenhum briefing ou material novo aguardando triagem.</span></div> : <div className="material-triage-list">
          {materialTriage.slice(0, 8).map((item) => {
            const age = materialTriageAge(item, triageNow);
            const mine = item.target_person === data?.profile?.person || isAdlerAccount;
            const snoozed = item.status === "SNOOZED" && item.snoozed_until && new Date(item.snoozed_until).getTime() > triageNow;
            const itemBusy = Boolean(triageBusy?.startsWith(`${item.id}:`));
            return <article className={`material-triage-item ${item.status === "IN_PROGRESS" ? "claimed" : snoozed ? "snoozed" : age.severity}`} key={item.id}>
              <div className="material-triage-main"><div className="material-triage-client"><b>{text(item.client_display_name || "Cliente")}</b><span>{materialTriageSummary(item)}</span></div><div className="material-triage-meta"><span>{text(item.metadata?.origin || item.source)}</span><strong>{materialTriageState(item, triageNow)}</strong></div></div>
              <div className="material-triage-actions">
                {!snoozed && item.status !== "IN_PROGRESS" && <button disabled={itemBusy} className="btn primary" onClick={() => void materialTriageAction(item, "CLAIM")}>Assumir</button>}
                {snoozed && (!item.target_person || mine) && <button disabled={itemBusy} className="btn" onClick={() => void materialTriageAction(item, "CLAIM")}>Retomar</button>}
                {(!item.target_person || mine) && <button disabled={itemBusy} className="btn" onClick={() => void viewTriageMaterial(item)}>Ver material</button>}
                {(!item.target_person || mine) && <button disabled={itemBusy} className="btn" onClick={() => void continueTriageMaterial(item)}>{nextLabel(item)}</button>}
                {!snoozed && item.status !== "IN_PROGRESS" && <button disabled={itemBusy} className="btn" onClick={() => void materialTriageAction(item, "SNOOZE", { minutes: 15 })}>Adiar 15 min</button>}
                <button disabled={itemBusy} className="btn material-triage-ack" title="Encerra a triagem deste material. O briefing/vídeo continua na origem." onClick={() => void materialTriageAction(item, "ACKNOWLEDGE")}>{triageBusy === `${item.id}:ACKNOWLEDGE` ? "Ciente…" : "Ciente"}</button>
                {item.status === "IN_PROGRESS" && mine && <button disabled={itemBusy} className="btn" onClick={() => void materialTriageAction(item, "COMPLETE")}>Concluir triagem</button>}
              </div>
            </article>;
          })}
          {materialTriage.length > 8 && <div className="material-triage-more">+ {materialTriage.length - 8} itens na fila</div>}
        </div>}
      </section>}
      <SmartSearch question={opsQuestion} setQuestion={setOpsQuestion} clients={allClients} conversations={data?.conversations || []} commitments={data?.commitments || []} openClient={openClient} />
      <AttentionCenter clients={activeClients} operations={data?.operations || {}} preclients={data?.preclients || []} />
      <ExecutiveBrief ready={!!data} clients={activeClients} onboardingGroups={onboardingGroups} stageLabels={data?.stage_labels || {}} openClient={openClient} />
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
              <thead><tr><th scope="col">Cliente</th><th scope="col">Prioridade</th><th scope="col">Próxima ação</th><th scope="col">Responsáveis</th><th scope="col">Cobertura</th></tr></thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.client_id} onClick={() => openClient(client.client_id)}>
                    <td><button type="button" className="cell-open name" onClick={(e) => { e.stopPropagation(); openClient(client.client_id); }} aria-label={`Abrir ${text(client.display_name)}`}>{text(client.display_name)}</button><div className="small">{text(client.current_subject || client.summary_today)}</div></td>
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

      {selected && <ClientDrawer detail={selected} loading={detailLoading} close={() => setSelected(null)} contractsAllowed={contractsAllowed} token={session.access_token} />}
      {commandOpen && <GlobalCommand clients={allClients} tasks={data?.clickup?.recent_completed || []} preclients={data?.preclients || []} close={() => setCommandOpen(false)} openClient={openClient} />}
      {profileOpen && <ProfileMenu preferences={data?.preferences || {}} profile={data?.profile || {}} email={session.user.email || ""} settings={() => { setProfileOpen(false); setSettingsOpen(true); }} openWalletManagement={() => { setProfileOpen(false); setWalletManagementOpen(true); }} canManageWallets={canManageWallets} close={() => setProfileOpen(false)} signOut={() => supabase.auth.signOut()} requestAccess={requestAccess} token={session.access_token} clients={allClients} />}
      {walletManagementOpen && canManageWallets && <AdlerWalletManagement token={session.access_token} close={() => setWalletManagementOpen(false)} refresh={load} />}
      {notificationsOpen && <NotificationCenter items={data?.notifications || []} close={() => setNotificationsOpen(false)} refresh={load} openClient={openClient} openWork={(id) => { setNotificationsOpen(false); setWorkItemId(id); setView("work"); }} token={session.access_token} pendingRequests={data?.access_requests_pending || []} canDecide={Boolean(data?.profile?.can_decide_access_requests)} decide={decideAccessRequest} />}
      {dailyLeadAlerts.length > 0 && <DailyLeadRadarModal items={dailyLeadAlerts} token={session.access_token} refresh={load} openClient={openClient} profile={data?.profile || {}} />}
      {settingsOpen && <SettingsModal preferences={data?.preferences || {}} close={() => setSettingsOpen(false)} refresh={load} token={session.access_token} pendingRequests={data?.access_requests_pending || []} canDecide={Boolean(data?.profile?.can_decide_access_requests)} decide={decideAccessRequest} />}
      {toast && <button className={`toast${toastLeaving ? " leaving" : ""}`} onClick={() => { const workId = toast.metadata?.work_item_id; if (workId) { setWorkItemId(String(workId)); setView("work"); } else if (toast.client_id) openClient(toast.client_id); setToast(null); }}><Chip value={toast.level}/><span><b>{text(toast.title)}</b><small>{text(toast.actor ? `${toast.actor}: ${toast.description}` : toast.description)}</small>{(toast.gestor || toast.carteira) && <small className="toast-meta">{text(toast.carteira ? `Carteira ${toast.carteira}` : (toast.gestor ? `Gestor: ${toast.gestor}` : ""))}</small>}</span><i onClick={(event) => { event.stopPropagation(); setToast(null); }}>×</i></button>}
      {win && data?.preferences?.win_celebration_enabled !== false && <button className="win-pulse" onClick={() => { if (win.client_id) openClient(win.client_id); setWin(null); }}><small>NOVO CLIENTE</small><strong>{text(win.description)}</strong><span>Acabou de entrar para a operação</span></button>}
    </main>
      {session?.access_token && <AIAskWidget token={session.access_token} />}
</>
  );
}

function GtPortfolioOverview({ profile, clients, campaigns, alerts, commitments, conversations, openClient, setView }: { profile: Row; clients: Row[]; campaigns: Row[]; alerts: Row[]; commitments: Row[]; conversations: Row[]; openClient: (id: string) => void; setView: (view: View) => void }) {
  const now = Date.now();
  const action = clients.filter((client) => ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(text(client.priority)) || Boolean(client.next_step));
  const critical = alerts.filter((alert) => ["CRITICAL", "HIGH"].includes(text(alert.severity)));
  const overdue = commitments.filter((item) => item.due_at && new Date(item.due_at).getTime() < now);
  const waiting = conversations.filter((item) => item.waiting_for_agency || item.conversation_status === "WAITING_AGENCY");
  const stale = campaigns.filter((campaign) => campaign.is_stale);
  const priorities = [...clients].sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9)).slice(0, 6);
  return <section className="gt-home" aria-label="Minha carteira hoje">
    <div className="gt-home-head"><div><span className="eyebrow">Minha carteira hoje</span><h2>{text(profile.person || "Gestor")}</h2><p>{profile.carteira ? `Carteira ${text(profile.carteira)} · ` : ""}{clients.length} clientes ativos e em onboarding. Todos os dados abaixo estão limitados à sua carteira.</p></div><span className="gt-scope-lock">Escopo protegido</span></div>
    <div className="gt-action-grid">
      <button onClick={() => setView("focus")}><strong>{action.length}</strong><span>ações e acompanhamentos</span><small>Abrir Foco do dia</small></button>
      <button onClick={() => setView("alerts")}><strong>{critical.length}</strong><span>alertas críticos ou altos</span><small>Revisar e encaminhar</small></button>
      <button onClick={() => setView("campaigns")}><strong>{stale.length}</strong><span>contas com mídia desatualizada</span><small>Abrir campanhas</small></button>
      <button onClick={() => setView("conversations")}><strong>{waiting.length}</strong><span>conversas aguardando agência</span><small>Ver conversas</small></button>
      <button onClick={() => setView("work")}><strong>{overdue.length}</strong><span>compromissos vencidos</span><small>Abrir Central de Trabalho</small></button>
    </div>
    <div className="gt-priority-list"><div className="section-head"><div><div className="section-title">Prioridades da carteira</div><div className="subtitle">Ordenadas pelo que exige ação primeiro</div></div><button className="btn" onClick={() => setView("clients")}>Ver carteira completa</button></div>{priorities.map((client) => <button key={client.client_id} onClick={() => openClient(String(client.client_id))}><span><b>{text(client.display_name)}</b><small>{text(client.next_step || client.current_subject || "Sem próxima ação registrada")}</small></span><Chip value={client.priority} /></button>)}{!priorities.length && <div className="empty">Nenhuma prioridade pendente na sua carteira.</div>}</div>
  </section>;
}

function WorkCenter({ token, clients, profile, focusId, clearFocus }: { token: string; clients: Row[]; profile: Row; focusId: string | null; clearFocus: () => void }) {
  const [payload, setPayload] = useState<Row>({ items: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("OPEN");
  const [personFilter, setPersonFilter] = useState("ALL");
  const [quickFilter, setQuickFilter] = useState("ALL");
  const [workQuery, setWorkQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(focusId);
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [waitingReason, setWaitingReason] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<Row>({ client_id: "", type: "GENERAL", priority: "MEDIUM", target_role: "CS", target_person: "Joel Antoniete", title: "", description: "", due_at: "" });

  const loadWork = useCallback(async () => {
    setLoading(true); setError("");
    try { setPayload(await api("work", token)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar demandas."); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { loadWork(); }, [loadWork]);
  useEffect(() => {
    if (!focusId) return;
    setExpanded(focusId); setFilter("ALL");
    window.setTimeout(() => document.getElementById(`work-${focusId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 120);
    clearFocus();
  }, [focusId, clearFocus]);

  const nowMs = Date.now();
  const HOUR = 3600000;
  const dayKey = (raw: unknown) => {
    if (!raw) return "";
    const date = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  };
  const todayKey = dayKey(new Date());
  const openItem = (item: Row) => !["COMPLETED", "DISMISSED"].includes(String(item.status));
  const ageHours = (item: Row) => item.created_at ? Math.max(0, (nowMs - new Date(String(item.created_at)).getTime()) / HOUR) : 0;
  const dueHours = (item: Row) => item.due_at ? (new Date(String(item.due_at)).getTime() - nowMs) / HOUR : null;
  const isOverdue = (item: Row) => openItem(item) && dueHours(item) != null && Number(dueHours(item)) < 0;
  const isDueToday = (item: Row) => openItem(item) && Boolean(item.due_at) && dayKey(item.due_at) === todayKey;
  const score = (item: Row) => {
    const base: Record<string, number> = { CRITICAL: 500, HIGH: 330, MEDIUM: 180, LOW: 80 };
    let points = base[String(item.priority)] ?? 100;
    const due = dueHours(item); const age = ageHours(item);
    if (due != null && due < 0) points += 650 + Math.min(240, Math.abs(due) * 5);
    else if (due != null && due <= 4) points += 360;
    else if (due != null && due <= 12) points += 240;
    else if (isDueToday(item)) points += 160;
    if (age >= 72) points += 220; else if (age >= 48) points += 160; else if (age >= 24) points += 110; else if (age >= 8) points += 45;
    if (item.status === "WAITING") points -= 90;
    if (item.status === "SNOOZED") points -= 180;
    return points;
  };
  const ageLabel = (item: Row) => { const h = ageHours(item); return h < 1 ? "aberta há menos de 1h" : h < 24 ? `aberta há ${Math.floor(h)}h` : `aberta há ${Math.floor(h / 24)}d`; };
  const dueLabel = (item: Row) => {
    if (!item.due_at) return "sem prazo";
    const h = dueHours(item); if (h == null) return "sem prazo";
    if (h < 0) { const late = Math.abs(h); return late < 1 ? "prazo vencido" : late < 24 ? `${Math.floor(late)}h atrasada` : `${Math.floor(late / 24)}d atrasada`; }
    const time = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(String(item.due_at)));
    if (isDueToday(item)) return `vence hoje ${time}`;
    if (h <= 24) return `vence em ${Math.max(1, Math.ceil(h))}h`;
    return `prazo ${formatDate(item.due_at)}`;
  };
  const WAIT_REASONS = [
    { value: "CLIENT", label: "Aguardando cliente" }, { value: "GT", label: "Aguardando GT" },
    { value: "CS", label: "Aguardando CS" }, { value: "DESIGN", label: "Aguardando Design" },
    { value: "APPROVAL", label: "Aguardando aprovação" }, { value: "TECHNICAL", label: "Dependência técnica" },
    { value: "OTHER", label: "Outro motivo" },
  ];
  const waitingLabel = (reason: unknown) => WAIT_REASONS.find((option) => option.value === String(reason || ""))?.label || "Aguardando";
  const items: Row[] = payload.items || [];
  const roster: Row[] = payload.roster || [];
  const ranked = [...items].sort((a, b) => score(b) - score(a));
  const needle = workQuery.trim().toLocaleLowerCase("pt-BR");
  const visible = ranked.filter((item) => {
    const statusOk = filter === "ALL" || (filter === "OPEN" ? openItem(item) : item.status === filter);
    const personOk = personFilter === "ALL" || String(item.target_person || "") === personFilter;
    const quickOk = quickFilter === "ALL"
      || (quickFilter === "MINE" && String(item.target_person || "") === String(profile.person || ""))
      || (quickFilter === "OVERDUE" && isOverdue(item))
      || (quickFilter === "TODAY" && isDueToday(item))
      || (quickFilter === "STALE" && openItem(item) && ageHours(item) >= 24)
      || (quickFilter === "CRITICAL" && openItem(item) && item.priority === "CRITICAL")
      || (quickFilter === "UNASSIGNED" && openItem(item) && !item.target_person);
    const client = item.clients || {};
    const hay = [item.title, item.description, client.display_name, item.target_person, item.target_role, item.created_by_person].join(" ").toLocaleLowerCase("pt-BR");
    return statusOk && personOk && quickOk && (!needle || hay.includes(needle));
  });
  const doNow = ranked.filter((item) => openItem(item) && !["WAITING", "SNOOZED"].includes(String(item.status))).slice(0, 5);
  const selectedClient = clients.find((client) => String(client.client_id) === String(form.client_id));
  const csOptions = [{ value: "Joel Antoniete", label: "Joel" }, { value: "Gustavo Lima", label: "Gustavo" }];
  const designOptions = [{ value: "Davi Nycollas", label: "Nycollas" }, { value: "Filipe Azevedo", label: "Filipe" }, { value: "Davi Henrique", label: "Davi" }];
  const assigneeOptions = String(form.target_role) === "CS" ? csOptions
    : String(form.target_role) === "DESIGN" ? designOptions
    : String(form.target_role) === "GT" ? (selectedClient?.gt_owner ? [{ value: String(selectedClient.gt_owner), label: String(selectedClient.gt_owner) }] : [])
    : String(form.target_role) === "MGMT" ? [{ value: "Adler Furtado", label: "Adler Furtado" }]
    : [];
  const assigneeLabel = (person: unknown) => {
    const value = String(person || "");
    return designOptions.find((option) => option.value === value)?.label || csOptions.find((option) => option.value === value)?.label || value || "não definido";
  };
  const canSeeTeamLoad = profile.person === "Adler Furtado" || profile.access_level === "FULL" || Boolean(profile.elevated);
  const teamLoad = (canSeeTeamLoad ? roster : roster.filter((person) => person.person === profile.person))
    .filter((person) => ["CS", "DESIGN", "GT", "MGMT"].includes(String(person.role)))
    .map((person) => {
      const assigned = items.filter((item) => openItem(item) && String(item.target_person || "") === String(person.person));
      return { person: String(person.person), role: String(person.role), open: assigned.length, today: assigned.filter(isDueToday).length, overdue: assigned.filter(isOverdue).length, waiting: assigned.filter((item) => item.status === "WAITING").length, critical: assigned.filter((item) => item.priority === "CRITICAL").length };
    })
    .filter((row) => row.open > 0 || row.person === profile.person)
    .sort((a, b) => b.overdue - a.overdue || b.critical - a.critical || b.open - a.open);

  function changeClient(clientId: string) {
    const client = clients.find((row) => String(row.client_id) === clientId);
    setForm((current: Row) => ({
      ...current,
      client_id: clientId,
      target_person: current.target_role === "GT" ? (client?.gt_owner || "") : current.target_person,
    }));
  }

  function changeRole(role: string) {
    const client = clients.find((row) => String(row.client_id) === String(form.client_id));
    const targetPerson = role === "CS" ? "Joel Antoniete"
      : role === "DESIGN" ? "Davi Nycollas"
      : role === "GT" ? (client?.gt_owner || "")
      : role === "MGMT" ? "Adler Furtado"
      : "";
    setForm((current: Row) => ({ ...current, target_role: role, target_person: targetPerson }));
  }

  async function createItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form.target_person) {
      setError(form.target_role === "GT" ? "Selecione um cliente com GT responsável antes de encaminhar para Tráfego." : "Selecione o colaborador responsável pela demanda.");
      return;
    }
    setBusy("create"); setError("");
    try {
      await apiPost("work-item-create", token, { ...form, client_id: form.client_id || null, target_person: form.target_person, due_at: form.due_at ? new Date(form.due_at).toISOString() : null, create_clickup: form.type === "CLICKUP" });
      setForm({ client_id: "", type: "GENERAL", priority: "MEDIUM", target_role: "CS", target_person: "Joel Antoniete", title: "", description: "", due_at: "" });
      setFormOpen(false); await loadWork();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao criar solicitação."); }
    finally { setBusy(""); }
  }

  async function updateItem(item: Row, status: string) {
    if (status === "WAITING") {
      const id = String(item.id); const reason = waitingReason[id] || String(item.waiting_reason || "");
      if (!reason) { setError("Selecione por que a demanda ficará aguardando."); setExpanded(id); return; }
      setBusy(id); setError("");
      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/agency-ops-work-item-wait-api`, { method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ id: item.id, waiting_reason: reason }) });
        const json = await response.json().catch(() => null);
        if (!response.ok) throw new Error(json?.error || "Falha ao registrar o motivo de espera.");
        await loadWork();
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao colocar a demanda em espera."); }
      finally { setBusy(""); }
      return;
    }
    const note = (resolution[String(item.id)] || "").trim();
    if (status === "COMPLETED" && !note) { setError("Descreva o que foi feito antes de concluir."); setExpanded(String(item.id)); return; }
    setBusy(String(item.id)); setError("");
    try { await apiPost("work-item-update", token, { id: item.id, status, resolution: note || undefined, snoozed_until: status === "SNOOZED" ? new Date(Date.now() + 86400000).toISOString() : undefined }); await loadWork(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao atualizar solicitação."); }
    finally { setBusy(""); }
  }

  const summary = payload.summary || {};
  return <section className="workspace work-center">
    <div className="workspace-head"><div><span className="eyebrow">Mesa de despacho operacional</span><h2>Central de Trabalho</h2><p>Prioridade, prazo, idade da pendência e carga por colaborador em uma única fila.</p></div><button className="primary work-new" onClick={() => setFormOpen((open) => !open)}>{formOpen ? "Cancelar" : "+ Nova solicitação"}</button></div>
    <div className="grid work-kpis"><Metric label="Em aberto" value={formatNumber(summary.open, 0)} tone="blue" hint="aguardando ação" /><Metric label="Críticas" value={formatNumber(summary.critical, 0)} tone="red" hint="prioridade máxima" /><Metric label="Atrasadas" value={formatNumber(summary.overdue, 0)} tone="yellow" hint="prazo vencido" /><Metric label="Aguardando" value={formatNumber(summary.waiting, 0)} tone="yellow" hint="dependência registrada" /></div>
    {doNow.length > 0 && <section className="card risk-watch" style={{ marginBottom: 14 }}><div className="panel-heading" style={{ padding: "16px 17px 11px" }}><div><span className="eyebrow">Fazer agora</span><h3>Prioridade operacional automática</h3></div><span className="counter">{doNow.length}</span></div>{doNow.map((item, index) => { const client = item.clients || {}; return <button key={item.id} onClick={() => { setExpanded(String(item.id)); setFilter("ALL"); }}><span className="rank">{String(index + 1).padStart(2, "0")}</span><span><b>{text(item.title)}</b><small>{text(client.display_name || "Solicitação geral")} · {assigneeLabel(item.target_person || item.target_role)} · {dueLabel(item)} · {ageLabel(item)}</small></span><Chip value={item.priority} /></button>; })}</section>}
    {formOpen && <form className="card work-form" onSubmit={createItem}><div className="section-title">Criar solicitação</div><div className="work-form-grid"><label>Cliente<select className="control" value={form.client_id} onChange={(event) => changeClient(event.target.value)}><option value="">Solicitação geral</option>{clients.map((client) => <option key={client.client_id} value={client.client_id}>{client.display_name}</option>)}</select></label><label>Tipo<select className="control" value={form.type} onChange={(event) => setForm((current: Row) => ({ ...current, type: event.target.value }))}><option value="GENERAL">Geral</option><option value="ESCALATION">Escalonamento</option><option value="CREATIVE_REQUEST">Solicitação para designer</option><option value="TECHNICAL">Problema técnico</option><option value="CLIENT_FOLLOWUP">Acompanhamento do cliente</option><option value="CLICKUP">Criar também no ClickUp</option></select></label><label>Área responsável<select className="control" value={form.target_role} onChange={(event) => changeRole(event.target.value)}><option value="CS">CS</option><option value="DESIGN">Designer</option><option value="GT">Gestor de Tráfego</option><option value="MGMT">Operações</option></select></label><label>Encaminhar para<select className="control" value={form.target_person || ""} onChange={(event) => setForm((current: Row) => ({ ...current, target_person: event.target.value }))} disabled={form.target_role === "GT" && !selectedClient?.gt_owner}>{form.target_role === "GT" && !selectedClient?.gt_owner && <option value="">{form.client_id ? "Cliente sem GT definido" : "Selecione o cliente primeiro"}</option>}{assigneeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><label>Prioridade<select className="control" value={form.priority} onChange={(event) => setForm((current: Row) => ({ ...current, priority: event.target.value }))}><option value="CRITICAL">Crítica</option><option value="HIGH">Alta</option><option value="MEDIUM">Média</option><option value="LOW">Baixa</option></select></label><label>Prazo<input className="control" type="datetime-local" value={form.due_at} onChange={(event) => setForm((current: Row) => ({ ...current, due_at: event.target.value }))} /></label></div><label>Título<input className="control" required value={form.title} onChange={(event) => setForm((current: Row) => ({ ...current, title: event.target.value }))} placeholder="O que precisa ser feito" /></label><label>Contexto<textarea className="control" value={form.description} onChange={(event) => setForm((current: Row) => ({ ...current, description: event.target.value }))} placeholder="Explique o problema, a evidência e o resultado esperado" /></label><div className="work-form-footer"><span>{form.target_person ? `Será encaminhada para ${assigneeLabel(form.target_person)}` : form.target_role === "GT" ? "O GT é definido pela carteira do cliente" : "Selecione quem receberá a demanda"}</span><button className="primary" disabled={busy === "create" || !form.target_person}>{busy === "create" ? "Criando…" : "Criar e notificar"}</button></div></form>}
    {teamLoad.length > 0 && <section className="card section" style={{ marginBottom: 14 }}><div className="section-head"><div><div className="section-title">Carga por colaborador</div><div className="subtitle">Clique em uma pessoa para filtrar a fila.</div></div></div><div className="table-wrap" style={{ maxHeight: 280 }}><table><thead><tr><th>Responsável</th><th>Abertas</th><th>Hoje</th><th>Atrasadas</th><th>Aguardando</th><th>Críticas</th></tr></thead><tbody>{teamLoad.map((row) => <tr key={row.person} onClick={() => { setPersonFilter(row.person); setFilter("OPEN"); setQuickFilter("ALL"); }}><td><b>{row.person}</b><div className="small">{row.role}</div></td><td>{row.open}</td><td>{row.today}</td><td className={row.overdue ? "red" : ""}>{row.overdue}</td><td>{row.waiting}</td><td className={row.critical ? "red" : ""}>{row.critical}</td></tr>)}</tbody></table></div></section>}
    {error && <div className="error-box">{error}</div>}
    <section className="card section" style={{ marginBottom: 10 }}><div className="toolbar"><input className="control" style={{ flex: 1 }} value={workQuery} onChange={(event) => setWorkQuery(event.target.value)} placeholder="Buscar demanda, cliente ou responsável" /><select className="control" value={personFilter} onChange={(event) => setPersonFilter(event.target.value)}><option value="ALL">Todos os responsáveis</option>{roster.filter((person) => ["CS", "DESIGN", "GT", "MGMT"].includes(String(person.role))).map((person) => <option key={person.person} value={person.person}>{person.person} · {person.role}</option>)}</select></div><div className="filter-tabs" style={{ marginTop: 10 }}>{[["ALL","Tudo"],["MINE","Minhas"],["OVERDUE","Atrasadas"],["TODAY","Vencem hoje"],["STALE","Paradas +24h"],["CRITICAL","Críticas"],["UNASSIGNED","Sem responsável"]].map(([key,label]) => <button key={key} className={quickFilter === key ? "active" : ""} onClick={() => setQuickFilter(key)}>{label}</button>)}</div></section>
    <div className="filter-tabs work-filters">{[["OPEN", "Em aberto"], ["IN_PROGRESS", "Em andamento"], ["WAITING", "Aguardando"], ["SNOOZED", "Adiados"], ["COMPLETED", "Concluídos"], ["ALL", "Todos"]].map(([key, label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}</div>
    <div className="work-list">{visible.map((item) => { const open = expanded === String(item.id); const client = item.clients || {}; const routedTo = assigneeLabel(item.target_person || item.target_role); return <article id={`work-${item.id}`} className={`card work-item${open ? " expanded" : ""}`} key={item.id}><button className="work-item-main" onClick={() => setExpanded(open ? null : String(item.id))}><Chip value={item.priority} /><span><b>{text(item.title)}</b><small>{text(client.display_name || "Solicitação geral")} · encaminhada para {text(routedTo)} · {dueLabel(item)} · {ageLabel(item)}</small>{item.status === "WAITING" && <small className="yellow">{waitingLabel(item.waiting_reason)}{item.waiting_since ? ` · desde ${formatDate(item.waiting_since)}` : ""}</small>}</span><Chip value={item.status} /></button>{open && <div className="work-item-detail"><p>{text(item.description || "Sem descrição adicional.")}</p><div className="work-meta"><span>Encaminhada para: {text(routedTo)}</span><span>{ageLabel(item)}</span><span>Prazo: {dueLabel(item)}</span>{item.status === "WAITING" && <span>{waitingLabel(item.waiting_reason)}</span>}{item.completed_by && <span>Concluída por {text(item.completed_by)}</span>}</div>{item.metadata?.clickup_url && <a className="work-clickup" href={item.metadata.clickup_url} target="_blank" rel="noreferrer">Abrir tarefa no ClickUp ↗</a>}{!["COMPLETED", "DISMISSED"].includes(item.status) && <><div className="toolbar" style={{ marginTop: 12 }}><label className="small">Motivo se ficar aguardando <select className="control" value={waitingReason[String(item.id)] || String(item.waiting_reason || "")} onChange={(event) => setWaitingReason((current) => ({ ...current, [String(item.id)]: event.target.value }))}><option value="">Selecione…</option>{WAIT_REASONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div><textarea className="control" value={resolution[String(item.id)] || ""} onChange={(event) => setResolution((current) => ({ ...current, [String(item.id)]: event.target.value }))} placeholder="Registre o que foi feito, a decisão ou o motivo…" /><div className="work-actions"><button disabled={busy === String(item.id)} onClick={() => updateItem(item, "IN_PROGRESS")}>Iniciar</button><button disabled={busy === String(item.id)} onClick={() => updateItem(item, "WAITING")}>Aguardando</button><button disabled={busy === String(item.id)} onClick={() => updateItem(item, "SNOOZED")}>Adiar 1 dia</button><button className="success" disabled={busy === String(item.id)} onClick={() => updateItem(item, "COMPLETED")}>Concluir</button><button className="muted" disabled={busy === String(item.id)} onClick={() => updateItem(item, "DISMISSED")}>Descartar</button></div></>}{item.status === "COMPLETED" && item.resolution && <div className="work-resolution"><b>Conclusão</b><p>{text(item.resolution)}</p></div>}</div>}</article>; })}{!loading && !visible.length && <div className="card empty">Nenhuma solicitação nesse filtro.</div>}{loading && <div className="card empty">Carregando solicitações…</div>}</div>
  </section>;
}

function AIAskWidget({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [question, setQuestionText] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "ai"; text: string }[]>([]);
  const [asking, setAsking] = useState(false);
  const AI_ASK_URL = API_URL.replace(/agency-ops-dashboard-api$/, "agency-ops-ai-ask");

  async function send() {
    const q = question.trim();
    if (!q || asking) return;
    setMessages((prev) => [...prev, { role: "user", text: q }]);
    setQuestionText("");
    setAsking(true);
    try {
      const response = await fetch(AI_ASK_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const json = await response.json().catch(() => null);
      const answer = json && json.ok ? json.answer : (json && json.error ? `Não consegui responder: ${json.error}` : "Não consegui responder agora.");
      setMessages((prev) => [...prev, { role: "ai", text: answer }]);
    } catch {
      setMessages((prev) => [...prev, { role: "ai", text: "Não consegui responder agora. Tente novamente em instantes." }]);
    } finally {
      setAsking(false);
    }
  }

  return (
    <aside style={{ position: "fixed", right: 18, bottom: 18, zIndex: 9999, width: open ? "min(380px,calc(100vw - 36px))" : "auto", fontFamily: "inherit" }}>
      {!open && (
        <button onClick={() => setOpen(true)} style={{ background: "rgba(9,12,20,.94)", color: "#f8fafc", border: "1px solid #2a3040", borderRadius: 999, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer", boxShadow: "0 16px 50px rgba(0,0,0,.28)" }}>
          <span style={{ fontSize: 16 }}>💬</span>
          <b style={{ fontSize: 12.5 }}>Perguntar à IA</b>
        </button>
      )}
      {open && (
        <div style={{ background: "rgba(9,12,20,.96)", color: "#f8fafc", borderRadius: 14, border: "1px solid #2a3040", boxShadow: "0 16px 50px rgba(0,0,0,.28)", display: "flex", flexDirection: "column", height: 460, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid #2a3040" }}>
            <b style={{ fontSize: 12.5 }}>Perguntar à IA · agency_ops</b>
            <span style={{ cursor: "pointer", fontSize: 16, color: "#94a3b8" }} onClick={() => setOpen(false)}>−</span>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            {!messages.length && <div style={{ fontSize: 12, color: "#94a3b8" }}>Pergunte qualquer coisa sobre clientes, formulários, materiais, alertas ou produtividade — a resposta vem direto do banco de dados.</div>}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", background: m.role === "user" ? "#2563eb" : "#1c2333", color: "#f8fafc", borderRadius: 10, padding: "7px 10px", fontSize: 12.5, maxWidth: "88%", whiteSpace: "pre-wrap" }}>{m.text}</div>
            ))}
            {asking && <div style={{ alignSelf: "flex-start", fontSize: 12, color: "#94a3b8" }}>Consultando o banco…</div>}
          </div>
          <div style={{ display: "flex", gap: 6, padding: 10, borderTop: "1px solid #2a3040" }}>
            <input value={question} onChange={(e) => setQuestionText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") send(); }} placeholder="Ex: quantos clientes estão em RED?" style={{ flex: 1, background: "#12151f", border: "1px solid #2a3040", borderRadius: 8, color: "#f8fafc", padding: "7px 9px", fontSize: 12.5 }} />
            <button onClick={send} disabled={asking || !question.trim()} style={{ background: "#2563eb", border: "none", borderRadius: 8, color: "#fff", padding: "7px 12px", fontSize: 12.5, cursor: "pointer", opacity: asking || !question.trim() ? 0.6 : 1 }}>Enviar</button>
          </div>
        </div>
      )}
    </aside>
  );
}

function ExecutiveBrief({ ready, clients, onboardingGroups, stageLabels, openClient }: { ready: boolean; clients: Row[]; onboardingGroups: [string, Row[]][]; stageLabels: Record<string, string>; openClient: (id: string) => void }) {
  const counts = {
    attention: clients.filter((c) => c.priority === "ATTENTION").length,
    follow: clients.filter((c) => c.priority === "FOLLOW_UP").length,
    incomplete: clients.filter((c) => ["DATA_INCOMPLETE", "UNDETERMINED"].includes(c.priority)).length,
    ok: clients.filter((c) => c.priority === "OK").length,
  };
  const total = Math.max(clients.length, 1);
  const risk = [...clients].sort((a, b) => (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9)).slice(0, 6);
  const onboardingTotal = onboardingGroups.reduce((sum, [, rows]) => sum + rows.length, 0);
  const headline = !ready
    ? "Consolidando a leitura da operação…"
    : counts.attention
    ? `${counts.attention} cliente${counts.attention > 1 ? "s" : ""} exige${counts.attention > 1 ? "m" : ""} ação imediata.`
    : counts.follow ? `A carteira está estável, com ${counts.follow} follow-up${counts.follow > 1 ? "s" : ""} em acompanhamento.`
    : "A carteira está estável e sem prioridade crítica registrada.";
  return <section className="executive-grid">
    <article className="card executive-story"><div className="eyebrow">Leitura executiva · agora</div><h2>{headline}</h2><p>{!ready ? "Aguardando a carga para avaliar a cobertura." : counts.incomplete ? `${counts.incomplete} registros ainda têm cobertura incompleta e podem limitar o diagnóstico.` : "A cobertura atual permite uma leitura consistente da operação."}</p><div className="method"><span>i</span><div><b>Como é calculado</b><small>Prioridade, cobertura, compromissos e alertas consolidados pelo motor operacional.</small></div></div></article>
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

// ---------------------------------------------------------------- Foco do dia
//
// A tela antes era um briefing em prosa + quatro colunas de "caixa de acao" + duas
// listas soltas de SLA e compromissos. Quem abria lia quatro contagens e ainda tinha
// que decidir sozinho por onde comecar - e as duas coisas com prazo real (cliente
// esperando resposta e compromisso vencido) ficavam no rodape, abaixo da carteira.
//
// Agora e' uma fila de trabalho unica, ordenada por atraso, dividida pelo VERBO da
// acao: Responder (alguem esta esperando a agencia), Resolver (venceu ou alertou) e
// Acompanhar (nao venceu, mas nao pode dormir). Cada linha responde na mesma altura:
// o que e', de quem e', ha quanto tempo e de quem e' a bola.

// Dia no fuso da operacao. O backend agrupa as tasks por data de Sao Paulo; se a tela
// perguntasse pelo dia em UTC, "Hoje" viraria o dia seguinte depois das 21h.
const diaSaoPaulo = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

const HORA_MS = 3600000;

function horasDesde(value: unknown) {
  if (!value) return null;
  const at = new Date(String(value)).getTime();
  return Number.isNaN(at) ? null : Math.max(0, (Date.now() - at) / HORA_MS);
}

// "há 3h" / "há 2 dias" / "há 3 semanas". O atraso e' o criterio de ordenacao da fila,
// entao ele precisa estar escrito na linha, nao escondido numa data absoluta.
function atrasoLabel(horas: number | null) {
  if (horas == null) return "sem data";
  if (horas < 1) return "há menos de 1h";
  if (horas < 24) return `há ${Math.floor(horas)}h`;
  const dias = Math.floor(horas / 24);
  if (dias < 14) return `há ${dias} ${dias === 1 ? "dia" : "dias"}`;
  return `há ${Math.floor(dias / 7)} semanas`;
}

type DesignLaneKey = "now" | "doing" | "next";

function designText(row: Row) {
  return [row.name, row.status, row.list_name].map((value) => text(value))
    .join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function designActivity(row: Row) {
  const value = designText(row);
  if (/ajuste|alteracao|correcao|refacao|revisao|feedback|aprovacao/.test(value)) return "Ajuste/revisão";
  if (/video|reel|motion|edicao|audiovisual/.test(value)) return "Vídeo";
  if (/carrossel|feed|story|criativo|estatic|arte|banner|thumbnail|capa/.test(value)) return "Criativo estático";
  if (/landing|pagina|site|web|email/.test(value)) return "Peça digital";
  return "Design";
}

function designDueDay(row: Row) {
  if (!row.due_date) return null;
  const date = new Date(String(row.due_date));
  return Number.isNaN(date.getTime()) ? null : diaSaoPaulo(date);
}

function designIsDoing(row: Row) {
  return /andamento|progress|doing|producao|produzindo|editando|revisao|review|ajuste|feedback|aprovacao/.test(designText(row));
}

function DesignFocusMetrics({ focus, loading }: { focus: Row; loading: boolean }) {
  const tasks: Row[] = focus.open_tasks || [];
  const today = diaSaoPaulo();
  const dueToday = tasks.filter((row) => designDueDay(row) === today).length;
  const overdue = tasks.filter((row) => {
    const due = designDueDay(row);
    return Boolean(due && due < today);
  }).length;
  const doing = tasks.filter(designIsDoing).length;
  const adjustments = tasks.filter((row) => designActivity(row) === "Ajuste/revisão").length;
  const next = Math.max(0, tasks.length - tasks.filter((row) => {
    const due = designDueDay(row);
    return Boolean((due && due <= today) || designIsDoing(row));
  }).length);

  return <section className="grid kpis">
    <Metric label="Demandas abertas" value={formatNumber(tasks.length)} tone="blue" hint="atribuídas a você" loading={loading} />
    <Metric label="Para hoje" value={formatNumber(dueToday)} tone={dueToday ? "yellow" : "green"} hint="entregas com prazo hoje" loading={loading} />
    <Metric label="Atrasadas" value={formatNumber(overdue)} tone={overdue ? "red" : "green"} hint="precisam de prioridade" loading={loading} />
    <Metric label="Em andamento" value={formatNumber(doing)} tone="blue" hint="produção, ajuste ou revisão" loading={loading} />
    <Metric label="Ajustes e revisões" value={formatNumber(adjustments)} tone={adjustments ? "yellow" : "green"} hint="feedbacks em aberto" loading={loading} />
    <Metric label="Concluídas hoje" value={formatNumber((focus.closed_today || []).length)} tone="green" hint={`${formatNumber(next)} próximas na fila`} loading={loading} />
  </section>;
}

function DesignFocusCenter({ focus }: { focus: Row }) {
  const [lane, setLane] = useState<"all" | DesignLaneKey>("all");
  const tasks: Row[] = focus.open_tasks || [];
  const today = diaSaoPaulo();

  const lanes = useMemo(() => {
    const grouped: Record<DesignLaneKey, Row[]> = { now: [], doing: [], next: [] };
    tasks.forEach((row) => {
      const due = designDueDay(row);
      if (due && due <= today) grouped.now.push(row);
      else if (designIsDoing(row)) grouped.doing.push(row);
      else grouped.next.push(row);
    });
    const byDue = (a: Row, b: Row) => {
      const aDue = a.due_date ? new Date(String(a.due_date)).getTime() : Number.MAX_SAFE_INTEGER;
      const bDue = b.due_date ? new Date(String(b.due_date)).getTime() : Number.MAX_SAFE_INTEGER;
      return aDue - bDue || text(a.name).localeCompare(text(b.name), "pt-BR");
    };
    (Object.keys(grouped) as DesignLaneKey[]).forEach((key) => grouped[key].sort(byDue));
    return [
      { key: "now" as const, verbo: "Fazer agora", titulo: "Atrasadas ou com entrega hoje", ajuda: "Somente demandas de design atribuídas a você que exigem ação imediata.", itens: grouped.now, tom: "danger" },
      { key: "doing" as const, verbo: "Em andamento", titulo: "Produção, ajustes e revisões", ajuda: "Peças que já estão em produção ou retornaram para ajuste, revisão ou aprovação.", itens: grouped.doing, tom: "warn" },
      { key: "next" as const, verbo: "Próximas", titulo: "Fila de produção", ajuda: "Demandas de design abertas que ainda não chegaram ao prazo do dia.", itens: grouped.next, tom: "" },
    ];
  }, [tasks, today]);

  const visible = lane === "all" ? lanes : lanes.filter((item) => item.key === lane);
  const total = tasks.length;
  const urgent = lanes[0].itens.length;
  const plan = [
    `Foco de Design · ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date())}`,
    `${total} demandas abertas · ${urgent} para fazer agora · ${(focus.closed_today || []).length} concluídas hoje`,
    "",
    ...lanes.flatMap((item) => item.itens.length
      ? [`${item.verbo.toUpperCase()}:`, ...item.itens.slice(0, 8).map((row, index) => `${index + 1}. ${text(row.client_display_name || row.list_name || "Sem cliente")} — ${text(row.name)} (${designActivity(row)} · ${row.due_date ? formatDate(row.due_date) : "sem prazo"})`), ""]
      : []),
  ].join("\n");

  return <section className="workspace foco">
    <div className="foco-head card">
      <div>
        <span className="eyebrow">Foco de Design</span>
        <h2>{total ? `${total} ${total === 1 ? "demanda criativa aberta" : "demandas criativas abertas"} · ${urgent} para fazer agora` : "Nenhuma demanda de design aberta hoje"}</h2>
        <p>Esta fila mostra exclusivamente tarefas de design atribuídas a você. A execução e a baixa continuam no ClickUp.</p>
      </div>
      <button type="button" onClick={() => navigator.clipboard?.writeText(plan)}>Copiar plano de design</button>
    </div>

    <div className="filter-tabs foco-tabs">
      <button type="button" className={lane === "all" ? "active" : ""} onClick={() => setLane("all")}>Tudo <b>{total}</b></button>
      {lanes.map((item) => <button key={item.key} type="button" className={lane === item.key ? "active" : ""} onClick={() => setLane(item.key)}>{item.verbo} <b>{item.itens.length}</b></button>)}
    </div>

    <div className={`foco-lanes${lane === "all" ? "" : " single"}`}>
      {visible.map((item) => <section className={`card foco-lane ${item.tom}`} key={item.key}>
        <div className="foco-lane-head"><div><b>{item.verbo}</b><span>{item.titulo}</span></div><strong>{item.itens.length}</strong></div>
        <p className="foco-lane-help">{item.ajuda}</p>
        {item.itens.map((row) => {
          const due = designDueDay(row);
          const late = Boolean(due && due < today);
          const when = !due ? "sem prazo" : due === today ? "entrega hoje" : late ? "atrasada" : `entrega ${formatDate(row.due_date)}`;
          const content = <><span className={`foco-age${late ? " late" : ""}`}>{when}</span><span className="foco-body"><b>{text(row.client_display_name || row.list_name || "Demanda interna")}</b><span>{text(row.name)}</span><small>{designActivity(row)} · {text(row.status || "aberta")}{row.list_name ? ` · ${text(row.list_name)}` : ""}</small></span><Chip value={late ? "ATRASADO" : due === today ? "HOJE" : designActivity(row)} /></>;
          return row.url
            ? <a className="foco-item" key={row.task_id} href={row.url} target="_blank" rel="noreferrer">{content}</a>
            : <div className="foco-item" key={row.task_id}>{content}</div>;
        })}
        {!item.itens.length && <div className="empty compact">Nada aqui hoje.</div>}
      </section>)}
    </div>
  </section>;
}

type FocoItem = {
  key: string;
  lane: "reply" | "solve" | "follow";
  client_id: string | null;
  cliente: string;
  titulo: string;
  detalhe: string;
  dono: string;
  horas: number | null;
  chip: string;
};

function FocusCenter({ clients, allClients, operations, alerts, openClient }: { clients: Row[]; allClients: Row[]; operations: Row; alerts: Row[]; openClient: (id: string) => void }) {
  const [lane, setLane] = useState<"all" | "reply" | "solve" | "follow">("all");

  const clientePorId = useMemo(() => new Map(allClients.map((client) => [String(client.client_id), client])), [allClients]);
  const nome = (id: unknown, fallback = "Sem cliente vinculado") => text(clientePorId.get(String(id ?? ""))?.display_name || fallback);
  const dono = (id: unknown) => {
    const client = clientePorId.get(String(id ?? ""));
    return text(client?.action_owner || client?.cs_owner || client?.gt_owner || "sem responsável");
  };

  const waiting: Row[] = operations.sla?.waiting_agency || [];
  const overdue: Row[] = operations.sla?.overdue_commitments || [];
  const criticos = useMemo(() => alerts.filter((alert) => ["CRITICAL", "HIGH"].includes(alert.severity)), [alerts]);
  const personalClickup: Row[] = operations.personal_focus?.open_tasks || [];

  const filas = useMemo(() => {
    const responder: FocoItem[] = waiting.map((row) => ({
      key: `reply-${row.chat_id}`,
      lane: "reply",
      client_id: row.client_id ?? null,
      cliente: nome(row.client_id, text(row.chat_name || row.chat_id)),
      titulo: text(row.open_question || row.last_summary || row.last_intent || "Cliente aguardando retorno"),
      detalhe: "Cliente esperando a agência",
      dono: dono(row.client_id),
      horas: horasDesde(row.waiting_since || row.updated_at),
      chip: row.sla_level || row.conversation_status || "ESPERANDO",
    }));

    const resolverCompromissos: FocoItem[] = overdue.map((row) => ({
      key: `commit-${row.id}`,
      lane: "solve",
      client_id: row.client_id ?? null,
      cliente: nome(row.client_id),
      titulo: text(row.descricao || row.title || "Compromisso sem descrição"),
      detalhe: "Compromisso vencido",
      dono: text(row.owner || dono(row.client_id)),
      horas: horasDesde(row.due_at),
      chip: "ATRASADO",
    }));

    const resolverAlertas: FocoItem[] = criticos.map((alert) => ({
      key: `alert-${alert.id}`,
      lane: "solve",
      client_id: alert.client_id ?? null,
      cliente: nome(alert.client_id, "Alerta geral"),
      titulo: text(alert.title || alert.description || "Alerta operacional"),
      detalhe: text(alert.description || "Alerta aberto"),
      dono: text(alert.owner || dono(alert.client_id)),
      // first_detected_at, nao last_detected_at: o detector reescreve last a cada
      // rodada, entao alerta aberto ha dois dias aparecia como "ha menos de 1h".
      horas: horasDesde(alert.first_detected_at || alert.last_detected_at),
      chip: alert.severity,
    }));

    const now = new Date();
    const clickupResolver: FocoItem[] = personalClickup
      .filter((row) => row.due_date && new Date(String(row.due_date)) <= now)
      .map((row) => ({
        key: `clickup-${row.task_id}`, lane: "solve" as const, client_id: row.client_id ?? null,
        cliente: nome(row.client_id, text(row.client_display_name || row.list_name || "Demanda interna")),
        titulo: text(row.name || "Tarefa do ClickUp"), detalhe: `ClickUp · ${text(row.status || "aberta")} · ${row.due_date ? `prazo ${formatDate(row.due_date)}` : "sem prazo"}`,
        dono: text(operations.personal_focus?.owner || "você"), horas: horasDesde(row.due_date), chip: "CLICKUP",
      }));
    const clickupAcompanhar: FocoItem[] = personalClickup
      .filter((row) => !row.due_date || new Date(String(row.due_date)) > now)
      .map((row) => ({
        key: `clickup-${row.task_id}`, lane: "follow" as const, client_id: row.client_id ?? null,
        cliente: nome(row.client_id, text(row.client_display_name || row.list_name || "Demanda interna")),
        titulo: text(row.name || "Tarefa do ClickUp"), detalhe: `ClickUp · ${text(row.status || "aberta")} · ${row.due_date ? `prazo ${formatDate(row.due_date)}` : "sem prazo"}`,
        dono: text(operations.personal_focus?.owner || "você"), horas: horasDesde(row.date_updated || row.date_created), chip: row.due_date ? "CLICKUP" : "SEM PRAZO",
      }));

    const acompanhar: FocoItem[] = clients
      .filter((client) => ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(client.priority) && client.next_step)
      .map((client) => ({
        key: `follow-${client.client_id}`,
        lane: "follow" as const,
        client_id: client.client_id,
        cliente: text(client.display_name),
        titulo: text(client.next_step),
        detalhe: text(client.current_subject || "Próxima ação da carteira"),
        dono: text(client.action_owner || client.cs_owner || "sem responsável"),
        horas: horasDesde(client.next_step_due),
        chip: client.priority,
      }));

    // Dentro de cada fila, o mais parado primeiro. Item sem data vai para o fim:
    // sem prazo nao da' para afirmar que esta' atrasado.
    const porAtraso = (a: FocoItem, b: FocoItem) => (b.horas ?? -1) - (a.horas ?? -1);
    return {
      reply: responder.sort(porAtraso),
      solve: [...resolverCompromissos, ...resolverAlertas, ...clickupResolver].sort(porAtraso),
      follow: [...acompanhar, ...clickupAcompanhar].sort(porAtraso),
    };
  }, [waiting, overdue, criticos, clients, clientePorId, personalClickup, operations.personal_focus?.owner]);

  const lanes = [
    { key: "reply" as const, verbo: "Responder", titulo: "Alguém está esperando você", ajuda: "Conversas em que o cliente falou por último e a agência ainda não voltou.", itens: filas.reply, tom: "danger" },
    { key: "solve" as const, verbo: "Resolver", titulo: "Venceu ou alertou", ajuda: "Compromissos com prazo estourado e alertas críticos/altos em aberto.", itens: filas.solve, tom: "warn" },
    { key: "follow" as const, verbo: "Acompanhar", titulo: "Não venceu, mas não pode dormir", ajuda: "Próximas ações da carteira em atenção ou follow-up.", itens: filas.follow, tom: "" },
  ];
  const visiveis = lane === "all" ? lanes : lanes.filter((item) => item.key === lane);
  const teto = lane === "all" ? 12 : 60;
  const totalFila = filas.reply.length + filas.solve.length + filas.follow.length;
  const parados = filas.reply.filter((item) => (item.horas ?? 0) >= 24).length + filas.solve.filter((item) => (item.horas ?? 0) >= 24).length;

  // O plano do dia sai em texto pronto para colar no grupo da equipe: o topo de cada
  // fila, com prazo e dono, na mesma ordem que a tela mostra.
  const planoDoDia = [
    `Foco do dia · ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date())}`,
    `${filas.reply.length} para responder · ${filas.solve.length} para resolver · ${filas.follow.length} para acompanhar`,
    "",
    ...lanes.flatMap((item) => item.itens.length
      ? [`${item.verbo.toUpperCase()}:`, ...item.itens.slice(0, 5).map((row, index) => `${index + 1}. ${row.cliente} — ${row.titulo} (${atrasoLabel(row.horas)}, ${row.dono})`), ""]
      : []),
  ].join("\n");

  return (
    <section className="workspace foco">
      <div className="foco-head card">
        <div>
          <span className="eyebrow">Fila do dia</span>
          <h2>{totalFila ? `${totalFila} ${totalFila === 1 ? "item aberto" : "itens abertos"} · ${parados} parado${parados === 1 ? "" : "s"} há mais de 24h` : "Nada em aberto na fila de hoje"}</h2>
          <p>Do mais parado para o mais recente. O diagnóstico é aqui; a baixa continua no ClickUp.</p>
        </div>
        <button type="button" onClick={() => navigator.clipboard?.writeText(planoDoDia)}>Copiar plano do dia</button>
      </div>

      <div className="filter-tabs foco-tabs">
        <button type="button" className={lane === "all" ? "active" : ""} onClick={() => setLane("all")}>Tudo <b>{totalFila}</b></button>
        {lanes.map((item) => <button key={item.key} type="button" className={lane === item.key ? "active" : ""} onClick={() => setLane(item.key)}>{item.verbo} <b>{item.itens.length}</b></button>)}
      </div>

      <div className={`foco-lanes${lane === "all" ? "" : " single"}`}>
        {visiveis.map((item) => (
          <section className={`card foco-lane ${item.tom}`} key={item.key}>
            <div className="foco-lane-head">
              <div>
                <b>{item.verbo}</b>
                <span>{item.titulo}</span>
              </div>
              <strong>{item.itens.length}</strong>
            </div>
            <p className="foco-lane-help">{item.ajuda}</p>
            {item.itens.slice(0, teto).map((row) => (
              <button type="button" className="foco-item" key={row.key} onClick={() => row.client_id && openClient(row.client_id)} disabled={!row.client_id}>
                <span className={`foco-age${(row.horas ?? 0) >= 24 ? " late" : ""}`}>{atrasoLabel(row.horas)}</span>
                <span className="foco-body">
                  <b>{row.cliente}</b>
                  <span>{row.titulo}</span>
                  <small>{row.detalhe} · {row.dono}</small>
                </span>
                <Chip value={row.chip} />
              </button>
            ))}
            {item.itens.length > teto && <div className="foco-more">+{item.itens.length - teto} itens — abra a fila “{item.verbo}” para ver todos.</div>}
            {!item.itens.length && <div className="empty compact">Nada aqui hoje.</div>}
          </section>
        ))}
      </div>

      <details className="card foco-carteira">
        <summary>Carteira por prioridade <span>{clients.length}</span></summary>
        <ActionInbox clients={clients} openClient={openClient} />
      </details>
    </section>
  );
}

function ClientPortfolio({ clients, total, query, setQuery, filter, setFilter, lifecycleFilter, setLifecycleFilter, openClient, restricted = false }: { clients: Row[]; total: number; query: string; setQuery: (value: string) => void; filter: string; setFilter: (value: string) => void; lifecycleFilter:string; setLifecycleFilter:(value:string)=>void; openClient: (id: string) => void; restricted?: boolean }) {
  if (restricted) return <section className="workspace"><div className="workspace-head"><div><h2>Clientes</h2><p>Cliente, Gestor de Tráfego responsável e tempo de relacionamento com a agência.</p></div><span className="counter">{clients.length} de {total}</span></div><section className="card section"><div className="toolbar portfolio-tools"><input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou Gestor de Tráfego" /></div><div className="table-wrap"><table><thead><tr><th scope="col">Cliente</th><th scope="col">Gestor de Tráfego</th><th scope="col">Tempo conosco</th></tr></thead><tbody>{clients.map((client) => <tr key={client.client_id}><td><div className="name">{text(client.display_name)}</div></td><td>{text(client.gt_owner || "Sem GT vinculado")}</td><td>{client.client_days == null ? "—" : `${formatNumber(client.client_days, 0)} dias`}</td></tr>)}{!clients.length && <tr><td colSpan={3} className="empty">Nenhum cliente encontrado.</td></tr>}</tbody></table></div></section></section>;
  return <section className="workspace"><div className="workspace-head"><div><h2>Carteira completa</h2><p>Saúde, tempo como cliente, responsáveis e próxima ação.</p></div><span className="counter">{clients.length} de {total}</span></div><section className="card section"><div className="toolbar portfolio-tools"><input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou responsável" /><select className="control" value={lifecycleFilter} onChange={(event) => setLifecycleFilter(event.target.value)}><option value="ACTIVE">Ativos</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option></select><select className="control" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="ALL">Todas as prioridades</option><option value="ATTENTION">Atenção</option><option value="FOLLOW_UP">Acompanhamento</option><option value="OK">OK</option><option value="UNDETERMINED">Indeterminado</option><option value="DATA_INCOMPLETE">Dados incompletos</option></select></div><div className="table-wrap"><table><thead><tr><th scope="col">Cliente</th><th scope="col">Status</th><th scope="col">Saúde</th><th scope="col">Tempo como cliente</th><th scope="col">Próxima ação</th><th scope="col">Responsável</th></tr></thead><tbody>{clients.map((client) => { const score = healthScore(client); return <tr key={client.client_id} onClick={() => openClient(client.client_id)}><td><button type="button" className="cell-open name" onClick={(e) => { e.stopPropagation(); openClient(client.client_id); }} aria-label={`Abrir ${text(client.display_name)}`}>{text(client.display_name)}</button><div className="small">{text(client.current_subject)}</div></td><td><Chip value={client.lifecycle}/></td><td><div className="score"><b>{score}</b><i><span style={{width:`${score}%`}} /></i></div></td><td>{client.entrada ? <><div>{formatNumber(client.client_days,0)} dias</div><div className="small">desde {new Intl.DateTimeFormat("pt-BR").format(new Date(`${client.entrada}T12:00:00`))}</div></> : "Revisão manual"}</td><td>{client.lifecycle === "CHURNED" ? "Histórico encerrado" : text(client.next_step)}<div className="small">{client.lifecycle === "CHURNED" ? "Sem alerta operacional" : relativeDate(client.next_step_due)}</div></td><td>{text(client.action_owner || client.cs_owner)}<div className="small">{client.carteira ? `Carteira ${client.carteira}` : "Sem carteira"}</div></td></tr>; })}{!clients.length && <tr><td colSpan={6} className="empty">Nenhum cliente nesse filtro.</td></tr>}</tbody></table></div></section></section>;
}

function CampaignCenter({ media, campaigns, clients, campaignFilter, setCampaignFilter, openClient }: { media: Row; campaigns: Row[]; clients: Row[]; campaignFilter:string; setCampaignFilter:(value:string)=>void; openClient: (id: string) => void }) {
  const clientById = new Map(clients.map((client) => [client.client_id, client]));
  const visibleClients=clients.filter((client)=>campaignFilter==="ALL"||(campaignFilter==="ACTIVE"?["ACTIVE","ONBOARDING"].includes(client.lifecycle):client.lifecycle===campaignFilter));
  return <section className="workspace"><div className="filter-tabs"><button type="button" aria-pressed={campaignFilter==="ACTIVE"} className={campaignFilter==="ACTIVE"?"active":""} onClick={()=>setCampaignFilter("ACTIVE")}>Ativos</button><button type="button" aria-pressed={campaignFilter==="CHURNED"} className={campaignFilter==="CHURNED"?"active":""} onClick={()=>setCampaignFilter("CHURNED")}>Churned</button><button type="button" aria-pressed={campaignFilter==="ALL"} className={campaignFilter==="ALL"?"active":""} onClick={()=>setCampaignFilter("ALL")}>Todos</button></div><MediaCenter media={media} clients={visibleClients} openClient={openClient} />{campaigns.length > 0 && <section className="card section"><div className="section-head"><div><div className="section-title">Diagnóstico por cliente</div><div className="subtitle">Volume, eficiência e atualidade da última carga</div></div></div><div className="table-wrap"><table><thead><tr><th scope="col">Cliente</th><th scope="col">Status</th><th scope="col">Investimento</th><th scope="col">Leads</th><th scope="col">CPL</th><th scope="col">Diagnóstico</th></tr></thead><tbody>{campaigns.map((row) => <tr key={`${row.client_id}-${row.account_key}`} onClick={() => row.client_id && openClient(row.client_id)}><td><b><button type="button" className="cell-open" onClick={(e) => { e.stopPropagation(); if (row.client_id) openClient(row.client_id); }} aria-label={`Abrir ${text(row.display_name || row.account_key)}`}>{text(row.display_name || clientById.get(row.client_id)?.display_name || row.account_key)}</button></b><div className="small">{text(row.latest_date)}</div></td><td><Chip value={row.lifecycle}/></td><td>{formatMoney(row.spend)}</td><td>{formatNumber(row.leads)}</td><td>{row.cpl == null ? "—" : formatMoney(row.cpl)}</td><td><CampaignDiagnosis row={row} /></td></tr>)}</tbody></table></div></section>}{!campaigns.length&&<div className="card empty">Nenhuma campanha neste filtro.</div>}</section>;
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
  const roleLabel: Record<TeamMember["role"], string> = { GT:"Gestor de Tráfego", CS:"Customer Success", DESIGN:"Design", AI:"Head de IA", MGMT:"Gestão", COMMERCIAL:"Comercial", CLOSER:"Closer", SDR:"SDR", UNASSIGNED:"Sem cadastro", FORMER:"Desligado" };
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
      return <article className={`card person-card ${canExpand ? "expandable" : ""}`} key={member.person}><div className="person-card-main" role={canExpand ? "button" : undefined} tabIndex={canExpand ? 0 : undefined} aria-expanded={canExpand ? isExpanded : undefined} onClick={() => toggle(member)} onKeyDown={(event) => { if (canExpand && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggle(member); } }}><div className="person-head"><div className="avatar">{member.person.split(" ").map((part) => part[0]).slice(0,2).join("")}</div><div><b>{member.person}</b><small>{member.carteira ? `${roleLabel[member.role]} · Carteira ${member.carteira}` : roleLabel[member.role]}</small></div>{canExpand && <span className="expand-indicator" aria-hidden="true">{isExpanded ? "−" : "+"}</span>}</div><div className={`person-stats${member.role === "CS" ? " cs" : ""}`}>{member.role === "CS" ? <><span className="hero"><b>{formatNumber(member.tasks_created_total,0)}</b><small>Criadas</small></span><span><b>{formatNumber(member.tasks_created_30d,0)}</b><small>Criadas 30d</small></span><span><b>{formatNumber(member.tasks_done,0)}</b><small>Concluídas</small></span><span><b className={member.tasks_overdue > 0 ? "red" : ""}>{formatNumber(member.tasks_overdue,0)}</b><small>Atrasadas</small></span></> : <><span><b>{formatNumber(member.tasks_done,0)}</b><small>Concluídas</small></span><span><b>{formatNumber(member.tasks_open,0)}</b><small>Em aberto</small></span><span><b className={member.tasks_overdue > 0 ? "red" : ""}>{formatNumber(member.tasks_overdue,0)}</b><small>Atrasadas</small></span><span><b>{formatNumber(member.tasks_done_30d,0)}</b><small>30 dias</small></span></>}</div><div className="person-badges">{member.role === "GT" && member.portfolio.length === 0 && <span className="team-badge info">Opera por tarefa, sem carteira</span>}{member.missing_clickup_link && <span className="team-badge warning">Sem conta ClickUp vinculada</span>}</div></div>{isExpanded && <div className="person-portfolio"><div className="portfolio-summary"><b>{member.carteira ? `Carteira ${member.carteira}` : "Carteira"} · {member.portfolio.length} clientes</b><small>{member.clients_onboarding} em onboarding</small></div>{portfolio.map((client) => <button key={client.client_id} onClick={() => openClient(client.client_id)}><span><b>{client.display_name}</b>{client.lifecycle === "ONBOARDING" && <small>Onboarding</small>}</span><Chip value={client.priority || "UNDETERMINED"}/></button>)}</div>}</article>;
    })}</div>{role === "GT" && unassigned.length > 0 && <div className="unassigned-warning"><div className="unassigned-head"><b>Cliente{unassigned.length > 1 ? "s" : ""} não distribuído{unassigned.length > 1 ? "s" : ""}</b><span>{unassigned.length}</span></div><p>Ativos sem gestor de tráfego atribuído. Não aparecem em nenhuma carteira acima.</p><div className="table-wrap"><table><thead><tr><th scope="col">Cliente</th><th scope="col">Situação</th><th scope="col">Prioridade</th><th scope="col">Dias de casa</th></tr></thead><tbody>{unassigned.map((client) => <tr key={client.client_id} onClick={() => openClient(client.client_id)}><td><b><button type="button" className="cell-open" onClick={(e) => { e.stopPropagation(); openClient(client.client_id); }} aria-label={`Abrir ${text(client.display_name)}`}>{text(client.display_name)}</button></b></td><td>{client.lifecycle === "ONBOARDING" ? "Onboarding" : "Ativo"}</td><td><Chip value={client.priority || "UNDETERMINED"}/></td><td>{client.client_days != null ? `${client.client_days}d` : "—"}</td></tr>)}</tbody></table></div></div>}</section>; })}
    <details className="card team-secondary"><summary>Sem cadastro no quadro <span>{unregistered.length}</span></summary><div className="table-wrap"><table><thead><tr><th scope="col">Nome</th><th scope="col">Concluídas</th><th scope="col">30 dias</th><th scope="col">Clientes tocados</th></tr></thead><tbody>{unregistered.map((member) => <tr key={member.person} className={member.tasks_done_30d === 0 ? "inactive-member" : ""}><td><b>{member.person}</b>{member.tasks_done_30d === 0 && <span className="inactive-label">Inativo</span>}</td><td>{formatNumber(member.tasks_done,0)}</td><td>{formatNumber(member.tasks_done_30d,0)}</td><td>{formatNumber(member.clients_touched,0)}</td></tr>)}</tbody></table></div></details>
    <details className="card team-secondary"><summary>Desligados <span>{former.length}</span></summary><div className="former-list">{former.map((member) => <div key={member.person}><span><b>{member.person}</b><small>{roleLabel[member.role]}</small></span><p>{member.former_reason || "Motivo não informado"}</p></div>)}</div></details>
  </section>;
}

function ClickUpRangeExplorer({ token, people }: { token: string; people: string[] }) {
  const presets = [
    { key: "7d", label: "7 dias" },
    { key: "30d", label: "30 dias" },
    { key: "month", label: "Mes atual" },
    { key: "prev_month", label: "Mes anterior" },
    { key: "custom", label: "Personalizado" },
  ];
  const [preset, setPreset] = useState("30d");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [rangeData, setRangeData] = useState<any>(null);
  const [rangeLoading, setRangeLoading] = useState(false);

  const range = useMemo(() => {
    const today = new Date();
    // Dia no fuso da operacao, nao em UTC: depois das 21h de Brasilia o toISOString()
    // ja' virou o dia seguinte e "Hoje" mostrava zero enquanto o time ainda trabalhava.
    const iso = (d: Date) => diaSaoPaulo(d);
    if (preset === "custom" && since && until) return { since, until };
    if (preset === "7d") return { since: iso(new Date(today.getTime() - 6 * 86400000)), until: iso(today) };
    if (preset === "month") return { since: iso(new Date(today.getFullYear(), today.getMonth(), 1)), until: iso(today) };
    if (preset === "prev_month") {
      const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const last = new Date(today.getFullYear(), today.getMonth(), 0);
      return { since: iso(first), until: iso(last) };
    }
    return { since: iso(new Date(today.getTime() - 29 * 86400000)), until: iso(today) };
  }, [preset, since, until]);

  useEffect(() => {
    let cancelled = false;
    setRangeLoading(true);
    api("clickup-range", token, { since: range.since, until: range.until, people: selected.join(",") })
      .then((res: any) => { if (!cancelled) setRangeData(res); })
      .catch(() => { if (!cancelled) setRangeData(null); })
      .finally(() => { if (!cancelled) setRangeLoading(false); });
    return () => { cancelled = true; };
  }, [token, range.since, range.until, selected]);

  const togglePerson = (p: string) => {
    setSelected((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  };

  const todayKey = diaSaoPaulo();
  const yesterdayKey = diaSaoPaulo(new Date(Date.now() - 86400000));
  const dayBeforeKey = diaSaoPaulo(new Date(Date.now() - 2 * 86400000));
  const byDate = new Map((rangeData?.daily_totals ?? []).map((row: any) => [row.date, row]));
  const dayCard = (label: string, dateKey: string) => {
    const row: any = byDate.get(dateKey);
    return (
      <span key={dateKey}>
        <b>{formatNumber(row ? row.tasks_done : 0, 0)} tarefas</b>
        {label}
      </span>
    );
  };

  return (
    <section className="card section">
      <div className="section-title">Produtividade por periodo</div>
      <div className="small">Critério de prazo atual: tarefas sem prazo cadastrado contam como sem atraso.</div>
      <div className="filter-tabs">
        {presets.map((p) => (
          <button key={p.key} type="button" className={preset === p.key ? "active" : ""} onClick={() => setPreset(p.key)}>
            {p.label}
          </button>
        ))}
      </div>
      {preset === "custom" && (
        <div className="campo-linha" style={{ marginTop: 10 }}>
          <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </div>
      )}
      <div className="attention-grid" style={{ justifyContent: "flex-start", margin: "12px 0" }}>
        {dayCard("Hoje", todayKey)}
        {dayCard("Ontem", yesterdayKey)}
        {dayCard("Anteontem", dayBeforeKey)}
      </div>
      <div className="person-badges">
        {people.map((p) => (
          <label key={p} className={"team-badge" + (selected.includes(p) ? " info" : "")}>
            <input type="checkbox" checked={selected.includes(p)} onChange={() => togglePerson(p)} style={{ marginRight: 4 }} />
            {p}
          </label>
        ))}
        {selected.length > 0 && (
          <button type="button" className="link-btn" onClick={() => setSelected([])}>
            limpar selecao
          </button>
        )}
      </div>
      {rangeLoading && <div className="empty">Carregando...</div>}
      {!rangeLoading && rangeData && (
        <div>
          {(rangeData.summary ?? []).map((row: any) => {
            const totalConsiderado = Number(row.completed_on_time ?? 0) + Number(row.completed_late ?? 0);
            const semAtrasoPct = totalConsiderado > 0 ? (100 * Number(row.completed_on_time ?? 0)) / totalConsiderado : null;
            return (
              <div className="productivity-row" key={row.user_id}>
                <div>
                  <b>{row.person}</b>
                  <small>{formatNumber(row.tasks_done, 0)} tarefas concluídas · {row.avg_cycle_hours == null ? "Ciclo médio não disponível" : `Ciclo médio ${formatNumber(row.avg_cycle_hours)}h`}</small>
                </div>
                <div title="Critério atual: tarefas concluídas até o prazo e tarefas sem prazo cadastrado contam como sem atraso; atraso é conclusão após a data limite do ClickUp." style={{ textAlign: "right" }}>
                  <small style={{ display: "block" }}>Sem atraso registrado</small>
                  <strong style={{ display: "block" }}>{formatNumber(row.completed_on_time, 0)} / {formatNumber(totalConsiderado, 0)} tarefas</strong>
                  <small style={{ display: "block" }}>{semAtrasoPct == null ? "Percentual não disponível" : `${formatNumber(semAtrasoPct, 1)}% sem atraso`}</small>
                </div>
              </div>
            );
          })}
          {!(rangeData.summary ?? []).length && <div className="empty">Sem dados no periodo selecionado.</div>}
        </div>
      )}
    </section>
  );
}


const TASK_CATEGORIES_BY_ROLE: Record<string, string[]> = {
  GT: ["Campanha nova subida", "Otimização de campanha", "Ajuste de orçamento", "Análise de métricas", "Reunião com cliente", "Outro"],
  CS: ["Atendimento ao cliente", "Onboarding", "Reunião com cliente", "Resolução de pendência", "Relatório de resultados", "Outro"],
  DESIGN: ["Criativo novo", "Revisão de arte", "Edição de vídeo", "Banco de imagens", "Reunião de briefing", "Outro"],
  AI: ["Automação criada", "Otimização de prompt/IA", "Integração de sistema", "Análise de dados", "Reunião", "Outro"],
  MGMT: ["Reunião de gestão", "Planejamento estratégico", "Revisão de equipe", "Financeiro", "Reunião com cliente", "Outro"],
};
const DEFAULT_TASK_CATEGORIES = ["Execução", "Reunião", "Criativo", "Atendimento", "Outro"];

const ADJ_TIPOS_BY_ROLE: Record<string, string[]> = {
  GT: ["Ajuste de campanha", "Otimização de budget", "Ajuste de segmentação", "Observação", "Pendência", "Risco identificado"],
  CS: ["Ajuste de atendimento", "Alinhamento com cliente", "Observação", "Pendência", "Risco identificado"],
  DESIGN: ["Ajuste de criativo", "Revisão de arte", "Observação", "Pendência", "Risco identificado"],
  AI: ["Ajuste de automação", "Ajuste de fluxo", "Observação", "Pendência", "Risco identificado"],
  MGMT: ["Ajuste estratégico", "Observação", "Pendência", "Risco identificado"],
};
const DEFAULT_ADJ_TIPOS = ["Ajuste realizado", "Observação", "Pendência", "Risco identificado"];

function DiaryCenter({ clients, adjustments, taskLog, profile, token, reload }: { clients: Row[]; adjustments: Row[]; taskLog: Row; profile: Row; token: string; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<"ajustes" | "tasklog">("ajustes");

  const activeClientsSorted = useMemo(
    () => clients.filter((client) => ["ACTIVE", "ONBOARDING"].includes(client.lifecycle)).sort((a, b) => String(a.display_name ?? "").localeCompare(String(b.display_name ?? ""), "pt-BR")),
    [clients]
  );

  const role = String(profile?.role || "").toUpperCase();
    const taskCategoryOptions = TASK_CATEGORIES_BY_ROLE[role] || DEFAULT_TASK_CATEGORIES;
    const adjTipoOptions = ADJ_TIPOS_BY_ROLE[role] || DEFAULT_ADJ_TIPOS;

    const [adjClient, setAdjClient] = useState("");
  const [adjTipo, setAdjTipo] = useState(adjTipoOptions[0]);
  const [adjDescricao, setAdjDescricao] = useState("");
  const [adjSaving, setAdjSaving] = useState(false);
  const [adjError, setAdjError] = useState("");

  async function submitAdjustment() {
    if (!adjClient || !adjDescricao.trim()) { setAdjError("Selecione o cliente e escreva a descrição."); return; }
    setAdjSaving(true);
    setAdjError("");
    try {
      await apiPost("adjustment-create", token, { client_id: adjClient, tipo: adjTipo, descricao: adjDescricao.trim() });
      setAdjDescricao("");
      await reload();
    } catch (caught) {
      setAdjError(caught instanceof Error ? caught.message : "Falha ao registrar ajuste.");
    } finally {
      setAdjSaving(false);
    }
  }

  const [taskCategory, setTaskCategory] = useState(taskCategoryOptions[0]);
  const [taskName, setTaskName] = useState("");
  const [taskDate, setTaskDate] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()));
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskError, setTaskError] = useState("");

  async function submitTask() {
    if (!taskName.trim()) { setTaskError("Descreva a tarefa."); return; }
    setTaskSaving(true);
    setTaskError("");
    try {
      await apiPost("tasklog-create", token, { category: taskCategory, task_name: taskName.trim(), task_date: taskDate });
      setTaskName("");
      await reload();
    } catch (caught) {
      setTaskError(caught instanceof Error ? caught.message : "Falha ao registrar tarefa.");
    } finally {
      setTaskSaving(false);
    }
  }

  const isFullView = profile?.access_level === "FULL" || profile?.elevated;
  const recentAdjustments = adjustments.slice(0, 50);
  const recentTasks = (taskLog.recent || []).slice(0, 50);
  const row = { display: "flex", gap: 8, flexWrap: "wrap" as const, marginTop: 10 };
  const wide = { width: "100%", marginTop: 10, minHeight: 80 };

  return (
    <section className="workspace">
      <div className="workspace-head">
        <div><h2>Diário</h2><p>Registre ajustes de clientes e tarefas executadas direto no dashboard — sem depender dos apps desktop.</p></div>
        <span className="counter">{adjustments.length} ajustes · {taskLog.total || 0} tarefas</span>
      </div>
      <div className="filter-tabs">
        <button type="button" className={tab === "ajustes" ? "active" : ""} onClick={() => setTab("ajustes")}>Diário de Ajustes</button>
        <button type="button" className={tab === "tasklog" ? "active" : ""} onClick={() => setTab("tasklog")}>TaskLog</button>
      </div>

      {tab === "ajustes" && (
        <>
          <section className="card section">
            <div className="section-title">Novo ajuste</div>
            <div style={row}>
              <select className="control" value={adjClient} onChange={(event) => setAdjClient(event.target.value)}>
                <option value="">Selecione o cliente…</option>
                {activeClientsSorted.map((client) => <option key={client.client_id} value={client.client_id}>{client.display_name}</option>)}
              </select>
              <select className="control" value={adjTipo} onChange={(event) => setAdjTipo(event.target.value)}>
                {adjTipoOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>
            <textarea className="control" style={wide} placeholder="O que foi feito ou observado…" value={adjDescricao} onChange={(event) => setAdjDescricao(event.target.value)} />
            {adjError && <div className="error-box" style={{ marginTop: 8 }}>{adjError}</div>}
            <button type="button" className="primary" style={{ marginTop: 10 }} disabled={adjSaving} onClick={submitAdjustment}>{adjSaving ? "Salvando…" : "Registrar ajuste"}</button>
          </section>
          <section className="card section" style={{ marginTop: 16 }}>
            <div className="section-title">Últimos ajustes</div>
            {recentAdjustments.map((entry: Row) => (
              <div className="productivity-row" key={entry.id}>
                <div><b>{text(entry.client_display_name || "Cliente")}</b><small>{text(entry.tipo)} · {text(entry.descricao)}</small></div>
                <strong>{formatDate(entry.occurred_at)}</strong>
              </div>
            ))}
            {!recentAdjustments.length && <div className="empty">Nenhum ajuste registrado ainda.</div>}
          </section>
        </>
      )}

      {tab === "tasklog" && (
        <>
          <section className="card section">
            <div className="section-title">Nova tarefa</div>
            <div style={row}>
              <select className="control" value={taskCategory} onChange={(event) => setTaskCategory(event.target.value)}>
                {taskCategoryOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              <input type="date" className="control" value={taskDate} onChange={(event) => setTaskDate(event.target.value)} />
            </div>
            <input className="control" style={{ width: "100%", marginTop: 10 }} placeholder="O que foi feito…" value={taskName} onChange={(event) => setTaskName(event.target.value)} />
            {taskError && <div className="error-box" style={{ marginTop: 8 }}>{taskError}</div>}
            <button type="button" className="primary" style={{ marginTop: 10 }} disabled={taskSaving} onClick={submitTask}>{taskSaving ? "Salvando…" : "Registrar tarefa"}</button>
          </section>
          <section className="card section" style={{ marginTop: 16 }}>
            <div className="section-title">{isFullView ? "Últimas tarefas da equipe" : "Minhas últimas tarefas"}</div>
            {recentTasks.map((entry: Row, index: number) => (
              <div className="productivity-row" key={entry.id || index}>
                <div><b>{text(entry.task_name)}</b><small>{text(entry.category)} · {text(entry.collaborator_name)}</small></div>
                <strong>{formatDate(entry.task_date)}</strong>
              </div>
            ))}
            {!recentTasks.length && <div className="empty">Nenhuma tarefa registrada ainda.</div>}
          </section>
        </>
      )}
    </section>
  );
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
      <Metric label="Concluídas registradas" value={`${formatNumber(clickup.total_completed, 0)} tarefas`} tone="green" hint="desde janeiro de 2026"/>
      <Metric label="Indexadas por cliente" value={indexing.matched == null ? "Acesso restrito" : `${formatNumber(indexing.matched, 0)} tarefas vinculadas`} tone="blue" hint={indexing.unmatched_label == null ? "Disponível apenas para perfis com visão global do ClickUp" : `${formatNumber(indexing.unmatched_label, 0)} com rótulo sem correspondência · ${formatNumber(indexing.without_label || 0, 0)} sem rótulo`}/>
      <Metric label="Pessoas com entregas" value={`${formatNumber(productivity.length, 0)} pessoas`} tone="blue" hint="últimos 30 dias"/>
      <Metric label="Última sincronização" value={clickup.last_sync ? (pt[text(clickup.last_sync.status)] || text(clickup.last_sync.status)) : "Sem sincronização"} tone={clickup.last_sync?.status === "SUCCESS" ? "green" : "yellow"} hint={clickup.last_sync ? formatDate(clickup.last_sync.finished_at || clickup.last_sync.started_at) : "Nenhuma execução registrada"}/>
    </div>
    {!connected && <div className="connection-note"><b>A ponte e o banco já estão prontos.</b><p>Falta configurar o token da API e o ID do Workspace ClickUp. O segredo do webhook será criado e guardado automaticamente ao ativar o tempo real.</p></div>}
    <ClickUpRangeExplorer token={token} people={(clickup.productivity_30d ?? []).map((r: any) => r.person)} />
    <div className="grid clickup-split">
      <section className="card section"><div className="section-title">Produção por pessoa · 30 dias{collabFilter !== "ALL" && ` · ${collabFilter}`}</div>{filteredProductivity.map((row: Row, index: number) => <div className="productivity-row" key={row.user_id}><span className="rank">{String(index+1).padStart(2,"0")}</span><div><b>{text(row.person)}</b><small title="Critério atual: tarefas sem prazo cadastrado também contam como sem atraso.">{formatNumber(row.tracked_hours)} horas registradas · {row.on_time_pct == null ? "Sem base para indicador de prazo" : `${formatNumber(row.on_time_pct)}% sem atraso registrado`}</small></div><strong>{formatNumber(row.tasks_done, 0)} tarefas</strong></div>)}{!filteredProductivity.length && <div className="empty">{productivity.length ? "Nenhum resultado para esse colaborador." : "Os indicadores aparecerão após a primeira sincronização."}</div>}</section>
      <section className="card section"><div className="section-title">Últimas tarefas concluídas{collabFilter !== "ALL" && ` · ${collabFilter}`}</div><div className="table-wrap"><table className="completed-table"><thead><tr><th scope="col">Tarefa</th><th scope="col">Colaborador</th><th scope="col">Lista e conclusão</th><th scope="col">Status</th></tr></thead><tbody>{filteredRecent.slice(0,20).map((task: Row) => { const assignees = Array.isArray(task.clickup_task_assignees) ? task.clickup_task_assignees : []; const collaboratorsLabel = assignees.map((person: Row) => person.username || person.email).filter(Boolean).join(", ") || "Não atribuído"; return <tr key={task.task_id}><td><a href={task.url || undefined} target="_blank" rel="noreferrer"><b>{text(task.name)}</b></a></td><td>{collaboratorsLabel}</td><td>{text(task.list_name)}<div className="small">{formatDate(task.date_closed)}</div></td><td><Chip value={task.status}/></td></tr>; })}{!filteredRecent.length && <tr><td colSpan={4} className="empty">{recent.length ? "Nenhuma tarefa desse colaborador." : "Nenhuma tarefa importada ainda."}</td></tr>}</tbody></table></div></section>
    </div>
    {unmatchedLabels.length > 0 && <section className="card section"><div className="section-title">Rótulos sem correspondência na base de clientes</div>{unmatchedLabels.slice(0,20).map((row: Row, index: number) => <div className="productivity-row" key={`${row.client_label}-${index}`}><span className="rank">{String(index+1).padStart(2,"0")}</span><div><b>[{text(row.client_label)}]</b><small>Requer cliente cadastrado ou confirmação de equivalência</small></div><strong>{formatNumber(row.task_count, 0)} tarefas</strong></div>)}</section>}
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

function AlertCenter({ alerts, clients, profile, token, canEscalate, openClient, openWork }: { alerts: Row[]; clients: Row[]; profile: Row; token: string; canEscalate: boolean; openClient: (id: string) => void; openWork: (id: string) => void }) {
  const clientById = new Map(clients.map((client) => [client.client_id, client]));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<Record<string, Row>>({});
  const [snooze, setSnooze] = useState<Record<string, string>>({});

  async function act(alert: Row, action: "CS" | "DESIGN" | "OPS" | "CLICKUP" | "ANALYZED" | "SNOOZE" | "FALSE") {
    const client = clientById.get(alert.client_id);
    const target = action === "CS" ? { role: "CS", person: client?.cs_owner, type: "ESCALATION" }
      : action === "DESIGN" ? { role: "DESIGN", person: client?.designer_owner, type: "CREATIVE_REQUEST" }
      : action === "OPS" ? { role: "MGMT", person: "Adler Furtado", type: "TECHNICAL" }
      : action === "CLICKUP" ? { role: profile.role || "GT", person: profile.person, type: "CLICKUP" }
      : { role: profile.role || "GT", person: profile.person, type: "GENERAL" };
    const titlePrefix = action === "CS" ? "Cliente/atendimento" : action === "DESIGN" ? "Solicitação criativa" : action === "OPS" ? "Problema técnico" : action === "CLICKUP" ? "Ação no ClickUp" : action === "FALSE" ? "Falso alerta" : action === "SNOOZE" ? "Alerta adiado" : "Alerta analisado";
    setBusy(`${alert.id}:${action}`); setMessage((current) => ({ ...current, [String(alert.id)]: {} }));
    try {
      const due = action === "SNOOZE" ? (snooze[String(alert.id)] ? new Date(`${snooze[String(alert.id)]}T12:00:00`).toISOString() : new Date(Date.now() + 86400000).toISOString()) : null;
      const created = await apiPost("work-item-create", token, {
        client_id: alert.client_id || null,
        type: target.type,
        priority: ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(alert.severity) ? alert.severity : "MEDIUM",
        title: `${titlePrefix}: ${text(alert.title)}`,
        description: `${text(alert.description)}\n\nOrigem: alerta ${text(alert.id)}`,
        source: "operational_alert",
        source_id: String(alert.id),
        target_role: target.role,
        target_person: target.person || null,
        due_at: due,
        create_clickup: action === "CLICKUP",
        metadata: { alert_id: alert.id, alert_type: alert.alert_type || null, original_severity: alert.severity },
      });
      if (["ANALYZED", "SNOOZE", "FALSE"].includes(action)) {
        await apiPost("work-item-update", token, { id: created.item.id, status: action === "ANALYZED" ? "COMPLETED" : action === "FALSE" ? "DISMISSED" : "SNOOZED", resolution: action === "ANALYZED" ? "Alerta analisado no dashboard." : action === "FALSE" ? "Marcado como falso alerta." : "Adiado para nova análise.", snoozed_until: due });
      }
      setMessage((current) => ({ ...current, [String(alert.id)]: { ok: true, id: created.item.id, clickup: created.clickup, text: action === "CLICKUP" ? "Tarefa criada no ClickUp e vinculada ao dashboard." : action === "ANALYZED" ? "Análise registrada no banco." : action === "FALSE" ? "Falso alerta registrado." : action === "SNOOZE" ? "Alerta adiado e registrado." : `Encaminhado para ${target.person || target.role}.` } }));
    } catch (caught) {
      setMessage((current) => ({ ...current, [String(alert.id)]: { error: true, text: caught instanceof Error ? caught.message : "Não foi possível registrar a ação." } }));
    } finally { setBusy(""); }
  }

  return <section className="workspace"><div className="workspace-head"><div><h2>Central de alertas</h2><p>Investigue, encaminhe ao responsável ou transforme o sinal em tarefa rastreável.</p></div><span className="counter">{alerts.length} abertos</span></div><section className="card alert-list actionable">{alerts.map((alert) => { const client = clientById.get(alert.client_id); const open = expanded === String(alert.id); const feedback = message[String(alert.id)]; return <article className={open ? "open" : ""} key={alert.id}><button className="alert-main" onClick={() => setExpanded(open ? null : String(alert.id))}><Chip value={alert.severity} /><div><strong>{text(alert.title)}</strong><p>{text(alert.description)}</p><small>{client ? text(client.display_name) : "Alerta geral"} · aberto em {formatDate(alert.first_detected_at)}</small></div><span className="arrow">{open ? "−" : "+"}</span></button>{open && <div className="alert-actions-panel">{client && <button className="link-btn" onClick={() => openClient(client.client_id)}>Abrir cliente</button>}{canEscalate && <><div className="alert-quick-actions"><button disabled={Boolean(busy)} onClick={() => act(alert, "CS")}>Encaminhar para CS</button><button disabled={Boolean(busy)} onClick={() => act(alert, "DESIGN")}>Solicitar ao designer</button><button disabled={Boolean(busy)} onClick={() => act(alert, "OPS")}>Problema técnico · Operações</button><button disabled={Boolean(busy)} onClick={() => act(alert, "CLICKUP")}>Criar tarefa no ClickUp</button><button disabled={Boolean(busy)} onClick={() => act(alert, "ANALYZED")}>Registrar como analisado</button><button className="muted" disabled={Boolean(busy)} onClick={() => act(alert, "FALSE")}>Marcar falso alerta</button></div><div className="alert-snooze"><input className="control" type="date" value={snooze[String(alert.id)] || ""} onChange={(event) => setSnooze((current) => ({ ...current, [String(alert.id)]: event.target.value }))} /><button disabled={Boolean(busy)} onClick={() => act(alert, "SNOOZE")}>Adiar até esta data</button></div></>}{feedback?.text && <div className={`alert-feedback${feedback.error ? " error" : " success"}`}><span>{feedback.text}</span>{feedback.ok && feedback.id && <button onClick={() => openWork(String(feedback.id))}>Abrir demanda</button>}{feedback.clickup?.url && <a href={feedback.clickup.url} target="_blank" rel="noreferrer">Abrir ClickUp ↗</a>}</div>}</div>}</article>; })}{!alerts.length && <div className="empty">Nenhum alerta aberto.</div>}</section></section>;
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
  return <section className="workspace"><div className="workspace-head"><div><h2>Pré-clientes</h2><p>Oportunidades avançadas do CRM Comercial antes de entrarem na operação.</p></div><span className="counter">{rows.length} oportunidades</span></div><div className="grid clickup-kpis"><Metric label="Em proposta" value={formatNumber(rows.filter(r=>r.stage==="proposta").length)} tone="blue" hint="proposta enviada"/><Metric label="Em negociação" value={formatNumber(rows.filter(r=>r.stage==="negociacao").length)} tone="yellow" hint="acompanhamento comercial"/><Metric label="Fechamentos detectados" value={formatNumber(won.length)} tone="green" hint="deduplicados pelo CRM"/><Metric label="Valor em aberto" value={formatMoney(rows.reduce((s,r)=>s+Number(r.estimated_value||0),0))} tone="blue" hint="valor estimado"/></div><section className="card section"><div className="table-wrap"><table><thead><tr><th scope="col">Empresa</th><th scope="col">Etapa</th><th scope="col">Tempo</th><th scope="col">Valor</th><th scope="col">Última interação</th><th scope="col">Próxima ação</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td><b>{text(row.company||row.name)}</b><div className="small">{text(row.source)}</div></td><td><Chip value={String(row.stage).toUpperCase()}/></td><td>{formatNumber(row.days_in_stage,0)} dias</td><td>{formatMoney(row.estimated_value)}</td><td>{formatDate(row.last_interaction||row.updated_at)}</td><td>{text(row.next_action)}<div className="small">{formatDate(row.next_action_at)}</div></td></tr>)}</tbody></table></div></section></section>;
}

function AuditCenter({runs,issues}:{runs:Row[];issues:Row[]}) {
  const run=runs[0]||{};
  return <section className="workspace"><div className="workspace-head"><div><h2>Confiabilidade dos dados</h2><p>Auditoria rastreável da base, relacionamentos e métricas derivadas.</p></div><Chip value={run.status}/></div><div className="grid clickup-kpis"><Metric label="Registros analisados" value={formatNumber(run.records_analyzed,0)} tone="blue" hint="base operacional e CRM"/><Metric label="Inconsistências" value={formatNumber(run.issues_found,0)} tone="yellow" hint="registradas com origem"/><Metric label="Correções seguras" value={formatNumber(run.issues_corrected,0)} tone="green" hint="sem inventar evidências"/><Metric label="Revisão manual" value={formatNumber(run.manual_review,0)} tone="red" hint="conflitos preservados"/></div><section className="card section"><div className="section-head"><div><div className="section-title">Relatório de inconsistências</div><div className="subtitle">Último recálculo: {formatDate(run.completed_at||run.started_at)}</div></div></div>{issues.map(issue=><div className="audit-row" key={issue.id}><Chip value={issue.severity}/><div><b>{issue.category} · {issue.issue_code.replaceAll("_"," ")}</b><small>{issue.explanation}</small></div><Chip value={issue.resolution_status==="MANUAL_REVIEW"?"REVISÃO MANUAL":issue.resolution_status}/></div>)}</section></section>;
}

function GlobalCommand({clients,tasks,preclients,close,openClient}:{clients:Row[];tasks:Row[];preclients:Row[];close:()=>void;openClient:(id:string)=>void}) {
  const dialogRef = useDialogFocus(close);
  const [search,setSearch]=useState(""); const needle=search.toLowerCase().trim();
  const clientRows=needle?clients.filter(c=>[c.display_name,c.cs_owner,c.gt_owner,c.current_subject,c.next_step].join(" ").toLowerCase().includes(needle)).slice(0,8):clients.slice(0,5);
  const taskRows=needle?tasks.filter(t=>[t.name,t.list_name,t.status].join(" ").toLowerCase().includes(needle)).slice(0,5):[];
  const leadRows=needle?preclients.filter(p=>[p.name,p.company,p.stage].join(" ").toLowerCase().includes(needle)).slice(0,5):[];
  return <><div className="overlay open" onClick={close}/><section ref={dialogRef as React.RefObject<HTMLElement>} role="dialog" aria-modal="true" aria-label="Busca operacional" className="command-modal"><div className="command-input"><span>⌕</span><input autoFocus value={search} onChange={e=>setSearch(e.target.value)} placeholder="Pesquisar cliente, tarefa, responsável, campanha ou pré-cliente"/><kbd>Esc</kbd></div><div className="command-results"><small>CLIENTES</small>{clientRows.map(c=><button key={c.client_id} onClick={()=>{openClient(c.client_id);close();}}><span><b>{c.display_name}</b><small>{pt[c.lifecycle]||c.lifecycle} · CS {text(c.cs_owner)} · GT {text(c.gt_owner)} · {text(c.next_step)}</small></span><Chip value={c.priority}/></button>)}{taskRows.length>0&&<small>TAREFAS</small>}{taskRows.map(t=><a key={t.task_id} href={t.url} target="_blank" rel="noreferrer"><span><b>{t.name}</b><small>{t.list_name} · {formatDate(t.date_closed)}</small></span><Chip value={t.status}/></a>)}{leadRows.length>0&&<small>PRÉ-CLIENTES</small>}{leadRows.map(p=><button key={p.id}><span><b>{p.company||p.name}</b><small>{p.stage} · {formatMoney(p.estimated_value)}</small></span></button>)}</div></section></>;
}

// Caixa de anotação do colaborador. O texto vai inteiro e cru para o banco; o
// vínculo com cliente é palpite do sistema, mostrado de volta para quem escreveu
// poder corrigir na hora. Duas leituras diferentes do mesmo texto — a da pessoa e
// a da máquina — nunca ficam em conflito silencioso.
function NoteBox({ token, clients }: { token: string; clients: Row[] }) {
  const [texto, setTexto] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [ultima, setUltima] = useState<Row | null>(null);

  async function salvar(clientId?: string) {
    const corpo = texto.trim();
    if (corpo.length < 3) return;
    setSalvando(true);
    try {
      const r = await apiPost("note-create", token, clientId ? { body: corpo, client_id: clientId } : { body: corpo });
      setUltima(r); setTexto("");
    } finally { setSalvando(false); }
  }

  async function confirmar(id: string, clientId: string) {
    const r = await apiPost("note-confirm", token, { id, client_id: clientId });
    setUltima({ ...(ultima || {}), match_status: "MANUAL", client_id: clientId, candidatos: [], confirmado: true, note: r?.note });
  }

  const nomeDe = (id: string) => clients.find((c) => c.client_id === id || c.id === id)?.display_name || "cliente";

  return <div className="note-box">
    <label htmlFor="nota-ops">Anotar algo</label>
    <textarea id="nota-ops" value={texto} rows={3} disabled={salvando}
      placeholder="O que aconteceu? Cite o cliente pelo nome — ex.: “Beto disse que vai cancelar se não melhorar o volume”."
      onChange={(e) => setTexto(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) salvar(); }} />
    <div className="note-actions">
      <small>Ctrl+Enter para salvar</small>
      <button disabled={salvando || texto.trim().length < 3} onClick={() => salvar()}>{salvando ? "Salvando…" : "Salvar"}</button>
    </div>

    {ultima?.ok && <div className={`note-echo ${ultima.match_status === "AMBIGUOUS" ? "duvida" : ""}`}>
      {ultima.match_status === "MATCHED" || ultima.match_status === "MANUAL"
        ? <p>Guardado em <b>{nomeDe(String(ultima.client_id))}</b>.</p>
        : ultima.match_status === "AMBIGUOUS"
        ? <><p>Guardado. Citou mais de um cliente — <b>qual é?</b></p>
            <div className="note-opcoes">{(ultima.candidatos || []).map((c: Row) =>
              <button key={String(c.client_id)} onClick={() => confirmar(String(ultima.id), String(c.client_id))}>{text(c.nome)}</button>)}</div></>
        : <p>Guardado <b>sem cliente</b>. Cite o nome dele no texto para vincular.</p>}
      {!!(ultima.sinais || []).length && <p className="note-sinais">Sinais lidos: {(ultima.sinais || []).map((x: Row) => text(x.sinal)).join(", ")}</p>}
    </div>}
  </div>;
}

function ProfileMenu({preferences,profile,email,settings,openWalletManagement,canManageWallets,close,signOut,requestAccess,token,clients}:{preferences:Row;profile:Row;email:string;settings:()=>void;openWalletManagement:()=>void;canManageWallets:boolean;close:()=>void;signOut:()=>Promise<unknown>;requestAccess:()=>Promise<void>;token:string;clients:Row[]}) {
  const dialogRef = useDialogFocus(close);
  const name=preferences.name||email;
  const showRequest = profile?.access_level === "RESTRICTED" && !profile?.elevated;
  const pending = preferences?.my_access_request?.status === "PENDING";
  const [asking, setAsking] = useState(false);
  async function ask() { setAsking(true); try { await requestAccess(); } finally { setAsking(false); } }
  return <div ref={dialogRef as React.RefObject<HTMLDivElement>} role="dialog" aria-modal="true" aria-label="Menu do perfil" className="profile-menu"><div className="profile-card"><span className="avatar">{initials(name)}</span><div><b>{text(name)}</b><small>{text(preferences.role||"Colaborador")}</small></div></div>
    {showRequest && <button className="request-access" disabled={pending || asking} onClick={ask}>{pending ? "Solicitação enviada — aguardando Adler" : asking ? "Enviando…" : "Solicitar acesso completo"}</button>}
    {canManageWallets && <button className="wallet-management-entry" onClick={openWalletManagement}>Gestão de carteiras</button>}<NoteBox token={token} clients={clients} /><button onClick={settings}>Meu perfil</button><button onClick={settings}>Configurações</button><button onClick={settings}>Preferências</button><button onClick={close}>Notificações</button><button className="muted" onClick={() => signOut()}>Sair</button></div>;
}

function DailyLeadRadarModal({items,token,refresh,openClient,profile}:{items:Row[];token:string;refresh:()=>Promise<void>;openClient:(id:string)=>void;profile:Row}) {
  const [closing,setClosing]=useState(false);
  const [dismissed,setDismissed]=useState(false);
  const [selectedGt,setSelectedGt]=useState("ALL");
  const [drafts,setDrafts]=useState<Record<string,Row>>({});
  const [saving,setSaving]=useState<string|null>(null);
  const [formError,setFormError]=useState("");
  const profileRole=String(profile?.role||"");
  const profilePerson=String(profile?.person||"");
  const reasonOptions=[
    ["CLIENT_NO_RESPONSE","Cliente sumido / sem retorno"],
    ["WAITING_AD_BALANCE","Aguardando cliente abastecer saldo"],
    ["CLIENT_PAYMENT_PENDING","Pendência financeira do cliente"],
    ["CLIENT_REQUESTED_PAUSE","Cliente pediu pausa / stand-by"],
    ["NO_ACTIVE_CAMPAIGN","Sem campanha ativa"],
    ["CAMPAIGN_REVIEW_OR_BLOCK","Campanha/anúncio em análise ou bloqueado"],
    ["CAMPAIGN_DELIVERY_ISSUE","Problema de entrega da campanha"],
    ["NEW_CAMPAIGN_LEARNING","Campanha nova / em aprendizado"],
    ["TRACKING_OR_INTEGRATION","Tracking / integração / dado do Meta"],
    ["LOW_BUDGET","Orçamento insuficiente / limitado"],
    ["OTHER","Outro motivo"],
  ] as const;
  const reasonLabel=(code:unknown)=>reasonOptions.find(([value])=>value===String(code||""))?.[1]||String(code||"—");
  const getGt=(item:Row)=>String(item.metadata?.gt_owner||item.metadata?.target_person||"Sem GT").trim()||"Sem GT";
  const gtNames=Array.from(new Set(items.map(getGt))).sort((a,b)=>a.localeCompare(b,"pt-BR"));
  const visibleItems=selectedGt==="ALL"?items:items.filter((item)=>getGt(item)===selectedGt);
  const zero=visibleItems.filter((item)=>Number(item.metadata?.leads||0)===0);
  const low=visibleItems.filter((item)=>Number(item.metadata?.leads||0)>0);
  const money=(value:unknown)=>value==null||value===""?"—":formatMoney(Number(value));
  const numberPt=(value:unknown,digits=0)=>new Intl.NumberFormat("pt-BR",{maximumFractionDigits:digits,minimumFractionDigits:digits}).format(Number(value||0));
  const savedFor=(item:Row)=>{
    const local=drafts[String(item.id)];
    if(local?.__saved)return local;
    return item.metadata?.daily_lead_explanation||null;
  };
  const pendingRequired=profileRole==="GT"
    ? items.filter((item)=>Number(item.metadata?.leads||0)===0&&!savedFor(item)?.reason_code)
    : [];

  useEffect(()=>{
    setDrafts((current)=>{
      let changed=false;
      const next={...current};
      for(const item of items){
        const id=String(item.id||"");
        if(!id)continue;
        const saved=item.metadata?.daily_lead_explanation;
        if(saved&&(!next[id]||(!next[id].__touched&&!next[id].__saved))){
          next[id]={...saved,__saved:true,__touched:false};
          changed=true;
        }else if(!next[id]){
          next[id]={reason_code:"",reason_detail:"",action_taken:"",follow_up_on:"",__saved:false,__touched:false};
          changed=true;
        }
      }
      return changed?next:current;
    });
  },[items]);

  const updateDraft=(id:string,patch:Row)=>setDrafts((current)=>({
    ...current,
    [id]:{...(current[id]||{}),...patch,__saved:false,__touched:true},
  }));

  async function saveExplanation(item:Row){
    const id=String(item.id||"");
    const draft=drafts[id]||{};
    if(!draft.reason_code){
      setFormError("Selecione o motivo antes de salvar a justificativa.");
      return;
    }
    setSaving(id);
    setFormError("");
    try{
      const result=await apiPost("daily-lead-explanation",token,{
        notification_id:id,
        reason_code:draft.reason_code,
        reason_detail:draft.reason_detail||null,
        action_taken:draft.action_taken||null,
        follow_up_on:draft.follow_up_on||null,
      });
      setDrafts((current)=>({
        ...current,
        [id]:{...(result?.explanation||draft),__saved:true,__touched:false},
      }));
    }catch(caught){
      setFormError(caught instanceof Error?caught.message:"Falha ao salvar a justificativa.");
    }finally{
      setSaving(null);
    }
  }

  async function acknowledge(){
    if(closing||dismissed)return;
    if(pendingRequired.length){
      setFormError(`Justifique ${pendingRequired.length} cliente${pendingRequired.length===1?"":"s"} com zero leads antes de concluir.`);
      return;
    }
    setFormError("");
    setClosing(true);
    try{
      const ids=items.map((item)=>String(item.id)).filter(Boolean);
      await apiPost("notifications-read",token,{ids});
      setDismissed(true);
      await refresh();
    }finally{setClosing(false);}
  }

  useEffect(()=>{
    const onKeyDown=(event:KeyboardEvent)=>{
      if(event.key==="Escape"){
        event.preventDefault();
        void acknowledge();
      }
    };
    document.addEventListener("keydown",onKeyDown);
    return ()=>document.removeEventListener("keydown",onKeyDown);
  },[closing,dismissed,items,token,pendingRequired.length]);

  function exportCsv(){
    const headers=["Cliente","Carteira GT","Leads","Investimento","CPL","Impressões","Alcance","Cliques","CTR","CPC","CPM","Frequência","Campanhas ativas","Fonte KPI","Meta vinculada","Motivo","Detalhe","Ação / próximo passo","Prazo / retorno","Justificado por","Justificado em"];
    const clean=(value:unknown)=>String(value??"").replace(/"/g,'""');
    const rows=visibleItems.map((item)=>{
      const m=item.metadata||{};
      const x=savedFor(item)||{};
      const name=String(item.title||"").replace(/^ZERO LEADS HOJE\s*[—-]?\s*/i,"").replace(/^BAIXO VOLUME DE LEADS\s*[—-]?\s*/i,"").replace(/\s*\(\d+\)\s*$/,"");
      return [
        name,getGt(item),Number(m.leads||0),m.spend==null?"":numberPt(m.spend,2),m.cpl==null?"":numberPt(m.cpl,2),
        m.impressions==null?"":numberPt(m.impressions),m.reach==null?"":numberPt(m.reach),m.clicks==null?"":numberPt(m.clicks),
        m.ctr==null?"":numberPt(m.ctr,2),m.cpc==null?"":numberPt(m.cpc,2),m.cpm==null?"":numberPt(m.cpm,2),
        m.frequency==null?"":numberPt(m.frequency,2),m.active_campaigns==null?"":numberPt(m.active_campaigns),m.kpi_source||"",
        m.meta_data_available===false?"Não":"Sim",x.reason_code?reasonLabel(x.reason_code):"",x.reason_detail||"",x.action_taken||"",
        x.follow_up_on||"",x.submitted_by||"",x.updated_at||x.submitted_at||"",
      ];
    });
    const csv="\uFEFF"+[headers,...rows].map((row)=>row.map((cell)=>`"${clean(cell)}"`).join(";")).join("\r\n");
    const blob=new Blob([csv],{type:"text/csv;charset=utf-8;"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`radar-leads-${todayOpsSafe()}-${selectedGt==="ALL"?"geral":selectedGt.replace(/[^a-z0-9]+/gi,"-").toLowerCase()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function todayOpsSafe(){
    return new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
  }

  const Card=({item}:{item:Row})=>{
    const m=item.metadata||{};
    const noLeads=Number(m.leads||0)===0;
    const id=String(item.id||"");
    const name=String(item.title||"").replace(/^ZERO LEADS HOJE\s*[—-]?\s*/i,"").replace(/^BAIXO VOLUME DE LEADS\s*[—-]?\s*/i,"").replace(/\s*\(\d+\)\s*$/,"");
    const draft=drafts[id]||{reason_code:"",reason_detail:"",action_taken:"",follow_up_on:""};
    const saved=savedFor(item);
    const canExplain=(profileRole==="GT"&&getGt(item)===profilePerson)||profileRole==="MGMT"||profilePerson==="Adler Furtado";
    return <article className={`dlr-client ${noLeads?"zero":"low"}`}>
      <button type="button" className="dlr-card-open" onClick={()=>item.client_id&&openClient(String(item.client_id))}>
        <div className="dlr-client-head"><div><small>{noLeads?"CRÍTICO • ZERO LEADS":"ATENÇÃO • BAIXO VOLUME"}</small><strong>{name}</strong><em>Carteira GT: {getGt(item)}</em></div><b>{Number(m.leads||0)} lead{Number(m.leads||0)===1?"":"s"}</b></div>
      </button>
      <div className="dlr-kpis">
        <span><small>Investimento</small><b>{money(m.spend)}</b></span>
        <span><small>CPL</small><b>{Number(m.leads||0)>0?money(m.cpl):"—"}</b></span>
        <span><small>Impressões</small><b>{m.impressions==null?"—":numberPt(m.impressions)}</b></span>
        <span><small>Alcance</small><b>{m.reach==null?"—":numberPt(m.reach)}</b></span>
        <span><small>Cliques</small><b>{m.clicks==null?"—":numberPt(m.clicks)}</b></span>
        <span><small>CTR</small><b>{m.ctr==null?"—":`${numberPt(m.ctr,2)}%`}</b></span>
        <span><small>CPC</small><b>{money(m.cpc)}</b></span>
        <span><small>CPM</small><b>{money(m.cpm)}</b></span>
        <span><small>Frequência</small><b>{m.frequency==null?"—":numberPt(m.frequency,2)}</b></span>
        <span><small>Campanhas ativas</small><b>{m.active_campaigns==null?"—":numberPt(m.active_campaigns)}</b></span>
      </div>
      {m.meta_data_available===false&&<div className="dlr-source-warning">KPIs de mídia indisponíveis: a conta Meta ainda não está vinculada a este cliente no Dash.</div>}
      <p className="dlr-recommended">{text(m.recommended_action)}</p>
      <div className={`dlr-explanation${canExplain?"":" readonly"}`}>
        <div className="dlr-explanation-head">
          <b>Motivo do baixo volume</b>
          {canExplain&&<span className={draft.__saved?"saved":"pending"}>{draft.__saved?"Justificativa salva":"Justificativa pendente"}</span>}
        </div>
        {canExplain?<>
          <div className="dlr-explanation-grid">
            <label><span>Motivo</span><select value={String(draft.reason_code||"")} onChange={(event)=>updateDraft(id,{reason_code:event.target.value})}>
              <option value="">Selecione o motivo...</option>
              {reasonOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}
            </select></label>
            <label><span>Prazo / retorno</span><input type="date" value={String(draft.follow_up_on||"")} onChange={(event)=>updateDraft(id,{follow_up_on:event.target.value})}/></label>
          </div>
          <label><span>Detalhe</span><textarea rows={2} value={String(draft.reason_detail||"")} placeholder="Ex.: cliente não responde desde ontem; estamos aguardando retorno." onChange={(event)=>updateDraft(id,{reason_detail:event.target.value})}/></label>
          <label><span>O que foi feito / próximo passo</span><textarea rows={2} value={String(draft.action_taken||"")} placeholder="Ex.: cobrei a recarga do saldo e vou revisar a conta amanhã às 10h." onChange={(event)=>updateDraft(id,{action_taken:event.target.value})}/></label>
          <button type="button" className="dlr-save" disabled={saving===id||!draft.reason_code} onClick={()=>void saveExplanation(item)}>{saving===id?"Salvando…":draft.__saved?"Atualizar justificativa":"Salvar justificativa"}</button>
        </>:saved?.reason_code?<div className="dlr-explanation-read">
          <strong>{reasonLabel(saved.reason_code)}</strong>
          {saved.reason_detail&&<p>{text(saved.reason_detail)}</p>}
          {saved.action_taken&&<p><b>Ação:</b> {text(saved.action_taken)}</p>}
          {saved.follow_up_on&&<small>Prazo / retorno: {text(saved.follow_up_on)}</small>}
          <small>Registrado por {text(saved.submitted_by||getGt(item))}{saved.updated_at||saved.submitted_at?` · ${formatDate(saved.updated_at||saved.submitted_at)}`:""}</small>
        </div>:<div className="dlr-explanation-waiting">Aguardando justificativa de <b>{getGt(item)}</b>.</div>}
      </div>
    </article>;
  };

  if(dismissed)return null;

  return <><div className="dlr-overlay"/><section role="alertdialog" aria-modal="true" aria-label="Radar diário de leads" className="dlr-modal">
    <style>{`
      .dlr-overlay{position:fixed;inset:0;background:rgba(2,7,12,.82);backdrop-filter:blur(8px);z-index:220}
      .dlr-modal{position:fixed;z-index:221;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1120px,calc(100vw - 32px));max-height:88vh;overflow:auto;background:#09131d;border:1px solid #294156;border-radius:24px;box-shadow:0 32px 90px rgba(0,0,0,.58);padding:24px;color:#edf5ff}
      .dlr-head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;padding-bottom:18px;border-bottom:1px solid #203445}.dlr-head small{display:block;color:#8ea6ba;font-weight:800;letter-spacing:.12em}.dlr-head h2{font-size:30px;margin:5px 0 7px}.dlr-head p{margin:0;color:#a9bac8;max-width:760px}.dlr-counts{display:flex;gap:10px;white-space:nowrap}.dlr-counts b{padding:9px 12px;border-radius:999px;background:#152635;font-size:13px}.dlr-counts .danger{background:#431a22;color:#ff9ca8}.dlr-counts .warn{background:#3a2d12;color:#ffd784}
      .dlr-toolbar{display:flex;align-items:end;gap:10px;flex-wrap:wrap;margin-top:16px}.dlr-filter{display:grid;gap:5px}.dlr-filter span{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#8ea6ba}.dlr-filter select,.dlr-export{height:38px;border:1px solid #31495b;border-radius:10px;background:#0e1a24;color:#edf5ff;padding:0 12px}.dlr-export{font-weight:800;cursor:pointer}.dlr-export:hover{background:#152635}.dlr-filter-summary{color:#91a7b9;font-size:12px;margin-left:auto}
      .dlr-group{margin-top:20px}.dlr-group>h3{margin:0 0 10px;font-size:15px;text-transform:uppercase;letter-spacing:.08em}.dlr-list{display:grid;gap:10px}.dlr-client{text-align:left;width:100%;border:1px solid #2b4050;border-radius:17px;padding:16px;background:#0e1a24;color:inherit}.dlr-client.zero{border-color:#7b2a39;background:linear-gradient(135deg,rgba(105,25,39,.34),rgba(14,26,36,.96))}.dlr-client.low{border-color:#665125;background:linear-gradient(135deg,rgba(100,74,24,.24),rgba(14,26,36,.96))}.dlr-card-open{display:block;width:100%;border:0;background:transparent;color:inherit;text-align:left;padding:0;cursor:pointer}.dlr-card-open:hover .dlr-client-head strong{text-decoration:underline;text-decoration-color:#47647a}.dlr-client-head{display:flex;justify-content:space-between;gap:16px;align-items:center}.dlr-client-head small{display:block;font-size:10px;letter-spacing:.1em;color:#9fb2c1}.dlr-client.zero .dlr-client-head small{color:#ff8e9c}.dlr-client.low .dlr-client-head small{color:#ffd16e}.dlr-client-head strong{display:block;font-size:18px;margin-top:4px}.dlr-client-head em{display:block;margin-top:3px;color:#8ea6ba;font-size:11px;font-style:normal}.dlr-client-head>b{font-size:24px}.dlr-kpis{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));gap:8px;margin-top:13px}.dlr-kpis span{background:rgba(8,16,23,.55);border:1px solid rgba(90,120,142,.18);padding:9px 10px;border-radius:11px}.dlr-kpis small{display:block;color:#8298aa;font-size:10px;text-transform:uppercase}.dlr-kpis b{display:block;margin-top:3px;font-size:14px}.dlr-source-warning{margin-top:11px;padding:8px 10px;border-radius:9px;background:rgba(255,209,110,.08);border:1px solid rgba(255,209,110,.22);color:#ffd784;font-size:11px}.dlr-recommended{margin:11px 0 0;color:#b5c4d0;font-size:12px}
      .dlr-explanation{margin-top:13px;padding:13px;border-radius:12px;border:1px solid rgba(121,158,184,.24);background:rgba(4,11,17,.45)}.dlr-explanation-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.dlr-explanation-head>b{font-size:12px}.dlr-explanation-head span{font-size:10px;padding:4px 7px;border-radius:999px}.dlr-explanation-head .saved{background:rgba(52,211,153,.12);color:#7ee2bd}.dlr-explanation-head .pending{background:rgba(255,209,110,.10);color:#ffd784}.dlr-explanation-grid{display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:10px}.dlr-explanation label{display:grid;gap:5px;margin-top:9px}.dlr-explanation label>span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#8ea6ba}.dlr-explanation select,.dlr-explanation input,.dlr-explanation textarea{width:100%;box-sizing:border-box;border:1px solid #31495b;border-radius:9px;background:#0b1721;color:#edf5ff;padding:9px 10px;font:inherit;outline:none}.dlr-explanation textarea{resize:vertical;min-height:54px}.dlr-explanation select:focus,.dlr-explanation input:focus,.dlr-explanation textarea:focus{border-color:#5c819e}.dlr-save{margin-top:10px;border:1px solid #41627b;border-radius:9px;background:#143047;color:#e8f5ff;padding:9px 12px;font-weight:800;cursor:pointer}.dlr-save:disabled{opacity:.5;cursor:not-allowed}.dlr-explanation-read strong{display:block;margin-top:8px;color:#dcecff}.dlr-explanation-read p{margin:6px 0 0;color:#b5c4d0;font-size:12px}.dlr-explanation-read small{display:block;margin-top:6px;color:#8298aa}.dlr-explanation-waiting{margin-top:8px;color:#ffd784;font-size:12px}.dlr-form-error{margin-top:14px;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,105,120,.35);background:rgba(105,25,39,.28);color:#ffb0ba;font-size:12px;font-weight:700}.dlr-actions{position:sticky;bottom:-24px;margin:20px -24px -24px;padding:16px 24px;background:rgba(9,19,29,.96);border-top:1px solid #203445;display:flex;align-items:center;justify-content:space-between;gap:12px}.dlr-actions small{color:#8197a9}.dlr-actions button{border:0;border-radius:12px;padding:12px 18px;font-weight:800;background:#dbefff;color:#07111a}.dlr-actions button:disabled{opacity:.5;cursor:not-allowed}
      @media(max-width:760px){.dlr-modal{padding:18px}.dlr-head{display:block}.dlr-counts{margin-top:12px;flex-wrap:wrap}.dlr-kpis{grid-template-columns:repeat(2,1fr)}.dlr-explanation-grid{grid-template-columns:1fr}.dlr-filter-summary{width:100%;margin-left:0}.dlr-actions{bottom:-18px;margin:18px -18px -18px;padding:14px 18px}}
    `}</style>
    <div className="dlr-head"><div><small>RADAR DIÁRIO DE LEADS • FECHAMENTO DO DIA</small><h2>Clientes com geração abaixo do mínimo</h2><p>Zero leads exige revisão imediata e justificativa do GT. De 1 a 3 leads entra como atenção e também pode receber contexto e próximo passo.</p></div><div className="dlr-counts"><b className="danger">{zero.length} com 0 leads</b><b className="warn">{low.length} com 1–3</b></div></div>
    <div className="dlr-toolbar">
      <label className="dlr-filter"><span>Carteira de GT</span><select value={selectedGt} onChange={(event)=>setSelectedGt(event.target.value)}><option value="ALL">Todas as carteiras</option>{gtNames.map((gt)=><option key={gt} value={gt}>{gt}</option>)}</select></label>
      <button className="dlr-export" onClick={exportCsv}>Exportar CSV</button>
      <span className="dlr-filter-summary">{visibleItems.length} cliente{visibleItems.length===1?"":"s"} no filtro atual</span>
    </div>
    {zero.length>0&&<div className="dlr-group"><h3>🚨 Zero leads • ação imediata</h3><div className="dlr-list">{zero.map((item)=><Card key={item.id} item={item}/>)}</div></div>}
    {low.length>0&&<div className="dlr-group"><h3>⚠️ 1 a 3 leads • acompanhar e corrigir</h3><div className="dlr-list">{low.map((item)=><Card key={item.id} item={item}/>)}</div></div>}
    {formError&&<div className="dlr-form-error">{formError}</div>}
    <div className="dlr-actions"><small>{profileRole==="GT"&&pendingRequired.length?`${pendingRequired.length} cliente${pendingRequired.length===1?"":"s"} com zero leads ainda sem justificativa.`:profileRole==="GT"?"Todos os clientes zerados estão justificados.":"Pressione Esc para fechar"}</small><button disabled={closing||pendingRequired.length>0} onClick={acknowledge}>{closing?"Confirmando…":profileRole==="GT"?"Justifiquei e vou acompanhar":"Entendi e vou acompanhar"}</button></div>
  </section></>;
}


function NotificationCenter({items,close,refresh,openClient,openWork,token,pendingRequests,canDecide,decide}:{items:Row[];close:()=>void;refresh:()=>Promise<void>;openClient:(id:string)=>void;openWork:(id:string)=>void;token:string;pendingRequests:Row[];canDecide:boolean;decide:(id:string,decision:"APPROVED"|"DENIED")=>Promise<void>}) {
  const dialogRef = useDialogFocus(close);
  const [deciding,setDeciding]=useState<string|null>(null);

  const radarGroups=new Map<string,Row[]>();
  const regularItems:Row[]=[];
  for(const item of items){
    if(item.type==="DAILY_LEAD_ALERT"){
      const day=String(item.metadata?.alert_date||String(item.occurred_at||"").slice(0,10)||"sem-data");
      const group=radarGroups.get(day)||[];
      group.push(item);
      radarGroups.set(day,group);
    }else{
      regularItems.push(item);
    }
  }
  const radarBatches:Row[]=Array.from(radarGroups.entries()).map(([day,rows])=>{
    const zero=rows.filter((row)=>Number(row.metadata?.leads||0)===0).length;
    const low=rows.length-zero;
    const occurredAt=rows.map((row)=>String(row.occurred_at||"")).sort().reverse()[0]||new Date().toISOString();
    const allRead=rows.every((row)=>Boolean(row.read_at));
    const readAt=allRead?(rows.map((row)=>String(row.read_at||"")).sort().reverse()[0]||occurredAt):null;
    return {
      id:`daily-lead-radar-batch:${day}`,
      type:"DAILY_LEAD_ALERT_BATCH",
      level:zero>0?"CRITICAL":"ATTENTION",
      title:"Radar diário de leads",
      description:`${rows.length} clientes abaixo do mínimo: ${zero} com 0 leads e ${low} com 1–3 leads.`,
      occurred_at:occurredAt,
      read_at:readAt,
      metadata:{alert_date:day,child_ids:rows.map((row)=>String(row.id)),zero_count:zero,low_count:low},
    };
  });
  const displayItems=[...regularItems,...radarBatches].sort((a,b)=>new Date(String(b.occurred_at||0)).getTime()-new Date(String(a.occurred_at||0)).getTime());

  async function read(id?:string,ids?:string[]){
    await apiPost("notifications-read",token,ids?.length?{ids}:id?{id}:{});
    await refresh();
  }
  // Solicitacoes de acesso ainda pendentes viram acao inline: aprovar aqui ja libera o colaborador.
  const pendingIds=new Set(pendingRequests.map((request)=>String(request.id)));
  async function act(requestId:string,decision:"APPROVED"|"DENIED"){
    setDeciding(requestId);
    try{await decide(requestId,decision);}finally{setDeciding(null);}
  }
  return <div ref={dialogRef as React.RefObject<HTMLDivElement>} role="dialog" aria-modal="true" aria-label="Central de notificações" className="notification-panel"><div className="panel-heading"><div><span className="eyebrow">Central de Notificações</span><h3>Atualizações da operação</h3></div><button onClick={close}>×</button></div><button className="mark-read" onClick={()=>read()}>Marcar todas como lidas</button><div className="notification-list">{displayItems.map(item=>{
    if(item.type==="DAILY_LEAD_ALERT_BATCH"){
      const childIds=Array.isArray(item.metadata?.child_ids)?item.metadata.child_ids.map(String):[];
      return <button className={item.read_at?"":"unread"} data-notification-id={String(item.id)} key={item.id} onClick={()=>read(undefined,childIds)}><Chip value={item.level}/><span><b>{text(item.title)}</b><small>{text(item.description)} · {formatDate(item.occurred_at)}</small><small className="notification-owner">Aviso único do Radar Diário · os clientes ficam agrupados dentro do radar</small></span></button>;
    }
    const requestId=item.metadata?.access_request_id?String(item.metadata.access_request_id):null;
    if(canDecide&&requestId&&pendingIds.has(requestId)) return <div className={`notification-action${item.read_at?"":" unread"}`} key={item.id}><Chip value={item.level}/><span><b>{text(item.title)}</b><small>{text(item.description)} · {formatDate(item.occurred_at)}</small></span><span className="access-request-actions"><button disabled={deciding===requestId} onClick={()=>act(requestId,"APPROVED")}>Aprovar</button><button className="muted" disabled={deciding===requestId} onClick={()=>act(requestId,"DENIED")}>Recusar</button></span></div>;
    const conclusao=taskCompletion(item);
    const hasOperationalContext=Boolean(item.client_id)&&(
      item.metadata?.context_available===true||
      item.metadata?.alert_type==="CLIENT_WAITING_SLA"||
      item.type==="COLLABORATOR_MEETING_STARTED"
    );
    return <button className={item.read_at?"":"unread"} data-notification-id={String(item.id)} key={item.id} onClick={()=>{read(item.id);const workId=item.metadata?.work_item_id;if(hasOperationalContext&&item.client_id)openClient(String(item.client_id));else if(workId)openWork(String(workId));else if(item.client_id)openClient(String(item.client_id));}}><Chip value={item.level}/><span><b>{item.title}</b>{conclusao
      ? <><small>{text(conclusao.tarefa)}</small><small className="notification-owner">Concluída por: {conclusao.concluidaPor || "não identificado"}</small><small className="notification-owner">Responsável: {text(conclusao.responsavel)}</small><small>{formatDate(item.occurred_at)}</small></>
      : <small>{text(item.actor ? `${item.actor}: ${item.description}` : item.description)} · {formatDate(item.occurred_at)}</small>}{(item.gestor || item.carteira) && <small className="notification-owner">{text(item.carteira ? `Carteira ${item.carteira}` : (item.gestor ? `Gestor: ${item.gestor}` : ""))}</small>}</span></button>;
  })}{!displayItems.length&&<div className="empty">Nenhuma notificação.</div>}</div></div>;
}

function SettingsModal({preferences,close,refresh,token,pendingRequests,canDecide,decide}:{preferences:Row;close:()=>void;refresh:()=>Promise<void>;token:string;pendingRequests:Row[];canDecide:boolean;decide:(id:string,decision:"APPROVED"|"DENIED")=>Promise<void>}) {
  const dialogRef = useDialogFocus(close);
  const [prefs,setPrefs]=useState<Row>(preferences); const toggle=(key:string)=>setPrefs((p:Row)=>({...p,[key]:p[key]===false}));
  const [deciding,setDeciding]=useState<string>("");
  async function save(){await apiPost("preferences",token,prefs);await refresh();close();}
  async function act(id:string,decision:"APPROVED"|"DENIED"){setDeciding(id);try{await decide(id,decision);}finally{setDeciding("");}}
  return <><div className="overlay open" onClick={close}/><section ref={dialogRef as React.RefObject<HTMLElement>} role="dialog" aria-modal="true" aria-label="Configurações" className="settings-modal"><div className="panel-heading"><div><span className="eyebrow">Configurações</span><h2>Conta e preferências</h2></div><button onClick={close}>×</button></div><div className="settings-grid"><div><h3>Conta</h3><label>Nome<input value={preferences.name||"Colaborador"} disabled/></label><label>Cargo<input value={preferences.role||"Colaborador"} disabled/></label></div><div><h3>Notificações</h3>{[["sounds_enabled","Som das notificações"],["win_sound_enabled","Som de novo cliente"],["win_celebration_enabled","Celebração de novo cliente"],["notifications_enabled","Notificações"],["animations_enabled","Animações"]].map(([key,label])=><button className="setting-toggle" key={key} onClick={()=>toggle(key)}><span>{label}</span><i className={prefs[key]===false?"":"on"}/></button>)}</div><div><h3>Integrações</h3>{["ClickUp","CRM Comercial","Supabase","WhatsApp","Meta Ads","Google Ads","Make","n8n","Notion"].map(name=><p className="integration-line" key={name}><span>{name}</span><small>{["ClickUp","CRM Comercial","Supabase","WhatsApp","Meta Ads","Notion"].includes(name)?"Configurado":"Preparado"}</small></p>)}</div><div><h3>Usuários e permissões</h3>{canDecide ? <div className="access-requests">{pendingRequests.length ? pendingRequests.map((request)=><div className="access-request-row" key={request.id}><span><b>{text(request.person)}</b><small>Solicitado em {formatDate(request.requested_at)}{request.note ? ` · ${request.note}` : ""}</small></span><span className="access-request-actions"><button disabled={deciding===request.id} onClick={()=>act(request.id,"APPROVED")}>Aprovar</button><button className="muted" disabled={deciding===request.id} onClick={()=>act(request.id,"DENIED")}>Recusar</button></span></div>) : <p className="small">Nenhuma solicitação de acesso pendente.</p>}</div> : <p className="small">Administrador · Operações · CS · GT · Designer · Comercial · Visualizador</p>}</div></div><div className="modal-actions"><button onClick={close}>Cancelar</button><button className="primary" onClick={save}>Salvar alterações</button></div></section></>;
}

function ClientDrawer({ detail, loading, close, contractsAllowed, token }: { detail: Row; loading: boolean; close: () => void; contractsAllowed: boolean; token: string }) {
  const dialogRef = useDialogFocus(close);
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
      <aside ref={dialogRef as React.RefObject<HTMLElement>} role="dialog" aria-modal="true" aria-label="Visão do cliente" className="drawer open">
        <div className="drawer-head"><div><div className="label">Visão do cliente</div><h2>{loading && !client.display_name ? <span className="skeleton skeleton-title" aria-label="Carregando cliente" /> : text(client.display_name)}</h2></div><button className="close" onClick={close}>×</button></div>
        <div className="drawer-body">
          {detail.error ? <div className="error-box">{text(detail.error)}</div> : loading ? <div className="empty">Buscando visão completa…</div> : (
            <div className="detail-grid">
              <Detail title="Resumo do cliente"><p><Chip value={client.lifecycle} /> <Chip value={client.priority} /> <Chip value={client.data_coverage} /></p><p><b>Etapa:</b> {text(client.onboarding_stage || (client.lifecycle === "ACTIVE" ? "Operação recorrente" : client.lifecycle))}</p><p><b>CS:</b> {text(client.cs_owner)} · <b>GT:</b> {text(client.gt_owner)}</p><p><b>Data de entrada:</b> {client.entrada ? new Intl.DateTimeFormat("pt-BR").format(new Date(`${client.entrada}T12:00:00`)) : "Revisão manual necessária"}</p>{client.lifecycle === "CHURNED" && <p><b>Data do churn:</b> {client.saida ? new Intl.DateTimeFormat("pt-BR").format(new Date(`${client.saida}T12:00:00`)) : "Revisão manual necessária"}</p>}<p><b>Tempo como cliente:</b> {client.client_days == null ? "Revisão manual necessária" : `${formatNumber(client.client_days,0)} dias`}</p><p><b>Última atividade:</b> {formatDate(client.last_activity_at)}</p><p><b>Campanhas:</b> {formatNumber(client.campaigns,0)} · <b>Alertas:</b> {formatNumber(client.alerts_count,0)}</p><p><b>Resumo:</b> {text(client.summary_today)}</p></Detail>
              <Detail title="Próxima ação"><p><b>{text(client.next_step)}</b></p><p>Responsável: {text(client.action_owner)}</p><p>Prazo: {formatDate(client.next_step_due)}</p></Detail>
              <Detail title="Onboarding"><p><Chip value={client.onboarding_status} /></p><p>Etapa: {text(client.onboarding_stage)}</p><p>Risco: {text(client.onboarding_risk)}</p><p>Próximo passo: {text(client.onboarding_next_action)}</p></Detail>
              <Detail title="Responsáveis"><p>Carteira: {text(client.carteira)}</p><p>CS: {text(client.cs_owner)}</p><p>GT: {text(client.gt_owner)}</p><p>Design: {text(client.designer_owner)}</p></Detail>
              <Detail title="Linha do tempo" full>{timeline.length ? <div className="timeline">{timeline.map((event, index) => <div className="timeline-event" key={`${event.kind}-${event.at}-${index}`}><i /><div><small>{formatDate(event.at)} · {event.kind}</small><p>{text(event.title)}</p></div><Chip value={event.tone} /></div>)}</div> : <p className="small">Ainda não há eventos datados para consolidar.</p>}</Detail>
              <Detail title="Evidências e confiança" full><p><b>Cobertura:</b> <Chip value={client.data_coverage} /> · <b>Confiança:</b> {client.confidence == null ? "não calculada" : `${Math.round(Number(client.confidence)*100)}%`}</p>{Array.isArray(evidence) && evidence.length ? evidence.slice(0,12).map((item: any,index: number) => <p key={index}>• {text(item?.text || item?.detail || item)}</p>) : <p className="small">Nenhuma evidência estruturada disponível neste snapshot.</p>}</Detail>
              <Detail title="Saúde histórica">{healthHistory.length ? healthHistory.slice(0,10).map((row: Row) => <p key={row.id || row.date}><b>{text(row.date)}</b> · {formatNumber(row.score)} pontos · <Chip value={row.band}/></p>) : <p className="small">Sem histórico calculado.</p>}</Detail>
              {contractsAllowed && client.client_id && <Suspense fallback={null}><ClientContractSection clientId={String(client.client_id)} token={token} /></Suspense>}
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

// ---------------------------------------------------------------------------
// Carteira de Clientes. Replica o relatorio de 14/08/2026 sobre dado vivo.
// Meses passados vem congelados de portfolio_monthly_history; o mes corrente e'
// recalculado a cada consulta. O campo `origem` distingue os dois, para a tela
// nunca apresentar reconstrucao como medicao.
// ---------------------------------------------------------------------------
