"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Metric, authenticatedFetch, formatDate, formatNumber, pt, type Row } from "../shared";

const VIDEO_API="https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-video-dashboard-api";
type Payload={controls:Row;worker:Row|null;jobs:Row[];outputs:Row[];triage_url:string;generated_at:string};
const label=(value:unknown)=>pt[String(value||"")]||String(value||"—");
function Switch({checked,disabled,onChange,label,detail}:{checked:boolean;disabled?:boolean;onChange:()=>void;label:string;detail:string}){
 return <label style={{display:"flex",gap:12,alignItems:"flex-start",padding:"13px 0",cursor:disabled?"not-allowed":"pointer",opacity:disabled?.65:1}}>
  <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} style={{marginTop:4,width:18,height:18}}/>
  <span><b>{label}</b><span className="small" style={{display:"block",marginTop:3,lineHeight:1.45}}>{detail}</span></span>
 </label>;
}
export function VideoAutomationCenter({token}:{token:string}){
 const [payload,setPayload]=useState<Payload|null>(null),[loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[error,setError]=useState("");
 const load=useCallback(async()=>{setLoading(true);setError("");try{const r=await authenticatedFetch(VIDEO_API,{cache:"no-store"});const b=await r.json();if(!r.ok)throw new Error(b.detail||b.error||`API ${r.status}`);setPayload(b);}catch(e){setError(e instanceof Error?e.message:"Não foi possível carregar os vídeos.");}finally{setLoading(false);}},[]);
 useEffect(()=>{void load();const id=window.setInterval(()=>void load(),30000);return()=>window.clearInterval(id);},[load]);
 const outputs=useMemo(()=>new Map((payload?.outputs||[]).map((o)=>[String(o.job_id),o])),[payload]);
 const queued=(payload?.jobs||[]).filter((j)=>["QUEUED","RETRY","WAITING_FOR_CONTEXT"].includes(String(j.status))).length;
 async function setEditing(enabled:boolean){
  if(enabled&&!window.confirm(`Ligar edição automática agora? Há ${queued} job(s) aguardando e o worker começará a processá-los.`))return;
  setSaving(true);setError("");try{const r=await authenticatedFetch(VIDEO_API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"set_edit_enabled",enabled})});const b=await r.json();if(!r.ok)throw new Error(b.detail||b.error||"Não foi possível alterar o switch.");await load();}catch(e){setError(e instanceof Error?e.message:"Falha ao alterar o switch.");}finally{setSaving(false);}
 }
 const worker=payload?.worker;const isOnline=worker&&Date.now()-new Date(worker.last_seen_at).getTime()<120000;
 return <section className="workspace">
  <div className="workspace-head"><div><h2>Vídeos Automáticos</h2><p>Controle executivo do pipeline: fila, worker, QA e triagem. Alterações de render só valem para o seu perfil.</p></div><div style={{display:"flex",gap:8,alignItems:"center"}}><a className="btn" href={payload?.triage_url||"https://drive.google.com/drive/folders/1uddoWTdo-f6ahyPWMca5mSZ2rO3FuS9i"} target="_blank" rel="noreferrer">Abrir triagem</a><button className="btn" onClick={()=>void load()} disabled={loading}>{loading?"Atualizando…":"Atualizar"}</button></div></div>
  {error&&<div className="error-box">{error}</div>}
  <div className="grid clickup-kpis">
   <Metric label="Worker V3" value={isOnline?"Online":"Atenção"} tone={isOnline?"green":"red"} hint={worker?`${worker.worker_version||"—"} · ${label(worker.state)}`:"sem heartbeat"} loading={loading}/>
   <Metric label="Fila aguardando" value={formatNumber(queued,0)} tone={queued?"yellow":"green"} hint="queued, retry e contexto pendente" loading={loading}/>
   <Metric label="Render automático" value={payload?.controls?.video_edit_enabled?"Ligado":"Desligado"} tone={payload?.controls?.video_edit_enabled?"yellow":"green"} hint="kill switch de produção" loading={loading}/>
   <Metric label="Análise de acervo" value={payload?.controls?.video_analysis_enabled?"Ligada":"Desligada"} tone="blue" hint="lotes controlados, 1 por vez" loading={loading}/>
  </div>
  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(310px,1fr))",gap:14,marginBottom:14}}>
   <section className="card section"><div className="section-title">Controles de produção</div><Switch checked={Boolean(payload?.controls?.video_edit_enabled)} disabled={loading||saving} onChange={()=>void setEditing(!payload?.controls?.video_edit_enabled)} label={saving?"Salvando…":"Processar vídeos automaticamente"} detail="Ao ligar, o worker consome somente os jobs já aprovados na fila. Ao desligar, nenhum novo render é iniciado."/><hr style={{border:"none",borderTop:"1px solid rgba(148,163,184,.15)"}}/><Switch checked={Boolean(payload?.controls?.video_analysis_enabled)} disabled onChange={()=>undefined} label="Analisar acervo antigo" detail="Protegido por batch controlado: o backfill é ativado apenas em validações unitárias, nunca em massa pelo dashboard."/></section>
   <section className="card section"><div className="section-title">Triagem e revisão</div><p className="small" style={{lineHeight:1.55}}>Todo vídeo concluído passa por QA e fica em <b>REVIEW_REQUIRED</b>. Ele não publica anúncio sozinho. A equipe revisa o arquivo na pasta de triagem antes de seguir.</p><a className="btn primary" href={payload?.triage_url||"https://drive.google.com/drive/folders/1uddoWTdo-f6ahyPWMca5mSZ2rO3FuS9i"} target="_blank" rel="noreferrer">Abrir pasta de triagem</a><div className="small" style={{marginTop:11}}>Última atualização: {payload?.generated_at?formatDate(payload.generated_at):"—"}</div></section>
  </div>
  <section className="card section"><div className="section-head"><div><div className="section-title">Fila e entregas recentes</div><div className="small">Status técnico, etapa atual, QA e link do vídeo quando já renderizado.</div></div></div>
   <div className="table-wrap"><table><thead><tr><th>Cliente / produto</th><th>Status</th><th>Etapa</th><th>Progresso</th><th>QA</th><th>Entrega</th></tr></thead><tbody>{(payload?.jobs||[]).length?(payload?.jobs||[]).map((job)=>{const output=outputs.get(String(job.id));return <tr key={job.id}><td><b>{job.product_name||"Sem produto"}</b><div className="small">{job.test_mode?"Teste controlado":"Produção"} · {formatDate(job.created_at)}</div></td><td><b>{label(job.status)}</b><div className="small">{job.attempt_count||0} tentativa(s)</div></td><td>{label(job.current_stage)}</td><td>{formatNumber(job.progress_pct||0,0)}%</td><td>{output?.qa_status?<b style={{color:output.qa_status==="PASS"?"#22c55e":"#ef4444"}}>{output.qa_status}</b>:"—"}</td><td>{output?.drive_url?<a href={output.drive_url} target="_blank" rel="noreferrer">Abrir vídeo</a>:job.last_error?<span style={{color:"#ef4444"}}>Ver erro na fila</span>:"Aguardando"}</td></tr>;}):<tr><td colSpan={6} className="small">Nenhum job recente.</td></tr>}</tbody></table></div>
  </section>
 </section>;
}