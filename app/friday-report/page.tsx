"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, formatNumber, supabase, text } from "../shared";

type Row = Record<string, any>;
type Payload = {
  profile?: Row;
  release_open?: boolean;
  current_week?: { start: string; end: string };
  current_reports?: Row[];
  history?: Row[];
  generated_at?: string;
};

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-friday-report-api`;
const rateOrder = ["attempt_rate","answer_lead_rate","answer_attempt_rate","conversation_answer_rate","visit_schedule_rate","visit_completion_rate","proposal_rate","sale_proposal_rate","sale_lead_rate"];

function fmtDate(value: unknown) {
  const raw = String(value || "");
  const [y,m,d] = raw.slice(0,10).split("-");
  return y && m && d ? `${d}/${m}/${y}` : raw || "—";
}
function statusLabel(value: unknown) {
  return ({ MATCH:"Meta conferido", META_PARTIAL:"Meta parcial", META_UNAVAILABLE:"Meta não consultado", DIVERGENCE_META_HIGHER:"Meta maior que comercial", DIVERGENCE_COMMERCIAL_HIGHER:"Comercial maior que Meta" } as Record<string,string>)[String(value)] || String(value || "—");
}
function confidenceLabel(value: unknown) {
  return ({ ALTA:"Alta", MEDIA:"Média", BAIXA:"Baixa", CRITICA:"Crítica" } as Record<string,string>)[String(value)] || String(value || "—");
}
function tone(value: unknown) {
  const raw = String(value || "");
  if (raw === "MATCH" || raw === "ALTA") return "ok";
  if (raw === "META_PARTIAL" || raw === "MEDIA") return "warn";
  return "bad";
}
function percent(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toLocaleString("pt-BR", { minimumFractionDigits:1, maximumFractionDigits:1 })}%` : "—";
}

