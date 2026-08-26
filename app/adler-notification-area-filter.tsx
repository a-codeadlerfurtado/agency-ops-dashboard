"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const FINANCE_PROBE = `${SUPABASE_URL}/functions/v1/agency-ops-adler-finance-api?probe=1`;
const STORAGE_KEY = "adler-notification-area-filter";

type Area = "ALL" | "TRAFEGO" | "DESIGN" | "CS" | "IA_TECH" | "OPERACOES" | "OUTROS";

const AREAS: Array<{ key: Area; label: string }> = [
  { key: "ALL", label: "Todas" },
  { key: "TRAFEGO", label: "Tráfego" },
  { key: "DESIGN", label: "Design" },
  { key: "CS", label: "CS" },
  { key: "IA_TECH", label: "IA / Tech" },
  { key: "OPERACOES", label: "Operações" },
  { key: "OUTROS", label: "Outros" },
];

function norm(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classify(raw: unknown): Exclude<Area, "ALL"> {
  const t = norm(raw);

  // Ordem intencional: o assunto da demanda vale mais que a tecnologia/origem usada
  // para gera-la. Ex.: "retorno ao cliente sobre qualificacao de leads" e CS, nao trafego.
  if (/(retorno ao cliente|cliente aguard|sem resposta|bom dia|feedback|qualificacao dos leads|atendimento|follow up|reuniao de apresentacao|produto persona|onboarding|sucesso do cliente|\bcs\b|joel antoniete|\bjoel\b|gustavo lima|\bgustavo\b)/.test(t)) return "CS";
  if (/(criativ|designer|\bdesign\b|\barte\b|carrossel|\bstory\b|stories|\bfeed\b|\bvideo\b|estatico|nycollas|filipe azevedo|davi henrique|aprovacao interna)/.test(t)) return "DESIGN";
  if (/(inteligencia artificial|\bia\b|\bcrm\b|automacao|webhook|supabase|\bapi\b|donnah|agente de ia|integracao ia|castro|gabriel castro|\btech\b)/.test(t)) return "IA_TECH";
  if (/(trafego|campanha|\bmeta\b|facebook ads|google ads|\bads\b|\bcpl\b|\bcpa\b|\bctr\b|\bcpc\b|saldo|orcamento|anuncio|pixel|publico|segmentacao|gestor de trafego|felipe oliveira|yuri melo|rodrigo cavalheiro|breno oliveira|danilo oliveira|joao margiotta|vitor hugo)/.test(t)) return "TRAFEGO";
  if (/(operacao|task engine|central de trabalho|radar gerencial|\bsla\b|pendencia gerencial|gestao|gerente operacional|adler furtado|auditoria|\bclickup\b|alerta operacional)/.test(t)) return "OPERACOES";
  return "OUTROS";
}

function readFilter(): Area {
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY) as Area | null;
    return AREAS.some((area) => area.key === saved) ? saved! : "ALL";
  } catch {
    return "ALL";
  }
}

function writeFilter(value: Area) {
  try { window.sessionStorage.setItem(STORAGE_KEY, value); } catch { /* sem storage */ }
}

function addStyles() {
  if (document.getElementById("adler-notification-area-filter-css")) return;
  const style = document.createElement("style");
  style.id = "adler-notification-area-filter-css";
  style.textContent = `
    .adler-notification-area-filter{display:grid;gap:7px;margin:10px 0 12px;padding:10px;border:1px solid rgba(91,153,204,.18);border-radius:12px;background:rgba(12,28,43,.72)}
    .adler-notification-area-filter-label{font:800 9px/1 Inter,system-ui,sans-serif;letter-spacing:.12em;color:#6f8ba4;text-transform:uppercase}
    .adler-notification-area-filter-buttons{display:flex;gap:6px;flex-wrap:wrap}
    .adler-notification-area-filter button{border:1px solid rgba(103,156,200,.18);border-radius:999px;padding:6px 9px;background:rgba(255,255,255,.025);color:#8fa8bd;font:700 10px/1 Inter,system-ui,sans-serif;cursor:pointer;transition:.15s ease}
    .adler-notification-area-filter button:hover{border-color:rgba(103,199,255,.38);color:#dff3ff}
    .adler-notification-area-filter button.active{border-color:rgba(103,199,255,.48);background:rgba(49,132,191,.18);color:#e9f8ff}
    .adler-notification-area-filter button b{margin-left:4px;color:#65c7ff;font-size:9px}
    .adler-notification-area-empty{padding:18px 10px;text-align:center;color:#7892a8;font:600 11px/1.4 Inter,system-ui,sans-serif;border-top:1px solid rgba(255,255,255,.06)}
    .nh-area-filter-wrap{margin:-6px 0 18px}
    @media(max-width:680px){.adler-notification-area-filter-buttons{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))}.adler-notification-area-filter button{width:100%;padding:7px 5px}}
  `;
  document.head.appendChild(style);
}

function removeUi() {
  document.querySelectorAll("[data-adler-notification-area-filter]").forEach((node) => node.remove());
  document.querySelectorAll<HTMLElement>("[data-adler-notification-area]").forEach((node) => {
    node.style.display = "";
    delete node.dataset.adlerNotificationArea;
  });
  document.querySelectorAll("[data-adler-notification-area-empty]").forEach((node) => node.remove());
}

