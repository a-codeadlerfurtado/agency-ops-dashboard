"use client";

import { useEffect, useState } from "react";
import { SUPABASE_URL, authenticatedFetch } from "./shared";

const API=`${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`;

export default function CommercialNotificationsBridge(){
  const [commercial,setCommercial]=useState(false);
  const [unread,setUnread]=useState(0);

  useEffect(()=>{
    if(window.location.pathname!=="/")return;
    let active=true;
    authenticatedFetch(API,{cache:"no-store"}).then(async r=>{const b=await r.json().catch(()=>({}));if(!active||!r.ok)return;setCommercial(String(b?.role||"").toUpperCase()==="COMMERCIAL");setUnread((b?.items||[]).filter((x:any)=>x.kind==="NOTIFICATION"&&!x.read_at&&x.status!=="RESOLVED").length);}).catch(()=>{});
    return()=>{active=false};
  },[]);

  useEffect(()=>{
    if(!commercial||window.location.pathname!=="/")return;
    const apply=()=>{
      const button=document.querySelector<HTMLButtonElement>('button[aria-label="Notificações"]');
      if(!button)return;
      button.dataset.commercialNotifications="true";
      button.title="Notificações da Direção Comercial";
      button.querySelectorAll("b").forEach(node=>node.remove());
      if(unread>0){const badge=document.createElement("b");badge.textContent=String(unread);badge.dataset.commercialUnread="true";button.appendChild(badge);}
    };
    const click=(event:MouseEvent)=>{
      const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button[aria-label="Notificações"]'):null;
      if(!button)return;
      event.preventDefault();event.stopImmediatePropagation();window.location.assign("/notifications");
    };
    apply();const observer=new MutationObserver(apply);observer.observe(document.body,{childList:true,subtree:true});document.addEventListener("click",click,true);
    return()=>{observer.disconnect();document.removeEventListener("click",click,true);};
  },[commercial,unread]);
  return null;
}
