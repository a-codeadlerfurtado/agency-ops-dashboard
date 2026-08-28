"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-performance-api`;
const CREATIVES_API = `${SUPABASE_URL}/functions/v1/agency-ops-meta-creatives-api`;
const NOTIFICATIONS_API = `${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`;
type Row = Record<string, any>;
type CreativeTab = "overview" | "creatives" | "campaigns" | "alerts" | "history";

function norm(value: unknown) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
function money(value: unknown) {
  const n = Number(value); return Number.isFinite(n) ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—";
}
function number(value: unknown, digits = 1) {
  const n = Number(value); return Number.isFinite(n) ? n.toLocaleString("pt-BR", { maximumFractionDigits: digits }) : "—";
}
function status(value: unknown) {
  return ({ OK:"OK",PARTIAL_PERIOD:"Período parcial",META_ACCESS_PENDING:"Acesso Meta pendente",NO_META_ACCOUNT:"Sem conta Meta",NO_CAMPAIGNS:"Sem campanha",NO_DELIVERY:"Sem entrega",API_ERROR:"Erro na API",API_PARTIAL:"API parcial",ERROR:"Erro" } as Row)[String(value)] || String(value || "—").replaceAll("_"," ");
}
function finite(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function removeInjected() {
  document.querySelectorAll("[data-meta-performance-nav],[data-meta-performance-client]").forEach(node => node.remove());
  document.querySelector("style[data-meta-creatives-style]")?.remove();
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
  const title = document.createElement("h3"); title.textContent = "Meta · Performance"; section.appendChild(title);
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
  link.textContent = "Abrir Performance Meta do cliente →";
  link.style.cssText = "display:inline-block;margin-top:5px;color:#72bfff;font-weight:800;font-size:10px;text-decoration:none";
  section.appendChild(link);
  root.appendChild(section);
}

function ensureCreativeStyles() {
  if (document.querySelector("style[data-meta-creatives-style]")) return;
  const style = document.createElement("style");
  style.dataset.metaCreativesStyle = "true";
  style.textContent = `
    [data-meta-performance-client]{margin-top:2px}
    .mpc-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:12px 0 4px;border-top:1px solid #173047;margin-top:12px}
    .mpc-tabs button{border:1px solid #1e3b53;background:#091a28;color:#7894ab;border-radius:9px;padding:8px 11px;font:800 9px/1 Inter,system-ui,sans-serif;cursor:pointer}
    .mpc-tabs button.active{background:#183d5d;border-color:#3f80ad;color:#e5f3ff}
    .mpc-refresh{margin-left:auto!important;color:#8bcaff!important}
    .mpc-state{padding:14px;border:1px solid #1c394f;border-radius:11px;background:#091925;color:#7892a7;font-size:10px;margin-top:10px}
    .mpc-overview{display:grid;grid-template-columns:minmax(280px,1.35fr) minmax(330px,1fr);gap:10px;margin-top:10px}
    .mpc-best{border:1px solid #24506f;background:#0b1d2c;border-radius:13px;overflow:hidden;display:grid;grid-template-columns:190px 1fr;min-height:190px}
    .mpc-best-media{background:#07111b;min-height:190px;display:grid;place-items:center;overflow:hidden}
    .mpc-best-media img{width:100%;height:100%;object-fit:cover;display:block}
    .mpc-placeholder{padding:20px;color:#66839b;text-align:center;font-size:9px}
    .mpc-best-copy{padding:15px;min-width:0}
    .mpc-eyebrow{font-size:8px;font-weight:900;letter-spacing:.09em;color:#68b7ff;text-transform:uppercase}
    .mpc-best h3{margin:6px 0 3px;font-size:17px;line-height:1.15;color:#f1f7fc;word-break:break-word}
    .mpc-best p{margin:0;color:#708ba2;font-size:9px;line-height:1.4}
    .mpc-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px}
    .mpc-metrics span{border-left:1px solid #21445c;padding-left:8px;min-width:0}
    .mpc-metrics span:first-child{border-left:0;padding-left:0}
    .mpc-metrics small,.mpc-metrics b{display:block}.mpc-metrics small{font-size:7px;color:#69849b}.mpc-metrics b{font-size:11px;color:#d8e7f2;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .mpc-signals{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .mpc-signal{border:1px solid #1c394f;border-radius:11px;background:#091925;padding:11px;min-width:0}
    .mpc-signal.warn{border-color:#624928;background:#211a12}.mpc-signal.good{border-color:#245447;background:#0d211c}.mpc-signal.bad{border-color:#60313b;background:#25171c}
    .mpc-signal small,.mpc-signal b,.mpc-signal span{display:block}.mpc-signal small{font-size:7px;font-weight:900;letter-spacing:.06em;color:#728ca2}.mpc-signal b{font-size:20px;margin:5px 0;color:#edf5fb}.mpc-signal span{font-size:8px;line-height:1.35;color:#71899e;word-break:break-word}
    .mpc-section-title{display:flex;justify-content:space-between;gap:10px;align-items:flex-end;margin:13px 0 8px}.mpc-section-title h3{margin:0;font-size:15px}.mpc-section-title p{margin:0;color:#70889e;font-size:8px}
    .mpc-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
    .mpc-card{border:1px solid #1a384f;background:#091925;border-radius:12px;overflow:hidden;min-width:0}
    .mpc-card-media{height:190px;background:#07111b;display:grid;place-items:center;overflow:hidden}.mpc-card-media img{width:100%;height:100%;object-fit:cover}.mpc-card-body{padding:10px}
    .mpc-card h4{margin:4px 0;font-size:11px;color:#e4edf5;line-height:1.25}.mpc-card p{margin:0;color:#6e899f;font-size:8px;line-height:1.4;min-height:24px}
    .mpc-card-stats{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:9px}.mpc-card-stats span{border-top:1px solid #19364c;padding-top:6px}.mpc-card-stats small,.mpc-card-stats b{display:block}.mpc-card-stats small{font-size:7px;color:#6b8499}.mpc-card-stats b{font-size:10px;color:#cfe0ec;margin-top:2px}
    .mpc-alert-list{display:grid;gap:7px;margin-top:10px}.mpc-alert{display:grid;grid-template-columns:110px 1fr auto;gap:10px;align-items:center;border:1px solid #1b394f;border-radius:10px;background:#091925;padding:10px}.mpc-alert.warn{border-color:#654b29;background:#211a12}.mpc-alert.bad{border-color:#61323c;background:#25171c}.mpc-alert.good{border-color:#245447;background:#0d211c}
    .mpc-alert>span{font-size:8px;font-weight:900;color:#7d9ab1;text-transform:uppercase}.mpc-alert b{display:block;font-size:10px;color:#e1edf6}.mpc-alert small{display:block;font-size:8px;color:#71899f;margin-top:2px}.mpc-alert strong{font-size:10px;color:#cfe1ee;text-align:right}
    .mpc-footnote{margin-top:9px;color:#617b91;font-size:8px;line-height:1.45}
    @media(max-width:900px){.mpc-overview{grid-template-columns:1fr}.mpc-grid{grid-template-columns:1fr 1fr}.mpc-best{grid-template-columns:150px 1fr}.mpc-refresh{margin-left:0!important}}
    @media(max-width:620px){.mpc-grid{grid-template-columns:1fr}.mpc-best{display:block}.mpc-best-media{height:220px}.mpc-signals{grid-template-columns:1fr}.mpc-alert{grid-template-columns:1fr}.mpc-alert strong{text-align:left}}
  `;
  document.head.appendChild(style);
}

function imageFor(row: Row | null | undefined) {
  return String(row?.thumbnail_url || row?.image_url || "").trim();
}
function sortedCreatives(rows: Row[]) {
  return [...rows].sort((a,b) => {
    const ar = finite(a.results) || 0, br = finite(b.results) || 0;
    if (br !== ar) return br - ar;
    const ac = finite(a.cost_per_result ?? a.cpl), bc = finite(b.cost_per_result ?? b.cpl);
    if (ac !== null && bc !== null && ac !== bc) return ac - bc;
    return (finite(b.spend) || 0) - (finite(a.spend) || 0);
  });
}
function creativeSignals(rows: Row[]) {
  const ranked = sortedCreatives(rows);
  const resultRows = ranked.filter(row => (finite(row.results) || 0) > 0);
  const best = resultRows[0] || ranked[0] || null;
  const waste = ranked.filter(row => (finite(row.spend) || 0) > 0 && (finite(row.results) || 0) <= 0).sort((a,b)=>(finite(b.spend)||0)-(finite(a.spend)||0));
  const fatigue = ranked.filter(row => (finite(row.frequency) || 0) >= 3 && (finite(row.impressions) || 0) > 0).sort((a,b)=>(finite(b.frequency)||0)-(finite(a.frequency)||0));
  const costs = resultRows.map(row => finite(row.cost_per_result ?? row.cpl)).filter((value): value is number => value !== null && value > 0);
  const med = median(costs);
  const scale = resultRows.filter(row => {
    const results = finite(row.results) || 0;
    const cost = finite(row.cost_per_result ?? row.cpl);
    return results >= 3 && cost !== null && med !== null && cost <= med;
  }).sort((a,b)=>(finite(b.results)||0)-(finite(a.results)||0));
  return { best, waste, fatigue, scale, medianCost: med };
}
function appendImage(root: HTMLElement, row: Row | null | undefined, className: string) {
  root.className = className;
  const src = imageFor(row);
  if (!src) {
    const placeholder = document.createElement("div"); placeholder.className = "mpc-placeholder"; placeholder.textContent = "Imagem do anúncio indisponível neste criativo."; root.appendChild(placeholder); return;
  }
  const img = document.createElement("img"); img.src = src; img.alt = String(row?.ad_name || row?.creative_name || "Criativo Meta"); img.loading = "lazy"; img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => { img.remove(); const placeholder = document.createElement("div"); placeholder.className = "mpc-placeholder"; placeholder.textContent = "A prévia expirou. Atualize os criativos para buscar uma nova imagem."; root.appendChild(placeholder); });
  root.appendChild(img);
}
function metricBox(label: string, value: string) {
  const span = document.createElement("span"); const small = document.createElement("small"); const b = document.createElement("b"); small.textContent = label; b.textContent = value; span.append(small,b); return span;
}
function signalCard(label:string,value:string,detail:string,tone="") {
  const card=document.createElement("article"); card.className=`mpc-signal ${tone}`.trim();
  const small=document.createElement("small");small.textContent=label;const b=document.createElement("b");b.textContent=value;const span=document.createElement("span");span.textContent=detail;card.append(small,b,span);return card;
}
function setCreativeTab(host: HTMLElement, tab: CreativeTab) {
  host.dataset.activeTab = tab;
  host.querySelectorAll<HTMLButtonElement>(".mpc-tabs button[data-tab]").forEach(button => button.classList.toggle("active", button.dataset.tab === tab));
  host.querySelectorAll<HTMLElement>("[data-mpc-panel]").forEach(panel => { panel.style.display = panel.dataset.mpcPanel === tab ? "block" : "none"; });
  const drawerBody = host.closest<HTMLElement>(".mp-drawer-body");
  const history = drawerBody?.querySelector<HTMLElement>(".mp-client-history");
  const campaigns = drawerBody?.querySelector<HTMLElement>(".mp-campaigns");
  const runs = drawerBody?.querySelector<HTMLElement>(".mp-client-runs");
  if (history) history.style.display = tab === "history" ? "block" : "none";
  if (campaigns) campaigns.style.display = tab === "campaigns" ? "block" : "none";
  if (runs) runs.style.display = ["history","campaigns"].includes(tab) ? "block" : "none";
}
function renderCreativePayload(host: HTMLElement, payload: Row | null) {
  const loading = host.querySelector<HTMLElement>("[data-mpc-loading]");
  const overview = host.querySelector<HTMLElement>("[data-mpc-panel='overview']");
  const creativesPanel = host.querySelector<HTMLElement>("[data-mpc-panel='creatives']");
  const alertsPanel = host.querySelector<HTMLElement>("[data-mpc-panel='alerts']");
  if (!overview || !creativesPanel || !alertsPanel) return;
  overview.replaceChildren(); creativesPanel.replaceChildren(); alertsPanel.replaceChildren();
  if (loading) loading.style.display = "none";
  const rows: Row[] = Array.isArray(payload?.creatives) ? payload!.creatives : [];
  const state = payload?.state || {};
  if (!payload || String(payload.error || "")) {
    const box=document.createElement("div");box.className="mpc-state";box.textContent=String(payload?.detail || payload?.error || "Não foi possível carregar os criativos da Meta.");overview.appendChild(box);creativesPanel.appendChild(box.cloneNode(true));alertsPanel.appendChild(box.cloneNode(true));return;
  }
  if (!rows.length) {
    const box=document.createElement("div");box.className="mpc-state";
    box.textContent=String(state.status)==="NO_META_ACCOUNT"?"Este cliente ainda não possui uma conta Meta legível para captura de criativos.":String(state.status)==="NO_DELIVERY"?"Nenhum anúncio teve entrega nesta janela.":String(state.status)==="ERROR"?`Falha ao consultar a Meta: ${state.last_error || "erro não detalhado"}`:"Ainda não há criativos capturados. Use Atualizar criativos para consultar a Meta.";
    overview.appendChild(box);creativesPanel.appendChild(box.cloneNode(true));alertsPanel.appendChild(box.cloneNode(true));return;
  }

  const signals=creativeSignals(rows); const best=signals.best;
  const wrap=document.createElement("div");wrap.className="mpc-overview";
  const bestCard=document.createElement("article");bestCard.className="mpc-best";
  const media=document.createElement("div");appendImage(media,best,"mpc-best-media");
  const copy=document.createElement("div");copy.className="mpc-best-copy";
  const eye=document.createElement("span");eye.className="mpc-eyebrow";eye.textContent="Melhor criativo da semana";
  const h=document.createElement("h3");h.textContent=String(best?.ad_name || best?.creative_name || "Criativo com melhor resultado");
  const p=document.createElement("p");p.textContent=[best?.campaign_name,best?.adset_name].filter(Boolean).join(" · ") || "Anúncio capturado diretamente da Meta";
  const metrics=document.createElement("div");metrics.className="mpc-metrics";
  metrics.append(metricBox("Resultados",number(best?.results,0)),metricBox("CPL / CPR",money(best?.cost_per_result ?? best?.cpl)),metricBox("Gasto",money(best?.spend)),metricBox("CTR",`${number(best?.ctr,2)}%`),metricBox("Frequência",number(best?.frequency,2)),metricBox("Alcance",number(best?.reach,0)));
  copy.append(eye,h,p,metrics);bestCard.append(media,copy);
  const signalGrid=document.createElement("div");signalGrid.className="mpc-signals";
  signalGrid.append(
    signalCard("MELHOR CRIATIVO DA SEMANA",best?number(best.results,0):"0",best?`${money(best.cost_per_result ?? best.cpl)} por resultado · ${String(best.ad_name || "anúncio")}`:"Sem resultado nesta janela","good"),
    signalCard("CRIATIVOS GASTANDO SEM RESULTADO",String(signals.waste.length),signals.waste[0]?`${String(signals.waste[0].ad_name || "Anúncio")} já gastou ${money(signals.waste[0].spend)}`:"Nenhum criativo nessa situação",signals.waste.length?"bad":"good"),
    signalCard("POSSÍVEL FADIGA",String(signals.fatigue.length),signals.fatigue[0]?`${String(signals.fatigue[0].ad_name || "Anúncio")} · frequência ${number(signals.fatigue[0].frequency,2)}`:"Nenhum sinal por frequência ≥ 3",signals.fatigue.length?"warn":"good"),
    signalCard("OPORTUNIDADES DE ESCALA",String(signals.scale.length),signals.scale[0]?`${String(signals.scale[0].ad_name || "Anúncio")} · ${number(signals.scale[0].results,0)} resultados a ${money(signals.scale[0].cost_per_result ?? signals.scale[0].cpl)}`:"Sem sinal suficiente nesta janela",signals.scale.length?"good":"")
  );
  wrap.append(bestCard,signalGrid); overview.appendChild(wrap);
  const note=document.createElement("p");note.className="mpc-footnote";note.textContent="Regras de leitura: possível fadiga = frequência ≥ 3; oportunidade de escala = pelo menos 3 resultados e custo por resultado igual ou melhor que a mediana dos criativos com resultado. São sinais operacionais, não decisões automáticas.";overview.appendChild(note);

  const creativeTitle=document.createElement("div");creativeTitle.className="mpc-section-title";const titleText=document.createElement("div");const ct=document.createElement("h3");ct.textContent=`Criativos · últimos ${payload?.period_days || 7} dias`;const cp=document.createElement("p");cp.textContent="Imagem real do anúncio + métricas capturadas pela Meta";titleText.append(ct,cp);const freshness=document.createElement("p");freshness.textContent=state.finished_at?`Atualizado ${new Intl.DateTimeFormat("pt-BR",{dateStyle:"short",timeStyle:"short"}).format(new Date(state.finished_at))}`:"Sem atualização";creativeTitle.append(titleText,freshness);creativesPanel.appendChild(creativeTitle);
  const grid=document.createElement("div");grid.className="mpc-grid";
  sortedCreatives(rows).forEach(row=>{
    const card=document.createElement("article");card.className="mpc-card";const cardMedia=document.createElement("div");appendImage(cardMedia,row,"mpc-card-media");const body=document.createElement("div");body.className="mpc-card-body";
    const eye=document.createElement("span");eye.className="mpc-eyebrow";eye.textContent=String(row.ad_status || "ANÚNCIO");const h4=document.createElement("h4");h4.textContent=String(row.ad_name || row.creative_name || row.ad_id || "Criativo");const desc=document.createElement("p");desc.textContent=[row.campaign_name,row.adset_name].filter(Boolean).join(" · ") || "—";const stats=document.createElement("div");stats.className="mpc-card-stats";stats.append(metricBox("Gasto",money(row.spend)),metricBox("Resultados",number(row.results,0)),metricBox("CPL / CPR",money(row.cost_per_result ?? row.cpl)),metricBox("CTR",`${number(row.ctr,2)}%`),metricBox("Frequência",number(row.frequency,2)),metricBox("Impressões",number(row.impressions,0)));body.append(eye,h4,desc,stats);card.append(cardMedia,body);grid.appendChild(card);
  }); creativesPanel.appendChild(grid);

  const alertsTitle=document.createElement("div");alertsTitle.className="mpc-section-title";const at=document.createElement("div");const ah=document.createElement("h3");ah.textContent="Alertas de criativo";const ap=document.createElement("p");ap.textContent="Sinais para o GT investigar antes de tomar ação";at.append(ah,ap);alertsTitle.appendChild(at);alertsPanel.appendChild(alertsTitle);
  const list=document.createElement("div");list.className="mpc-alert-list";
  const addAlert=(tone:string,label:string,row:Row,detail:string,value:string)=>{const a=document.createElement("article");a.className=`mpc-alert ${tone}`;const kind=document.createElement("span");kind.textContent=label;const middle=document.createElement("div");const b=document.createElement("b");b.textContent=String(row.ad_name || row.creative_name || "Anúncio");const small=document.createElement("small");small.textContent=detail;middle.append(b,small);const strong=document.createElement("strong");strong.textContent=value;a.append(kind,middle,strong);list.appendChild(a);};
  signals.waste.forEach(row=>addAlert("bad","Sem resultado",row,`${money(row.spend)} gastos · ${number(row.impressions,0)} impressões`,"Revisar"));
  signals.fatigue.forEach(row=>addAlert("warn","Possível fadiga",row,`${number(row.results,0)} resultados · CTR ${number(row.ctr,2)}%`, `Freq. ${number(row.frequency,2)}`));
  signals.scale.forEach(row=>addAlert("good","Pode escalar",row,`${number(row.results,0)} resultados · gasto ${money(row.spend)}`,money(row.cost_per_result ?? row.cpl)));
  if (!list.children.length) { const empty=document.createElement("div");empty.className="mpc-state";empty.textContent="Nenhum sinal de criativo foi disparado nesta janela.";alertsPanel.appendChild(empty); } else alertsPanel.appendChild(list);
}