function buildFilterBar(host: Element, marker: string, getNodes: () => HTMLElement[], current: () => Area, setCurrent: (area: Area) => void) {
  let bar = host.querySelector<HTMLElement>(`[data-adler-notification-area-filter=\"${marker}\"]`);
  if (!bar) {
    bar = document.createElement("div");
    bar.className = `adler-notification-area-filter${marker === "page" ? " nh-area-filter-wrap" : ""}`;
    bar.dataset.adlerNotificationAreaFilter = marker;
    const label = document.createElement("div");
    label.className = "adler-notification-area-filter-label";
    label.textContent = "Filtrar notificações por área";
    const buttons = document.createElement("div");
    buttons.className = "adler-notification-area-filter-buttons";
    AREAS.forEach(({ key, label: text }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.area = key;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setCurrent(key);
      });
      button.innerHTML = `<span>${text}</span><b>0</b>`;
      buttons.appendChild(button);
    });
    bar.append(label, buttons);
    host.appendChild(bar);
  }

  const nodes = getNodes();
  const counts: Record<Area, number> = { ALL: nodes.length, TRAFEGO: 0, DESIGN: 0, CS: 0, IA_TECH: 0, OPERACOES: 0, OUTROS: 0 };
  nodes.forEach((node) => {
    const area = classify(node.textContent);
    node.dataset.adlerNotificationArea = area;
    counts[area] += 1;
    node.style.display = current() === "ALL" || current() === area ? "" : "none";
  });

  bar.querySelectorAll<HTMLButtonElement>("button[data-area]").forEach((button) => {
    const area = button.dataset.area as Area;
    button.classList.toggle("active", area === current());
    button.setAttribute("aria-pressed", area === current() ? "true" : "false");
    const count = button.querySelector("b");
    if (count) count.textContent = String(counts[area] ?? 0);
  });

  let empty = host.querySelector<HTMLElement>(`[data-adler-notification-area-empty=\"${marker}\"]`);
  const visibleCount = current() === "ALL" ? nodes.length : counts[current()];
  if (!visibleCount && nodes.length) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "adler-notification-area-empty";
      empty.dataset.adlerNotificationAreaEmpty = marker;
      host.appendChild(empty);
    }
    empty.textContent = "Nenhuma notificação desta área neste recorte.";
  } else empty?.remove();
}

export default function AdlerNotificationAreaFilter() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setAllowed(false); return; }
    let active = true;
    authenticatedFetch(FINANCE_PROBE, { cache: "no-store" })
      .then((response) => { if (active) setAllowed(response.ok); })
      .catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => {
    if (!allowed) { removeUi(); return; }
    addStyles();
    let filter = readFilter();
    let frame = 0;
    let applying = false;

    const setFilter = (next: Area) => {
      filter = next;
      writeFilter(next);
      apply();
    };

    const apply = () => {
      if (applying) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        applying = true;
        try {
          const panel = document.querySelector<HTMLElement>(".notification-panel");
          const list = panel?.querySelector<HTMLElement>(".notification-list");
          if (panel && list) {
            const host = panel;
            let bar = host.querySelector<HTMLElement>("[data-adler-notification-area-filter=\"panel\"]");
            if (!bar) {
              bar = document.createElement("div");
              bar.dataset.adlerNotificationAreaFilter = "panel";
              // buildFilterBar cria o conteudo; este placeholder so' garante a posicao correta.
              const markRead = panel.querySelector(".mark-read");
              if (markRead?.nextSibling) panel.insertBefore(bar, markRead.nextSibling);
              else panel.insertBefore(bar, list);
              bar.remove();
            }
            buildFilterBar(panel, "panel", () => Array.from(list.children).filter((node): node is HTMLElement => node instanceof HTMLElement && !node.hasAttribute("data-adler-notification-area-empty")), () => filter, setFilter);
            const built = panel.querySelector<HTMLElement>("[data-adler-notification-area-filter=\"panel\"]");
            if (built && built.nextElementSibling !== list) panel.insertBefore(built, list);
          }

          const page = document.querySelector<HTMLElement>(".nh-page");
          const pageList = page?.querySelector<HTMLElement>(".nh-list");
          const statusFilters = page?.querySelector<HTMLElement>(".nh-filters");
          if (page && pageList && statusFilters) {
            buildFilterBar(page, "page", () => Array.from(pageList.querySelectorAll<HTMLElement>(".nh-item")), () => filter, setFilter);
            const built = page.querySelector<HTMLElement>("[data-adler-notification-area-filter=\"page\"]");
            if (built && statusFilters.nextSibling !== built) statusFilters.parentElement?.insertBefore(built, statusFilters.nextSibling);
          }
        } finally {
          applying = false;
        }
      });
    };

    apply();
    const observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) => node instanceof HTMLElement && node.hasAttribute("data-adler-notification-area-filter")))) return;
      apply();
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      removeUi();
    };
  }, [allowed]);

  return null;
}
