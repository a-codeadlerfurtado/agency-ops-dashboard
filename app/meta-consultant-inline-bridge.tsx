"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { Chip, SUPABASE_ANON_KEY, SUPABASE_URL, formatMoney, formatNumber, initials, supabase, text } from "./shared";

type Row = Record<string, any>;
type ChatRow = { question: string; answer: string };

const RADAR_API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-radar-api`;
const AI_API = `${SUPABASE_URL}/functions/v1/agency-ops-ai-ask`;

function finite(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function money(value: unknown) {
  return finite(value) === null ? "—" : formatMoney(value);
}

function number(value: unknown, digits = 0) {
  return finite(value) === null ? "—" : formatNumber(value, digits);
}

function pctChange(current: unknown, previous: unknown) {
  const a = finite(current), b = finite(previous);
  if (a === null || b === null || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function deltaLabel(value: number | null, inverse = false) {
  if (value === null) return { text: "sem comparação", cls: "muted" };
  const abs = Math.abs(value).toFixed(0);
  const direction = value > 0 ? "↑" : value < 0 ? "↓" : "=";
  const good = inverse ? value < 0 : value > 0;
  const bad = inverse ? value > 0 : value < 0;
  return { text: `${direction} ${abs}% vs. 7d anteriores`, cls: good ? "green" : bad ? "red" : "muted" };
}

function statusChip(band: string) {
  if (band === "ACTION_NOW") return "CRITICAL";
  if (band === "FOLLOW_UP") return "FOLLOW_UP";
  return "OK";
}

function bandLabel(band: string) {
  if (band === "ACTION_NOW") return "Ação agora";
  if (band === "FOLLOW_UP") return "Acompanhar";
  if (band === "HEALTHY") return "Saudável";
  return "Todos";
}

function waitingLabel(value: unknown) {
  const key = String(value || "");
  if (key === "CLIENT_WAITING_AGENCY") return "Cliente aguardando a agência";
  if (key === "AGENCY_WAITING_CLIENT") return "Agência aguardando o cliente";
  if (key === "BOTH_HAVE_ACTIONS") return "Ambos têm ação pendente";
  if (key === "NO_ONE_WAITING") return "Sem espera registrada";
  return "Sem leitura de espera";
}

function trimContext(detail: Row) {
  const current7 = detail.windows?.["7"] || detail.windows?.[7] || null;
  const previous7 = detail.previous_windows?.["7"] || detail.previous_windows?.[7] || null;
  const current3 = detail.windows?.["3"] || detail.windows?.[3] || null;
  const evaluation = detail.evaluation || {};
  const client = detail.client || {};
  return {
    cliente: {
      id: client.client_id,
      nome: client.display_name,
      gt: client.gt_owner,
      cs: client.cs_owner,
      designer: client.designer_owner,
      prioridade_operacional: client.priority,
      esperando: client.waiting_direction,
      assunto_atual: client.current_subject,
      resumo_hoje: client.summary_today,
      proximo_passo_operacional: client.next_step,
      compromissos_vencidos: client.overdue_commitments,
      reclamacoes_abertas: client.open_complaints,
      bloqueios: client.blockers,
    },
    meta_7d: current7 ? {
      spend: current7.spend,
      results: current7.results,
      cpl: current7.cpl,
      ctr: current7.ctr,
      frequency: current7.frequency,
      reach: current7.reach,
      impressions: current7.impressions,
      clicks: current7.clicks,
      active_campaigns: current7.active_campaigns,
      data_status: current7.data_status,
    } : null,
    meta_7d_anteriores: previous7 ? {
      spend: previous7.spend,
      results: previous7.results,
      cpl: previous7.cpl,
      ctr: previous7.ctr,
      frequency: previous7.frequency,
      reach: previous7.reach,
      impressions: previous7.impressions,
      clicks: previous7.clicks,
      active_campaigns: previous7.active_campaigns,
      data_status: previous7.data_status,
    } : null,
    meta_3d: current3 ? {
      spend: current3.spend,
      results: current3.results,
      cpl: current3.cpl,
      ctr: current3.ctr,
      frequency: current3.frequency,
      active_campaigns: current3.active_campaigns,
    } : null,
    sinais_do_motor: {
      faixa: evaluation.band,
      motivos: (evaluation.reasons || []).slice(0, 6),
      proxima_acao: evaluation.next_action,
      saldo: evaluation.balance,
      tasks: evaluation.tasks,
      mudancas: evaluation.changes,
    },
    criativos: (detail.current_creatives || []).slice(0, 10).map((creative: Row) => ({
      ad_name: creative.ad_name,
      campaign_name: creative.campaign_name,
      status: creative.ad_status,
      spend: creative.spend,
      results: creative.results,
      cost_per_result: creative.cost_per_result ?? creative.cpl,
      ctr: creative.ctr,
      frequency: creative.frequency,
      impressions: creative.impressions,
    })),
    tarefas_abertas: (detail.open_tasks || []).slice(0, 12).map((task: Row) => ({
      name: task.name,
      status: task.status,
      due_date: task.due_date,
      assignees: task.assignee_names,
    })),
  };
}

function buildAnalysisPrompt(detail: Row) {
  const context = trimContext(detail);
  const name = String(detail.client?.display_name || "cliente");
  return `Você é o consultor sênior de performance e operação da agência imobiliária. Faça uma leitura consultiva do cliente \"${name}\" para o Gestor de Tráfego tomar decisão agora.

