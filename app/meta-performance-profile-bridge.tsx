"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-performance-api`;
const NOTIFICATIONS_API = `${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`;
type Row = Record<string, any>;

function norm(value: unknown) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
function money(value: unknown) {
  const n = Number(value); return Number.isFinite(n) ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—";
}
function number(value: unknown) {
  const n = Number(value); return Number.isFinite(n) ? n.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) : "—";
}
function status(value: unknown) {
  return ({ OK:"OK",PARTIAL_PERIOD:"Período parcial",NO_META_ACCOUNT:"Sem conta Meta",NO_CAMPAIGNS:"Sem campanha",NO_DELIVERY:"Sem entrega",API_ERROR:"Erro na API",API_PARTIAL:"API parcial" } as Row)[String(value)] || String(value || "—").replaceAll("_"," ");
}
function removeInjected() {
  document.querySelectorAll("[data-meta-performance-nav],[data-meta-performance-client]").forEach(node => node.remove());
}
function installNav() {
  if (window.location.pathname !== "/") return;
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container || container.querySelector("[data-meta-performance-nav]")) return;
  const link = document.createElement("a");
  link.dataset.metaPerformanceNav = "true";
  link.href = "/meta-performance";
  link.title = "Performance Meta";
  link.textContent = "Performance Meta";
  const ia = Array.from(container.querySelectorAll<HTMLElement>("a,button")).find(node => norm(node.textContent).startsWith("ia"));
  if (ia) container.insertBefore(link, ia); else container.appendChild(link);
}
function renderClientCard(root: HTMLElement, snapshots: Row[], clientId: string) {
  if (root.querySelector("[data-meta-performance-client]")) return;
  const latestDate = snapshots[0]?.snapshot_date;
  const latest = snapshots.filter(row => row.snapshot_date === latestDate);
  const section = document.createElement("section");
  section.dataset.metaPerformanceClient = "true";
  section.className = "detail-card full";
  const title = document.createElement("h3"); title.textContent = "Meta · Histórico de Performance"; section.appendChild(title);
  if (!latest.length) {
    const p = document.createElement("p"); p.className = "small"; p.textContent = "Ainda não há snapshot semanal salvo para este cliente."; section.appendChild(p);
  } else {
    const dateLine = document.createElement("p"); dateLine.className = "small"; dateLine.textContent = `Último snapshot: ${new Intl.DateTimeFormat("pt-BR").format(new Date(`${latestDate}T12:00:00`))}`; section.appendChild(dateLine);
    const grid = document.createElement("div"); grid.style.cssText = "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:9px 0";
    for (const days of [3,7,14,30]) {
      const row = latest.find(item => Number(item.period_days) === days);
      const box = document.createElement("div"); box.style.cssText = "border:1px solid #24394d;border-radius:8px;padding:8px;background:rgba(14,27,40,.55);min-width:0";
      box.innerHTML = row
        ? `<b style="display:block;font-size:11px">${days} dias</b><small style="display:block;margin-top:3px">${status(row.data_status)}</small><strong style="display:block;margin-top:5px">${money(row.spend)}</strong><small style="display:block;margin-top:2px">${number(row.results)} resultados · CPL ${money(row.cpl)}</small>${row.is_partial_period ? `<small style="display:block;color:#ddb86e;margin-top:3px">${row.available_period_days}/${row.requested_period_days} dias disponíveis</small>` : ""}`
        : `<b>${days} dias</b><small style="display:block;margin-top:4px">Sem snapshot</small>`;
      grid.appendChild(box);
    }
    section.appendChild(grid);
  }
  const link = document.createElement("a");
  link.href = `/meta-performance?client=${encodeURIComponent(clientId)}`;
  link.textContent = "Abrir histórico completo de Performance Meta →";
  link.style.cssText = "display:inline-block;margin-top:5px;color:#72bfff;font-weight:800;font-size:10px;text-decoration:none";
  section.appendChild(link);
  root.appendChild(section);
}

