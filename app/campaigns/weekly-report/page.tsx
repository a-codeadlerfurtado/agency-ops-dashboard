"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, formatDay, supabase } from "../../shared";

const REPORT_API = `${SUPABASE_URL}/functions/v1/agency-ops-weekly-traffic-report-api`;
const EDIT_API = `${SUPABASE_URL}/functions/v1/agency-ops-weekly-traffic-report-edit-api`;

type Row = Record<string, any>;
type Payload = {
  profile?: Row;
  week?: { start: string; end: string };
  reports?: Row[];
  weeks?: string[];
  generated_at?: string;
};
type StatusFilter = "ALL" | "READY" | "REVIEWED" | "SENT" | "ALERT";

function money(value: unknown) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));
}
function number(value: unknown, digits = 0) {
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: digits }).format(Number(value || 0));
}
function statusLabel(status: unknown) {
  return ({ READY:"Pronto para revisar", REVIEWED:"Revisado", SENT:"Enviado" } as Record<string,string>)[String(status)] || String(status || "—");
}
function dataLabel(status: unknown) {
  return ({ READY:"Meta conferido", NO_META_ACCOUNT:"Sem conta Meta", NO_ACTIVITY:"Sem entrega na semana", PARTIAL:"Meta parcial", ERROR:"Falha na consulta Meta" } as Record<string,string>)[String(status)] || String(status || "—");
}
function dataTone(status: unknown) {
  return String(status) === "READY" ? "ok" : String(status) === "NO_ACTIVITY" ? "muted" : "warn";
}
function reviewTone(status: unknown) {
  return String(status) === "SENT" ? "sent" : String(status) === "REVIEWED" ? "reviewed" : "ready";
}
function dateTime(value: unknown) {
  return value ? new Intl.DateTimeFormat("pt-BR", { dateStyle:"short", timeStyle:"short", timeZone:"America/Sao_Paulo" }).format(new Date(String(value))) : "—";
}

