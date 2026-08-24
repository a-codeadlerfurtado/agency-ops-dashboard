"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, Chip, SUPABASE_URL, authenticatedFetch, formatNumber, healthScore, relativeDate, supabase, text } from "../shared";
import { PortfolioCenter } from "../views/portfolio";

type Row = Record<string, any>;
const API=`${SUPABASE_URL}/functions/v1/agency-ops-commercial-portfolio-api`;

export default function CommercialClientsPage(){
  const [session,setSession]=useState<Session|null>(null);
  const [ready,setReady]=useState(false);
  const [payload,setPayload]=useState<Row>({portfolio:null,clients:[]});
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [query,setQuery]=useState("");
  const [priority,setPriority]=useState("ALL");
  const [lifecycle,setLifecycle]=useState("ACTIVE");

  useEffect(()=>{supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true)});const {data:{subscription}}=supabase.auth.onAuthStateChange((_e,next)=>{setSession(next);setReady(true)});return()=>subscription.unsubscribe();},[]);
  useEffect(()=>{if(!ready)return;if(!session){window.location.assign("/");return;}let active=true;setLoading(true);setError("");authenticatedFetch(API,{cache:"no-store"}).then(async r=>{const b=await r.json().catch(()=>({}));if(!r.ok||!b?.ok)throw new Error(b.detail||b.error||`API ${r.status}`);if(active)setPayload(b);}).catch(e=>{if(active)setError(e instanceof Error?e.message:"Não foi possível carregar a carteira.");}).finally(()=>{if(active)setLoading(false)});return()=>{active=false};},[ready,session?.access_token]);

  const all:Row[]=payload.clients||[];
  const visible=useMemo(()=>{const q=query.trim().toLocaleLowerCase("pt-BR");return all.filter(c=>{
    const life=lifecycle==="ALL"|| (lifecycle==="ACTIVE"?["ACTIVE","ONBOARDING"].includes(String(c.lifecycle)):String(c.lifecycle)===lifecycle);
    const prio=priority==="ALL"||String(c.priority)===priority;
    const search=!q||`${c.display_name||""} ${c.cs_owner||""} ${c.gt_owner||""} ${c.action_owner||""} ${c.current_subject||""}`.toLocaleLowerCase("pt-BR").includes(q);
    return life&&prio&&search;
  });},[all,lifecycle,priority,query]);
  const openClient=(id:string)=>window.location.assign(`/?client=${encodeURIComponent(id)}`);

  if(!ready||!session)return <main className="auth-loading"><span className="dot loading"/> Validando sessão…</main>;
  return <main className="shell" style={{paddingLeft:0}}>
    <header className="top" style={{position:"sticky",top:0,zIndex:40}}>
      <div className="brand"><div className="logo"><BrandMark/></div><div><span className="brand-name">Leonardo Imobi</span><h1>Clientes</h1><div className="subtitle">Mesma leitura de carteira disponível no perfil de gestão.</div></div></div>
      <div className="live"><a className="btn" href="/commercial-home">Home Comercial</a><a className="btn" href="/">Dashboard</a></div>
    </header>
    <div className="source-banner"><span>Carteira executiva.</span> Métricas, retenção, histórico e clientes usam a mesma base da aba Clientes do perfil do Adler.</div>
    {error&&<div className="error-box" style={{margin:20}}>{error}</div>}
    {loading&&!payload.portfolio?<div className="auth-loading"><span className="dot loading"/> Carregando clientes…</div>:<>
      <PortfolioCenter portfolio={payload.portfolio||null} openClient={openClient}/>
      <details className="card portfolio-fulllist" style={{margin:"0 auto 28px",width:"min(1440px,calc(100% - 44px))"}} open>
        <summary>Lista completa de clientes <span>{all.length}</span></summary>
        <section className="workspace" style={{width:"100%",margin:0}}>
          <div className="workspace-head"><div><h2>Carteira completa</h2><p>Saúde, tempo como cliente, responsáveis e próxima ação.</p></div><span className="counter">{visible.length} de {all.length}</span></div>
          <section className="card section">
            <div className="toolbar portfolio-tools">
              <input className="control" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Buscar cliente ou responsável"/>
              <select className="control" value={lifecycle} onChange={e=>setLifecycle(e.target.value)}><option value="ACTIVE">Ativos</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option></select>
              <select className="control" value={priority} onChange={e=>setPriority(e.target.value)}><option value="ALL">Todas as prioridades</option><option value="ATTENTION">Atenção</option><option value="FOLLOW_UP">Acompanhamento</option><option value="OK">OK</option><option value="UNDETERMINED">Indeterminado</option><option value="DATA_INCOMPLETE">Dados incompletos</option></select>
            </div>
            <div className="table-wrap"><table><thead><tr><th>Cliente</th><th>Status</th><th>Saúde</th><th>Tempo como cliente</th><th>Próxima ação</th><th>Responsável</th></tr></thead><tbody>
              {visible.map(client=>{const score=healthScore(client);return <tr key={client.client_id} onClick={()=>openClient(client.client_id)}><td><button type="button" className="cell-open name" onClick={e=>{e.stopPropagation();openClient(client.client_id)}}>{text(client.display_name)}</button><div className="small">{text(client.current_subject)}</div></td><td><Chip value={client.lifecycle}/></td><td><div className="score"><b>{score}</b><i><span style={{width:`${score}%`}}/></i></div></td><td>{client.entrada?<><div>{formatNumber(client.client_days,0)} dias</div><div className="small">desde {new Intl.DateTimeFormat("pt-BR").format(new Date(`${client.entrada}T12:00:00`))}</div></>:"Revisão manual"}</td><td>{client.lifecycle==="CHURNED"?"Histórico encerrado":text(client.next_step)}<div className="small">{client.lifecycle==="CHURNED"?"Sem alerta operacional":relativeDate(client.next_step_due)}</div></td><td>{text(client.action_owner||client.cs_owner)}<div className="small">{client.carteira?`Carteira ${client.carteira}`:"Sem carteira"}</div></td></tr>})}
              {!visible.length&&<tr><td colSpan={6} className="empty">Nenhum cliente nesse filtro.</td></tr>}
            </tbody></table></div>
          </section>
        </section>
      </details>
    </>}
  </main>;
}