Use SOMENTE evidências reais. Cruze os dados compactos abaixo com as demais informações autorizadas desse mesmo cliente disponíveis no agency_ops (histórico Meta, relacionamento/WhatsApp, ClickUp, compromissos, reclamações, saldo, campanhas, relatórios e contexto operacional). Se uma hipótese não puder ser comprovada, chame explicitamente de hipótese. Não invente benchmark universal e não confunda correlação com causa.

DADOS ATUAIS DO DASHBOARD:
${JSON.stringify(context)}

Responda em português do Brasil, de forma curta, consultiva e prática, com estas seções exatamente:
DIAGNÓSTICO
O QUE OS KPIS ESTÃO DIZENDO
HIPÓTESE PRINCIPAL
DECISÃO RECOMENDADA AGORA
O QUE EU NÃO FARIA AGORA
O QUE OBSERVAR NAS PRÓXIMAS 48H
INFORMAÇÕES QUE FALTAM

Em DECISÃO RECOMENDADA AGORA, entregue no máximo 4 ações priorizadas. Explique o raciocínio por trás da decisão. Se a Meta estiver sem cobertura suficiente, diga isso antes de recomendar mudanças.`;
}

function removeOldRadarLink() {
  document.querySelectorAll("[data-meta-radar-nav]").forEach((node) => {
    const label = String(node.textContent || "").trim();
    if (label === "Radar da Carteira") node.remove();
  });
}

export default function MetaConsultantInlineBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState("");
  const [allowed, setAllowed] = useState(false);
  const [active, setActive] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [payload, setPayload] = useState<Row>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [band, setBand] = useState("ALL");
  const [gt, setGt] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<Row | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [analysisCache, setAnalysisCache] = useState<Record<string, string>>({});
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [question, setQuestion] = useState("");
  const [chat, setChat] = useState<Record<string, ChatRow[]>>({});
  const [questionLoading, setQuestionLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  const headers = useMemo(() => session?.access_token ? {
    Authorization: `Bearer ${session.access_token}`,
    apikey: SUPABASE_ANON_KEY,
  } : null, [session?.access_token]);

  useEffect(() => {
    if (!headers) {
      setRole("");
      setAllowed(false);
      return;
    }
    let alive = true;
    fetch(`${RADAR_API}?probe=1`, { headers, cache: "no-store" })
      .then(async (response) => {
        if (!alive || !response.ok) return;
        const body = await response.json().catch(() => ({}));
        const nextRole = String(body?.profile?.role || "");
        if (!alive) return;
        setRole(nextRole);
        setAllowed(["GT", "MGMT"].includes(nextRole));
      })
      .catch(() => { if (alive) setAllowed(false); });
    return () => { alive = false; };
  }, [headers]);

  const loadList = useCallback(async (selectedGt?: string) => {
    if (!headers) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (selectedGt) params.set("gt", selectedGt);
      const response = await fetch(`${RADAR_API}?${params.toString()}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
      if (!selectedGt && body.selected_gt) setGt(String(body.selected_gt));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar clientes.");
    } finally {
      setLoading(false);
    }
  }, [headers]);

  const askAI = useCallback(async (prompt: string) => {
    if (!headers) throw new Error("Sessão indisponível.");
    const response = await fetch(AI_API, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ question: prompt }),
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) throw new Error(body?.error || body?.detail || `IA ${response.status}`);
    const answer = String(body?.answer || body?.response || body?.output || body?.text || "").trim();
    if (!answer) throw new Error("A IA não devolveu uma leitura utilizável.");
    return answer;
  }, [headers]);

  const generateAnalysis = useCallback(async (clientDetail: Row, force = false) => {
    const id = String(clientDetail?.client?.client_id || "");
    if (!id || (!force && analysisCache[id])) return;
    setAnalysisLoading(true);
    setAnalysisError("");
    try {
      const answer = await askAI(buildAnalysisPrompt(clientDetail));
      setAnalysisCache((current) => ({ ...current, [id]: answer }));
    } catch (caught) {
      setAnalysisError(caught instanceof Error ? caught.message : "Falha ao gerar leitura da IA.");
    } finally {
      setAnalysisLoading(false);
    }
  }, [analysisCache, askAI]);

  const openClient = useCallback(async (id: string) => {
    if (!headers || !id) return;
    setSelectedId(id);
    setDetailLoading(true);
    setDetail(null);
    setAnalysisError("");
    setQuestion("");
    try {
      const params = new URLSearchParams({ client_id: id });
      if (role === "MGMT" && gt) params.set("gt", gt);
      const response = await fetch(`${RADAR_API}?${params.toString()}`, { headers, cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setDetail(body);
      void generateAnalysis(body, false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao abrir cliente.");
    } finally {
      setDetailLoading(false);
    }
  }, [headers, role, gt, generateAnalysis]);

  useEffect(() => {
    if (active && headers) void loadList(gt);
  }, [active, headers, loadList]);

  useEffect(() => {
    if (!allowed || window.location.pathname !== "/") {
      setActive(false);
      return;
    }
    let cleanup: (() => void) | null = null;
    const install = () => {
      removeOldRadarLink();
      const shell = document.querySelector<HTMLElement>(".shell");
      const container = document.querySelector<HTMLElement>(".side-nav-items");
      if (!shell || !container) return;
      setHost(shell);
      let button = container.querySelector<HTMLButtonElement>("[data-meta-consultant-nav]");
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.dataset.metaConsultantNav = "true";
        button.title = "Consultor de Performance";
        button.textContent = "Consultor de Performance";
        const campaigns = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent?.trim() === "Campanhas");
        if (campaigns?.nextSibling) container.insertBefore(button, campaigns.nextSibling);
        else if (campaigns) container.appendChild(button);
        else container.appendChild(button);
      }
      const onOpen = () => setActive(true);
      const onOtherNav = (event: Event) => {
        const target = event.target instanceof Element ? event.target.closest("button,a") : null;
        if (!target || target === button || target.hasAttribute("data-meta-consultant-nav")) return;
        setActive(false);
      };
      button.addEventListener("click", onOpen);
      container.addEventListener("click", onOtherNav, true);
      cleanup?.();
      cleanup = () => {
        button?.removeEventListener("click", onOpen);
        container.removeEventListener("click", onOtherNav, true);
      };
    };
    install();
    const timer = window.setInterval(install, 1500);
    return () => {
      window.clearInterval(timer);
      cleanup?.();
      document.querySelectorAll("[data-meta-consultant-nav]").forEach((node) => node.remove());
    };
  }, [allowed]);

  useEffect(() => {
    const shell = host || document.querySelector<HTMLElement>(".shell");
    if (!shell) return;
    shell.classList.toggle("meta-consultant-active", active);
    document.querySelector<HTMLElement>("[data-meta-consultant-nav]")?.classList.toggle("active", active);
    return () => shell.classList.remove("meta-consultant-active");
  }, [active, host]);

  const clients: Row[] = payload.clients || [];
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return clients.filter((client) => {
      const bandOk = band === "ALL" || client.evaluation?.band === band;
      const searchOk = !needle || [client.client_name, client.gt_owner, client.cs_owner].join(" ").toLocaleLowerCase("pt-BR").includes(needle);
      return bandOk && searchOk;
    });
  }, [clients, query, band]);

  useEffect(() => {
    if (!active || selectedId || !clients.length) return;
    const first = clients.find((client) => client.evaluation?.band === "ACTION_NOW") || clients[0];
    if (first?.client_id) void openClient(String(first.client_id));
  }, [active, clients, selectedId, openClient]);

  useEffect(() => {
    if (!active) {
      setSelectedId("");
      setDetail(null);
      setQuestion("");
    }
  }, [active]);

  async function sendQuestion() {
    const q = question.trim();
    if (!q || !detail || questionLoading) return;
    const id = String(detail.client?.client_id || "");
    const name = String(detail.client?.display_name || "cliente");
    setQuestionLoading(true);
    try {
      const prompt = `Sobre o cliente \"${name}\", responda a pergunta abaixo como consultor de performance da agência. Cruze os dados atuais do dashboard com as evidências autorizadas do agency_ops. Não invente informação. Se não houver evidência suficiente, diga isso.\n\nDADOS ATUAIS: ${JSON.stringify(trimContext(detail))}\n\nPERGUNTA DO GT: ${q}`;
      const answer = await askAI(prompt);
      setChat((current) => ({ ...current, [id]: [...(current[id] || []), { question: q, answer }] }));
      setQuestion("");
    } catch (caught) {
      setChat((current) => ({ ...current, [id]: [...(current[id] || []), { question: q, answer: caught instanceof Error ? caught.message : "Falha ao consultar a IA." }] }));
    } finally {
      setQuestionLoading(false);
    }
  }

  if (!allowed || !active || !host) return null;

  return createPortal(
    <section className="meta-consultant-host">
      <div className="mc-workspace-head">
        <div>
          <span className="eyebrow">Performance consultiva</span>
          <h2>Consultor de Performance</h2>
          <p>Cliente por cliente: o que os KPIs indicam, qual hipótese faz sentido e o que decidir agora.</p>
        </div>
        <div className="toolbar">
          {role === "MGMT" && <select className="control" value={gt} onChange={(event) => { const next = event.target.value; setGt(next); setSelectedId(""); setDetail(null); void loadList(next); }}><option value="">Todos os GTs</option>{(payload.gt_options || []).map((name: string) => <option key={name} value={name}>{name}</option>)}</select>}
          <button className="btn" onClick={() => loadList(gt)} disabled={loading}>{loading ? "Atualizando…" : "Atualizar carteira"}</button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <div className="mc-layout">
        <aside className="card mc-client-list">
          <div className="mc-client-list-head">
            <div><b>Carteira</b><small>{visible.length} cliente{visible.length === 1 ? "" : "s"}</small></div>
            <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente…" />
          </div>
          <div className="filter-tabs mc-band-tabs">
            {[ ["ALL", "Todos"], ["ACTION_NOW", "Ação agora"], ["FOLLOW_UP", "Acompanhar"], ["HEALTHY", "Saudáveis"] ].map(([key, label]) => <button key={key} className={band === key ? "active" : ""} onClick={() => setBand(key)}>{label}</button>)}
          </div>
          <div className="mc-client-scroll">
            {visible.map((client) => {
              const evaluation = client.evaluation || {};
              const reason = evaluation.reasons?.[0]?.text || evaluation.next_action || "Sem alerta relevante";
              return <button key={client.client_id} className={`mc-client-row${selectedId === String(client.client_id) ? " active" : ""}`} onClick={() => openClient(String(client.client_id))}>
                <span className="avatar">{initials(client.client_name)}</span>
                <span className="mc-client-copy"><b>{text(client.client_name)}</b><small>{text(reason)}</small><em>{client.meta ? `${money(client.meta.cpl)} CPL · ${number(client.meta.results)} resultados` : "Meta sem leitura"}</em></span>
                <Chip value={statusChip(String(evaluation.band || ""))} />
              </button>;
            })}
            {!loading && !visible.length && <div className="empty">Nenhum cliente nesse filtro.</div>}
            {loading && !clients.length && <div className="empty">Carregando carteira…</div>}
          </div>
        </aside>

        <main className="mc-client-detail">
          {detailLoading && <section className="card section mc-empty-detail"><span className="dot loading" /> Cruzando Meta, criativos, operação e contexto do cliente…</section>}
          {!detailLoading && !detail && <section className="card section mc-empty-detail">Selecione um cliente para começar a análise.</section>}
          {!detailLoading && detail && <ConsultiveDetail
            data={detail}
            analysis={analysisCache[String(detail.client?.client_id || "")] || ""}
            analysisLoading={analysisLoading}
            analysisError={analysisError}
            onRefreshAnalysis={() => generateAnalysis(detail, true)}
            question={question}
            setQuestion={setQuestion}
            sendQuestion={sendQuestion}
            questionLoading={questionLoading}
            chat={chat[String(detail.client?.client_id || "")] || []}
          />}
        </main>
      </div>
    </section>,
    host,
  );
}