export default function FridayReportPage() {
  const [session,setSession] = useState<Session|null>(null);
  const [ready,setReady] = useState(false);
  const [payload,setPayload] = useState<Payload>({});
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [week,setWeek] = useState("");
  const [client,setClient] = useState("ALL");
  const [query,setQuery] = useState("");
  const [copied,setCopied] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({data}) => { setSession(data.session); setReady(true); });
    const { data:{subscription} } = supabase.auth.onAuthStateChange((_event,next) => { setSession(next); setReady(true); });
    return () => subscription.unsubscribe();
  },[]);

  async function load() {
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(API_URL,{cache:"no-store"});
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
      if (!week) setWeek(String(body.current_week?.end || body.history?.[0]?.week_end || ""));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao carregar relatórios."); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    if (!ready) return;
    if (!session) { window.location.assign("/"); return; }
    load();
  },[ready,session?.access_token]);

  const weeks = useMemo(() => [...new Set((payload.history || []).map((row) => String(row.week_end)))].sort().reverse(),[payload.history]);
  const rows = useMemo(() => {
    const needle=query.trim().toLocaleLowerCase("pt-BR");
    return (payload.history || []).filter((row) => (!week || String(row.week_end)===week) && (client==="ALL" || String(row.client_id)===client) && (!needle || [row.client_message,row.gt_owner,row.cs_owner,row.source_summary].join(" ").toLocaleLowerCase("pt-BR").includes(needle)));
  },[payload.history,week,client,query]);
  const clients = useMemo(() => {
    const map=new Map<string,string>();
    for(const row of payload.history || []) map.set(String(row.client_id),String(row.client_message||"").match(/fechamento comercial[^\n]*/i)?.[0] ? String(row.context?.client_name || row.client_name || row.display_name || row.client_id) : String(row.client_name || row.display_name || row.client_id));
    for(const row of payload.history || []) if(!map.get(String(row.client_id)) || map.get(String(row.client_id))===String(row.client_id)) map.set(String(row.client_id), String(row.context?.client_name || row.client_name || row.display_name || row.client_id));
    return [...map.entries()].sort((a,b)=>a[1].localeCompare(b[1],"pt-BR"));
  },[payload.history]);

  async function copy(row: Row) {
    const value=String(row.client_message || "");
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(String(row.id));
    window.setTimeout(()=>setCopied(""),1800);
  }

  if (!ready || !session) return <main className="fr-loading">Carregando…</main>;

  return <main className="fr-shell"><style>{styles}</style>
    <header className="fr-top">
      <button className="fr-back" onClick={()=>window.location.assign("/")}>← Central de Operações</button>
      <div className="fr-brand"><span><BrandMark/></span><div><small>Leonardo Imobi</small><b>Relatório Comercial de Sexta</b></div></div>
      <div className="fr-user"><b>{text(payload.profile?.person || "CS")}</b><small>{text(payload.profile?.role || "CS")}</small></div>
    </header>

    <section className="fr-hero">
      <div><span className="fr-kicker">ROTINA SEMANAL · CS</span><h1>Mensagem pronta, <em>mas só depois da conferência.</em></h1><p>O sistema cruza o que os corretores reportaram no grupo comercial com os leads do Meta. Se o Meta estiver ausente, parcial ou divergente, o aviso aparece antes da mensagem para o CS validar com o GT.</p></div>
      <div className={`fr-release ${payload.release_open ? "open":"closed"}`}><small>{payload.release_open ? "LIBERADO HOJE":"FORA DA JANELA DE SEXTA"}</small><b>{fmtDate(payload.current_week?.end)}</b><span>{payload.release_open ? "relatórios da semana disponíveis para revisão":"histórico continua disponível"}</span></div>
    </section>

    <section className="fr-rules">
      <article><b>1</b><span><strong>Grupo Comercial</strong>Extrai leads, tentativas, contatos, conversas, visitas e propostas reportadas.</span></article>
      <article><b>2</b><span><strong>Meta Ads</strong>Tenta conferir o volume real de leads da mesma semana.</span></article>
      <article><b>3</b><span><strong>CS valida</strong>Se houver alerta, consulta o GT responsável antes de copiar para o cliente.</span></article>
    </section>

    <section className="fr-filters">
      <select value={week} onChange={(e)=>setWeek(e.target.value)}>{weeks.length ? weeks.map((item)=><option value={item} key={item}>Semana encerrada em {fmtDate(item)}</option>) : <option value="">Sem histórico ainda</option>}</select>
      <select value={client} onChange={(e)=>setClient(e.target.value)}><option value="ALL">Todos os clientes</option>{clients.map(([id,name])=><option value={id} key={id}>{name}</option>)}</select>
      <input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar GT, CS ou conteúdo"/>
      <button onClick={load} disabled={loading}>{loading?"Atualizando…":"Atualizar dados"}</button>
    </section>

    {error && <div className="fr-error">{error}</div>}
    {!loading && !rows.length && !error && <div className="fr-empty">Nenhum relatório salvo para este filtro. Na sexta, a edição corrente é gerada quando um CS ou a gestão abre esta tela.</div>}

    <section className="fr-grid">{rows.map((row) => {
      const metrics=row.metrics || {};
      const contexts=row.context?.rate_contexts || {};
      const reporters=Array.isArray(row.reporters)?row.reporters:[];
      const clientName=row.context?.client_name || row.client_name || row.display_name || `Cliente ${String(row.client_id).slice(0,8)}`;
      return <article className="fr-card" key={String(row.id)}>
        <div className="fr-card-head"><div><span className="fr-kicker">{fmtDate(row.week_start)} → {fmtDate(row.week_end)}</span><h2>{clientName}</h2><p>CS {text(row.cs_owner)} · GT {text(row.gt_owner)}</p></div><div className="fr-badges"><span className={tone(row.meta_cross_status)}>{statusLabel(row.meta_cross_status)}</span><span className={tone(row.confidence_level)}>Confiança {confidenceLabel(row.confidence_level)}</span></div></div>

        <div className={`fr-warning ${row.meta_cross_status === "MATCH" ? "ok":"warn"}`}><b>{row.meta_cross_status === "MATCH" ? "✓ Cruzamento conferido":"⚠ Verificação antes de enviar"}</b><span>{text(row.internal_warning)}</span>{row.meta_cross_status !== "MATCH" && <small>Consulte o GT responsável: <strong>{text(row.gt_owner)}</strong>.</small>}</div>

        <div className="fr-source-grid">
          <div><small>LEADS · GRUPO</small><b>{formatNumber(row.commercial_leads ?? 0,0)}</b><span>reportados pelo comercial</span></div>
          <div><small>LEADS · META</small><b>{row.meta_leads == null ? "—":formatNumber(row.meta_leads,0)}</b><span>{text(row.meta_source || "não disponível")}</span></div>
          <div><small>DIFERENÇA</small><b>{row.meta_difference == null ? "—":`${Number(row.meta_difference)>0?"+":""}${formatNumber(row.meta_difference,0)}`}</b><span>{row.meta_difference_pct == null ? "sem cruzamento completo":`${percent(row.meta_difference_pct)} do Meta`}</span></div>
          <div><small>FONTE DO RELATÓRIO</small><b className="fr-source-name">{text(row.source_summary)}</b><span>gerado {new Date(String(row.generated_at)).toLocaleString("pt-BR")}</span></div>
        </div>

        <div className="fr-metrics"><h3>Percentuais e contexto</h3><div>{rateOrder.map((key)=>{const item=contexts[key];if(!item)return null;return <article key={key}><span>{text(item.label)}</span><b>{percent(item.value)}</b><small>{text(item.context)}</small></article>;})}</div><p className="fr-bottleneck">{text(row.context?.bottleneck)}</p></div>

        {!!reporters.length && <div className="fr-reporters"><h3>Por corretor</h3><div className="fr-table"><table><thead><tr><th>Corretor</th><th>Leads</th><th>Tentativas</th><th>Atendidos</th><th>Conversas</th><th>Visitas ag.</th><th>Visitas real.</th><th>Propostas</th></tr></thead><tbody>{reporters.map((rep:any)=><tr key={String(rep.reporter)}><td><b>{text(rep.reporter)}</b></td><td>{formatNumber(rep.leads_received||0,0)}</td><td>{formatNumber(rep.calls_made||0,0)} <small>{percent(rep.attempt_rate)}</small></td><td>{formatNumber(rep.calls_answered||0,0)} <small>{percent(rep.answer_attempt_rate)}</small></td><td>{formatNumber(rep.conversations||0,0)}</td><td>{formatNumber(rep.visits_scheduled||0,0)}</td><td>{formatNumber(rep.visits_completed||0,0)}</td><td>{formatNumber(rep.proposals||0,0)}</td></tr>)}</tbody></table></div></div>}

        <div className="fr-message"><div><h3>Mensagem pronta para o grupo comercial</h3><p>O aviso interno acima não entra no texto copiado. Se houver divergência ou Meta incompleto, valide primeiro com o GT.</p></div><pre>{text(row.client_message)}</pre><button onClick={()=>copy(row)}>{copied===String(row.id)?"✓ Copiado":"Copiar mensagem para o grupo"}</button></div>
      </article>;
    })}</section>
  </main>;
}

