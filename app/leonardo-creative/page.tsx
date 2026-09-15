"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, loadProfileLite, supabase } from "../shared";
import { CreativeCenter } from "../views/creative";

export default function LeonardoCreativePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setAllowed(false); setReady(Boolean(session === null)); return; }
    let active = true;
    loadProfileLite()
      .then((body) => {
        if (!active) return;
        setAllowed(String(body?.profile?.person || "") === "Leonardo Augusto" && String(body?.profile?.role || "").toUpperCase() === "COMMERCIAL");
        setReady(true);
      })
      .catch(() => { if (active) { setAllowed(false); setReady(true); } });
    return () => { active = false; };
  }, [session?.access_token]);

  if (!session || !ready) return <main className="shell"><div className="empty">Carregando Central Criativa…</div></main>;
  if (!allowed) return <main className="shell"><div className="error-box">Área restrita à Direção Comercial.</div></main>;

  return <main className="shell">
    <header className="top">
      <div className="brand">
        <div className="logo"><BrandMark /></div>
        <div><span className="brand-name">Leonardo Imobi</span><h1>Central Criativa</h1><div className="subtitle">A mesma base, clientes, regras, materiais, histórico e aprendizado disponíveis ao Adler.</div></div>
      </div>
      <div className="live"><button className="btn" onClick={() => window.location.assign("/")}>← Home Comercial</button></div>
    </header>
    <CreativeCenter token={session.access_token} />
  </main>;
}