export default function WeeklyTrafficReportsPage() {
  const [session,setSession] = useState<Session|null>(null);
  const [ready,setReady] = useState(false);
  const [payload,setPayload] = useState<Payload>({});
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [week,setWeek] = useState("");
  const [gt,setGt] = useState("ALL");
  const [status,setStatus] = useState<StatusFilter>("ALL");
  const [query,setQuery] = useState("");
  const [openId,setOpenId] = useState<string|null>(null);
  const [drafts,setDrafts] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState<Record<string,string>>({});
  const [copied,setCopied] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({data}) => { setSession(data.session); setReady(true); if (!data.session) window.location.replace("/"); });
    const {data:{subscription}} = supabase.auth.onAuthStateChange((_event,next) => { setSession(next); if (!next) window.location.replace("/"); });
    return () => subscription.unsubscribe();
  },[]);

  const load = useCallback(async (requestedWeek?: string) => {
    if (!session?.access_token) return;
    setLoading(true); setError("");
    try {
      const url = new URL(REPORT_API);
      const target = requestedWeek || week;
      if (target) url.searchParams.set("week_end", target);
      const response = await authenticatedFetch(url.toString(), { cache:"no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || `API ${response.status}`);
      setPayload(body);
      const end = String(body.week?.end || target || "");
      if (end && end !== week) setWeek(end);
      const nextDrafts: Record<string,string> = {};
      for (const report of body.reports || []) nextDrafts[String(report.id)] = String(report.report_text || "");
      setDrafts(nextDrafts);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar os relatórios semanais.");
    } finally { setLoading(false); }
  },[session?.access_token,week]);

  useEffect(() => { if (ready && session?.access_token) load(); },[ready,session?.access_token]);

  const reports = payload.reports || [];
  const isManagement = String(payload.profile?.role || "") === "MGMT";
  const gtOptions = useMemo(() => [...new Set(reports.map((row) => String(row.gt_owner || "Sem GT")))].sort((a,b)=>a.localeCompare(b,"pt-BR")),[reports]);

  const filtered = useMemo(() => {
    const needle=query.trim().toLocaleLowerCase("pt-BR");
    return reports.filter((row) => {
      if (gt !== "ALL" && String(row.gt_owner || "Sem GT") !== gt) return false;
      if (status === "ALERT" && String(row.data_status) === "READY") return false;
      if (["READY","REVIEWED","SENT"].includes(status) && String(row.review_status) !== status) return false;
      if (needle && ![row.client_name,row.client_code,row.gt_owner,row.report_text].join(" ").toLocaleLowerCase("pt-BR").includes(needle)) return false;
      return true;
    }).sort((a,b) => {
      const rank:Record<string,number>={ READY:0, REVIEWED:1, SENT:2 };
      return (rank[String(a.review_status)]??9)-(rank[String(b.review_status)]??9) || String(a.client_name).localeCompare(String(b.client_name),"pt-BR");
    });
  },[reports,gt,status,query]);

  const totals = useMemo(() => ({
    all:reports.length,
    ready:reports.filter((row)=>row.review_status==="READY").length,
    reviewed:reports.filter((row)=>row.review_status==="REVIEWED").length,
    sent:reports.filter((row)=>row.review_status==="SENT").length,
    alerts:reports.filter((row)=>row.data_status!=="READY").length,
  }),[reports]);

  async function saveDraft(report: Row) {
    const id=String(report.id), text=String(drafts[id] ?? report.report_text ?? "");
    setBusy((current)=>({...current,[id]:"saving"})); setError("");
    try {
      const response=await authenticatedFetch(EDIT_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({report_id:id,report_text:text})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok) throw new Error(body.detail||body.error||`API ${response.status}`);
      setPayload((current)=>({...current,reports:(current.reports||[]).map((row)=>String(row.id)===id?body.report:row)}));
      setDrafts((current)=>({...current,[id]:String(body.report?.report_text||text)}));
      return true;
    } catch(caught){setError(caught instanceof Error?caught.message:"Falha ao salvar a revisão.");return false;}
    finally{setBusy((current)=>({...current,[id]:""}));}
  }

  async function copyReport(report: Row) {
    const id=String(report.id), text=String(drafts[id] ?? report.report_text ?? "");
    const changed=text!==String(report.report_text||"");
    if(changed){const saved=await saveDraft(report);if(!saved)return;}
    await navigator.clipboard.writeText(text);
    setCopied(id); window.setTimeout(()=>setCopied(""),1800);
  }

  async function markSent(report: Row) {
    const id=String(report.id), text=String(drafts[id] ?? report.report_text ?? "");
    if(text!==String(report.report_text||"")){const saved=await saveDraft(report);if(!saved)return;}
    setBusy((current)=>({...current,[id]:"sent"})); setError("");
    try{
      const response=await authenticatedFetch(REPORT_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"sent",report_id:id})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body.detail||body.error||`API ${response.status}`);
      setPayload((current)=>({...current,reports:(current.reports||[]).map((row)=>String(row.id)===id?body.report:row)}));
    }catch(caught){setError(caught instanceof Error?caught.message:"Falha ao marcar como enviado.");}
    finally{setBusy((current)=>({...current,[id]:""}));}
  }

  async function regenerate(report: Row) {
    const id=String(report.id);
    setBusy((current)=>({...current,[id]:"regen"})); setError("");
    try{
      const response=await authenticatedFetch(REPORT_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"regenerate",week_end:report.week_end,client_id:report.client_id})});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body.detail||body.error||`API ${response.status}`);
      await load(String(report.week_end));
    }catch(caught){setError(caught instanceof Error?caught.message:"Falha ao regerar o relatório.");}
    finally{setBusy((current)=>({...current,[id]:""}));}
  }

  if(!ready||!session)return <main className="wr-loading">Carregando…</main>;
  return <main className="wr-shell"><style>{styles}</style>
    <header className="wr-top">
      <div><span className="wr-kicker">SEGUNDA-FEIRA · META ADS → RELATÓRIO PRONTO</span><h1>Relatórios Semanais</h1><p>A semana anterior já chega consolidada por cliente e campanha. O GT revisa a análise, ajusta se precisar, copia e envia no grupo.</p></div>
      <div className="wr-top-actions"><span>{loading?"Atualizando…":`Base gerada · ${dateTime(payload.generated_at)}`}</span><button onClick={()=>load()} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button></div>
    </header>

    <section className="wr-routine">
      <article><b>1</b><span><strong>Segunda, 07h</strong>O sistema consulta automaticamente o Meta da segunda ao domingo anterior.</span></article>
      <article><b>2</b><span><strong>Texto já montado</strong>Campanha, leads/conversas, gasto, CPA, impressões, alcance e análise.</span></article>
      <article><b>3</b><span><strong>GT só confere</strong>Edita se necessário, copia e marca como enviado.</span></article>
    </section>

    <section className="wr-toolbar">
      <label>Semana<select value={week} onChange={(e)=>{const value=e.target.value;setWeek(value);setOpenId(null);load(value);}}>{(payload.weeks||[]).map((item)=><option value={item} key={item}>Até {formatDay(item)}</option>)}</select></label>
      {isManagement&&<label>GT<select value={gt} onChange={(e)=>setGt(e.target.value)}><option value="ALL">Todos os GTs</option>{gtOptions.map((item)=><option value={item} key={item}>{item}</option>)}</select></label>}
      <label>Status<select value={status} onChange={(e)=>setStatus(e.target.value as StatusFilter)}><option value="ALL">Todos</option><option value="READY">Pendentes de revisão</option><option value="REVIEWED">Revisados</option><option value="SENT">Enviados</option><option value="ALERT">Com alerta de dados</option></select></label>
      <label className="wr-search">Buscar<input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Cliente, código ou conteúdo"/></label>
    </section>

    <div className="wr-period">Período do relatório: <b>{formatDay(payload.week?.start)} → {formatDay(payload.week?.end)}</b> · {filtered.length} cliente(s) exibido(s)</div>
    {error&&<div className="wr-error">{error}</div>}

    <section className="wr-metrics">
      <button onClick={()=>setStatus("ALL")} className={status==="ALL"?"active":""}><small>TOTAL</small><b>{totals.all}</b><span>relatórios</span></button>
      <button onClick={()=>setStatus("READY")} className={status==="READY"?"active":""}><small>PARA REVISAR</small><b>{totals.ready}</b><span>pendentes</span></button>
      <button onClick={()=>setStatus("REVIEWED")} className={status==="REVIEWED"?"active":""}><small>REVISADOS</small><b>{totals.reviewed}</b><span>prontos para envio</span></button>
      <button onClick={()=>setStatus("SENT")} className={status==="SENT"?"active":""}><small>ENVIADOS</small><b>{totals.sent}</b><span>finalizados</span></button>
      <button onClick={()=>setStatus("ALERT")} className={`${status==="ALERT"?"active ":""}${totals.alerts?"warn":""}`}><small>ALERTAS</small><b>{totals.alerts}</b><span>verificar dados</span></button>
    </section>

    <section className="wr-list">
      {filtered.map((report)=>{
        const id=String(report.id), open=openId===id, summary=report.summary||{}, campaigns=Array.isArray(report.campaigns)?report.campaigns:[], text=String(drafts[id]??report.report_text??"");
        const changed=text!==String(report.report_text||"");
        return <article className={`wr-card ${open?"open":""}`} key={id}>
          <button className="wr-card-head" onClick={()=>setOpenId(open?null:id)}>
            <span className="wr-client"><b>{report.client_code?`${report.client_code} — `:""}{report.client_name}</b><small>{report.gt_owner||"Sem GT"} · {campaigns.length} campanha(s) com movimento</small></span>
            <span><small>RESULTADOS</small><b>{number(summary.results)}</b></span>
            <span><small>GASTO</small><b>{money(summary.spend)}</b></span>
            <span><small>CPA MÉDIO</small><b>{Number(summary.results)>0?money(Number(summary.spend||0)/Number(summary.results)):"—"}</b></span>
            <span className={`wr-data ${dataTone(report.data_status)}`}>{dataLabel(report.data_status)}</span>
            <span className={`wr-review ${reviewTone(report.review_status)}`}>{statusLabel(report.review_status)}</span>
            <i>{open?"−":"+"}</i>
          </button>
          {open&&<div className="wr-body">
            {report.data_status!=="READY"&&<div className="wr-warning"><b>Confira antes de enviar:</b><span>{report.data_status==="NO_META_ACCOUNT"?"este cliente não tem conta Meta vinculada no cadastro.":report.data_status==="NO_ACTIVITY"?"não houve entrega encontrada no período.":report.data_status==="PARTIAL"?"uma ou mais contas Meta falharam na consulta; os dados podem estar parciais.":"a consulta ao Meta apresentou erro."}</span></div>}

            <div className="wr-audit">
              <div><small>Resultados</small><b>{number(summary.results)}</b></div><div><small>Leads</small><b>{number(summary.leads)}</b></div><div><small>Gasto</small><b>{money(summary.spend)}</b></div><div><small>Impressões</small><b>{number(summary.impressions)}</b></div><div><small>Alcance*</small><b>{number(summary.reach_sum)}</b></div><div><small>Cliques</small><b>{number(summary.clicks)}</b></div>
            </div>
            <small className="wr-reach-note">* Alcance do resumo é a soma das campanhas; o mesmo usuário pode aparecer em mais de uma campanha. No texto, cada campanha usa o alcance nativo da Meta.</small>

            <div className="wr-editor-head"><div><h3>Mensagem pronta</h3><p>Edite qualquer frase antes de copiar. Alterações salvas ficam registradas como revisão do GT.</p></div>{changed&&<span>Alterações não salvas</span>}</div>
            <textarea value={text} onChange={(e)=>setDrafts((current)=>({...current,[id]:e.target.value}))} spellCheck={true}/>
            <div className="wr-actions">
              <button onClick={()=>saveDraft(report)} disabled={Boolean(busy[id])}>{busy[id]==="saving"?"Salvando…":"Salvar revisão"}</button>
              <button className="primary" onClick={()=>copyReport(report)} disabled={Boolean(busy[id])}>{copied===id?"✓ Copiado":"Copiar relatório"}</button>
              <button onClick={()=>regenerate(report)} disabled={Boolean(busy[id])}>{busy[id]==="regen"?"Consultando Meta…":"Regerar com Meta"}</button>
              <button className="sent" onClick={()=>markSent(report)} disabled={Boolean(busy[id])||report.review_status==="SENT"}>{report.review_status==="SENT"?"✓ Enviado":"Marcar como enviado"}</button>
            </div>
            {(report.reviewed_at||report.sent_at)&&<div className="wr-history">{report.reviewed_at&&<span>Revisado por <b>{report.reviewed_by}</b> em {dateTime(report.reviewed_at)}</span>}{report.sent_at&&<span>Enviado por <b>{report.sent_by}</b> em {dateTime(report.sent_at)}</span>}</div>}

            {!!campaigns.length&&<details className="wr-campaigns"><summary>Conferir dados brutos das campanhas ({campaigns.length})</summary><div className="wr-table"><table><thead><tr><th>Campanha</th><th>Resultados</th><th>Gasto</th><th>CPA</th><th>Impressões</th><th>Alcance</th><th>CTR</th></tr></thead><tbody>{campaigns.map((campaign:Row)=><tr key={String(campaign.campaign_id)}><td><b>{campaign.campaign_name}</b><small>{campaign.campaign_status||"—"}</small></td><td>{number(campaign.result_count)}</td><td>{money(campaign.spend)}</td><td>{Number(campaign.result_count)>0?money(Number(campaign.spend||0)/Number(campaign.result_count)):"—"}</td><td>{number(campaign.impressions)}</td><td>{number(campaign.reach)}</td><td>{number(campaign.ctr,2)}%</td></tr>)}</tbody></table></div></details>}
          </div>}
        </article>;
      })}
      {!loading&&!filtered.length&&<div className="wr-empty">Nenhum relatório encontrado neste filtro.</div>}
      {loading&&!reports.length&&<div className="wr-empty">Gerando e carregando os relatórios da semana…</div>}
    </section>
  </main>;
}

