"use client";

import { useEffect, useState } from "react";
import { SUPABASE_URL, authenticatedFetch } from "./shared";

type Profile={person?:string|null;role?:string|null};
const DASHBOARD_API=`${SUPABASE_URL}/functions/v1/agency-ops-dashboard-api?view=home`;
const norm=(v:unknown)=>String(v??"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ").trim().toLowerCase();

function makeButton(label:string,href:string,key:string,template?:HTMLButtonElement|null){const b=document.createElement("button");b.type="button";b.dataset.leadershipNav=key;b.title=label;b.textContent=label;if(template?.className)b.className=template.className.replace(/\bactive\b/g,"").trim();b.addEventListener("click",()=>window.location.assign(href));return b;}
function findButton(container:HTMLElement,label:string){return [...container.querySelectorAll<HTMLButtonElement>("button")].find(b=>norm(b.title||b.textContent)===norm(label));}
function ensure(container:HTMLElement,label:string,href:string,key:string,beforeLabel?:string,afterLabel?:string){if(container.querySelector(`[data-leadership-nav="${key}"]`))return;const buttons=[...container.querySelectorAll<HTMLButtonElement>("button")];const template=buttons[0]||null;const button=makeButton(label,href,key,template);const before=beforeLabel?findButton(container,beforeLabel):null;const after=afterLabel?findButton(container,afterLabel):null;if(before)container.insertBefore(button,before);else if(after?.nextSibling)container.insertBefore(button,after.nextSibling);else container.appendChild(button);}

export default function LeadershipNavigationBridge(){
 const [profile,setProfile]=useState<Profile>({});
 useEffect(()=>{let active=true;authenticatedFetch(DASHBOARD_API,{cache:"no-store"}).then(async r=>{if(!active||!r.ok)return;const b=await r.json().catch(()=>({}));if(active)setProfile(b?.profile||{});}).catch(()=>{});return()=>{active=false};},[]);
 useEffect(()=>{
   const person=String(profile.person||"");if(!["Adler Furtado","Leonardo Augusto"].includes(person))return;
   const apply=()=>{
     if(window.location.pathname==="/"){
       const container=document.querySelector<HTMLElement>(".side-nav-items");
       if(container){
         if(person==="Leonardo Augusto"){
           ensure(container,"Central de Trabalho","/leadership-work","leadership-work","Clientes");
           ensure(container,"Equipe","/leadership-team","leadership-team","IA (Beta)","Saúde");
         }
         ensure(container,"Mensalidades & Impl.","/client-revenue","client-revenue",person==="Leonardo Augusto"?"Onboarding":"Onboarding","Clientes");
       }
     }
     document.querySelectorAll<HTMLElement>(".eyebrow").forEach(node=>{if(norm(node.textContent).includes("privado · adler only"))node.textContent="PRIVADO · DIREÇÃO";});
   };
   apply();const obs=new MutationObserver(apply);obs.observe(document.body,{childList:true,subtree:true});const timer=window.setInterval(apply,1200);return()=>{obs.disconnect();window.clearInterval(timer);document.querySelectorAll("[data-leadership-nav]").forEach(n=>n.remove());};
 },[profile.person]);
 return null;
}
