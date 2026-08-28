"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
type Payload = {
  client?: Row;
  fiscal?: Row;
  management?: Row | null;
  permissions?: Row;
};

const API = `${SUPABASE_URL}/functions/v1/agency-ops-client-commercial-profile-api`;
const STYLE_ID = "client-commercial-profile-bridge-style";
const SLOT_CLASS = "client-commercial-profile-slot";

const brl = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "—";
};
const date = (value: unknown) => {
  if (!value) return "—";
  const d = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return Number.isNaN(d.getTime()) ? String(value) : new Intl.DateTimeFormat("pt-BR").format(d);
};

function line(label: string, value: unknown, strong = false) {
  const p = document.createElement("p");
  const b = document.createElement("b");
  b.textContent = `${label}: `;
  p.appendChild(b);
  const content = document.createElement(strong ? "strong" : "span");
  content.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
  p.appendChild(content);
  return p;
}

function makeBadge(text: string, tone = "") {
  const span = document.createElement("span");
  span.className = `client-commercial-badge${tone ? ` ${tone}` : ""}`;
  span.textContent = text;
  return span;
}

function render(slot: HTMLElement, payload: Payload) {
  slot.replaceChildren();
  const fiscal = payload.fiscal || {};
  const management = payload.management || null;

  const head = document.createElement("div");
  head.className = "client-commercial-head";
  const title = document.createElement("h3");
  title.textContent = "Dados fiscais";
  head.appendChild(title);
  head.appendChild(makeBadge(fiscal.identified ? "CONFIRMADO" : "PENDENTE", fiscal.identified ? "ok" : "warn"));
  slot.appendChild(head);

  if (fiscal.legal_name) slot.appendChild(line("Razão social", fiscal.legal_name));
  if (fiscal.identified) {
    slot.appendChild(line(String(fiscal.fiscal_type || "Documento"), fiscal.fiscal_value, true));
    if (String(fiscal.fiscal_type || "") === "CNPJ") {
      const note = document.createElement("small");
      note.className = "client-commercial-note";
      note.textContent = "CNPJ priorizado. CPF só é exibido como documento fiscal quando não há CNPJ cadastrado.";
      slot.appendChild(note);
    }
  } else {
    const p = document.createElement("p");
    p.className = "client-commercial-missing";
    p.textContent = "CNPJ/CPF ainda não identificado no cadastro fiscal deste cliente.";
    slot.appendChild(p);
  }

  if (!management) return;

  const divider = document.createElement("div");
  divider.className = "client-commercial-private";
  const privateHead = document.createElement("div");
  privateHead.className = "client-commercial-head";
  const privateTitle = document.createElement("h3");
  privateTitle.textContent = "Contrato e comercial";
  privateHead.appendChild(privateTitle);
  privateHead.appendChild(makeBadge("PRIVADO · ADLER / LEONARDO", "private"));
  divider.appendChild(privateHead);

  const grid = document.createElement("div");
  grid.className = "client-commercial-grid";
  const colA = document.createElement("div");
  const colB = document.createElement("div");

  if (management.representative_name) colA.appendChild(line("Representante", management.representative_name));
  if (management.representative_cpf) colA.appendChild(line("CPF do representante", management.representative_cpf));
  colA.appendChild(line("Mensalidade", brl(management.monthly_value), true));
  colA.appendChild(line("Implementação", brl(management.implementation_value), true));
  if (management.implementation_due_timing) colA.appendChild(line("Pagamento da implementação", management.implementation_due_timing));
  if (management.first_monthly_due_terms) colA.appendChild(line("Primeira mensalidade", management.first_monthly_due_terms));

  colB.appendChild(line("Prazo contratual", management.term_months ? `${management.term_months} meses` : "—"));
  colB.appendChild(line("Início", date(management.contract_start_date)));
  colB.appendChild(line("Término", date(management.contract_end_date)));
  if (management.document_name) colB.appendChild(line("Contrato", management.document_name));
  if (management.contract_status) colB.appendChild(line("Status do contrato", management.contract_status));
  colB.appendChild(line("Verba mínima de mídia indicada", management.minimum_ad_budget == null ? "—" : `${brl(management.minimum_ad_budget)}/mês`));

  grid.append(colA, colB);
  divider.appendChild(grid);

  if (management.implementation_payment_terms) {
    const terms = document.createElement("div");
    terms.className = "client-commercial-warning";
    const b = document.createElement("b");
    b.textContent = "Condição de implementação: ";
    terms.appendChild(b);
    terms.appendChild(document.createTextNode(String(management.implementation_payment_terms)));
    divider.appendChild(terms);
  }
  if (management.commercial_evidence) {
    const evidence = document.createElement("small");
    evidence.className = "client-commercial-evidence";
    evidence.textContent = `Fonte comercial: ${String(management.commercial_evidence)}`;
    divider.appendChild(evidence);
  }

  slot.appendChild(divider);
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.${SLOT_CLASS}{grid-column:1/-1;border:1px solid rgba(59,130,246,.24);border-radius:14px;padding:15px 16px;background:rgba(59,130,246,.035);min-width:0}
.${SLOT_CLASS} h3{margin:0;font-size:14px}.client-commercial-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.client-commercial-badge{font-size:9px;font-weight:900;letter-spacing:.07em;border:1px solid rgba(148,163,184,.25);border-radius:999px;padding:4px 7px;white-space:nowrap}.client-commercial-badge.ok{color:#34d399;background:rgba(16,185,129,.08);border-color:rgba(16,185,129,.22)}.client-commercial-badge.warn{color:#f59e0b;background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.22)}.client-commercial-badge.private{color:#a78bfa;background:rgba(139,92,246,.10);border-color:rgba(139,92,246,.25)}
.${SLOT_CLASS} p{margin:6px 0;line-height:1.45;font-size:12px}.client-commercial-note,.client-commercial-evidence{display:block;color:var(--muted);font-size:10px;line-height:1.45;margin-top:7px}.client-commercial-missing{color:var(--muted)}.client-commercial-private{border-top:1px solid var(--line);margin-top:13px;padding-top:13px}.client-commercial-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 22px}.client-commercial-warning{margin-top:10px;padding:10px 11px;border:1px solid rgba(245,158,11,.24);border-radius:10px;background:rgba(245,158,11,.06);font-size:11px;line-height:1.5}.client-commercial-loading{color:var(--muted);font-size:11px}.client-commercial-error{color:#f87171;font-size:11px}
.ops-360-grid>.${SLOT_CLASS}{grid-column:1/-1}.leo-client-dossier-grid>.${SLOT_CLASS}{grid-column:1/-1;margin-bottom:0}
@media(max-width:720px){.client-commercial-grid{grid-template-columns:1fr}.client-commercial-head{align-items:flex-start;flex-direction:column}.client-commercial-badge{white-space:normal}}
`;
  document.head.appendChild(style);
}

function targets() {
  const result: Array<{ root: HTMLElement; anchor: HTMLElement; heading: HTMLElement; kind: string }> = [];
  const drawer = document.querySelector(".drawer.open") as HTMLElement | null;
  const drawerGrid = drawer?.querySelector(".detail-grid") as HTMLElement | null;
  const drawerHeading = drawer?.querySelector(".drawer-head h2") as HTMLElement | null;
  if (drawer && drawerGrid && drawerHeading) result.push({ root: drawer, anchor: drawerGrid, heading: drawerHeading, kind: "drawer" });

  const view360 = document.querySelector(".ops-360") as HTMLElement | null;
  const view360Grid = view360?.querySelector(".ops-360-grid") as HTMLElement | null;
  const view360Heading = view360?.querySelector(".ops-360-head h2") as HTMLElement | null;
  if (view360 && view360Grid && view360Heading) result.push({ root: view360, anchor: view360Grid, heading: view360Heading, kind: "360" });

  const leo = document.querySelector(".leo-client-dossier") as HTMLElement | null;
  const leoGrid = leo?.querySelector(".leo-client-dossier-grid") as HTMLElement | null;
  const leoHeading = leo?.querySelector(".workspace-head h2") as HTMLElement | null;
  if (leo && leoGrid && leoHeading) result.push({ root: leo, anchor: leoGrid, heading: leoHeading, kind: "leonardo" });
  return result;
}

export default function ClientCommercialProfileBridge() {
  useEffect(() => {
    ensureStyle();
    let active = true;
    let scanning = false;
    const cache = new Map<string, { at: number; payload: Payload }>();

    async function load(name: string): Promise<Payload | null> {
      const cached = cache.get(name);
      if (cached && Date.now() - cached.at < 30_000) return cached.payload;
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return null;
      const response = await fetch(`${API}?name=${encodeURIComponent(name)}`, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      if (response.status === 403 || response.status === 404) return null;
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) throw new Error(payload?.error || `API ${response.status}`);
      cache.set(name, { at: Date.now(), payload });
      return payload;
    }

    async function scan() {
      if (!active || scanning) return;
      scanning = true;
      try {
        for (const target of targets()) {
          const name = (target.heading.textContent || "").trim();
          if (!name || /carregando|buscando/i.test(name)) continue;
          let slot = target.anchor.querySelector(`:scope > .${SLOT_CLASS}`) as HTMLElement | null;
          if (!slot) {
            slot = document.createElement("section");
            slot.className = SLOT_CLASS;
            target.anchor.insertBefore(slot, target.anchor.firstChild);
          }
          const key = `${target.kind}:${name}`;
          if (slot.dataset.profileKey === key && slot.dataset.profileState === "ready") continue;
          slot.dataset.profileKey = key;
          slot.dataset.profileState = "loading";
          slot.replaceChildren();
          const loading = document.createElement("span");
          loading.className = "client-commercial-loading";
          loading.textContent = "Carregando dados fiscais…";
          slot.appendChild(loading);
          try {
            const payload = await load(name);
            if (!active || slot.dataset.profileKey !== key) continue;
            if (!payload) { slot.remove(); continue; }
            render(slot, payload);
            slot.dataset.profileState = "ready";
          } catch (error) {
            if (!active || slot.dataset.profileKey !== key) continue;
            slot.replaceChildren();
            const message = document.createElement("span");
            message.className = "client-commercial-error";
            message.textContent = "Não foi possível carregar os dados fiscais agora.";
            slot.appendChild(message);
            slot.dataset.profileState = "error";
          }
        }
      } finally {
        scanning = false;
      }
    }

    void scan();
    const observer = new MutationObserver(() => { void scan(); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const timer = window.setInterval(() => { void scan(); }, 1200);
    return () => {
      active = false;
      observer.disconnect();
      window.clearInterval(timer);
      document.querySelectorAll(`.${SLOT_CLASS}`).forEach((node) => node.remove());
      document.getElementById(STYLE_ID)?.remove();
    };
  }, []);
  return null;
}
