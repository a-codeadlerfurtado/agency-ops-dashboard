"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_URL, authenticatedFetch, formatDate, formatNumber, text } from "../shared";

type Row = Record<string, any>;
type Tab = "NOW" | "AUTOMATIONS" | "HISTORY";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-automation-health-api`;

function statusLabel(value: unknown) {
  return ({
    OK: "Saudável",
    DEGRADED: "Com alerta",
    ERROR: "Falhando",
    OPEN: "Aberto",
    ACKNOWLEDGED: "Reconhecido",
    RESOLVED: "Resolvido",
    SUCCESS: "Sucesso",
  } as Record<string, string>)[String(value || "").toUpperCase()] || text(value);
}

function categoryLabel(value: unknown) {
  return ({
    DATA: "Dados",
    EXECUTION: "Execução",
    INTEGRATION: "Integração",
    TECHNICAL: "Técnico",
    ROUTING: "Roteamento",
  } as Record<string, string>)[String(value || "").toUpperCase()] || text(value);
}

function severity(value: unknown) {
  const raw = String(value || "").toUpperCase();
  if (["CRITICAL", "ERROR"].includes(raw)) return "critical";
  if (["ATTENTION", "DEGRADED"].includes(raw)) return "attention";
  return "ok";
}

function recommendation(item: Row) {
  const category = String(item.category || "").toUpperCase();
  if (item.kind === "LEAD_DATA" || category === "DATA") return "Revisar o mapeamento dos campos no fluxo e conferir a saída do módulo anterior ao envio.";
  if (category === "INTEGRATION") return "Revisar a conexão, token e permissões do serviço envolvido antes da próxima execução.";
  if (category === "ROUTING") return "Revisar a regra que identifica o cliente/destino e os critérios usados no roteamento.";
  if (category === "TECHNICAL") return "Verificar indisponibilidade, timeout ou erro de rede e confirmar se o fluxo possui retentativa segura.";
  return "Revisar a execução correspondente e identificar em qual etapa o retorno começou a divergir do esperado.";
}

function leadIssueSummary(item: Row) {
  const required = Array.isArray(item.missing_required) ? item.missing_required.map(String) : [];
  const extras = Array.isArray(item.missing_extra_questions) ? item.missing_extra_questions : [];
  const parts = [
    ...required.map((field) => `${field} ausente ou inválido`),
    ...extras.map((row: Row) => `sem resposta em “${text(row?.question || "pergunta adicional") }”`),
  ];
  return parts.length ? parts.join(" · ") : text(item.detail || "Dado incompleto detectado");
}

export function AutomationHealthCenter({ token }: { token: string }) {
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [tab, setTab] = useState<Tab>("NOW");
  const [payload, setPayload] = useState<Row>({ summary: {}, automations: [], recurring: [], timeline: [], incidents: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const url = new URL(API_URL);
      url.searchParams.set("days", String(days));
      const response = await authenticatedFetch(url, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar a saúde das automações.");
    } finally {
      setLoading(false);
    }
  }, [days, token]);

  useEffect(() => { load(); }, [load]);

  const summary = payload.summary || {};
  const automations: Row[] = payload.automations || [];
  const recurring: Row[] = payload.recurring || [];
  const incidents: Row[] = payload.incidents || [];
  const timeline: Row[] = payload.timeline || [];

  const unhealthy = useMemo(
    () => automations.filter((item) => String(item.status || "").toUpperCase() !== "OK"),
    [automations],
  );

  const groupedTimeline = useMemo(() => {
    const groups = new Map<string, Row>();
    for (const item of timeline) {
      const kind = String(item.kind || "JOB");
      const key = kind === "LEAD_DATA"
        ? ["lead", item.client_id || item.client_name || "sem-cliente", item.product_label || "sem-produto", item.detail || "sem-detalhe"].join("|")
        : ["job", item.job_name || item.friendly_name || item.family || "sem-job", item.category || "EXECUTION", item.detail || item.error || "sem-detalhe"].join("|");
      const current = groups.get(key);
      if (!current) {
        groups.set(key, { ...item, _group_key: key, _count: 1, _first_at: item.occurred_at, _last_at: item.occurred_at });
        continue;
      }
      current._count = Number(current._count || 1) + 1;
      const time = new Date(item.occurred_at || 0).getTime();
      if (time > new Date(current._last_at || 0).getTime()) {
        const count = current._count;
        const first = current._first_at;
        groups.set(key, { ...item, _group_key: key, _count: count, _first_at: first, _last_at: item.occurred_at });
      } else if (time < new Date(current._first_at || Date.now()).getTime()) {
        current._first_at = item.occurred_at;
      }
    }
    return [...groups.values()].sort((a, b) => {
      const rank = (row: Row) => severity(row.severity || row.status) === "critical" ? 0 : severity(row.severity || row.status) === "attention" ? 1 : 2;
      return rank(a) - rank(b)
        || Number(b._count || 1) - Number(a._count || 1)
        || new Date(b._last_at || b.occurred_at || 0).getTime() - new Date(a._last_at || a.occurred_at || 0).getTime();
    });
  }, [timeline]);

  const visibleTimeline = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return groupedTimeline.filter((item) => {
      if (filter !== "ALL" && String(item.category || "").toUpperCase() !== filter) return false;
      if (!needle) return true;
      return [item.title, item.detail, item.client_name, item.product_label, item.family, item.job_name, item.error]
        .join(" ").toLocaleLowerCase("pt-BR").includes(needle);
    });
  }, [groupedTimeline, filter, query]);

  const topIssue = recurring[0] || groupedTimeline[0] || null;
  const actionCount = Number(summary.open_incidents || 0) + unhealthy.length;
  const headline = actionCount
    ? `${actionCount} ${actionCount === 1 ? "ponto precisa" : "pontos precisam"} de atenção agora`
    : "Nenhuma pendência crítica agora";
  const headlineDetail = topIssue
    ? recurring[0]
      ? `O problema que mais se repete é ${text(recurring[0].signature)} em ${text(recurring[0].client_name || "cliente não identificado")}.`
      : `O problema mais relevante no período está em ${text(topIssue.title || topIssue.friendly_name)}.`
    : "Os fluxos monitorados não registraram problema no período selecionado.";

  function openRecurring(row: Row) {
    const incident = incidents.find((item) => String(item.id) === String(row.last_incident_id));
    setSelected(incident ? { ...incident, _count: row.count } : { ...row, kind: "RECURRENCE", title: `${row.client_name || "Cliente não identificado"} · ${row.product_label || "Produto"}`, _count: row.count });
    setCopied(false);
  }

  async function copyRaw() {
    const raw = String(selected?.raw_text || "");
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  return <section className="ah-shell">
    <style>{styles}</style>

    <div className="ah-head">
      <div>
        <span className="eyebrow">Saúde das automações</span>
        <h2>O que está quebrando?</h2>
        <p>Primeiro o que exige ação. Detalhes técnicos só aparecem quando você abre um problema.</p>
      </div>
      <div className="ah-head-actions">
        <span>{payload.generated_at ? `Atualizado ${formatDate(payload.generated_at)}` : ""}</span>
        <button onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
      </div>
    </div>

    <div className="ah-toolbar">
      <div className="ah-tabs">
        <button className={tab === "NOW" ? "active" : ""} onClick={() => setTab("NOW")}>Agora</button>
        <button className={tab === "AUTOMATIONS" ? "active" : ""} onClick={() => setTab("AUTOMATIONS")}>Automações</button>
        <button className={tab === "HISTORY" ? "active" : ""} onClick={() => setTab("HISTORY")}>Histórico</button>
      </div>
      <div className="ah-period">
        <span>Período</span>
        {([1, 7, 30] as const).map((value) => <button key={value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>{value === 1 ? "24h" : `${value} dias`}</button>)}
      </div>
    </div>

    {error && <div className="ah-error">{error}</div>}

    {tab === "NOW" && <>
      <section className={`ah-situation ${actionCount ? "needs-action" : "healthy"}`}>
        <div className="ah-situation-icon">{actionCount ? "!" : "✓"}</div>
        <div className="ah-situation-copy">
          <small>SITUAÇÃO AGORA</small>
          <h3>{headline}</h3>
          <p>{headlineDetail}</p>
        </div>
        <div className="ah-situation-side">
          <span><b>{formatNumber(summary.affected_clients, 0)}</b><small>clientes afetados</small></span>
          <span><b>{formatNumber(summary.recurring_groups, 0)}</b><small>erros repetindo</small></span>
        </div>
      </section>

      <div className="ah-kpis">
        <article className={Number(summary.open_incidents) ? "danger" : ""}><small>ABERTOS AGORA</small><b>{formatNumber(summary.open_incidents, 0)}</b><span>incidentes ainda sem baixa</span></article>
        <article className={unhealthy.length ? "warn" : ""}><small>AUTOMAÇÕES COM ALERTA</small><b>{formatNumber(unhealthy.length, 0)}</b><span>de {formatNumber(summary.monitored_automations, 0)} monitoradas</span></article>
        <article className={Number(summary.recurring_groups) ? "danger" : ""}><small>PROBLEMAS RECORRENTES</small><b>{formatNumber(summary.recurring_groups, 0)}</b><span>mesma falha acontecendo de novo</span></article>
        <article><small>CLIENTES IMPACTADOS</small><b>{formatNumber(summary.affected_clients, 0)}</b><span>no período selecionado</span></article>
      </div>

      <div className="ah-now-grid">
        <section className="ah-section ah-priority">
          <div className="ah-section-head"><div><span className="ah-kicker">PRIORIDADE</span><h3>Erros que estão se repetindo</h3><p>Os que merecem correção primeiro, porque já aconteceram mais de uma vez.</p></div><span className="ah-counter">{recurring.length}</span></div>
          <div className="ah-priority-list">
            {recurring.slice(0, 8).map((row, index) => <button key={String(row.key)} onClick={() => openRecurring(row)}>
              <span className="ah-rank">{index + 1}</span>
              <span className="ah-priority-main"><b>{text(row.client_name || "Cliente não identificado")}</b><strong>{text(row.signature)}</strong><small>{text(row.product_label)} · última vez {formatDate(row.last_at)}</small></span>
              <span className="ah-repeat"><b>{formatNumber(row.count, 0)}×</b><small>ocorrências</small></span>
              <i>›</i>
            </button>)}
            {!loading && !recurring.length && <div className="ah-empty good">Nenhum erro recorrente neste período.</div>}
          </div>
        </section>

        <section className="ah-section ah-live">
          <div className="ah-section-head"><div><span className="ah-kicker">STATUS ATUAL</span><h3>Automações com problema</h3><p>Somente o que não está 100% saudável neste momento.</p></div><span className="ah-counter">{unhealthy.length}</span></div>
          <div className="ah-live-list">
            {unhealthy.slice(0, 8).map((item) => <button key={String(item.job_name)} onClick={() => setSelected({ ...item, kind: "AUTOMATION", title: item.friendly_name })}>
              <span className={`ah-dot ${String(item.status).toLowerCase()}`} />
              <span><b>{text(item.friendly_name)}</b><small>{text(item.family)}</small></span>
              <span className="ah-live-status"><strong>{statusLabel(item.status)}</strong><small>{item.last_error_at ? formatDate(item.last_error_at) : "sem horário de erro"}</small></span>
              <i>›</i>
            </button>)}
            {!loading && !unhealthy.length && <div className="ah-empty good">Todas as automações monitoradas estão saudáveis agora.</div>}
          </div>
          <button className="ah-see-all" onClick={() => setTab("AUTOMATIONS")}>Ver todas as automações →</button>
        </section>
      </div>

      <section className="ah-section">
        <div className="ah-section-head"><div><span className="ah-kicker">ÚLTIMOS PROBLEMAS</span><h3>O que aconteceu recentemente</h3><p>Ocorrências iguais são agrupadas para você não precisar ler o mesmo erro 40 vezes.</p></div><button className="ah-link" onClick={() => setTab("HISTORY")}>Abrir histórico completo</button></div>
        <div className="ah-recent">
          {groupedTimeline.slice(0, 10).map((item, index) => <button key={String(item._group_key || index)} onClick={() => { setSelected(item); setCopied(false); }}>
            <span className={`ah-badge ${severity(item.severity || item.status)}`}>{item.kind === "LEAD_DATA" ? "DADO" : categoryLabel(item.category).toUpperCase()}</span>
            <span className="ah-event-main"><b>{text(item.title)}</b><small>{item.kind === "LEAD_DATA" ? leadIssueSummary(item) : text(item.detail)}</small></span>
            {Number(item._count || 1) > 1 && <span className="ah-group-count">{formatNumber(item._count, 0)}×</span>}
            <span className="ah-event-time">{formatDate(item._last_at || item.occurred_at)}</span>
            <i>›</i>
          </button>)}
          {!loading && !groupedTimeline.length && <div className="ah-empty good">Nenhum problema encontrado.</div>}
        </div>
      </section>
    </>}

    {tab === "AUTOMATIONS" && <section className="ah-section ah-automation-section">
      <div className="ah-section-head"><div><span className="ah-kicker">MAPA GERAL</span><h3>Todas as automações monitoradas</h3><p>Verde está saudável. Amarelo merece atenção. Vermelho indica falha.</p></div><span className="ah-counter">{automations.length}</span></div>
      <div className="ah-health-grid">
        {automations.map((item) => <button key={String(item.job_name)} className={`ah-health ${String(item.status).toLowerCase()}`} onClick={() => setSelected({ ...item, kind: "AUTOMATION", title: item.friendly_name })}>
          <span className={`ah-dot ${String(item.status).toLowerCase()}`} />
          <span className="ah-health-name"><b>{text(item.friendly_name)}</b><small>{text(item.family)}</small></span>
          <span className="ah-health-status"><strong>{statusLabel(item.status)}</strong><small>{item.last_success_at ? `Último sucesso: ${formatDate(item.last_success_at)}` : "Sem sucesso registrado"}</small></span>
          <i>›</i>
        </button>)}
        {!loading && !automations.length && <div className="ah-empty">Nenhuma automação monitorada.</div>}
      </div>
    </section>}

    {tab === "HISTORY" && <section className="ah-section">
      <div className="ah-section-head ah-history-head">
        <div><span className="ah-kicker">HISTÓRICO</span><h3>Problemas do período</h3><p>Itens iguais continuam agrupados; o número ao lado mostra quantas vezes aconteceram.</p></div>
        <div className="ah-search"><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="ALL">Todos os tipos</option><option value="DATA">Dados</option><option value="INTEGRATION">Integração</option><option value="TECHNICAL">Técnico</option><option value="ROUTING">Roteamento</option><option value="EXECUTION">Execução</option></select><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, produto ou erro" /></div>
      </div>
      <div className="ah-history-list">
        {visibleTimeline.map((item, index) => <button key={String(item._group_key || index)} onClick={() => { setSelected(item); setCopied(false); }}>
          <span className={`ah-badge ${severity(item.severity || item.status)}`}>{item.kind === "LEAD_DATA" ? "DADOS" : categoryLabel(item.category).toUpperCase()}</span>
          <span className="ah-event-main"><b>{text(item.title)}</b><small>{item.kind === "LEAD_DATA" ? leadIssueSummary(item) : text(item.detail)}</small></span>
          <span className="ah-history-meta"><b>{Number(item._count || 1) > 1 ? `${formatNumber(item._count, 0)} ocorrências` : text(item.family)}</b><small>Última: {formatDate(item._last_at || item.occurred_at)}</small></span>
          <i>›</i>
        </button>)}
        {!loading && !visibleTimeline.length && <div className="ah-empty">Nenhum problema encontrado nesse filtro.</div>}
      </div>
    </section>}

    <div className="ah-source-note"><b>Importante:</b> esta central consolida os erros e sinais que já chegam ao banco pelos fluxos da operação. Ela ainda não é o histórico nativo de execuções dentro do Make.</div>

    {selected && <div className="ah-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <section className="ah-modal" role="dialog" aria-modal="true" aria-label="Detalhes da ocorrência">
        <header>
          <div>
            <span className={`ah-badge ${severity(selected.severity || selected.status)}`}>{selected.kind === "LEAD_DATA" ? "ERRO DE DADOS" : selected.kind === "AUTOMATION" ? statusLabel(selected.status).toUpperCase() : categoryLabel(selected.category).toUpperCase()}</span>
            <h3>{text(selected.title || selected.friendly_name)}</h3>
            <p>{selected.kind === "LEAD_DATA" ? leadIssueSummary(selected) : text(selected.detail || selected.last_error || "Detalhes da automação")}</p>
          </div>
          <button onClick={() => setSelected(null)} aria-label="Fechar">×</button>
        </header>

        {Number(selected._count || 1) > 1 && <div className="ah-recurrence-banner"><b>{formatNumber(selected._count, 0)} ocorrências semelhantes</b><span>O dashboard agrupou repetições do mesmo problema para facilitar a leitura.</span></div>}

        <div className="ah-action-box"><small>O QUE FAZER PRIMEIRO</small><b>{recommendation(selected)}</b></div>

        {selected.kind === "LEAD_DATA" && <>
          <div className="ah-modal-grid">
            <div><small>Cliente</small><b>{text(selected.client_name || "Não identificado")}</b></div>
            <div><small>Produto</small><b>{text(selected.product_label || "Não identificado")}</b></div>
            <div><small>Ocorrência</small><b>{selected.occurrence_no ? `${selected.occurrence_no}ª` : "—"}</b></div>
            <div><small>Status</small><b>{statusLabel(selected.status)}</b></div>
            <div><small>Roteamento</small><b>{text(selected.dispatch?.routing_status || "Não informado")}</b></div>
            <div><small>Detectado</small><b>{formatDate(selected.created_at || selected.occurred_at)}</b></div>
          </div>

          <div className="ah-diagnosis"><b>O que o sistema encontrou</b><div>{(selected.missing_required || []).map((field: string) => <span key={field}>{field}: ausente ou inválido</span>)}{(selected.missing_extra_questions || []).map((row: Row, index: number) => <span key={index}>Sem resposta: {text(row.question || `pergunta ${index + 1}`)}</span>)}</div></div>

          <div className="ah-flow"><span>Lead recebido</span><i>→</i><span className="issue">Validação falhou aqui</span><i>→</i><span>Envio / destino</span></div>

          <details className="ah-raw" open>
            <summary>Ver mensagem exatamente como chegou</summary>
            <div className="ah-raw-head"><b>Mensagem original</b><button onClick={copyRaw} disabled={!selected.raw_text}>{copied ? "✓ Copiado" : "Copiar"}</button></div>
            <pre>{String(selected.raw_text || "[Mensagem bruta indisponível]")}</pre>
          </details>

          <details className="ah-tech"><summary>Dados técnicos</summary><div><span><small>Message ID</small><code>{text(selected.message_id)}</code></span><span><small>Incident ID</small><code>{text(selected.id)}</code></span><span><small>Lead detectado</small><code>{text(selected.dispatch?.lead_name)}</code></span><span><small>Telefone detectado</small><code>{text(selected.dispatch?.lead_phone)}</code></span><span><small>E-mail detectado</small><code>{text(selected.dispatch?.lead_email)}</code></span><span><small>Destino</small><code>{text(selected.dispatch?.recipient_phone)}</code></span><span><small>Match destino</small><code>{text(selected.dispatch?.recipient_match_method)}</code></span><span><small>Match esperado</small><code>{text(selected.dispatch?.expected_match_method)}</code></span></div></details>
        </>}

        {selected.kind === "JOB" && <>
          <div className="ah-modal-grid compact">
            <div><small>Automação</small><b>{text(selected.friendly_name || selected.job_name)}</b></div>
            <div><small>Sistema</small><b>{text(selected.family)}</b></div>
            <div><small>Tipo</small><b>{categoryLabel(selected.category)}</b></div>
            <div><small>Status</small><b>{text(selected.status)}</b></div>
            <div><small>Eventos processados</small><b>{formatNumber(selected.events_processed, 0)}</b></div>
            <div><small>Duração</small><b>{selected.duration_ms == null ? "—" : `${formatNumber(Number(selected.duration_ms) / 1000, 1)}s`}</b></div>
          </div>
          <div className="ah-job-error"><b>Erro registrado</b><pre>{text(selected.error || selected.detail)}</pre></div>
        </>}

        {selected.kind === "AUTOMATION" && <>
          <div className="ah-modal-grid compact">
            <div><small>Sistema</small><b>{text(selected.family)}</b></div>
            <div><small>Status atual</small><b>{statusLabel(selected.status)}</b></div>
            <div><small>Último sucesso</small><b>{selected.last_success_at ? formatDate(selected.last_success_at) : "—"}</b></div>
            <div><small>Último erro</small><b>{selected.last_error_at ? formatDate(selected.last_error_at) : "—"}</b></div>
          </div>
          <div className="ah-job-error"><b>Último erro conhecido</b><pre>{text(selected.last_error || "Nenhum erro ativo registrado.")}</pre></div>
        </>}
      </section>
    </div>}
  </section>;
}

const styles = `
.ah-shell{display:grid;gap:16px;max-width:1500px;margin:0 auto}.ah-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.ah-head h2{font:800 clamp(30px,4vw,46px)/.98 'Inter Tight',Inter,sans-serif;letter-spacing:-.045em;margin:6px 0 8px}.ah-head p{margin:0;color:#94a9ba;max-width:720px;font-size:13px;line-height:1.45}.ah-head-actions{display:flex;gap:10px;align-items:center}.ah-head-actions span{font-size:10px;color:#71889a}.ah-head-actions button,.ah-toolbar button,.ah-link,.ah-see-all{border:1px solid #2a4a60;background:#0b1d2a;color:#dcebf6;border-radius:10px;padding:9px 12px;font-weight:800;cursor:pointer}.ah-head-actions button:hover,.ah-toolbar button:hover,.ah-link:hover,.ah-see-all:hover{background:#10293a}.ah-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid #183247;padding-bottom:12px}.ah-tabs,.ah-period{display:flex;align-items:center;gap:6px}.ah-tabs button{min-width:105px}.ah-tabs button.active{border-color:#4a87b2;background:#102b3d;color:#fff}.ah-period>span{color:#728da2;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.09em;margin-right:2px}.ah-period button{padding:8px 10px}.ah-period button.active{border-color:#d66f3b;background:#2b1710;color:#ffd5bf}.ah-error{border:1px solid #7a3440;background:#2a1218;color:#ffd0d7;border-radius:12px;padding:12px 14px}.ah-situation{display:grid;grid-template-columns:58px minmax(0,1fr) auto;align-items:center;gap:16px;border:1px solid #29465a;border-radius:18px;padding:18px;background:linear-gradient(135deg,#0c1c28,#07131d)}.ah-situation.needs-action{border-color:#6b3941;background:radial-gradient(circle at 0 0,rgba(226,82,96,.14),transparent 32%),linear-gradient(135deg,#151318,#08131c)}.ah-situation.healthy{border-color:#285844;background:radial-gradient(circle at 0 0,rgba(54,186,126,.12),transparent 32%),linear-gradient(135deg,#0b1b19,#08131c)}.ah-situation-icon{width:56px;height:56px;border-radius:15px;display:grid;place-items:center;font-size:32px;font-weight:1000;background:#34151b;color:#ff7b87;border:1px solid #763541}.ah-situation.healthy .ah-situation-icon{background:#112d23;color:#6ed2a8;border-color:#2c624d}.ah-situation-copy small{display:block;color:#7f97aa;font-size:9px;font-weight:900;letter-spacing:.11em}.ah-situation-copy h3{font:800 clamp(22px,3vw,34px)/1.05 'Inter Tight',Inter,sans-serif;margin:5px 0 7px}.ah-situation-copy p{margin:0;color:#9cafbd;line-height:1.4;font-size:12px}.ah-situation-side{display:flex;gap:10px}.ah-situation-side>span{min-width:125px;border:1px solid #274256;background:rgba(6,16,24,.66);border-radius:12px;padding:10px 12px}.ah-situation-side b,.ah-situation-side small{display:block}.ah-situation-side b{font-size:22px}.ah-situation-side small{font-size:8px;color:#7f98aa;margin-top:2px}.ah-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.ah-kpis article{border:1px solid #1d3a4e;background:#081824;border-radius:14px;padding:14px}.ah-kpis article.warn{border-left:3px solid #dfa84b}.ah-kpis article.danger{border-left:3px solid #ed5967}.ah-kpis small,.ah-kpis b,.ah-kpis span{display:block}.ah-kpis small{font-size:8px;color:#718da2;font-weight:900;letter-spacing:.08em}.ah-kpis b{font-size:29px;margin:5px 0}.ah-kpis span{font-size:9px;color:#849caf}.ah-now-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:12px}.ah-section{border:1px solid #19384c;background:#071521;border-radius:16px;padding:14px}.ah-section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:11px}.ah-section-head h3{font-size:16px;margin:2px 0 0}.ah-section-head p{font-size:9px;color:#718da2;margin:4px 0 0;line-height:1.35}.ah-kicker{font-size:8px;font-weight:900;color:#6f8da3;letter-spacing:.12em}.ah-counter{border:1px solid #29495f;border-radius:999px;padding:4px 8px;color:#a9c1d1;font-size:9px}.ah-priority-list,.ah-live-list,.ah-recent,.ah-history-list{display:grid;gap:5px}.ah-priority-list>button{display:grid;grid-template-columns:30px minmax(0,1fr) 70px 14px;align-items:center;gap:9px;width:100%;border:1px solid #203b4d;background:#091925;color:#e3eef6;border-radius:11px;padding:10px;text-align:left;cursor:pointer}.ah-priority-list>button:hover,.ah-live-list>button:hover,.ah-recent>button:hover,.ah-history-list>button:hover{background:#0d2231}.ah-rank{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;background:#24171a;color:#ff8a96;font-size:10px;font-weight:900}.ah-priority-main b,.ah-priority-main strong,.ah-priority-main small{display:block}.ah-priority-main b{font-size:11px}.ah-priority-main strong{font-size:10px;color:#ffb6be;margin-top:3px}.ah-priority-main small{font-size:8px;color:#738ca0;margin-top:3px}.ah-repeat{text-align:right}.ah-repeat b,.ah-repeat small{display:block}.ah-repeat b{font-size:15px;color:#ff8995}.ah-repeat small{font-size:7px;color:#6d8799}.ah-priority-list i,.ah-live-list i,.ah-recent i,.ah-history-list i,.ah-health i{font-size:19px;color:#6f8ca1}.ah-live-list>button{display:grid;grid-template-columns:10px minmax(0,1fr) 115px 14px;align-items:center;gap:9px;width:100%;border:1px solid #1d394c;background:#091925;color:#e3eef6;border-radius:10px;padding:10px;text-align:left;cursor:pointer}.ah-live-list b,.ah-live-list small{display:block}.ah-live-list b{font-size:10px}.ah-live-list small{font-size:8px;color:#728ca0;margin-top:2px}.ah-live-status{text-align:right}.ah-live-status strong{display:block;font-size:9px}.ah-see-all{width:100%;margin-top:8px;font-size:9px}.ah-dot{width:8px;height:8px;border-radius:50%;background:#4b6476}.ah-dot.ok{background:#39c487;box-shadow:0 0 0 4px rgba(57,196,135,.1)}.ah-dot.degraded{background:#e7b04f;box-shadow:0 0 0 4px rgba(231,176,79,.1)}.ah-dot.error{background:#f05e6b;box-shadow:0 0 0 4px rgba(240,94,107,.12)}.ah-recent>button{display:grid;grid-template-columns:82px minmax(0,1fr) 52px 126px 14px;align-items:center;gap:10px;width:100%;border:0;border-top:1px solid #143044;background:transparent;color:#dcebf5;padding:11px 5px;text-align:left;cursor:pointer}.ah-recent>button:first-child{border-top:0}.ah-event-main b,.ah-event-main small{display:block}.ah-event-main b{font-size:10px}.ah-event-main small{font-size:8px;color:#8099ab;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ah-group-count{justify-self:end;border:1px solid #6b3440;background:#2f161c;color:#ff9ca7;border-radius:999px;padding:4px 7px;font-size:8px;font-weight:900}.ah-event-time{font-size:8px;color:#6d879a;text-align:right}.ah-badge{display:inline-flex;width:max-content;border:1px solid #38556a;background:#142634;color:#a9c2d3;border-radius:999px;padding:4px 7px;font-size:7px;font-weight:900;letter-spacing:.07em}.ah-badge.critical{border-color:#783642;background:#35151d;color:#ff9ba7}.ah-badge.attention{border-color:#6a552d;background:#322813;color:#edc66b}.ah-badge.ok{border-color:#275d48;background:#102c23;color:#7bdbb2}.ah-health-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.ah-health{display:grid;grid-template-columns:10px minmax(0,1fr) 180px 14px;align-items:center;gap:10px;border:1px solid #1c394c;background:#091a27;color:#dcebf5;border-radius:11px;padding:12px;text-align:left;cursor:pointer}.ah-health:hover{background:#0d2232}.ah-health.error{border-color:#71313c}.ah-health.degraded{border-color:#66522f}.ah-health-name b,.ah-health-name small,.ah-health-status strong,.ah-health-status small{display:block}.ah-health-name b{font-size:11px}.ah-health-name small{font-size:8px;color:#718da3;margin-top:2px}.ah-health-status{text-align:right}.ah-health-status strong{font-size:9px}.ah-health-status small{font-size:8px;color:#70899d;margin-top:2px}.ah-history-head{align-items:end}.ah-search{display:flex;gap:6px;min-width:min(560px,55vw)}.ah-search select,.ah-search input{height:37px;border:1px solid #24465d;background:#06121c;color:#deedf7;border-radius:9px;padding:0 10px;font-size:10px;outline:none}.ah-search input{flex:1}.ah-history-list{max-height:690px;overflow:auto}.ah-history-list>button{display:grid;grid-template-columns:92px minmax(0,1fr) 150px 14px;gap:10px;align-items:center;width:100%;border:0;border-top:1px solid #143044;background:transparent;color:#dcebf5;padding:11px 5px;text-align:left;cursor:pointer}.ah-history-list>button:first-child{border-top:0}.ah-history-meta{text-align:right}.ah-history-meta b,.ah-history-meta small{display:block}.ah-history-meta b{font-size:8px;color:#a7bece}.ah-history-meta small{font-size:8px;color:#698399;margin-top:2px}.ah-link{font-size:9px;padding:7px 9px}.ah-empty{padding:24px;text-align:center;color:#708ba0;font-size:10px;border:1px dashed #213e51;border-radius:10px}.ah-empty.good{color:#75cba8;border-color:#285744;background:#0b201a}.ah-source-note{font-size:9px;color:#668296;border-top:1px solid #183246;padding-top:10px}.ah-source-note b{color:#8da8bb}.ah-modal-backdrop{position:fixed;inset:0;z-index:2147483645;background:rgba(2,7,12,.84);backdrop-filter:blur(9px);display:grid;place-items:center;padding:16px}.ah-modal{width:min(980px,100%);max-height:calc(100dvh - 32px);overflow:auto;border:1px solid #29475b;background:#07121d;border-radius:18px;box-shadow:0 38px 120px rgba(0,0,0,.65);padding:18px}.ah-modal>header{display:flex;justify-content:space-between;gap:14px;border-bottom:1px solid #193447;padding-bottom:13px}.ah-modal>header h3{font:800 clamp(24px,3vw,36px)/1.04 'Inter Tight',Inter,sans-serif;margin:7px 0}.ah-modal>header p{margin:0;color:#96aaba;max-width:780px;line-height:1.45;font-size:11px}.ah-modal>header>button{width:36px;height:36px;border:1px solid #29465a;background:#0a1b28;color:#b8cede;border-radius:10px;font-size:22px;cursor:pointer}.ah-recurrence-banner{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;border:1px solid #713541;background:#2c151b;border-radius:10px;padding:9px 11px}.ah-recurrence-banner b{font-size:10px;color:#ff9aa6}.ah-recurrence-banner span{font-size:8px;color:#a87f86}.ah-action-box{margin-top:12px;border:1px solid #35536a;background:#0b1f2d;border-radius:12px;padding:11px}.ah-action-box small,.ah-action-box b{display:block}.ah-action-box small{font-size:8px;letter-spacing:.1em;color:#79a0bb;font-weight:900}.ah-action-box b{font-size:11px;line-height:1.4;margin-top:4px;color:#d7e8f4}.ah-modal-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px;margin-top:12px}.ah-modal-grid.compact{grid-template-columns:repeat(4,minmax(0,1fr))}.ah-modal-grid div{border:1px solid #193649;background:#091925;border-radius:9px;padding:9px;min-width:0}.ah-modal-grid small,.ah-modal-grid b{display:block}.ah-modal-grid small{font-size:7px;color:#69859a;text-transform:uppercase}.ah-modal-grid b{font-size:9px;margin-top:3px;overflow-wrap:anywhere}.ah-diagnosis{margin-top:10px;border:1px solid #6b303b;background:#251218;border-radius:10px;padding:10px}.ah-diagnosis>b{font-size:10px}.ah-diagnosis>div{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.ah-diagnosis span{border:1px solid #85404d;background:#38151c;color:#ffd5db;border-radius:999px;padding:5px 8px;font-size:8px}.ah-flow{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:10px;border:1px solid #1b384c;background:#081824;border-radius:10px;padding:9px}.ah-flow span{border:1px solid #294b61;border-radius:999px;padding:5px 8px;font-size:8px;color:#b0c7d7}.ah-flow span.issue{border-color:#7e3945;background:#33151c;color:#ffb5bd}.ah-flow i{color:#5e7e94}.ah-raw,.ah-job-error{margin-top:10px;border:1px solid #1d394c;background:#050c12;border-radius:10px;overflow:hidden}.ah-raw summary{padding:9px 10px;cursor:pointer;color:#a5bac9;font-size:9px;font-weight:800}.ah-raw-head{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-top:1px solid #1a3344;border-bottom:1px solid #1a3344}.ah-raw-head b,.ah-job-error>b{font-size:9px}.ah-raw button{border:1px solid #31536b;background:#0b2130;color:#bfe6ff;border-radius:7px;padding:5px 8px;font-size:8px;font-weight:800}.ah-raw pre,.ah-job-error pre{margin:0;padding:11px;white-space:pre-wrap;word-break:break-word;max-height:38vh;overflow:auto;color:#d4e0e9;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.ah-job-error>b{display:block;padding:8px 10px;border-bottom:1px solid #1a3344}.ah-tech{margin-top:10px;border:1px solid #1c394c;border-radius:10px;background:#081721;overflow:hidden}.ah-tech summary{padding:9px 10px;cursor:pointer;color:#8fa8bb;font-size:9px;font-weight:800}.ah-tech>div{border-top:1px solid #1c394c;padding:10px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}.ah-tech small,.ah-tech code{display:block}.ah-tech small{font-size:7px;color:#668399;text-transform:uppercase}.ah-tech code{font-size:8px;color:#c0d2df;margin-top:3px;overflow-wrap:anywhere}
@media(max-width:1000px){.ah-situation{grid-template-columns:52px 1fr}.ah-situation-side{grid-column:1/-1}.ah-kpis{grid-template-columns:1fr 1fr}.ah-now-grid{grid-template-columns:1fr}.ah-health-grid{grid-template-columns:1fr}.ah-modal-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.ah-recent>button{grid-template-columns:78px minmax(0,1fr) 44px 14px}.ah-event-time{display:none}}
@media(max-width:700px){.ah-head{flex-direction:column}.ah-head-actions{width:100%;justify-content:space-between}.ah-toolbar{align-items:flex-start;flex-direction:column}.ah-tabs{width:100%}.ah-tabs button{flex:1;min-width:0}.ah-situation{grid-template-columns:44px 1fr;padding:13px}.ah-situation-icon{width:42px;height:42px;font-size:24px}.ah-situation-side{display:grid;grid-template-columns:1fr 1fr;width:100%}.ah-situation-side>span{min-width:0}.ah-kpis{grid-template-columns:1fr 1fr}.ah-priority-list>button{grid-template-columns:28px minmax(0,1fr) 52px 12px}.ah-live-list>button{grid-template-columns:10px minmax(0,1fr) 12px}.ah-live-status{display:none}.ah-recent>button{grid-template-columns:68px minmax(0,1fr) 40px 12px}.ah-history-head{align-items:stretch;flex-direction:column}.ah-search{min-width:0;width:100%;flex-direction:column}.ah-history-list>button{grid-template-columns:76px minmax(0,1fr) 12px}.ah-history-meta{display:none}.ah-health{grid-template-columns:10px minmax(0,1fr) 12px}.ah-health-status{display:none}.ah-modal-backdrop{padding:7px;place-items:start center;overflow:auto}.ah-modal{max-height:none;min-height:calc(100dvh - 14px);padding:14px}.ah-modal-grid,.ah-modal-grid.compact{grid-template-columns:1fr 1fr}.ah-tech>div{grid-template-columns:1fr 1fr}.ah-kpis b{font-size:24px}}
`;
