"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-gt-analysis-api`;
function remove(){document.querySelectorAll("[data-meta-analysis-nav]").forEach(n=>n.remove());}
function install(label:string){
  if(window.location.pathname!=="/")return;
  const container=document.querySelector<HTMLElement>(".side-nav-items");
  if(!container||container.querySelector("[data-meta-analysis-nav]"))return;
  const link=document.createElement("a");link.dataset.metaAnalysisNav="true";link.href="/meta-analysis";link.title=label;link.textContent=label;
  const ia=Array.from(container.querySelectorAll<HTMLElement>("a,button")).find(n=>String(n.textContent||"").trim().toLowerCase().startsWith("ia"));
  if(ia)container.insertBefore(link,ia);else container.appendChild(link);
}
export default function MetaAnalysisNavBridge(){
  const[session,setSession]=useState<Session|null>(null),[label,setLabel]=useState("");
  useEffect(()=>{supabase.auth.getSession().then(({data})=>setSession(data.session));const{data:{subscription}}=supabase.auth.onAuthStateChange((_e,next)=>setSession(next));return()=>subscription.unsubscribe();},[]);
  useEffect(()=>{if(!session?.access_token){setLabel("");remove();return;}let alive=true;fetch(API,{headers:{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY},cache:"no-store"}).then(async r=>{if(!alive)return;if(!r.ok){setLabel("");remove();return;}const b=await r.json().catch(()=>({}));setLabel(b?.profile?.is_adler?"Análises dos GTs":b?.profile?.role==="GT"?"Análise Meta semanal":"");}).catch(()=>{if(alive){setLabel("");remove();}});return()=>{alive=false;};},[session?.access_token]);
  useEffect(()=>{if(!label){remove();return;}const apply=()=>install(label);apply();const timer=window.setInterval(apply,1200);return()=>{clearInterval(timer);remove();};},[label]);
  useEffect(()=>{if(!label)return;const click=(event:MouseEvent)=>{const target=event.target as HTMLElement|null;const card=target?.closest?.(".notification-panel .notification-list > button, button.toast, .nh-item, .client-notifications-bridge-host .cn-item") as HTMLElement|null;if(!card)return;const title=card.querySelector<HTMLElement>("b,strong,h2,h4")?.textContent?.trim()||"";const normalized=title.normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();const matches=normalized==="analise meta semanal disponivel"||normalized.includes("entregou a analise meta semanal")||normalized==="analise meta semanal revisada"||normalized==="revisao solicitada na analise meta";if(!matches)return;event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();window.location.assign("/meta-analysis");};window.addEventListener("click",click,true);return()=>window.removeEventListener("click",click,true);},[label]);
  return null;
}
