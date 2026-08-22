"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-friday-report-api`;

export default function FridayReportShortcut() {
  const [session,setSession]=useState<Session|null>(null);
  const [allowed,setAllowed]=useState(false);
  useEffect(()=>{
    supabase.auth.getSession().then(({data})=>setSession(data.session));
    const {data:{subscription}}=supabase.auth.onAuthStateChange((_event,next)=>setSession(next));
    return()=>subscription.unsubscribe();
  },[]);
  useEffect(()=>{
    if(!session?.access_token)return;
    let active=true;
    authenticatedFetch(API_URL,{cache:"no-store"}).then((response)=>{if(active)setAllowed(response.ok);}).catch(()=>{if(active)setAllowed(false);});
    return()=>{active=false;};
  },[session?.access_token]);
  const friday=useMemo(()=>new Intl.DateTimeFormat("en-US",{timeZone:"America/Sao_Paulo",weekday:"short"}).format(new Date())==="Fri",[]);
  if(!session||!allowed||typeof window==="undefined"||window.location.pathname==="/friday-report")return null;
  return <button type="button" className={`friday-report-shortcut ${friday?"is-friday":""}`} onClick={()=>window.location.assign("/friday-report")} title="Abrir relatório comercial semanal para CS">
    <span>▤</span><b>{friday?"Relatório de sexta · disponível":"Relatório de sexta"}</b>
    <style>{`
      .friday-report-shortcut{position:fixed;left:calc(var(--sidenav-width,224px) + 18px);bottom:104px;z-index:10030;display:flex;align-items:center;gap:8px;border:1px solid rgba(110,206,160,.25);background:rgba(8,27,23,.95);color:#e9f7ef;border-radius:999px;padding:9px 13px;box-shadow:0 14px 38px rgba(0,0,0,.28);backdrop-filter:blur(14px);cursor:pointer;font-size:11.5px}.friday-report-shortcut span{color:#72d9a6;font-size:14px}.friday-report-shortcut b{font-weight:750}.friday-report-shortcut.is-friday{border-color:rgba(104,222,163,.5);box-shadow:0 0 0 1px rgba(80,201,140,.12),0 14px 38px rgba(0,0,0,.28)}@media(max-width:760px){.friday-report-shortcut{left:12px;bottom:calc(154px + env(safe-area-inset-bottom));padding:9px 11px}.friday-report-shortcut b{font-size:10px}}
    `}</style>
  </button>;
}
