"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-radar-api?probe=1`;
function remove(){document.querySelectorAll("[data-meta-radar-nav]").forEach(n=>n.remove());}
function install(label:string){
  if(window.location.pathname!=="/")return;
  const container=document.querySelector<HTMLElement>(".side-nav-items");
  if(!container||container.querySelector("[data-meta-radar-nav]"))return;
  const link=document.createElement("a");link.dataset.metaRadarNav="true";link.href="/creative-intelligence";link.title=label;link.textContent=label;
  const performance=Array.from(container.querySelectorAll<HTMLAnchorElement>("a")).find(n=>String(n.getAttribute("href")||"")==="/meta-performance");
  if(performance)container.insertBefore(link,performance);else{
    const ia=Array.from(container.querySelectorAll<HTMLElement>("a,button")).find(n=>String(n.textContent||"").trim().toLowerCase().startsWith("ia"));
    if(ia)container.insertBefore(link,ia);else container.appendChild(link);
  }
}
export default function MetaRadarNavBridge(){
  const[session,setSession]=useState<Session|null>(null),[label,setLabel]=useState("");
  useEffect(()=>{supabase.auth.getSession().then(({data})=>setSession(data.session));const{data:{subscription}}=supabase.auth.onAuthStateChange((_e,next)=>setSession(next));return()=>subscription.unsubscribe();},[]);
  useEffect(()=>{if(!session?.access_token){setLabel("");remove();return;}let alive=true;fetch(API,{headers:{Authorization:`Bearer ${session.access_token}`,apikey:SUPABASE_ANON_KEY},cache:"no-store"}).then(async r=>{if(!alive)return;if(!r.ok){setLabel("");remove();return;}const b=await r.json().catch(()=>({}));const role=String(b?.profile?.role||"");setLabel(role==="DESIGN"?"Inteligência Criativa":"");}).catch(()=>{if(alive){setLabel("");remove();}});return()=>{alive=false;};},[session?.access_token]);
  useEffect(()=>{if(!label){remove();return;}const apply=()=>install(label);apply();const timer=window.setInterval(apply,1200);return()=>{clearInterval(timer);remove();};},[label]);
  return null;
}