function installCreativeShell(drawer: HTMLElement, clientId: string, onRefresh: () => Promise<Row | null>) {
  ensureCreativeStyles();
  const body=drawer.querySelector<HTMLElement>(".mp-drawer-body"); if(!body)return null;
  const existing=body.querySelector<HTMLElement>("[data-meta-performance-client]"); if(existing)return existing;
  const drawerTitle=drawer.querySelector<HTMLElement>(".mp-drawer-head b"); if(drawerTitle)drawerTitle.textContent="Performance Meta do cliente";
  const hero=body.querySelector<HTMLElement>(".mp-client-hero");
  const host=document.createElement("section");host.dataset.metaPerformanceClient="true";host.dataset.clientId=clientId;
  const tabs=document.createElement("nav");tabs.className="mpc-tabs";
  const defs:[CreativeTab,string][]=[["overview","Visão geral"],["creatives","Criativos"],["campaigns","Campanhas"],["alerts","Alertas"],["history","Histórico"]];
  defs.forEach(([key,label])=>{const btn=document.createElement("button");btn.dataset.tab=key;btn.textContent=label;btn.addEventListener("click",()=>setCreativeTab(host,key));tabs.appendChild(btn);});
  const refresh=document.createElement("button");refresh.className="mpc-refresh";refresh.textContent="Atualizar criativos";refresh.addEventListener("click",async()=>{refresh.disabled=true;refresh.textContent="Atualizando…";const payload=await onRefresh();renderCreativePayload(host,payload);refresh.disabled=false;refresh.textContent="Atualizar criativos";});tabs.appendChild(refresh);host.appendChild(tabs);
  const loading=document.createElement("div");loading.dataset.mpcLoading="true";loading.className="mpc-state";loading.textContent="Buscando criativos e métricas da Meta…";host.appendChild(loading);
  (["overview","creatives","alerts"] as CreativeTab[]).forEach(key=>{const panel=document.createElement("div");panel.dataset.mpcPanel=key;panel.style.display="none";host.appendChild(panel);});
  if(hero?.nextSibling)body.insertBefore(host,hero.nextSibling);else body.appendChild(host);
  setCreativeTab(host,"overview");
  return host;
}
function normalizePerformancePageCopy() {
  if (window.location.pathname !== "/meta-performance") return;
  const kicker=document.querySelector<HTMLElement>(".mp-kicker"); if(kicker)kicker.textContent="INTELIGÊNCIA DE TRÁFEGO · PERFORMANCE";
  Array.from(document.querySelectorAll<HTMLButtonElement>(".mp-tabs button")).forEach(button=>{if(norm(button.textContent)==="relatorio semanal")button.textContent="Snapshot semanal";});
  const drawerTitle=document.querySelector<HTMLElement>(".mp-drawer-head b"); if(drawerTitle)drawerTitle.textContent="Performance Meta do cliente";
}

