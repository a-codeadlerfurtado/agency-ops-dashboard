"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./shared";

export default function SalesFunnelShortcut() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  if (!session || typeof window === "undefined" || window.location.pathname === "/sales-funnel") return null;

  return <button type="button" className="sales-funnel-shortcut" onClick={() => window.location.assign("/sales-funnel")} title="Abrir funil comercial e ranking de vendas">
    <span>↗</span><b>Funil comercial</b>
    <style>{`
      .sales-funnel-shortcut{position:fixed;left:calc(var(--sidenav-width,224px) + 18px);bottom:61px;z-index:10030;display:flex;align-items:center;gap:8px;border:1px solid rgba(76,196,137,.28);background:rgba(8,29,28,.95);color:#eaf8f0;border-radius:999px;padding:9px 13px;box-shadow:0 14px 38px rgba(0,0,0,.28);backdrop-filter:blur(14px);cursor:pointer;font-size:11.5px}.sales-funnel-shortcut span{color:#70d9a1;font-size:15px}.sales-funnel-shortcut b{font-weight:750}@media(max-width:760px){.sales-funnel-shortcut{left:12px;bottom:calc(112px + env(safe-area-inset-bottom));padding:9px 11px}.sales-funnel-shortcut b{font-size:10px}}
    `}</style>
  </button>;
}
