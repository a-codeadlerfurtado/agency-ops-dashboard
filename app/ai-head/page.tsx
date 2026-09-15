"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "../shared";
import { AIWorkBoard } from "./ai-work-board";
import "./ai-head.css";

type Agent = {
  client_id: string;
  display_name: string;
  lifecycle: string;
  service_status: string;
  state: "ACTIVE" | "BUILDING" | "MISSING_N8N";
  n8n_connected: boolean;
  n8n_sources: number;
  agent_name: string | null;
  last_evidence_at: string | null;
  cs_owner: string | null;
  gt_owner: string | null;
  open_demands: number;
};
type Demand = { id:string; source:string; client_id:string; display_name:string; title:string; status:string; priority:string|null; due_at:string|null; owner:string|null; url:string|null };
type Payload = { profile?:{person?:string;role?:string}; summary?:{total:number;n8n:number;building:number;attention:number;demands:number}; agents?:Agent[]; demands?:Demand[]; generated_at?:string };

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-ai-head-api`;

function fmt(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" }).format(date);
}
function stateLabel(state: Agent["state"]) { return state === "ACTIVE" ? "N8N ATIVO" : state === "BUILDING" ? "EM IMPLANTAÇÃO" : "SEM N8N LOCALIZADO"; }

export default function AIHeadPage() {
  const [session,setSession]=useState<Session|null>(null);
  const [ready,setReady]=useState(false);
  const [payload,setPayload]=useState<Payload|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [section,setSection]=useState<"work"|"agents">("work");

  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true);if(!data.session)window.location.replace("/");});
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>{setSession(next);if(!next)window.location.replace("/");});
    return()=>subscription.unsubscribe();
  },[]);

  const load=useCallback(async()=>{
    if(!session?.access_token)return;
    setLoading(true);setError("");
    try{
      const response=await fetch(API_URL,{headers:{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY},cache:"no-store"});
      const body=await response.json().catch(()=>({}));
      if(response.status===403){window.location.replace("/");return;}
      if(!response.ok)throw new Error(body.detail||body.error||`API ${response.status}`);
      setPayload(body);
    }catch(caught){setError(caught instanceof Error?caught.message:"Falha ao carregar agentes de IA.");}
    finally{setLoading(false);}
  },[session?.access_token]);

  useEffect(()=>{if(!session?.access_token)return;load();const timer=window.setInterval(load,30000);return()=>window.clearInterval(timer);},[session?.access_token,load]);

  async function signOut(){await supabase.auth.signOut();window.location.replace("/");}
  if(!ready)return <main className="aih-loading"><div><span className="aih-spinner"/>Validando perfil…</div></main>;
  if(!session)return null;
  const summary=payload?.summary||{total:0,n8n:0,building:0,attention:0,demands:0};
  const agents=payload?.agents||[]; const demands=payload?.demands||[];

  return <main className="aih-shell">
    <header className="aih-top">
      <div><span className="aih-kicker">GABRIEL CASTRO · HEAD DE IA</span><h1>{section==="work"?"Central de Trabalho IA":"Central de Agentes IA"}</h1><p>{section==="work"?"Seu espaço operacional para receber, organizar, executar e concluir as demandas dos clientes que usam nossa IA.":"Clientes e agentes validados pela presença de fluxo n8n nosso. Nomes manuais não substituem essa validação."}</p></div>
      <div className="aih-actions"><button onClick={load} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button><button className="aih-signout" onClick={signOut}>Sair</button></div>
    </header>

    <nav className="aih-main-tabs" aria-label="Áreas do Head de IA">
      <button className={section==="work"?"active":""} onClick={()=>setSection("work")}><span>Central de Trabalho</span><small>quadro de demandas</small></button>
      <button className={section==="agents"?"active":""} onClick={()=>setSection("agents")}><span>Agentes IA</span><small>{summary.n8n} n8n ativos</small></button>
    </nav>

    {error&&<div className="aih-error">{error}</div>}

    {section==="work" && <AIWorkBoard token={session.access_token}/>} 

    {section==="agents" && <>
      <section className="aih-metrics">
        <article className="aih-metric"><small>CLIENTES IA</small><b>{summary.total}</b><span>ativos ou em implantação</span></article>
        <article className="aih-metric"><small>AGENTES N8N</small><b>{summary.n8n}</b><span>fonte n8n localizada</span></article>
        <article className="aih-metric warn"><small>EM IMPLANTAÇÃO</small><b>{summary.building}</b><span>ainda em construção</span></article>
        <article className={`aih-metric ${summary.attention?"bad":""}`}><small>ATENÇÃO</small><b>{summary.attention}</b><span>IA ativa sem n8n localizado</span></article>
      </section>

      <section className="aih-section">
        <div className="aih-section-head"><div><h2>Agentes dos clientes</h2><p>O agente aparece como ativo apenas quando há evidência n8n para aquele cliente.</p></div><span className="aih-counter">Atualizado {fmt(payload?.generated_at)}</span></div>
        <div className="aih-agent-grid">{agents.map(agent=>{
          const tone=agent.state==="MISSING_N8N"?"attention":agent.state==="BUILDING"?"building":"";
          return <article className={`aih-agent ${tone}`} key={agent.client_id}>
            <div className="aih-agent-top"><div><h3>{agent.display_name}</h3><div className="sub">{agent.lifecycle} · IA {agent.service_status}</div></div><span className={`aih-pill ${tone}`}>{stateLabel(agent.state)}</span></div>
            <div className="aih-agent-name"><small>AGENTE</small><b>{agent.n8n_connected?(agent.agent_name||"Agente n8n"):agent.state==="BUILDING"?"Ainda não publicado no n8n":"Não localizado no n8n"}</b></div>
            <div className="aih-meta"><div><small>FONTES N8N</small><b>{agent.n8n_sources}</b></div><div><small>DEMANDAS IA</small><b>{agent.open_demands}</b></div><div><small>ÚLTIMA EVIDÊNCIA</small><b>{fmt(agent.last_evidence_at)}</b></div><div><small>CS</small><b>{agent.cs_owner||"—"}</b></div></div>
          </article>;
        })}</div>
        {!agents.length&&!loading&&<div className="aih-empty">Nenhum cliente da nossa IA encontrado.</div>}
      </section>

      <section className="aih-section">
        <div className="aih-section-head"><div><h2>Leitura rápida de demandas</h2><p>Prévia das demandas de IA detectadas nas fontes atuais. A execução e o histórico ficam na Central de Trabalho.</p></div><span className="aih-counter">{summary.demands} abertas</span></div>
        <div className="aih-demand-list">{demands.map(d=><article className="aih-demand" key={d.id}><strong>{d.display_name}</strong><span className="title">{d.title}</span><small>{d.status}{d.due_at?` · ${fmt(d.due_at)}`:""}</small><small className="owner">{d.owner||d.source}</small></article>)}</div>
        {!demands.length&&!loading&&<div className="aih-empty">Nenhuma demanda de IA detectada nos clientes do escopo.</div>}
      </section>
    </>}
  </main>;
}
