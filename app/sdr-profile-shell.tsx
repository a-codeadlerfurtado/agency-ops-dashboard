"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, loadProfileLite, supabase } from "./shared";

type Row = Record<string, any>;
type View = "calls" | "meetings";
const API = SUPABASE_URL + "/functions/v1/agency-ops-sdr-api";
const views: Array<[View,string]> = [["calls","Minhas ligações"],["meetings","Minhas reuniões"]];
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();
const text=(v:unknown,fallback="—")=>String(v??"").trim()||fallback;
const dateTime=(v:unknown)=>{
  if(!v)return "—";
  const d=new Date(String(v));
  return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo",dateStyle:"short",timeStyle:"short"}).format(d);
};
const duration=(seconds:unknown)=>{
  const n=Math.max(0,Number(seconds||0));
  if(!n)return "—";
  const m=Math.floor(n/60),s=Math.floor(n%60);
  return m?(m+"m "+s+"s"):(s+"s");
};
function Empty({children}:{children:React.ReactNode}) {
  return <div className="sdr-empty">{children}</div>;
}

function CallsView({data}:{data:Row}) {
  const [query,setQuery]=useState("");
  const calls:Row[]=data.calls||[];
  const visible=useMemo(()=>calls.filter(row=>{
    const q=norm(query);
    return !q||norm(String(row.prospect_name||"")+" "+String(row.remote_name||"")+" "+String(row.remote_phone||"")+" "+String(row.notes||"")).includes(q);
  }),[calls,query]);
  return <section className="sdr-card">
    <header className="sdr-section-head"><div><span>RELATO AI · SDR</span><h2>Minhas ligações</h2>
      <p>Somente calls registradas por você.</p></div><b>{visible.length}</b></header>
    <div className="sdr-filter"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar prospect, telefone ou anotação"/></div>
    <div className="sdr-list">{visible.map(row=><article className="sdr-item" key={row.id}>
      <div className="sdr-item-top"><div><span>{text(row.channel,"Ligação")}</span><h3>{text(row.prospect_name||row.remote_name,"Contato")}</h3></div>
      <time>{dateTime(row.created_at)}</time></div>
      <p>{text(row.transcript_summary||row.notes,"Sem resumo disponível ainda.")}</p>
      <footer><span>{text(row.remote_phone)}</span>{row.stage&&<b>Etapa: {text(row.stage)}</b>}
      {row.next_step&&<b>Próximo passo: {row.next_step}{row.next_step_at?(" · "+dateTime(row.next_step_at)):""}</b>}</footer>
    </article>)}</div>{!visible.length&&<Empty>Nenhuma ligação encontrada.</Empty>}
  </section>;
}
function MeetingsView({data}:{data:Row}) {
  const [query,setQuery]=useState("");
  const meetings:Row[]=data.meetings||[];
  const visible=useMemo(()=>meetings.filter(row=>{
    const q=norm(query);
    return !q||norm(String(row.title||"")+" "+(row.participants||[]).join(" ")+" "+String(row.summary||"")).includes(q);
  }),[meetings,query]);
  return <section className="sdr-card">
    <header className="sdr-section-head"><div><span>RELATO AI · SDR</span><h2>Minhas reuniões</h2>
      <p>Reuniões gravadas e transcritas no seu perfil.</p></div><b>{visible.length}</b></header>
    <div className="sdr-filter"><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar reunião ou participante"/></div>
    <div className="sdr-list">{visible.map(row=><article className="sdr-item" key={row.id}>
      <div className="sdr-item-top"><div><span>REUNIÃO</span><h3>{text(row.title)}</h3></div>
      <time>{dateTime(row.started_at)}</time></div>
      <p>{text(row.summary,"Sem resumo disponível ainda.")}</p>
      <footer><span>{duration(row.duration_seconds)}</span><span>{(row.participants||[]).join(" · ")||"Participantes não informados"}</span></footer>
      {Array.isArray(row.commitments)&&row.commitments.length>0&&<div className="sdr-note"><b>Compromissos</b>{row.commitments.slice(0,5).map((x:any,i:number)=><span key={i}>{text(typeof x==="string"?x:x?.text||x?.title)}</span>)}</div>}
    </article>)}</div>{!visible.length&&<Empty>Nenhuma reunião encontrada.</Empty>}
  </section>;
}
export default function SdrProfileShell() {
  const [session,setSession]=useState<Session|null>(null);
  const [role,setRole]=useState("");
  const [person,setPerson]=useState("");
  const [view,setView]=useState<View>("calls");
  const [data,setData]=useState<Row>({});
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>setSession(data.session));
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));
    return ()=>subscription.unsubscribe();
  },[]);
  useEffect(()=>{
    if(!session?.access_token){setRole("");setPerson("");return;}
    let active=true;
    loadProfileLite().then(body=>{
      if(active){setRole(String(body?.profile?.role||"").toUpperCase());setPerson(String(body?.profile?.person||""));}
    }).catch(()=>{if(active){setRole("");setPerson("");}});
    return ()=>{active=false;};
  },[session?.access_token]);

  const load=useCallback(async()=>{
    if(!session?.access_token||role!=="SDR")return;
    setLoading(true);setError("");
    try{
      const response=await authenticatedFetch(API,{cache:"no-store"});
      const body=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(body?.detail||body?.error||("API "+response.status));
      setData(body||{});
    }catch(error){
      setError(error instanceof Error?error.message:"Não foi possível carregar seu Relato.");
    }finally{setLoading(false);}
  },[session?.access_token,role]);
  useEffect(()=>{
    if(role!=="SDR")return;
    load();
    const timer=window.setInterval(load,60_000);
    return()=>window.clearInterval(timer);
  },[role,load]);

  if(role!=="SDR"||!session)return null;
  const displayName=data.profile?.person||person||"Gustavo Lima";
  return <div className="sdr-root"><style>{styles}</style>
    <aside className="sdr-sidebar"><div className="sdr-brand"><BrandMark/><div><b>Leonardo Imobi</b><span>Relato AI · SDR</span></div></div>
      <nav>{views.map(([key,label])=><button key={key} className={view===key?"active":""} onClick={()=>setView(key)}>{label}</button>)}</nav>
      <div className="sdr-profile"><span>Perfil</span><b>{displayName}</b><small>SDR · atividade própria</small></div>
    </aside>
    <main className="sdr-main"><header className="sdr-top"><div><span>ORGANIZAÇÃO COMERCIAL</span><h1>{views.find(([k])=>k===view)?.[1]}</h1>
      <p>Você vê somente suas próprias ligações e reuniões.</p></div>
      <div className="sdr-actions"><span>{loading?"Atualizando…":error?"Falha na atualização":("Atualizado "+dateTime(data.generated_at))}</span>
      <button onClick={load} disabled={loading}>Atualizar</button><button className="ghost" onClick={()=>supabase.auth.signOut({scope:"local"})}>Sair</button></div></header>
      {error&&<div className="sdr-error">{error}</div>}
      <section className="sdr-content">
        <div className="sdr-kpis"><article><span>Ligações</span><b>{Number(data.summary?.calls||0)}</b></article>
        <article><span>Reuniões</span><b>{Number(data.summary?.meetings||0)}</b></article></div>
        {view==="calls"?<CallsView data={data}/>:<MeetingsView data={data}/>}
      </section>
    </main>
  </div>;
}
const styles = [
".sdr-root{position:fixed;inset:0;z-index:9000;display:grid;grid-template-columns:220px minmax(0,1fr);background:#071015;color:#eaf2ef;font-family:Inter,system-ui,sans-serif}",
".sdr-sidebar{display:flex;flex-direction:column;border-right:1px solid #203137;background:#091417;padding:18px 12px}.sdr-brand{display:flex;align-items:center;gap:10px;padding:8px 8px 22px}.sdr-brand svg{width:30px;color:#f47b43}.sdr-brand div{display:flex;flex-direction:column}.sdr-brand b{font-size:13px}.sdr-brand span,.sdr-profile span{font-size:8px;color:#78908c;text-transform:uppercase;letter-spacing:.12em;margin-top:3px}",
".sdr-sidebar nav{display:grid;gap:5px}.sdr-sidebar nav button{border:1px solid transparent;background:transparent;color:#8ca39e;text-align:left;border-radius:9px;padding:11px 12px;font:700 11px Inter;cursor:pointer}.sdr-sidebar nav button.active{background:#142b25;border-color:#285043;color:#bdf4d8}.sdr-profile{margin-top:auto;border-top:1px solid #1b2c31;padding:15px 9px 4px;display:flex;flex-direction:column}.sdr-profile b{font-size:11px;margin-top:5px}.sdr-profile small{font-size:9px;color:#708783;margin-top:3px}",
".sdr-main{height:100vh;overflow:auto}.sdr-top{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:20px 26px;border-bottom:1px solid #203137;background:rgba(7,16,21,.96)}.sdr-top span,.sdr-section-head span{font-size:9px;color:#62cca0;font-weight:800;letter-spacing:.12em}.sdr-top h1{margin:4px 0;font-size:26px}.sdr-top p,.sdr-section-head p{margin:0;color:#78918c;font-size:11px}",
".sdr-actions{display:flex;gap:8px;align-items:center}.sdr-actions>span{color:#708783;font-size:9px;letter-spacing:0}.sdr-actions button{border:1px solid #2b4941;background:#10231f;color:#d9f5e9;border-radius:9px;padding:9px 11px;font:700 10px Inter;cursor:pointer}.sdr-actions .ghost{background:transparent}",
".sdr-content{padding:22px 26px 60px;max-width:1250px;margin:auto}.sdr-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,220px));gap:9px;margin-bottom:12px}.sdr-kpis article,.sdr-card{border:1px solid #203338;background:#0b171b;border-radius:14px}.sdr-kpis article{padding:14px}.sdr-kpis span{display:block;font-size:8px;color:#738b86;text-transform:uppercase}.sdr-kpis b{display:block;font-size:24px;margin-top:6px}.sdr-card{padding:17px}.sdr-section-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}.sdr-section-head h2{margin:4px 0;font-size:22px}.sdr-section-head>b{font-size:11px;color:#a8c7be}.sdr-filter{margin:14px 0}.sdr-filter input{width:min(430px,100%);border:1px solid #263a3f;background:#081317;color:#cfe0dc;border-radius:9px;padding:10px;font:600 10px Inter}",
".sdr-list{display:grid;gap:9px}.sdr-item{border:1px solid #1d3135;background:#091519;border-radius:12px;padding:14px}.sdr-item-top{display:flex;justify-content:space-between;gap:12px}.sdr-item-top span{font-size:8px;color:#62cca0;font-weight:800}.sdr-item h3{font-size:13px;margin:4px 0}.sdr-item time{font-size:9px;color:#6f8882}.sdr-item p{font-size:10px;color:#8ca49e;line-height:1.55}.sdr-item footer{display:flex;flex-wrap:wrap;gap:8px;border-top:1px solid #182b2e;padding-top:9px}.sdr-item footer>*{font-size:9px;color:#76908a}.sdr-note{display:grid;gap:4px;margin-top:10px;border-top:1px solid #182b2e;padding-top:9px}.sdr-note b{font-size:9px}.sdr-note span{font-size:9px;color:#8ca49e}.sdr-empty{padding:24px;text-align:center;color:#657f79;font-size:10px}.sdr-error{margin:14px 26px 0;border:1px solid #663b37;background:#2a1514;color:#ef9b90;border-radius:10px;padding:10px 12px;font-size:10px}",
"@media(max-width:760px){.sdr-root{display:block;overflow:auto}.sdr-sidebar{height:auto;position:sticky;top:0;z-index:8}.sdr-brand,.sdr-profile{display:none}.sdr-sidebar nav{display:flex}.sdr-sidebar nav button{white-space:nowrap}.sdr-main{height:auto}.sdr-top{position:relative;align-items:flex-start;flex-direction:column;padding:16px}.sdr-content{padding:14px 12px 70px}.sdr-kpis{grid-template-columns:1fr 1fr}.sdr-actions{flex-wrap:wrap}}"
].join("");
