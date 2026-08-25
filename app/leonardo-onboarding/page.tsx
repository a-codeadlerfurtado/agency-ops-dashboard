"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "../shared";

type Row = Record<string, any>;
const API = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-overview-api`;
const WRITE_API = `${SUPABASE_URL}/functions/v1/agency-ops-leonardo-onboarding-write-api`;
const DONE = new Set(["DONE", "SKIPPED", "COMPLETED"]);
const LANES = [
  ["INTRO", "1ª apresentação"],
  ["PRODUCT", "Produto + Persona"],
  ["INPUTS", "Insumos e materiais"],
  ["INTEGRATION", "Integração com GT"],
  ["CREATIVE", "Produção e aprovação"],
  ["LAUNCH", "Pronto para campanha"],
  ["BLOCKED", "Bloqueados / atenção"],
] as const;
const STATUS_LABEL: Record<string,string> = { PENDING:"Pendente",SCHEDULED:"Agendada",IN_PROGRESS:"Em andamento",DONE:"Concluída",SKIPPED:"Superada",BLOCKED:"Bloqueada" };

function fmt(value: unknown) {
  if (!value) return "—";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { timeZone:"America/Sao_Paulo", dateStyle:"short", timeStyle:"short" }).format(date);
}
function stageOf(client: Row, code: string) { return (client.stages || []).find((stage: Row) => stage.stage_code === code) || null; }
function blocked(client: Row) { return String(client.onboarding_risk || "").toUpperCase() === "CRITICAL" || (client.stages || []).some((stage:Row)=>String(stage.status).toUpperCase()==="BLOCKED" || Boolean(stage.overdue)); }
function lane(client: Row) {
  if (blocked(client)) return "BLOCKED";
  const stage = String(client.current_stage || "");
  if (["SALES_CONFIRMED","OPERATIONAL_ACTIVATION","INTRO_MEETING"].includes(stage)) return "INTRO";
  if (["PRODUCT_PERSONA_MEETING","PRODUCT_FORM","PERSONA_FORM"].includes(stage)) return "PRODUCT";
  if (stage === "RAW_ASSETS") return "INPUTS";
  if (["INTEGRATION_MEETING","ACCESS_VALIDATION"].includes(stage)) return "INTEGRATION";
  if (["CREATIVE_PRODUCTION","CREATIVE_APPROVAL"].includes(stage)) return "CREATIVE";
  if (["READY_TO_LAUNCH","CAMPAIGN_LAUNCH","COMPLETED"].includes(stage)) return "LAUNCH";
  return "INTRO";
}
function tone(value: unknown) {
  const status = String(value || "").toUpperCase();
  if (["BLOCKED","CRITICAL"].includes(status)) return "bad";
  if (["HIGH","ATTENTION","SCHEDULED","IN_PROGRESS"].includes(status)) return "warn";
  if (["OK","DONE","SKIPPED","COMPLETED"].includes(status)) return "ok";
  return "muted";
}

export default function LeonardoOnboardingPage() {
  const [session,setSession] = useState<Session|null>(null);
  const [ready,setReady] = useState(false);
  const [data,setData] = useState<Row>({});
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState("");
  const [query,setQuery] = useState("");
  const [selected,setSelected] = useState<Row|null>(null);
  const [saving,setSaving] = useState(false);
  const [form,setForm] = useState<Row>({});

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true);if(!data.session)window.location.assign("/");});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>{setSession(next);if(!next)window.location.assign("/");});
    return()=>subscription.unsubscribe();
  },[]);

  const load = useCallback(async()=>{
    if(!session?.access_token)return;
    setLoading(true);setError("");
    try{
      const response=await authenticatedFetch(API,{cache:"no-store"});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body.detail||body.error||`API ${response.status}`);
      if(String(body?.profile?.person||"")!=="Leonardo Augusto")throw new Error("Área disponível apenas para a Direção Comercial.");
      setData(body);
    }catch(caught){setError(caught instanceof Error?caught.message:"Falha ao carregar onboarding.");}
    finally{setLoading(false);}
  },[session?.access_token]);
  useEffect(()=>{if(!session?.access_token)return;load();const timer=window.setInterval(load,30000);return()=>window.clearInterval(timer);},[session?.access_token,load]);

  const clients:Row[] = data.clients || [];
  const visible = useMemo(()=>clients.filter((client)=>!query.trim() || `${client.display_name} ${client.gt_owner||""} ${client.cs_owner||""} ${client.current_stage_label||""}`.toLowerCase().includes(query.trim().toLowerCase())),[clients,query]);
  const groups = useMemo(()=>LANES.map(([key,label])=>({key,label,items:visible.filter((client)=>lane(client)===key)})),[visible]);
  const definitions:Row[] = data.definitions || [];
  const summary=data.summary||{};

  function edit(client:Row){
    setSelected(client);
    setForm({ current_stage:client.current_stage||"", onboarding_risk:client.onboarding_risk||"OK", next_action:client.next_action||"", next_action_due:client.next_action_due?String(client.next_action_due).slice(0,16):"", stage_code:client.current_stage||"", stage_status:stageOf(client,String(client.current_stage||""))?.status||"PENDING", stage_due:stageOf(client,String(client.current_stage||""))?.due_at?String(stageOf(client,String(client.current_stage||""))?.due_at).slice(0,16):"" });
  }
  async function write(body:Row){
    const response=await authenticatedFetch(WRITE_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),cache:"no-store"});
    const json=await response.json().catch(()=>({}));
    if(!response.ok||!json?.ok)throw new Error(json?.detail||json?.error||`API ${response.status}`);
  }
  async function saveCase(){
    if(!selected||saving)return;setSaving(true);setError("");
    try{
      await write({action:"update_case",case_id:selected.case_id,current_stage:form.current_stage,onboarding_risk:form.onboarding_risk,next_action:form.next_action,next_action_due:form.next_action_due||null});
      await write({action:"update_stage",case_id:selected.case_id,stage_code:form.stage_code,status:form.stage_status,due_at:form.stage_due||null});
      setSelected(null);await load();
    }catch(caught){setError(caught instanceof Error?caught.message:"Falha ao salvar onboarding.");}
    finally{setSaving(false);}
  }

  if(!ready||!session)return <main className="lo-loading">Carregando…</main>;
  return <main className="lo-root"><style>{styles}</style>
    <header className="lo-top"><div><button onClick={()=>window.location.assign("/")}>← Central Comercial</button><span>DIREÇÃO COMERCIAL · ONBOARDING</span><h1>Panorama do onboarding</h1><p>Todos os clientes vendidos, distribuídos pela etapa atual. Leonardo pode atualizar o andamento sem abrir a operação geral.</p></div><div className="lo-actions"><small>{loading?"Sincronizando…":`Atualizado ${fmt(data.generated_at)}`}</small><button onClick={load} disabled={loading}>Atualizar</button></div></header>
    {error&&<div className="lo-error">{error}</div>}
    <section className="lo-kpis"><article><small>EM ONBOARDING</small><b>{Number(summary.clients||clients.length)}</b></article><article><small>REUNIÕES AGENDADAS</small><b>{Number(summary.meetings_scheduled||0)}</b></article><article><small>COM ATRASO</small><b>{Number(summary.overdue||0)}</b></article><article><small>BLOQUEIOS</small><b>{Number(summary.blocked||0)}</b></article></section>
    <section className="lo-toolbar"><div><b>Visão panorâmica</b><span>Cada card representa um cliente e a fase em que ele está agora.</span></div><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar cliente, GT, CS ou etapa"/></section>
    <section className="lo-board">{groups.map(group=><article className={`lo-lane ${group.key==="BLOCKED"?"danger":""}`} key={group.key}><header><div><h2>{group.label}</h2><small>{group.items.length} cliente(s)</small></div><b>{group.items.length}</b></header><div className="lo-cards">{group.items.map(client=>{
      const current=stageOf(client,String(client.current_stage||""));
      return <div className="lo-card" key={client.case_id}><div className="lo-card-top"><div><h3>{client.display_name}</h3><small>GT {client.gt_owner||"não definido"} · CS {client.cs_owner||"não definido"}</small></div><span className={tone(client.onboarding_risk)}>{client.onboarding_risk||"OK"}</span></div><div className="lo-stage"><small>ETAPA ATUAL</small><b>{client.current_stage_label||client.current_stage||"—"}</b><em className={tone(current?.status)}>{STATUS_LABEL[String(current?.status||"")]||current?.status||"Pendente"}</em></div><p>{client.next_action||"Acompanhar a próxima etapa do onboarding."}</p><footer><small>{client.next_action_due?`Prazo ${fmt(client.next_action_due)}`:"Sem prazo consolidado"}</small><button onClick={()=>edit(client)}>Gerenciar →</button></footer></div>;
    })}{!group.items.length&&<div className="lo-empty">Nenhum cliente nesta fase.</div>}</div></article>)}</section>
    {selected&&<div className="lo-modal-bg" onMouseDown={(e)=>{if(e.currentTarget===e.target&&!saving)setSelected(null)}}><section className="lo-modal"><header><div><span>GERENCIAR ONBOARDING</span><h2>{selected.display_name}</h2><p>As alterações ficam registradas com o usuário Leonardo Augusto.</p></div><button onClick={()=>setSelected(null)} disabled={saving}>×</button></header><div className="lo-form"><label>Etapa atual<select value={form.current_stage} onChange={e=>setForm(v=>({...v,current_stage:e.target.value,stage_code:e.target.value,stage_status:stageOf(selected,e.target.value)?.status||"PENDING",stage_due:stageOf(selected,e.target.value)?.due_at?String(stageOf(selected,e.target.value)?.due_at).slice(0,16):""}))}>{definitions.map(row=><option value={row.code} key={row.code}>{row.label}</option>)}</select></label><label>Risco<select value={form.onboarding_risk} onChange={e=>setForm(v=>({...v,onboarding_risk:e.target.value}))}><option>OK</option><option>ATTENTION</option><option>HIGH</option><option>CRITICAL</option></select></label><label>Status da etapa<select value={form.stage_status} onChange={e=>setForm(v=>({...v,stage_status:e.target.value}))}>{["PENDING","SCHEDULED","IN_PROGRESS","DONE","BLOCKED","SKIPPED"].map(value=><option value={value} key={value}>{STATUS_LABEL[value]||value}</option>)}</select></label><label>Prazo da etapa<input type="datetime-local" value={form.stage_due||""} onChange={e=>setForm(v=>({...v,stage_due:e.target.value}))}/></label><label className="wide">Próxima ação<textarea value={form.next_action||""} onChange={e=>setForm(v=>({...v,next_action:e.target.value}))}/></label><label>Prazo da próxima ação<input type="datetime-local" value={form.next_action_due||""} onChange={e=>setForm(v=>({...v,next_action_due:e.target.value}))}/></label></div><footer><button onClick={()=>setSelected(null)} disabled={saving}>Cancelar</button><button className="save" onClick={saveCase} disabled={saving}>{saving?"Salvando…":"Salvar alterações"}</button></footer></section></div>}
  </main>;
}

const styles=`
.lo-root{min-height:100vh;background:#071015;color:#e8f2ef;font-family:Inter,system-ui,sans-serif;padding-bottom:40px}.lo-loading{min-height:100vh;display:grid;place-items:center;background:#071015;color:#c7d7d2}.lo-top{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:22px 26px;border-bottom:1px solid #203237;background:#081317;position:sticky;top:0;z-index:10}.lo-top>div:first-child>button,.lo-actions button{border:1px solid #2a4940;background:#10231f;color:#cce8df;border-radius:9px;padding:8px 10px;cursor:pointer}.lo-top span{display:block;margin-top:12px;color:#62cca0;font-size:9px;font-weight:900;letter-spacing:.13em}.lo-top h1{margin:4px 0;font:800 28px 'Inter Tight',Inter}.lo-top p{margin:0;color:#76918a;font-size:11px}.lo-actions{display:flex;gap:9px;align-items:center}.lo-actions small{color:#718983}.lo-error{margin:14px 26px;border:1px solid #713f3b;background:#2a1514;color:#f0a097;border-radius:10px;padding:10px 12px}.lo-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:20px 26px 10px}.lo-kpis article{border:1px solid #203338;background:#0b171b;border-radius:13px;padding:15px}.lo-kpis small{color:#708883;font-size:8px;font-weight:850;letter-spacing:.09em}.lo-kpis b{display:block;font-size:25px;margin-top:7px}.lo-toolbar{margin:0 26px 14px;border:1px solid #203338;background:#0b171b;border-radius:13px;padding:13px 15px;display:flex;justify-content:space-between;gap:15px;align-items:center}.lo-toolbar div{display:flex;flex-direction:column}.lo-toolbar b{font-size:12px}.lo-toolbar span{font-size:9px;color:#6f8781;margin-top:3px}.lo-toolbar input,.lo-form input,.lo-form select,.lo-form textarea{border:1px solid #2a4145;background:#071115;color:#dce9e5;border-radius:9px;padding:9px 10px;font:600 10px Inter}.lo-toolbar input{min-width:300px}.lo-board{display:grid;grid-template-columns:repeat(7,minmax(245px,1fr));gap:10px;overflow:auto;padding:0 26px}.lo-lane{border:1px solid #1e3235;background:#091519;border-radius:13px;min-height:420px}.lo-lane.danger{border-color:#5e3a37}.lo-lane>header{padding:12px 13px;border-bottom:1px solid #1a2b2e;display:flex;justify-content:space-between;align-items:center}.lo-lane h2{font-size:11px;margin:0}.lo-lane header small{font-size:8px;color:#68817b}.lo-lane header>b{font-size:10px;background:#10231f;border:1px solid #25443c;border-radius:999px;padding:4px 7px}.lo-cards{display:grid;gap:8px;padding:9px}.lo-card{border:1px solid #1d3033;background:#0b191c;border-radius:11px;padding:11px}.lo-card-top{display:flex;justify-content:space-between;gap:8px}.lo-card h3{font-size:11px;margin:0}.lo-card small{font-size:8px;color:#6d8580}.lo-card-top span,.lo-stage em{font-style:normal;font-size:7.5px;border:1px solid #314843;border-radius:999px;padding:3px 5px;height:max-content}.lo-card-top span.ok,.lo-stage em.ok{color:#80d9ad;border-color:#31624d}.lo-card-top span.warn,.lo-stage em.warn{color:#e7c06d;border-color:#65522d}.lo-card-top span.bad,.lo-stage em.bad{color:#ed9187;border-color:#6d3e3a}.lo-stage{margin-top:10px;border-top:1px solid #182a2d;padding-top:8px;display:grid;gap:3px}.lo-stage b{font-size:9.5px}.lo-stage em{width:max-content}.lo-card p{font-size:9px;color:#849b95;line-height:1.45;min-height:38px}.lo-card footer{display:flex;justify-content:space-between;gap:8px;align-items:center}.lo-card footer button{border:0;background:transparent;color:#69cba4;font:800 9px Inter;cursor:pointer}.lo-empty{padding:20px 8px;text-align:center;color:#5f7872;font-size:9px}.lo-modal-bg{position:fixed;inset:0;z-index:10000;background:#020709cc;display:grid;place-items:center;padding:20px;backdrop-filter:blur(7px)}.lo-modal{width:min(780px,96vw);background:#0a1519;border:1px solid #29413f;border-radius:15px;box-shadow:0 30px 90px #0008}.lo-modal>header{display:flex;justify-content:space-between;padding:18px;border-bottom:1px solid #1c2e32}.lo-modal header span{font-size:8px;color:#62cca0;font-weight:900;letter-spacing:.12em}.lo-modal h2{margin:4px 0;font-size:21px}.lo-modal header p{margin:0;color:#718983;font-size:9px}.lo-modal header button{width:34px;height:34px;border:1px solid #2a4145;background:#0d1d20;color:#ccd9d5;border-radius:9px}.lo-form{display:grid;grid-template-columns:1fr 1fr;gap:11px;padding:18px}.lo-form label{display:grid;gap:5px;color:#819792;font-size:9px}.lo-form .wide{grid-column:1/-1}.lo-form textarea{min-height:90px;resize:vertical}.lo-modal>footer{display:flex;justify-content:flex-end;gap:8px;padding:0 18px 18px}.lo-modal>footer button{border:1px solid #2b4540;background:#10231f;color:#c9ded8;border-radius:9px;padding:9px 12px;font-weight:800;cursor:pointer}.lo-modal>footer button.save{background:#164b37;border-color:#2a7a57;color:#bdf0d6}@media(max-width:900px){.lo-kpis{grid-template-columns:repeat(2,1fr)}.lo-top{align-items:flex-start;flex-direction:column}.lo-toolbar{align-items:stretch;flex-direction:column}.lo-toolbar input{min-width:0}.lo-form{grid-template-columns:1fr}.lo-form .wide{grid-column:auto}}
`;
