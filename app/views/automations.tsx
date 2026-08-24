"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_URL, authenticatedFetch, formatDate, formatNumber, text } from "../shared";

type Row = Record<string, any>;

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-automation-health-api`;

function statusLabel(value: unknown) {
  return ({ OK: "Saudável", DEGRADED: "Com alerta", ERROR: "Falhando", OPEN: "Aberto", ACKNOWLEDGED: "Reconhecido", RESOLVED: "Resolvido" } as Record<string, string>)[String(value || "").toUpperCase()] || text(value);
}
function categoryLabel(value: unknown) {
  return ({ DATA: "Dados", EXECUTION: "Execução", INTEGRATION: "Integração", TECHNICAL: "Técnico", ROUTING: "Roteamento" } as Record<string, string>)[String(value || "").toUpperCase()] || text(value);
}
function severity(value: unknown) {
  const raw = String(value || "").toUpperCase();
  return raw === "CRITICAL" || raw === "ERROR" ? "critical" : raw === "ATTENTION" || raw === "DEGRADED" ? "attention" : "ok";
}

export function AutomationHealthCenter({ token }: { token: string }) {
  const [days, setDays] = useState<1 | 7 | 30>(7);
  const [payload, setPayload] = useState<Row>({ summary: {}, automations: [], recurring: [], timeline: [], incidents: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("ALL");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const url = new URL(API_URL);
      url.searchParams.set("days", String(days));
      const response = await authenticatedFetch(url, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar a saúde das automações.");
    } finally { setLoading(false); }
  }, [days, token]);

  useEffect(() => { load(); }, [load]);

  const summary = payload.summary || {};
  const automations: Row[] = payload.automations || [];
  const recurring: Row[] = payload.recurring || [];
  const incidents: Row[] = payload.incidents || [];
  const timeline: Row[] = payload.timeline || [];
  const visibleTimeline = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return timeline.filter((item) => {
      if (filter !== "ALL" && String(item.category || "").toUpperCase() !== filter) return false;
      if (!needle) return true;
      return [item.title, item.detail, item.client_name, item.product_label, item.family, item.job_name, item.error]
        .join(" ").toLocaleLowerCase("pt-BR").includes(needle);
    });
  }, [timeline, filter, query]);

  function openRecurring(row: Row) {
    const incident = incidents.find((item) => String(item.id) === String(row.last_incident_id));
    setSelected(incident || { ...row, kind: "RECURRENCE", title: `${row.client_name || "Cliente não identificado"} · ${row.product_label || "Produto"}` });
    setCopied(false);
  }

  async function copyRaw() {
    const raw = String(selected?.raw_text || "");
    if (!raw) return;
    try { await navigator.clipboard.writeText(raw); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch {}
  }

  return <section className="ah-shell">
    <style>{styles}</style>
    <div className="ah-head">
      <div><span className="eyebrow">Operação técnica</span><h2>Central de Saúde das Automações</h2><p>Make, Z-API, Meta, Supabase e rotinas internas em uma visão única. Clique em qualquer ocorrência para abrir o diagnóstico real.</p></div>
      <div className="ah-head-actions"><span>{payload.generated_at ? `Atualizado ${formatDate(payload.generated_at)}` : ""}</span><button onClick={load} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button></div>
    </div>

    <div className="ah-period">
      <span>Período</span>
      {([1,7,30] as const).map((value) => <button key={value} className={days === value ? "active" : ""} onClick={() => setDays(value)}>{value === 1 ? "24 horas" : `${value} dias`}</button>)}
    </div>

    {error && <div className="ah-error">{error}</div>}

    <div className="ah-kpis">
      <article><small>AUTOMAÇÕES MONITORADAS</small><b>{formatNumber(summary.monitored_automations, 0)}</b><span>{formatNumber(summary.automations_with_issue, 0)} com alerta agora</span></article>
      <article className={Number(summary.execution_issues) ? "warn" : ""}><small>ERROS / ALERTAS DE EXECUÇÃO</small><b>{formatNumber(summary.execution_issues, 0)}</b><span>no período selecionado</span></article>
      <article className={Number(summary.lead_data_incidents) ? "warn" : ""}><small>ERROS DE DADOS</small><b>{formatNumber(summary.lead_data_incidents, 0)}</b><span>{formatNumber(summary.critical_incidents, 0)} recorrentes/críticos</span></article>
      <article><small>CLIENTES AFETADOS</small><b>{formatNumber(summary.affected_clients, 0)}</b><span>{formatNumber(summary.open_incidents, 0)} incidentes ainda abertos</span></article>
      <article className={Number(summary.recurring_groups) ? "danger" : ""}><small>RECORRÊNCIAS</small><b>{formatNumber(summary.recurring_groups, 0)}</b><span>mesmo erro repetido</span></article>
    </div>

    <section className="ah-section">
      <div className="ah-section-head"><div><h3>Status agora</h3><p>Última execução e último erro conhecido de cada rotina monitorada.</p></div></div>
      <div className="ah-health-grid">
        {automations.map((item) => <button key={String(item.job_name)} className={`ah-health ${String(item.status).toLowerCase()}`} onClick={() => setSelected({ ...item, kind: "AUTOMATION", title: item.friendly_name })}>
          <span className={`ah-dot ${String(item.status).toLowerCase()}`} />
          <span><b>{text(item.friendly_name)}</b><small>{text(item.family)}</small></span>
          <span className="ah-health-right"><strong>{statusLabel(item.status)}</strong><small>{item.last_success_at ? `Sucesso: ${formatDate(item.last_success_at)}` : "Sem sucesso registrado"}</small></span>
        </button>)}
        {!loading && !automations.length && <div className="ah-empty">Nenhuma automação monitorada.</div>}
      </div>
    </section>

    <div className="ah-columns">
      <section className="ah-section ah-recurring">
        <div className="ah-section-head"><div><h3>Erros recorrentes</h3><p>Mesma combinação de cliente, produto e falha repetida no período.</p></div><span>{recurring.length}</span></div>
        <div className="ah-rec-list">
          {recurring.slice(0, 15).map((row) => <button key={String(row.key)} onClick={() => openRecurring(row)}>
            <span className="ah-count">{row.count}×</span>
            <span><b>{text(row.client_name || "Cliente não identificado")}</b><small>{text(row.product_label)} · {text(row.signature)}</small><small>Última: {formatDate(row.last_at)} · {row.open ? `${row.open} aberta(s)` : "sem pendência aberta"}</small></span>
            <i>›</i>
          </button>)}
          {!recurring.length && <div className="ah-empty">Nenhuma recorrência detectada neste período.</div>}
        </div>
      </section>

      <section className="ah-section ah-guide">
        <div className="ah-section-head"><div><h3>Leitura rápida</h3><p>Como interpretar os tipos de problema.</p></div></div>
        <div className="ah-guide-list">
          <div><span>Dados</span><p>Campo ausente, telefone/e-mail inválido ou resposta de formulário vazia.</p></div>
          <div><span>Integração</span><p>Permissão, token, credencial ou acesso negado por serviço externo.</p></div>
          <div><span>Técnico</span><p>Timeout, rede, conexão, HTTP 5xx ou indisponibilidade.</p></div>
          <div><span>Roteamento</span><p>Destino, cliente ou regra de encaminhamento inconsistente.</p></div>
          <div><span>Execução</span><p>Falha geral de rotina que não se encaixou nas categorias acima.</p></div>
        </div>
      </section>
    </div>

    <section className="ah-section">
      <div className="ah-section-head ah-timeline-head"><div><h3>Linha do tempo dos problemas</h3><p>Histórico técnico consolidado. O item clicado abre payload, mensagem e IDs quando disponíveis.</p></div><div className="ah-search"><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="ALL">Todos os tipos</option><option value="DATA">Dados</option><option value="INTEGRATION">Integração</option><option value="TECHNICAL">Técnico</option><option value="ROUTING">Roteamento</option><option value="EXECUTION">Execução</option></select><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cliente, produto, automação ou erro" /></div></div>
      <div className="ah-timeline">
        {visibleTimeline.map((item, index) => <button key={`${item.kind}-${item.id || index}`} onClick={() => { setSelected(item); setCopied(false); }}>
          <span className={`ah-badge ${severity(item.severity)}`}>{item.kind === "LEAD_DATA" ? "DADOS" : categoryLabel(item.category).toUpperCase()}</span>
          <span className="ah-event-main"><b>{text(item.title)}</b><small>{text(item.detail)}</small></span>
          <span className="ah-event-meta"><b>{text(item.family)}</b><small>{formatDate(item.occurred_at)}</small></span>
          <i>›</i>
        </button>)}
        {!loading && !visibleTimeline.length && <div className="ah-empty">Nenhuma ocorrência encontrada neste filtro.</div>}
      </div>
    </section>

    {selected && <div className="ah-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <section className="ah-modal" role="dialog" aria-modal="true" aria-label="Detalhes da ocorrência">
        <header><div><span className={`ah-badge ${severity(selected.severity || selected.status)}`}>{selected.kind === "LEAD_DATA" ? "ERRO DE DADOS" : selected.kind === "AUTOMATION" ? statusLabel(selected.status).toUpperCase() : categoryLabel(selected.category).toUpperCase()}</span><h3>{text(selected.title || selected.friendly_name)}</h3><p>{text(selected.detail || selected.last_error || "Detalhes técnicos da automação")}</p></div><button onClick={() => setSelected(null)}>×</button></header>

        {selected.kind === "LEAD_DATA" && <>
          <div className="ah-modal-grid">
            <div><small>Cliente</small><b>{text(selected.client_name || "Não identificado")}</b></div>
            <div><small>Produto</small><b>{text(selected.product_label || "Não identificado")}</b></div>
            <div><small>Ocorrência</small><b>{selected.occurrence_no ? `${selected.occurrence_no}ª` : "—"}</b></div>
            <div><small>Status</small><b>{statusLabel(selected.status)}</b></div>
            <div><small>Roteamento</small><b>{text(selected.dispatch?.routing_status || "Não informado")}</b></div>
            <div><small>Detectado</small><b>{formatDate(selected.created_at || selected.occurred_at)}</b></div>
          </div>
          <div className="ah-flow"><span>Lead / entrada</span><i>→</i><span>Automação</span><i>→</i><span className="issue">Validação de dados</span><i>→</i><span>Z-API / destino</span></div>
          <div className="ah-diagnosis"><b>O que foi identificado</b><div>{(selected.missing_required || []).map((field: string) => <span key={field}>{field}: ausente ou inválido</span>)}{(selected.missing_extra_questions || []).map((row: Row, index: number) => <span key={index}>Sem resposta: {text(row.question || `pergunta ${index + 1}`)}</span>)}</div></div>
          <div className="ah-raw"><div><b>Mensagem exatamente como chegou</b><button onClick={copyRaw} disabled={!selected.raw_text}>{copied ? "✓ Copiado" : "Copiar"}</button></div><pre>{String(selected.raw_text || "[Mensagem bruta indisponível]")}</pre></div>
          <details className="ah-tech"><summary>Dados técnicos do disparo</summary><div><span><small>Message ID</small><code>{text(selected.message_id)}</code></span><span><small>Incident ID</small><code>{text(selected.id)}</code></span><span><small>Lead detectado</small><code>{text(selected.dispatch?.lead_name)}</code></span><span><small>Telefone detectado</small><code>{text(selected.dispatch?.lead_phone)}</code></span><span><small>E-mail detectado</small><code>{text(selected.dispatch?.lead_email)}</code></span><span><small>Destino</small><code>{text(selected.dispatch?.recipient_phone)}</code></span><span><small>Match destino</small><code>{text(selected.dispatch?.recipient_match_method)}</code></span><span><small>Match esperado</small><code>{text(selected.dispatch?.expected_match_method)}</code></span></div></details>
        </>}

        {selected.kind === "JOB" && <>
          <div className="ah-modal-grid"><div><small>Automação</small><b>{text(selected.friendly_name || selected.job_name)}</b></div><div><small>Família</small><b>{text(selected.family)}</b></div><div><small>Categoria</small><b>{categoryLabel(selected.category)}</b></div><div><small>Status</small><b>{text(selected.status)}</b></div><div><small>Eventos processados</small><b>{formatNumber(selected.events_processed, 0)}</b></div><div><small>Duração</small><b>{selected.duration_ms == null ? "—" : `${formatNumber(Number(selected.duration_ms) / 1000, 1)}s`}</b></div></div>
          <div className="ah-job-error"><b>Erro registrado</b><pre>{text(selected.error || selected.detail)}</pre></div>
        </>}

        {selected.kind === "AUTOMATION" && <>
          <div className="ah-modal-grid"><div><small>Sistema</small><b>{text(selected.family)}</b></div><div><small>Status atual</small><b>{statusLabel(selected.status)}</b></div><div><small>Último sucesso</small><b>{selected.last_success_at ? formatDate(selected.last_success_at) : "—"}</b></div><div><small>Último erro</small><b>{selected.last_error_at ? formatDate(selected.last_error_at) : "—"}</b></div></div>
          <div className="ah-job-error"><b>Último erro conhecido</b><pre>{text(selected.last_error || "Nenhum erro ativo registrado.")}</pre></div>
        </>}
      </section>
    </div>}
  </section>;
}

const styles = `
.ah-shell{display:grid;gap:14px}.ah-head{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.ah-head h2{font:800 clamp(26px,3vw,40px)/1 'Inter Tight',Inter,sans-serif;letter-spacing:-.035em;margin:5px 0 8px}.ah-head p{margin:0;color:#8da5b8;max-width:850px;line-height:1.45}.ah-head-actions{display:flex;gap:9px;align-items:center}.ah-head-actions span{font-size:10px;color:#718ba0}.ah-head-actions button,.ah-period button{border:1px solid #294a60;background:#0a1a26;color:#dcecf7;border-radius:9px;padding:9px 12px;font-weight:800;cursor:pointer}.ah-period{display:flex;align-items:center;gap:7px}.ah-period>span{color:#728da2;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.09em;margin-right:3px}.ah-period button.active{border-color:#e06f35;background:#2a1710;color:#ffd4bd}.ah-error{border:1px solid #7a3440;background:#2a1218;color:#ffd0d7;border-radius:11px;padding:11px 13px}.ah-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px}.ah-kpis article{border:1px solid #1d3a4e;background:#081824;border-radius:13px;padding:13px}.ah-kpis article.warn{border-left:3px solid #e1ad50}.ah-kpis article.danger{border-left:3px solid #ef5b68}.ah-kpis small,.ah-kpis b,.ah-kpis span{display:block}.ah-kpis small{font-size:8px;color:#6f8ca2;font-weight:900;letter-spacing:.08em}.ah-kpis b{font-size:26px;margin:4px 0}.ah-kpis span{font-size:9px;color:#829caf}.ah-section{border:1px solid #19384c;background:#071521;border-radius:15px;padding:13px}.ah-section-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px}.ah-section-head h3{font-size:14px;margin:0}.ah-section-head p{font-size:9px;color:#708da3;margin:3px 0 0}.ah-section-head>span{border:1px solid #284a61;border-radius:999px;padding:4px 8px;color:#9fbbce;font-size:9px}.ah-health-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.ah-health{display:grid;grid-template-columns:10px 1fr auto;gap:9px;align-items:center;border:1px solid #18364a;background:#091a27;color:#dcebf5;border-radius:10px;padding:10px;text-align:left;cursor:pointer}.ah-health:hover{background:#0d2232}.ah-health.error{border-color:#71313c}.ah-health.degraded{border-color:#66522f}.ah-dot{width:8px;height:8px;border-radius:50%;background:#4b6476}.ah-dot.ok{background:#39c487;box-shadow:0 0 0 4px rgba(57,196,135,.1)}.ah-dot.degraded{background:#e7b04f;box-shadow:0 0 0 4px rgba(231,176,79,.1)}.ah-dot.error{background:#f05e6b;box-shadow:0 0 0 4px rgba(240,94,107,.12)}.ah-health span b,.ah-health span small,.ah-health-right strong,.ah-health-right small{display:block}.ah-health span b{font-size:11px}.ah-health span small{font-size:8px;color:#718da3;margin-top:2px}.ah-health-right{text-align:right}.ah-health-right strong{font-size:9px}.ah-health-right small{font-size:8px;color:#70899d;margin-top:2px}.ah-columns{display:grid;grid-template-columns:1.35fr .65fr;gap:10px}.ah-rec-list{display:grid;gap:6px}.ah-rec-list>button{display:grid;grid-template-columns:42px 1fr 16px;gap:9px;align-items:center;width:100%;border:1px solid #183448;background:#091925;color:#dfeef8;border-radius:10px;padding:9px;text-align:left;cursor:pointer}.ah-rec-list>button:hover{background:#0d2231}.ah-count{display:grid;place-items:center;height:34px;border-radius:8px;background:#35141c;color:#ff9aa5;font-weight:900}.ah-rec-list b,.ah-rec-list small{display:block}.ah-rec-list b{font-size:11px}.ah-rec-list small{font-size:8px;color:#768fa3;margin-top:2px}.ah-rec-list i{font-size:20px;color:#708da2}.ah-guide-list{display:grid;gap:7px}.ah-guide-list div{border:1px solid #193649;border-radius:9px;background:#091823;padding:8px}.ah-guide-list span{font-size:9px;font-weight:900;color:#cfe1ee}.ah-guide-list p{font-size:8px;line-height:1.35;color:#748fa3;margin:3px 0 0}.ah-timeline-head{align-items:end}.ah-search{display:flex;gap:6px;min-width:min(520px,55vw)}.ah-search select,.ah-search input{height:35px;border:1px solid #24465d;background:#06121c;color:#deedf7;border-radius:8px;padding:0 9px;font-size:10px;outline:none}.ah-search input{flex:1}.ah-timeline{display:grid;gap:4px;max-height:560px;overflow:auto}.ah-timeline>button{display:grid;grid-template-columns:92px minmax(0,1fr) 150px 16px;gap:10px;align-items:center;width:100%;border:0;border-top:1px solid #122d3d;background:transparent;color:#dcecf7;padding:10px 5px;text-align:left;cursor:pointer}.ah-timeline>button:first-child{border-top:0}.ah-timeline>button:hover{background:#0a1c29}.ah-badge{display:inline-flex;width:max-content;border:1px solid #38556a;background:#142634;color:#a9c2d3;border-radius:999px;padding:4px 7px;font-size:7px;font-weight:900;letter-spacing:.07em}.ah-badge.critical{border-color:#783642;background:#35151d;color:#ff9ba7}.ah-badge.attention{border-color:#6a552d;background:#322813;color:#edc66b}.ah-badge.ok{border-color:#275d48;background:#102c23;color:#7bdbb2}.ah-event-main b,.ah-event-main small,.ah-event-meta b,.ah-event-meta small{display:block}.ah-event-main b{font-size:10px}.ah-event-main small{font-size:8px;color:#8299aa;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ah-event-meta{text-align:right}.ah-event-meta b{font-size:8px;color:#9eb6c7}.ah-event-meta small{font-size:8px;color:#668197;margin-top:2px}.ah-timeline i{font-size:19px;color:#66859b}.ah-empty{padding:22px;text-align:center;color:#708ba0;font-size:10px}.ah-modal-backdrop{position:fixed;inset:0;z-index:2147483645;background:rgba(2,7,12,.82);backdrop-filter:blur(9px);display:grid;place-items:center;padding:16px}.ah-modal{width:min(980px,100%);max-height:calc(100dvh - 32px);overflow:auto;border:1px solid #29475b;background:#07121d;border-radius:17px;box-shadow:0 38px 120px rgba(0,0,0,.65);padding:17px}.ah-modal>header{display:flex;justify-content:space-between;gap:14px;border-bottom:1px solid #193447;padding-bottom:12px}.ah-modal>header h3{font:800 clamp(22px,3vw,34px)/1.04 'Inter Tight',Inter,sans-serif;margin:6px 0}.ah-modal>header p{margin:0;color:#8da4b5;max-width:780px;line-height:1.4;font-size:11px}.ah-modal>header>button{width:35px;height:35px;border:1px solid #29465a;background:#0a1b28;color:#b8cede;border-radius:9px;font-size:22px;cursor:pointer}.ah-modal-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px;margin-top:12px}.ah-modal-grid div{border:1px solid #193649;background:#091925;border-radius:9px;padding:8px;min-width:0}.ah-modal-grid small,.ah-modal-grid b{display:block}.ah-modal-grid small{font-size:7px;color:#69859a;text-transform:uppercase}.ah-modal-grid b{font-size:9px;margin-top:3px;overflow-wrap:anywhere}.ah-flow{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:10px;border:1px solid #1b384c;background:#081824;border-radius:10px;padding:9px}.ah-flow span{border:1px solid #294b61;border-radius:999px;padding:5px 8px;font-size:8px;color:#b0c7d7}.ah-flow span.issue{border-color:#7e3945;background:#33151c;color:#ffb5bd}.ah-flow i{color:#5e7e94}.ah-diagnosis{margin-top:10px;border:1px solid #6b303b;background:#251218;border-radius:10px;padding:10px}.ah-diagnosis>b{font-size:10px}.ah-diagnosis>div{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.ah-diagnosis span{border:1px solid #85404d;background:#38151c;color:#ffd5db;border-radius:999px;padding:5px 8px;font-size:8px}.ah-raw,.ah-job-error{margin-top:10px;border:1px solid #1d394c;background:#050c12;border-radius:10px;overflow:hidden}.ah-raw>div{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border-bottom:1px solid #1a3344}.ah-raw>div b,.ah-job-error>b{font-size:9px}.ah-raw button{border:1px solid #31536b;background:#0b2130;color:#bfe6ff;border-radius:7px;padding:5px 8px;font-size:8px;font-weight:800}.ah-raw pre,.ah-job-error pre{margin:0;padding:11px;white-space:pre-wrap;word-break:break-word;max-height:38vh;overflow:auto;color:#d4e0e9;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.ah-job-error>b{display:block;padding:8px 10px;border-bottom:1px solid #1a3344}.ah-tech{margin-top:10px;border:1px solid #1c394c;border-radius:10px;background:#081721;overflow:hidden}.ah-tech summary{padding:9px 10px;cursor:pointer;color:#8fa8bb;font-size:9px;font-weight:800}.ah-tech>div{border-top:1px solid #1c394c;padding:9px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.ah-tech small,.ah-tech code{display:block}.ah-tech small{font-size:7px;color:#68849a;text-transform:uppercase}.ah-tech code{font-size:8px;color:#c3d6e3;margin-top:2px;overflow-wrap:anywhere}@media(max-width:1100px){.ah-kpis{grid-template-columns:repeat(3,1fr)}.ah-columns{grid-template-columns:1fr}.ah-modal-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:760px){.ah-head{flex-direction:column}.ah-head-actions{width:100%;justify-content:space-between}.ah-kpis{grid-template-columns:1fr 1fr}.ah-health-grid{grid-template-columns:1fr}.ah-timeline-head{align-items:stretch;flex-direction:column}.ah-search{min-width:0;width:100%;flex-direction:column}.ah-timeline>button{grid-template-columns:78px 1fr 14px}.ah-event-meta{grid-column:2;text-align:left}.ah-modal-backdrop{padding:6px;place-items:start center;overflow:auto}.ah-modal{max-height:none;min-height:calc(100dvh - 12px);padding:12px}.ah-modal-grid{grid-template-columns:1fr 1fr}.ah-tech>div{grid-template-columns:1fr 1fr}}
`;
