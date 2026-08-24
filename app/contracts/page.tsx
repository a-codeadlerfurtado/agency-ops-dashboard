"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, supabase } from "../shared";
import { ContractsCenter } from "../views/contracts";

export default function ContractsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => { setSession(next); setReady(true); });
    return () => subscription.unsubscribe();
  }, []);

  if (!ready) return <main className="auth-loading"><span className="dot loading"/> Validando sessão…</main>;
  if (!session) { window.location.assign("/"); return null; }

  return <main style={{ minHeight: "100vh", background: "var(--bg,#07100d)", color: "var(--text,#edf7f2)" }}>
    <header style={{ position:"sticky", top:0, zIndex:20, display:"flex", justifyContent:"space-between", alignItems:"center", gap:16, padding:"14px 22px", background:"rgba(7,16,13,.95)", borderBottom:"1px solid #20382f", backdropFilter:"blur(14px)" }}>
      <div style={{ display:"flex", alignItems:"center", gap:12 }}><div className="logo"><BrandMark /></div><div><small style={{ color:"#6c9e87", letterSpacing:'.12em' }}>LEONARDO IMOBI</small><h1 style={{ margin:'2px 0 0', fontSize:20 }}>Contratos</h1></div></div>
      <nav style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
        <a href="/commercial-direction" style={linkStyle}>Direção Comercial</a>
        <a href="/client-revenue" style={linkStyle}>Mensalidades & Impl.</a>
      </nav>
    </header>
    <section style={{ width:"min(1500px,calc(100% - 36px))", margin:"20px auto" }}><ContractsCenter token={session.access_token} /></section>
  </main>;
}

const linkStyle: React.CSSProperties = { border:"1px solid #29473b", background:"#0d1b16", color:"#b4cbc0", borderRadius:8, padding:"8px 11px", textDecoration:"none", fontSize:11, fontWeight:700 };
