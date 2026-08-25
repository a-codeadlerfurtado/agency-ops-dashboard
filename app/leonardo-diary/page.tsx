"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "../shared";
import { DiaryCenter } from "../views/diary";

type Row=Record<string,any>;
const COMMERCIAL_API=`${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;

export default function LeonardoDiaryPage(){
 const[session,setSession]=useState<Session|null>(null),[ready,setReady]=useState(false),[data,setData]=useState<Row>({}),[error,setError]=useState("");
 useEffect(()=>{supabase.auth.getSession().then(({data})=>{setSession(data.session);setReady(true);if(!data.session)window.location.assign("/")});const{data:{subscription}}=supabase.auth.onAuthStateChange((_e,n)=>{setSession(n);if(!n)window.location.assign("/")});return()=>subscription.unsubscribe()},[]);
 const load=useCallback(async()=>{if(!session?.access_token)return;try{const r=await authenticatedFetch(COMMERCIAL_API,{cache:"no-store"}),b=await r.json().catch(()=>({}));if(!r.ok)throw new Error(b.detail||b.error||`API ${r.status}`);if(String(b?.profile?.person||"")!=="Leonardo Augusto")throw new Error("Área restrita à Direção Comercial.");setData(b);setError("")}catch(e){setError(e instanceof Error?e.message:"Falha ao carregar contexto comercial.")}},[session?.access_token]);
 useEffect(()=>{if(session?.access_token)load()},[session?.access_token,load]);
 useEffect(()=>{if(typeof window==="undefined"||new URLSearchParams(window.location.search).get("tab")!=="tasklog")return;let tries=0;const timer=window.setInterval(()=>{tries++;const button=Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent?.trim()==="TaskLog");if(button){button.click();clearInterval(timer)}else if(tries>30)clearInterval(timer)},100);return()=>clearInterval(timer)},[ready]);
 if(!ready||!session)return <main style={{minHeight:"100vh",display:"grid",placeItems:"center",background:"#071015",color:"#c9d8d4"}}>Carregando…</main>;
 const clients=(data.portfolio_clients||[]).map((row:Row)=>({client_id:row.client_id,display_name:row.display_name}));
 return <main style={{minHeight:"100vh",background:"#071015",color:"#e8f2ef",fontFamily:"Inter,system-ui",padding:"20px 24px 60px"}}><header style={{display:"flex",justifyContent:"space-between",gap:16,alignItems:"flex-end",marginBottom:18,paddingBottom:16,borderBottom:"1px solid #203237"}}><div><button onClick={()=>window.location.assign("/")} style={{border:"1px solid #2a4940",background:"#10231f",color:"#cce8df",borderRadius:9,padding:"8px 10px",cursor:"pointer"}}>← Central Comercial</button><span style={{display:"block",marginTop:12,color:"#62cca0",fontSize:9,fontWeight:900,letterSpacing:".12em"}}>DIREÇÃO COMERCIAL</span><h1 style={{margin:"4px 0",fontSize:28}}>Diário & TaskLog</h1><p style={{margin:0,color:"#76918a",fontSize:11}}>Registros pessoais do Leonardo. Ele cria e consulta os próprios ajustes e atividades; registros dos outros colaboradores permanecem fora do escopo.</p></div></header>{error&&<div style={{border:"1px solid #713f3b",background:"#2a1514",color:"#f0a097",borderRadius:10,padding:10,marginBottom:12}}>{error}</div>}<DiaryCenter clients={clients} adjustments={[]} taskLog={{}} profile={{person:"Leonardo Augusto",role:"COMMERCIAL"}} token={session.access_token} reload={load}/></main>
}
