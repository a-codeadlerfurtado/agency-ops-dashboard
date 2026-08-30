"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row=Record<string,any>;
type Payload={ok:boolean;allowed?:boolean;summary?:{open:number;high:number;openai_keys:number;passwords:number;tokens:number};findings?:Row[];scan_state?:Row[];error?:string};
const API=`${SUPABASE_URL}/functions/v1/agency-ops-security-center-api`;
const NAV_ATTR="data-security-center-nav";
const typeLabel:Record<string,string>={OPENAI_API_KEY:"Chave OpenAI",META_ACCESS_TOKEN:"Token Meta",PASSWORD:"Senha",TOKEN:"Token",API_KEY:"Chave de API",SECRET:"Segredo"};
const sourceLabel:Record<string,string>={WHATSAPP:"WhatsApp",OPS_NOTE:"Nota operacional"};
function fmt(value:unknown){if(!value)return"—";const d=new Date(String(value));if(Number.isNaN(d.getTime()))return String(value);return new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short",timeZone:"America/Sao_Paulo"}).format(d);}

export default function SecurityCenter(){
  const [allowed,setAllowed]=useState(false);const [open,setOpen]=useState(false);const [data,setData]=useState<Payload|null>(null);const [busy,setBusy]=useState(false);const [filter,setFilter]=useState("OPEN");
  const api=useCallback(async(action:string,extra:Row={})=>{const{data:{session}}=await supabase.auth.getSession();if(!session?.access_token)return null;const r=await fetch(API,{method:"POST",headers:{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY,"content-type":"application/json"},cache:"no-store",body:JSON.stringify({action,...extra})});return r.json().catch(()=>null);},[]);
  const refresh=useCallback(async()=>{const p=await api("SUMMARY") as Payload|null;if(p?.ok&&p.allowed){setAllowed(true);setData(p);}else setAllowed(false);},[api]);
  useEffect(()=>{const t=window.setTimeout(()=>void refresh(),1300);return()=>window.clearTimeout(t);},[refresh]);
  useEffect(()=>{if(!allowed||window.location.pathname!=="/")return;let alive=true;const mount=()=>{if(!alive)return;const nav=document.querySelector<HTMLElement>(".side-nav-items");if(!nav)return;let b=nav.querySelector<HTMLButtonElement>(`[${NAV_ATTR}]`);if(!b){b=document.createElement("button");b.type="button";b.setAttribute(NAV_ATTR,"true");b.title="Segurança e credenciais expostas";b.innerHTML='<span aria-hidden="true">⌾</span><span>Segurança</span>';nav.appendChild(b);}b.onclick=()=>{setOpen(true);void refresh();};};mount();const o=new MutationObserver(mount);o.observe(document.body,{childList:true,subtree:true});const i=window.setInterval(mount,1800);return()=>{alive=false;o.disconnect();window.clearInterval(i);document.querySelectorAll(`[${NAV_ATTR}]`).forEach(n=>n.remove());};},[allowed,refresh]);
  const findings=data?.findings||[];const visible=useMemo(()=>findings.filter(r=>filter==="ALL"||r.status===filter),[findings,filter]);
  async function runScan(){setBusy(true);try{const p=await api("RUN_SCAN") as Payload|null;if(p?.ok)setData(p);}finally{setBusy(false);}}
  async function resolve(id:string,status:string){if(status==="ROTATED"&&!window.confirm("Confirma que essa credencial já foi rotacionada no sistema de origem?"))return;setBusy(true);try{const p=await api("RESOLVE",{id,status}) as Payload|null;if(p?.ok)setData(p);}finally{setBusy(false);}}
  if(!open)return null;
  return <div className="security-center-overlay" role="dialog" aria-modal="true" aria-label="Central de Segurança"><div className="security-center-shell">
    <header className="security-center-head"><div><span>GESTÃO · SEGURANÇA</span><h2>Central de Segurança</h2><p>Credenciais encontradas fora do cofre. O segredo nunca é exibido nem armazenado nesta tela.</p></div><button onClick={()=>setOpen(false)}>Fechar</button></header>
    <div className="security-center-stats"><div><b>{data?.summary?.open??0}</b><span>Exposições abertas</span></div><div><b>{data?.summary?.openai_keys??0}</b><span>Chaves OpenAI</span></div><div><b>{data?.summary?.passwords??0}</b><span>Senhas</span></div><div><b>{data?.summary?.tokens??0}</b><span>Tokens</span></div></div>
    <div className="security-center-toolbar"><div><button className={filter==="OPEN"?"active":""} onClick={()=>setFilter("OPEN")}>Abertas</button><button className={filter==="ROTATED"?"active":""} onClick={()=>setFilter("ROTATED")}>Rotacionadas</button><button className={filter==="IGNORED"?"active":""} onClick={()=>setFilter("IGNORED")}>Ignoradas</button><button className={filter==="ALL"?"active":""} onClick={()=>setFilter("ALL")}>Todas</button></div><button className="scan" onClick={runScan} disabled={busy}>{busy?"Varrendo…":"Varrer agora"}</button></div>
    <div className="security-center-note"><b>Proteção ativa:</b> o resumo de “clientes aguardando resposta” agora remove senha, login, token e API key antes de gerar alertas internos. O scan automático roda diariamente.</div>
    <div className="security-center-list">{visible.length?visible.map((f:Row)=><article key={f.id} className={`security-finding ${f.status.toLowerCase()}`}><div className="security-finding-top"><div><span className="security-kind">{typeLabel[f.secret_type]||f.secret_type}</span><h3>{f.client?.display_name||f.source_title||"Origem não vinculada"}</h3></div><span className="security-status">{f.status}</span></div><p>{f.masked_context}</p><div className="security-meta"><span>{sourceLabel[f.source_type]||f.source_type}</span><span>{f.source_title||"—"}</span><span>{fmt(f.source_at)}</span>{f.client?.lifecycle?<span>{f.client.lifecycle}</span>:null}</div>{f.status==="OPEN"?<div className="security-actions"><button onClick={()=>resolve(f.id,"ROTATED")} disabled={busy}>Marcar como rotacionada</button><button onClick={()=>resolve(f.id,"IGNORED")} disabled={busy}>Ignorar</button></div>:<div className="security-actions"><button onClick={()=>resolve(f.id,"OPEN")} disabled={busy}>Reabrir</button></div>}</article>):<div className="security-empty">Nenhum item neste filtro.</div>}</div>
    <footer className="security-center-foot">Último scan: {(data?.scan_state||[]).map((s:Row)=>`${sourceLabel[s.source_type]||s.source_type}: ${fmt(s.last_run_at)}`).join(" · ")||"—"}</footer>
  </div></div>;
}