const styles=`
:root{color-scheme:dark}.wr-shell{min-height:100vh;background:#050d16;color:#eaf2fb;padding:26px 30px 70px;font-family:Inter,system-ui,sans-serif}.wr-loading{min-height:100vh;display:grid;place-items:center;background:#050d16;color:#9db4c8}.wr-top{display:flex;justify-content:space-between;gap:24px;align-items:flex-start}.wr-kicker{color:#f1874e;font-size:10px;font-weight:900;letter-spacing:.13em}.wr-top h1{font:800 clamp(32px,4vw,50px)/1 Inter Tight,Inter,sans-serif;margin:7px 0 9px}.wr-top p{color:#91a8bc;max-width:860px;line-height:1.5;margin:0}.wr-top-actions{display:flex;align-items:center;gap:10px}.wr-top-actions span{font-size:10px;color:#7893aa}.wr-top-actions button,.wr-actions button{border:1px solid #28506e;background:#0b1d2b;color:#dcecf8;border-radius:9px;padding:9px 12px;font-weight:800;cursor:pointer}.wr-top-actions button:hover,.wr-actions button:hover{background:#10293b}.wr-routine{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:22px 0 12px}.wr-routine article{display:flex;gap:11px;border:1px solid #18364d;background:#091725;border-radius:13px;padding:13px}.wr-routine article>b{width:27px;height:27px;display:grid;place-items:center;border-radius:8px;background:#25170f;color:#ff9b61}.wr-routine strong,.wr-routine span{display:block}.wr-routine strong{font-size:11px;color:#dfeef8;margin-bottom:3px}.wr-routine span{font-size:10px;color:#819caf;line-height:1.4}.wr-toolbar{display:flex;gap:9px;align-items:end;flex-wrap:wrap;border:1px solid #18364d;background:#091725;border-radius:14px;padding:11px}.wr-toolbar label{display:flex;flex-direction:column;gap:5px;color:#738ea6;font-size:9px;font-weight:900;text-transform:uppercase;letter-spacing:.07em}.wr-toolbar select,.wr-toolbar input{height:38px;border:1px solid #24455e;background:#07131f;color:#e8f3fb;border-radius:9px;padding:0 10px;outline:none;font:600 11px Inter,sans-serif}.wr-toolbar select:focus,.wr-toolbar input:focus{border-color:#66c9ff}.wr-search{flex:1;min-width:240px}.wr-period{margin:8px 2px 0;color:#6f8fa8;font-size:10px}.wr-period b{color:#9bb6cb}.wr-error{margin-top:10px;border:1px solid #753444;background:#25131a;color:#ffc9d3;padding:11px 13px;border-radius:10px}.wr-metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;margin:16px 0}.wr-metrics button{border:1px solid #19384f;background:#0a1928;color:#e9f4fc;border-radius:13px;padding:12px 13px;text-align:left;cursor:pointer}.wr-metrics button:hover,.wr-metrics button.active{border-color:#ba5a29;background:linear-gradient(135deg,rgba(242,107,33,.12),#0a1928)}.wr-metrics button.warn{border-left:3px solid #f0ba52}.wr-metrics small,.wr-metrics b,.wr-metrics span{display:block}.wr-metrics small{font-size:8px;color:#718da4;font-weight:900;letter-spacing:.09em}.wr-metrics b{font-size:25px;margin:3px 0}.wr-metrics span{font-size:9px;color:#829caf}.wr-list{border:1px solid #19384f;background:#06121e;border-radius:15px;overflow:hidden}.wr-card{border-top:1px solid #142c3e}.wr-card:first-child{border-top:0}.wr-card-head{width:100%;display:grid;grid-template-columns:minmax(280px,2fr) 90px 105px 105px minmax(135px,.9fr) minmax(125px,.8fr) 24px;gap:10px;align-items:center;border:0;background:#081724;color:#dcebf5;padding:12px 14px;text-align:left;cursor:pointer}.wr-card-head:hover{background:#0b1d2b}.wr-card.open .wr-card-head{background:linear-gradient(90deg,rgba(242,107,33,.07),rgba(72,184,255,.04))}.wr-client b,.wr-client small,.wr-card-head>span>small,.wr-card-head>span>b{display:block}.wr-client b{font-size:13px;color:#f0f8fd}.wr-client small{color:#6f8da4;font-size:9px;margin-top:3px}.wr-card-head>span>small{color:#68869e;font-size:8px;font-weight:900;letter-spacing:.07em}.wr-card-head>span>b{font-size:12px;margin-top:3px}.wr-card-head i{font-style:normal;color:#6e8ba3;font-size:18px}.wr-data,.wr-review{display:inline-flex!important;width:max-content;max-width:100%;padding:5px 8px;border-radius:999px;font-size:8px!important;font-weight:900}.wr-data.ok{background:#10362b;color:#79dbb4}.wr-data.warn{background:#3a2918;color:#f4c36b}.wr-data.muted{background:#172633;color:#91a5b5}.wr-review.ready{background:#172b3d;color:#95b4c9}.wr-review.reviewed{background:#2e2b18;color:#e4cc78}.wr-review.sent{background:#11352b;color:#75dab0}.wr-body{padding:14px 16px 18px;background:#050f19;border-top:1px solid #203c50}.wr-warning{display:flex;gap:8px;align-items:baseline;border:1px solid #5f4921;background:#1c170c;color:#e7ca85;border-radius:10px;padding:9px 11px;font-size:10px;margin-bottom:10px}.wr-warning b{color:#ffd875}.wr-audit{display:grid;grid-template-columns:repeat(6,1fr);gap:7px}.wr-audit div{border:1px solid #173148;background:#081724;border-radius:9px;padding:9px}.wr-audit small,.wr-audit b{display:block}.wr-audit small{font-size:8px;color:#6f8da5;text-transform:uppercase}.wr-audit b{font-size:14px;margin-top:3px}.wr-reach-note{display:block;color:#5f7a90;font-size:8px;margin:5px 1px 12px}.wr-editor-head{display:flex;justify-content:space-between;align-items:end;gap:12px}.wr-editor-head h3{margin:0;color:#edf7fd;font-size:13px}.wr-editor-head p{margin:3px 0 7px;color:#718da3;font-size:9px}.wr-editor-head>span{font-size:9px;color:#f3c068;margin-bottom:7px}.wr-body textarea{width:100%;min-height:380px;resize:vertical;box-sizing:border-box;border:1px solid #1d4059;background:#07131e;color:#e8f2f8;border-radius:11px;padding:14px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;outline:none}.wr-body textarea:focus{border-color:#62c5f8;box-shadow:0 0 0 2px rgba(98,197,248,.08)}.wr-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:9px}.wr-actions button.primary{border-color:#bc5a27;background:#2a1710;color:#ffd4be}.wr-actions button.sent{border-color:#27664d;background:#0d281f;color:#9ae5c1}.wr-actions button:disabled{opacity:.5;cursor:wait}.wr-history{display:flex;gap:12px;flex-wrap:wrap;color:#6f899e;font-size:9px;margin-top:8px}.wr-history b{color:#9cb4c7}.wr-campaigns{margin-top:13px;border:1px solid #173248;border-radius:10px;background:#07131f}.wr-campaigns summary{padding:10px 12px;cursor:pointer;color:#9cb4c8;font-size:10px;font-weight:800}.wr-table{overflow:auto;border-top:1px solid #173248}.wr-table table{width:100%;border-collapse:collapse;min-width:850px}.wr-table th,.wr-table td{padding:8px 10px;border-bottom:1px solid #10283a;text-align:right;font-size:9px}.wr-table th{color:#66859d;text-transform:uppercase;font-size:7px;background:#091827}.wr-table th:first-child,.wr-table td:first-child{text-align:left}.wr-table td:first-child b,.wr-table td:first-child small{display:block}.wr-table td:first-child b{color:#dceaf4}.wr-table td:first-child small{color:#617d91;margin-top:2px}.wr-empty{padding:34px;text-align:center;color:#718ca2;font-size:11px}@media(max-width:1100px){.wr-metrics{grid-template-columns:repeat(3,1fr)}.wr-card-head{grid-template-columns:minmax(230px,2fr) 75px 95px minmax(120px,1fr) minmax(110px,1fr) 20px}.wr-card-head>span:nth-child(4){display:none}.wr-audit{grid-template-columns:repeat(3,1fr)}}@media(max-width:760px){.wr-shell{padding:18px 12px 70px}.wr-top{flex-direction:column}.wr-routine{grid-template-columns:1fr}.wr-metrics{grid-template-columns:1fr 1fr}.wr-card-head{grid-template-columns:1fr 70px 20px}.wr-card-head>span:nth-child(3),.wr-card-head>span:nth-child(4),.wr-card-head>span:nth-child(5){display:none}.wr-review{grid-column:1/3}.wr-audit{grid-template-columns:1fr 1fr}.wr-body textarea{min-height:440px}.wr-top-actions{width:100%;justify-content:space-between}}
`;
