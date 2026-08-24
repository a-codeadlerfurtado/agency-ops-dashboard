"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../shared";
import { AutomationHealthCenter } from "../views/automations";

const ADLER_USER_ID = "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476";

export default function AutomationsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
      if (!data.session) window.location.replace("/");
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setReady(true);
      if (!next) window.location.replace("/");
    });
    return () => subscription.unsubscribe();
  }, []);

  if (!ready || !session) return <main className="automation-page-loading">Carregando…<style>{pageStyles}</style></main>;
  if (session.user.id !== ADLER_USER_ID) return <main className="automation-page-loading">Acesso restrito.<style>{pageStyles}</style></main>;

  return <main className="automation-page-shell">
    <style>{pageStyles}</style>
    <nav className="automation-page-nav">
      <button onClick={() => window.location.assign("/")}>← Central de Operações</button>
      <span>Ctrl + Alt + H também volta para a Home</span>
    </nav>
    <AutomationHealthCenter token={session.access_token} />
  </main>;
}

const pageStyles = `
:root{color-scheme:dark}.automation-page-shell{min-height:100vh;background:#050d16;color:#eaf2fb;padding:18px 28px 70px;font-family:Inter,system-ui,sans-serif}.automation-page-nav{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px;border-bottom:1px solid #183247;padding-bottom:12px}.automation-page-nav button{border:1px solid #294b61;background:#091a27;color:#dcecf7;border-radius:9px;padding:8px 11px;font-weight:800;cursor:pointer}.automation-page-nav button:hover{background:#0d2231}.automation-page-nav span{font-size:9px;color:#6f8aa0}.automation-page-loading{min-height:100vh;background:#050d16;color:#92aabc;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif}@media(max-width:760px){.automation-page-shell{padding:12px 10px 60px}.automation-page-nav span{display:none}}
`;