function ConsultiveDetail({ data, analysis, analysisLoading, analysisError, onRefreshAnalysis, question, setQuestion, sendQuestion, questionLoading, chat }: {
  data: Row;
  analysis: string;
  analysisLoading: boolean;
  analysisError: string;
  onRefreshAnalysis: () => void;
  question: string;
  setQuestion: (value: string) => void;
  sendQuestion: () => void;
  questionLoading: boolean;
  chat: ChatRow[];
}) {
  const client = data.client || {};
  const evaluation = data.evaluation || {};
  const current7 = data.windows?.["7"] || data.windows?.[7] || {};
  const previous7 = data.previous_windows?.["7"] || data.previous_windows?.[7] || {};
  const resultsDelta = pctChange(current7.results, previous7.results);
  const cplDelta = pctChange(current7.cpl, previous7.cpl);
  const ctrDelta = pctChange(current7.ctr, previous7.ctr);
  const spendDelta = pctChange(current7.spend, previous7.spend);
  const resultTrend = deltaLabel(resultsDelta);
  const cplTrend = deltaLabel(cplDelta, true);
  const ctrTrend = deltaLabel(ctrDelta);
  const spendTrend = deltaLabel(spendDelta);
  const creatives: Row[] = data.current_creatives || [];
  const bestId = String(evaluation.creative_signals?.best?.ad_id || "");
  const wasteIds = new Set((evaluation.creative_signals?.waste || []).map((row: Row) => String(row.ad_id)));
  const fatigueIds = new Set((evaluation.creative_signals?.fatigue || []).map((row: Row) => String(row.ad_id)));
  const featured = [...creatives].sort((a, b) => {
    const rank = (row: Row) => String(row.ad_id) === bestId ? 0 : wasteIds.has(String(row.ad_id)) ? 1 : fatigueIds.has(String(row.ad_id)) ? 2 : 3;
    return rank(a) - rank(b) || Number(b.results || 0) - Number(a.results || 0);
  }).slice(0, 3);

  const kpis = [
    { label: "Resultados · 7d", value: number(current7.results), delta: resultTrend, explanation: resultsDelta === null ? "Ainda não há base anterior suficiente para comparar volume." : resultsDelta < -20 ? "O volume caiu de forma relevante. Vale descobrir se a queda veio de entrega, criativo, público ou conversão." : resultsDelta > 20 ? "O volume cresceu. Confirme se o ganho veio com eficiência ou apenas com mais investimento." : "O volume está relativamente estável versus a semana anterior." },
    { label: "CPL / CPR · 7d", value: money(current7.cpl), delta: cplTrend, explanation: cplDelta === null ? "Sem comparação confiável com a janela anterior." : cplDelta > 20 ? "A eficiência piorou. Antes de escalar, encontre onde o custo está subindo." : cplDelta < -15 ? "A eficiência melhorou. Verifique se o ganho é consistente e se há espaço para escala gradual." : "O custo está relativamente estável." },
    { label: "CTR · 7d", value: finite(current7.ctr) === null ? "—" : `${number(current7.ctr, 2)}%`, delta: ctrTrend, explanation: ctrDelta === null ? "Use CTR junto de CPL e resultados; sozinho ele não determina qualidade." : ctrDelta < -20 ? "O anúncio está atraindo proporcionalmente menos cliques que antes. Pode haver perda de apelo ou mudança de entrega." : ctrDelta > 20 ? "O anúncio ganhou capacidade de gerar clique. Confirme se isso também virou resultado." : "A capacidade de gerar clique mudou pouco." },
    { label: "Frequência · 7d", value: number(current7.frequency, 2), delta: { text: finite(current7.frequency) === null ? "sem leitura" : finite(current7.frequency)! >= 3 ? "atenção à repetição" : "sem sinal forte de saturação", cls: finite(current7.frequency) !== null && finite(current7.frequency)! >= 3 ? "yellow" : "muted" }, explanation: finite(current7.frequency) !== null && finite(current7.frequency)! >= 3 ? "A mesma audiência está vendo os anúncios repetidamente. Cruze isso com queda de CTR/CPL antes de concluir fadiga." : "A frequência, isoladamente, não aponta saturação forte neste recorte." },
    { label: "Investimento · 7d", value: money(current7.spend), delta: spendTrend, explanation: spendDelta !== null && spendDelta > 15 && resultsDelta !== null && resultsDelta <= 0 ? "O gasto cresceu sem crescimento proporcional de resultado: sinal de perda de eficiência." : "Leia investimento junto de resultados e custo por resultado." },
  ];

  return <>
    <section className="card section mc-client-hero">
      <div className="mc-client-title"><span className="avatar">{initials(client.display_name)}</span><div><span className="eyebrow">Cliente em análise</span><h2>{text(client.display_name)}</h2><p>GT {text(client.gt_owner)} · CS {text(client.cs_owner)} · {waitingLabel(client.waiting_direction)}</p></div></div>
      <div className="mc-hero-status"><Chip value={statusChip(String(evaluation.band || ""))} /><small>{bandLabel(String(evaluation.band || ""))}</small></div>
    </section>

    <section className="card section mc-decision">
      <span className="eyebrow">Decisão sugerida pelo motor operacional</span>
      <h3>{text(evaluation.next_action || client.next_step || "Manter acompanhamento normal.")}</h3>
      <div className="mc-reason-chips">{(evaluation.reasons || []).slice(0, 4).map((reason: Row, index: number) => <span key={`${reason.code}-${index}`} className={reason.tone || "info"}>{text(reason.text)}</span>)}</div>
    </section>

    <section className="card section mc-ai-reading">
      <div className="section-head"><div><span className="eyebrow">Leitura operacional analisada por IA</span><div className="section-title">O que está acontecendo com este cliente?</div></div><button className="btn" onClick={onRefreshAnalysis} disabled={analysisLoading}>{analysisLoading ? "Analisando…" : analysis ? "Atualizar leitura" : "Gerar leitura"}</button></div>
      {analysisLoading && <div className="mc-ai-loading"><span className="dot loading" /><div><b>Cruzando as evidências…</b><small>Meta, criativos, histórico, operação, ClickUp, saldo e contexto autorizado.</small></div></div>}
      {analysisError && !analysisLoading && <div className="error-box">{analysisError}</div>}
      {analysis && !analysisLoading && <AIAnswer text={analysis} />}
      {!analysis && !analysisLoading && !analysisError && <div className="empty">A leitura da IA será gerada automaticamente para este cliente.</div>}
    </section>

    <section className="mc-kpi-section">
      <div className="mc-section-heading"><div><span className="eyebrow">Leitura dos indicadores</span><h3>O que os KPIs estão indicando</h3></div><small>Comparação principal: últimos 7 dias × 7 dias anteriores</small></div>
      <div className="mc-kpi-grid">{kpis.map((kpi) => <article className="card mc-kpi" key={kpi.label}><small>{kpi.label}</small><b>{kpi.value}</b><em className={kpi.delta.cls}>{kpi.delta.text}</em><p>{kpi.explanation}</p></article>)}</div>
    </section>

    <div className="mc-evidence-grid">
      <section className="card section">
        <div className="section-head"><div><span className="eyebrow">Criativos</span><div className="section-title">O que está puxando ou queimando verba</div></div><small className="counter">{creatives.length} capturados</small></div>
        <div className="mc-creatives">{featured.map((creative) => {
          const id = String(creative.ad_id || "");
          const badge = id === bestId ? "Campeão" : wasteIds.has(id) ? "Sem resultado" : fatigueIds.has(id) ? "Possível fadiga" : "Em veiculação";
          const badgeClass = id === bestId ? "good" : wasteIds.has(id) ? "bad" : fatigueIds.has(id) ? "warn" : "info";
          const src = creative.image_url || creative.thumbnail_url;
          return <article key={id || creative.ad_name} className="mc-creative-card"><div className="mc-creative-image">{src ? <img src={src} alt="" onError={(event) => { event.currentTarget.style.display = "none"; event.currentTarget.parentElement?.classList.add("image-error"); }} /> : null}<span>Prévia indisponível</span><em className={badgeClass}>{badge}</em></div><div><b>{text(creative.ad_name)}</b><small>{text(creative.campaign_name)}</small><dl><div><dt>Resultados</dt><dd>{number(creative.results)}</dd></div><div><dt>CPR</dt><dd>{money(creative.cost_per_result ?? creative.cpl)}</dd></div><div><dt>Gasto</dt><dd>{money(creative.spend)}</dd></div></dl></div></article>;
        })}{!featured.length && <div className="empty">Ainda não há captura visual de criativos para este cliente.</div>}</div>
      </section>

      <section className="card section mc-ops-context">
        <div className="section-head"><div><span className="eyebrow">Contexto operacional</span><div className="section-title">Antes de mexer na campanha</div></div></div>
        <div className="mc-context-row"><span>Relacionamento</span><b>{waitingLabel(client.waiting_direction)}</b></div>
        <div className="mc-context-row"><span>Tasks abertas</span><b>{number(evaluation.tasks?.open)}</b></div>
        <div className="mc-context-row"><span>Tasks vencidas</span><b className={Number(evaluation.tasks?.overdue || 0) > 0 ? "red" : ""}>{number(evaluation.tasks?.overdue)}</b></div>
        <div className="mc-context-row"><span>Saldo estimado</span><b>{evaluation.balance?.available_balance == null ? "—" : money(evaluation.balance.available_balance)}</b></div>
        <div className="mc-context-row"><span>Dias de mídia estimados</span><b className={finite(evaluation.balance?.days_remaining) !== null && finite(evaluation.balance?.days_remaining)! <= 3 ? "yellow" : ""}>{number(evaluation.balance?.days_remaining, 1)}</b></div>
        <div className="mc-context-row"><span>Campanhas ativas</span><b>{number(current7.active_campaigns)}</b></div>
        {(data.open_tasks || []).slice(0, 4).map((task: Row) => <div className="mc-task" key={task.task_id}><b>{text(task.name)}</b><small>{task.due_date ? `Prazo ${new Intl.DateTimeFormat("pt-BR").format(new Date(task.due_date))}` : "Sem prazo"} · {text(task.assignee_names)}</small></div>)}
      </section>
    </div>

    <section className="card section mc-ask">
      <div className="section-head"><div><span className="eyebrow">Aprofundar análise</span><div className="section-title">Pergunte sobre este cliente</div></div></div>
      {chat.map((row, index) => <article className="mc-chat" key={`${row.question}-${index}`}><b>Você: {row.question}</b><AIAnswer text={row.answer} compact /></article>)}
      <div className="mc-question"><input className="control" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") sendQuestion(); }} placeholder="Ex.: o problema parece mais criativo, público ou oferta?" /><button className="btn" onClick={sendQuestion} disabled={questionLoading || !question.trim()}>{questionLoading ? "Analisando…" : "Perguntar à IA"}</button></div>
    </section>
  </>;
}

function AIAnswer({ text: raw, compact = false }: { text: string; compact?: boolean }) {
  const lines = String(raw || "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean);
  return <div className={`mc-ai-answer${compact ? " compact" : ""}`}>{lines.map((line, index) => {
    const cleaned = line.replace(/^#{1,4}\s*/, "").replace(/^\*\*(.*?)\*\*:?$/, "$1");
    const isHeading = /^(DIAGNÓSTICO|O QUE OS KPIS ESTÃO DIZENDO|HIPÓTESE PRINCIPAL|DECISÃO RECOMENDADA AGORA|O QUE EU NÃO FARIA AGORA|O QUE OBSERVAR NAS PRÓXIMAS 48H|INFORMAÇÕES QUE FALTAM)$/i.test(cleaned.replace(/:$/, ""));
    if (isHeading) return <h4 key={index}>{cleaned.replace(/:$/, "")}</h4>;
    if (/^[-•*]\s+/.test(line) || /^\d+[.)]\s+/.test(line)) return <p className="bullet" key={index}>{line.replace(/^[-•*]\s+/, "")}</p>;
    return <p key={index}>{line.replace(/^\*\*(.*?)\*\*$/, "$1")}</p>;
  })}</div>;
}