export default function MetaPerformanceProfileBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowed, setAllowed] = useState(false);
  const clientCache = useRef(new Map<string,{at:number;body:Row}>());
  const notifications = useRef<{ at:number; rows:Row[] }>({ at:0, rows:[] });

  useEffect(() => {
    supabase.auth.getSession().then(({data}) => setSession(data.session));
    const { data:{subscription} } = supabase.auth.onAuthStateChange((_e,next) => { setSession(next); if(!next){setAllowed(false);clientCache.current.clear();removeInjected();} });
    return () => subscription.unsubscribe();
  }, []);

  const headers = useCallback(() => session?.access_token ? { Authorization:`Bearer ${session.access_token}`, apikey:SUPABASE_ANON_KEY } : null, [session?.access_token]);
  const loadClient = useCallback(async (name:string) => {
    const h=headers(); if(!h)return null;
    const key=norm(name),cached=clientCache.current.get(key);
    if(cached&&Date.now()-cached.at<30000)return cached.body;
    const response=await fetch(`${API}?client_name=${encodeURIComponent(name)}`,{headers:h,cache:"no-store"});
    if(!response.ok)return null;
    const body=await response.json().catch(()=>null);if(body)clientCache.current.set(key,{at:Date.now(),body});return body;
  },[headers]);
  const loadNotifications = useCallback(async () => {
    const h=headers(); if(!h)return [] as Row[];
    if(Date.now()-notifications.current.at<5000)return notifications.current.rows;
    const response=await fetch(NOTIFICATIONS_API,{headers:h,cache:"no-store"}); const body=await response.json().catch(()=>({}));
    const rows:Row[]=response.ok&&body?.ok&&Array.isArray(body.items)?body.items:[]; notifications.current={at:Date.now(),rows}; return rows;
  },[headers]);

  useEffect(() => {
    const h=headers(); if(!h){setAllowed(false);removeInjected();return;}
    let alive=true;
    fetch(`${API}?probe=1`,{headers:h,cache:"no-store"}).then(response=>{if(alive)setAllowed(response.ok);}).catch(()=>{if(alive)setAllowed(false);});
    return()=>{alive=false;};
  },[headers]);

  useEffect(() => {
    if(!allowed){removeInjected();return;}
    let frame=0, applying=false;
    const apply=()=>{
      if(applying)return;
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(async()=>{
        applying=true;
        try{
          installNav();
          if(window.location.pathname!=="/")return;
          const drawer=document.querySelector<HTMLElement>(".drawer.open");
          const grid=drawer?.querySelector<HTMLElement>(".drawer-body .detail-grid");
          if(!drawer||!grid||grid.querySelector("[data-meta-performance-client]"))return;
          const name=drawer.querySelector<HTMLElement>(".drawer-head h2")?.textContent?.trim();
          if(!name)return;
          const detail=await loadClient(name),clientId=String(detail?.client?.id||"");
          if(!clientId)return;
          const snaps:Row[]=(detail?.snapshots||[]).sort((a:Row,b:Row)=>String(b.snapshot_date).localeCompare(String(a.snapshot_date))||Number(a.period_days)-Number(b.period_days));
          renderClientCard(grid,snaps,clientId);
        }finally{applying=false;}
      });
    };
    apply();
    const observer=new MutationObserver(apply); observer.observe(document.body,{childList:true,subtree:true});
    const interval=window.setInterval(apply,1500);
    return()=>{observer.disconnect();clearInterval(interval);cancelAnimationFrame(frame);removeInjected();};
  },[allowed,loadClient]);

  useEffect(() => {
    if(!allowed)return;
    const click=(event:MouseEvent)=>{
      const target=event.target as HTMLElement|null;
      const card=target?.closest?.(".notification-panel .notification-list > button, button.toast, .nh-item, .client-notifications-bridge-host .cn-item") as HTMLElement|null;
      if(!card)return;
      const title=card.querySelector<HTMLElement>("b,strong,h2,h4")?.textContent?.trim()||"";
      if(norm(title)!==norm("Relatório Meta semanal concluído"))return;
      event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();
      void(async()=>{
        const id=String(card.dataset.notificationId||"").trim(); const rows=await loadNotifications();
        let item=id?rows.find(row=>String(row.id)===id):null;
        if(!item)item=rows.filter(row=>norm(row.title)===norm(title)).sort((a,b)=>+new Date(b.occurred_at||0)-+new Date(a.occurred_at||0))[0];
        const run=String(item?.metadata?.meta_performance_run_id||"");
        window.location.assign(run?`/meta-performance?run=${encodeURIComponent(run)}`:"/meta-performance");
      })();
    };
    window.addEventListener("click",click,true); return()=>window.removeEventListener("click",click,true);
  },[allowed,loadNotifications]);

  return null;
}