export default function MetaPerformanceProfileBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowed, setAllowed] = useState(false);
  const clientCache = useRef(new Map<string,{at:number;body:Row}>());
  const creativeCache = useRef(new Map<string,{at:number;body:Row}>());
  const creativeInflight = useRef(new Map<string,Promise<Row | null>>());
  const notifications = useRef<{ at:number; rows:Row[] }>({ at:0, rows:[] });

  useEffect(() => {
    supabase.auth.getSession().then(({data}) => setSession(data.session));
    const { data:{subscription} } = supabase.auth.onAuthStateChange((_e,next) => { setSession(next); if(!next){setAllowed(false);clientCache.current.clear();creativeCache.current.clear();creativeInflight.current.clear();removeInjected();} });
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
  const requestCreatives = useCallback(async(clientId:string,refresh=false) => {
    const h=headers(); if(!h)return null;
    const key=`${clientId}:7`;const cached=creativeCache.current.get(key);
    if(!refresh&&cached&&Date.now()-cached.at<30000)return cached.body;
    const inflightKey=`${key}:${refresh?"refresh":"read"}`;
    const existing=creativeInflight.current.get(inflightKey);if(existing)return existing;
    const task=(async()=>{
      const options:RequestInit=refresh?{method:"POST",headers:{...h,"content-type":"application/json"},body:JSON.stringify({client_id:clientId,period_days:7,force:true}),cache:"no-store"}:{headers:h,cache:"no-store"};
      const response=await fetch(`${CREATIVES_API}?client_id=${encodeURIComponent(clientId)}&period_days=7`,options);
      const body=await response.json().catch(()=>({error:`API ${response.status}`}));
      const normalized=response.ok?body:{...body,error:body?.error||`API ${response.status}`};
      creativeCache.current.set(key,{at:Date.now(),body:normalized});return normalized;
    })().finally(()=>creativeInflight.current.delete(inflightKey));
    creativeInflight.current.set(inflightKey,task);return task;
  },[headers]);
  const loadCreatives = useCallback(async(clientId:string) => {
    const cached=await requestCreatives(clientId,false); if(!cached)return null;
    if(cached?.stale || !Array.isArray(cached?.creatives) || cached.creatives.length===0) return await requestCreatives(clientId,true);
    return cached;
  },[requestCreatives]);
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
          normalizePerformancePageCopy();
          if(window.location.pathname==="/"){
            installNav();
            const drawer=document.querySelector<HTMLElement>(".drawer.open");
            const grid=drawer?.querySelector<HTMLElement>(".drawer-body .detail-grid");
            if(!drawer||!grid||grid.querySelector("[data-meta-performance-client]"))return;
            const name=drawer.querySelector<HTMLElement>(".drawer-head h2")?.textContent?.trim();
            if(!name)return;
            const detail=await loadClient(name),clientId=String(detail?.client?.id||"");
            if(!clientId)return;
            const snaps:Row[]=(detail?.snapshots||[]).sort((a:Row,b:Row)=>String(b.snapshot_date).localeCompare(String(a.snapshot_date))||Number(a.period_days)-Number(b.period_days));
            renderClientCard(grid,snaps,clientId);
            return;
          }
          if(window.location.pathname!=="/meta-performance")return;
          const drawer=document.querySelector<HTMLElement>(".mp-drawer");
          const clientId=new URL(window.location.href).searchParams.get("client")||"";
          if(!drawer||!clientId)return;
          const host=installCreativeShell(drawer,clientId,async()=>await requestCreatives(clientId,true));
          if(!host||host.dataset.loaded==="true")return;
          host.dataset.loaded="true";
          const creativePayload=await loadCreatives(clientId);
          if(document.body.contains(host))renderCreativePayload(host,creativePayload);
        }finally{applying=false;}
      });
    };
    apply();
    const observer=new MutationObserver(apply); observer.observe(document.body,{childList:true,subtree:true});
    const interval=window.setInterval(apply,1500);
    const route=()=>apply(); window.addEventListener("popstate",route);
    return()=>{observer.disconnect();clearInterval(interval);cancelAnimationFrame(frame);window.removeEventListener("popstate",route);removeInjected();};
  },[allowed,loadClient,loadCreatives,requestCreatives]);

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
