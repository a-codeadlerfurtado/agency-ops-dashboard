"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
const API = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-history-api`;

function precisionMeta(row: Row) {
  const precision = String(row?.summary?.campaign_timestamp_precision || "").toUpperCase();
  const note = String(row?.summary?.campaign_timestamp_note || "").trim();
  if (precision === "EXACT") return { label: "✓ data/hora confirmada", tone: "exact", note };
  if (precision === "APPROXIMATE") return { label: "≈ data reconstruída", tone: "approx", note };
  if (precision === "UPPER_BOUND") return { label: "≤ campanha já existia até esta data", tone: "bound", note };
  return null;
}

export default function OnboardingHistoryPrecisionBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<Row[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token || typeof window === "undefined" || !window.location.pathname.startsWith("/onboarding-overview/history")) return;
    let cancelled = false;
    fetch(API, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!cancelled && response.ok) setItems(Array.isArray(body?.items) ? body.items : []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [session?.access_token]);

  useEffect(() => {
    if (!items.length || typeof document === "undefined") return;
    const map = new Map(items.map((item) => [String(item.client_display_name || "").trim(), item]));

    const decorate = () => {
      if (!window.location.pathname.startsWith("/onboarding-overview/history")) return;

      document.querySelectorAll<HTMLTableRowElement>(".oh-table tbody tr").forEach((row) => {
        const client = row.querySelector<HTMLTableCellElement>("td:first-child b")?.textContent?.trim() || "";
        const item = map.get(client);
        const meta = item ? precisionMeta(item) : null;
        const periodCell = row.querySelector<HTMLTableCellElement>("td:nth-child(2)");
        if (!meta || !periodCell || periodCell.querySelector("[data-oh-precision]") ) return;
        const badge = document.createElement("small");
        badge.dataset.ohPrecision = "1";
        badge.className = `oh-precision ${meta.tone}`;
        badge.textContent = meta.label;
        badge.title = meta.note || meta.label;
        periodCell.appendChild(badge);
      });

      const drawer = document.querySelector<HTMLElement>(".oh-drawer");
      const client = drawer?.querySelector<HTMLElement>(".oh-hero h2")?.textContent?.trim() || "";
      const item = map.get(client);
      const meta = item ? precisionMeta(item) : null;
      const hero = drawer?.querySelector<HTMLElement>(".oh-hero");
      if (meta && hero && !hero.querySelector("[data-oh-precision-detail]")) {
        const detail = document.createElement("div");
        detail.dataset.ohPrecisionDetail = "1";
        detail.className = `oh-precision-detail ${meta.tone}`;
        detail.innerHTML = `<b>${meta.label}</b><span>${meta.note || "Precisão temporal registrada no backfill."}</span>`;
        hero.insertAdjacentElement("afterend", detail);
      }
    };

    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [items]);

  return <style>{`
    .oh-precision{display:block!important;margin-top:5px!important;font-size:9px!important;font-weight:850!important;letter-spacing:.02em!important;white-space:normal!important}
    .oh-precision.exact{color:#78d9ad!important}.oh-precision.approx{color:#f2c979!important}.oh-precision.bound{color:#f0a36f!important}
    .oh-precision-detail{margin:10px 0 0;padding:11px 13px;border-radius:11px;border:1px solid rgba(114,155,189,.18);background:rgba(10,25,38,.72);display:flex;gap:8px;align-items:flex-start;flex-direction:column;font-family:Inter,system-ui,sans-serif}
    .oh-precision-detail b{font-size:10px;letter-spacing:.03em}.oh-precision-detail span{font-size:11px;line-height:1.45;color:#9fb2c2}
    .oh-precision-detail.exact{border-color:rgba(69,187,136,.25)}.oh-precision-detail.exact b{color:#86dfb7}
    .oh-precision-detail.approx{border-color:rgba(221,166,74,.28)}.oh-precision-detail.approx b{color:#f2ca82}
    .oh-precision-detail.bound{border-color:rgba(226,139,79,.30)}.oh-precision-detail.bound b{color:#f3ad7d}
  `}</style>;
}