const styles=`
:root{color-scheme:dark}.fr-shell{min-height:100vh;background:#07100f;color:#eef7f3;padding:26px 28px 70px;font-family:Inter,system-ui,sans-serif}.fr-loading{min-height:100vh;display:grid;place-items:center;background:#07100f;color:#dcebe5}.fr-top{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:18px;max-width:1440px;margin:0 auto 28px}.fr-back,.fr-filters button,.fr-message button{border:1px solid rgba(122,214,166,.22);background:#0d1d1a;color:#e9f7f0;border-radius:10px;padding:10px 13px;cursor:pointer}.fr-brand{display:flex;align-items:center;gap:10px}.fr-brand>span{width:34px;height:34px;display:grid;place-items:center}.fr-brand small,.fr-user small{display:block;color:#78978a;font-size:10px;text-transform:uppercase;letter-spacing:.1em}.fr-brand b{font-size:13px}.fr-user{text-align:right}.fr-hero{max-width:1440px;margin:0 auto 18px;display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:20px;padding:28px;border:1px solid rgba(126,208,166,.14);border-radius:18px;background:linear-gradient(135deg,rgba(26,71,58,.31),rgba(9,22,19,.86))}.fr-kicker{font-size:10px;letter-spacing:.12em;color:#68c895;font-weight:800}.fr-hero h1{font-family:'Inter Tight',Inter,sans-serif;font-size:38px;line-height:1.02;margin:8px 0 10px;max-width:820px}.fr-hero h1 em{font-style:normal;color:#78d9a8}.fr-hero p{color:#9ab5aa;max-width:840px;line-height:1.55;margin:0}.fr-release{border:1px solid rgba(255,255,255,.09);border-radius:14px;padding:17px;display:flex;flex-direction:column;justify-content:center}.fr-release.open{background:rgba(39,153,99,.12)}.fr-release.closed{background:rgba(132,149,142,.06)}.fr-release small{color:#79a891;font-weight:800;font-size:9px;letter-spacing:.1em}.fr-release b{font-size:27px;margin:6px 0}.fr-release span{font-size:11px;color:#90a99f}.fr-rules{max-width:1440px;margin:0 auto 18px;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.fr-rules article{border:1px solid rgba(255,255,255,.07);background:#0b1715;border-radius:12px;padding:14px;display:flex;gap:12px}.fr-rules article>b{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;background:#123327;color:#75d6a4}.fr-rules strong{display:block;font-size:12px}.fr-rules span{font-size:11px;color:#8da79c;line-height:1.45}.fr-filters{max-width:1440px;margin:0 auto 18px;display:grid;grid-template-columns:230px 260px 1fr auto;gap:9px}.fr-filters select,.fr-filters input{border:1px solid rgba(255,255,255,.08);background:#0c1816;color:#e8f4ef;border-radius:10px;padding:11px 12px}.fr-error,.fr-empty{max-width:1440px;margin:0 auto 18px;padding:14px;border-radius:10px}.fr-error{background:rgba(214,65,65,.12);border:1px solid rgba(214,65,65,.25);color:#ffc0c0}.fr-empty{background:#0b1715;color:#8fa69d;border:1px solid rgba(255,255,255,.07)}.fr-grid{max-width:1440px;margin:0 auto;display:grid;gap:16px}.fr-card{border:1px solid rgba(255,255,255,.08);background:#0a1513;border-radius:16px;padding:20px;box-shadow:0 16px 42px rgba(0,0,0,.16)}.fr-card-head{display:flex;justify-content:space-between;gap:18px}.fr-card-head h2{font-size:23px;margin:5px 0 3px}.fr-card-head p{margin:0;color:#7e9a8f;font-size:11px}.fr-badges{display:flex;gap:7px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end}.fr-badges span{font-size:10px;font-weight:800;border-radius:999px;padding:6px 9px}.fr-badges .ok{background:rgba(56,176,111,.12);color:#79dfaa;border:1px solid rgba(56,176,111,.25)}.fr-badges .warn{background:rgba(226,164,58,.12);color:#f2bf65;border:1px solid rgba(226,164,58,.25)}.fr-badges .bad{background:rgba(224,76,76,.12);color:#ff9494;border:1px solid rgba(224,76,76,.24)}.fr-warning{margin-top:16px;border-radius:11px;padding:13px 14px;display:grid;gap:4px}.fr-warning.ok{background:rgba(46,145,91,.10);border:1px solid rgba(68,181,119,.2)}.fr-warning.warn{background:rgba(203,137,41,.09);border:1px solid rgba(230,165,68,.22)}.fr-warning b{font-size:12px}.fr-warning span{font-size:11px;color:#b1c4bc;line-height:1.5}.fr-warning small{font-size:10px;color:#f0c274}.fr-source-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:13px}.fr-source-grid>div{background:#0e1b18;border:1px solid rgba(255,255,255,.06);border-radius:11px;padding:13px}.fr-source-grid small{display:block;color:#688478;font-size:9px;font-weight:800;letter-spacing:.08em}.fr-source-grid b{display:block;font-size:24px;margin:5px 0}.fr-source-grid b.fr-source-name{font-size:12px;line-height:1.3}.fr-source-grid span{font-size:10px;color:#78958a}.fr-metrics,.fr-reporters,.fr-message{margin-top:16px;border-top:1px solid rgba(255,255,255,.07);padding-top:16px}.fr-metrics h3,.fr-reporters h3,.fr-message h3{margin:0 0 10px;font-size:13px}.fr-metrics>div{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.fr-metrics article{background:#0d1917;border-radius:9px;padding:11px}.fr-metrics article span{font-size:10px;color:#8aa399}.fr-metrics article b{display:block;font-size:18px;margin:4px 0}.fr-metrics article small{color:#759085;font-size:9px;line-height:1.35}.fr-bottleneck{font-size:11px;color:#e7b867;margin:10px 0 0}.fr-table{overflow:auto}.fr-table table{width:100%;border-collapse:collapse;min-width:780px}.fr-table th,.fr-table td{padding:9px 8px;border-bottom:1px solid rgba(255,255,255,.06);text-align:left;font-size:10px}.fr-table th{color:#6f8b80;text-transform:uppercase;font-size:8px;letter-spacing:.08em}.fr-table td small{display:block;color:#6f9182}.fr-message>div{display:flex;justify-content:space-between;gap:12px}.fr-message>div p{font-size:10px;color:#819b91;margin:0}.fr-message pre{white-space:pre-wrap;background:#07110f;border:1px solid rgba(255,255,255,.07);padding:15px;border-radius:10px;color:#dcece5;font:11px/1.55 Inter,system-ui,sans-serif;max-height:430px;overflow:auto}.fr-message button{background:#143a2d;border-color:rgba(92,208,148,.35);font-weight:800;color:#8ae1b3}@media(max-width:900px){.fr-shell{padding:18px 12px 100px}.fr-top{grid-template-columns:1fr auto}.fr-user{display:none}.fr-hero{grid-template-columns:1fr;padding:20px}.fr-hero h1{font-size:30px}.fr-rules{grid-template-columns:1fr}.fr-filters{grid-template-columns:1fr 1fr}.fr-filters input{grid-column:1/-1}.fr-source-grid{grid-template-columns:1fr 1fr}.fr-metrics>div{grid-template-columns:1fr 1fr}}@media(max-width:560px){.fr-brand small{display:none}.fr-brand b{font-size:11px}.fr-filters{grid-template-columns:1fr}.fr-filters input{grid-column:auto}.fr-card-head{flex-direction:column}.fr-badges{justify-content:flex-start}.fr-source-grid,.fr-metrics>div{grid-template-columns:1fr}.fr-message>div{display:block}.fr-message>div p{margin-bottom:8px}}
`;
