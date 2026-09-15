"use client";

import { useEffect, useState } from "react";
import { supabase } from "../shared";

export default function CreativeIntelligencePage() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      if (!data.session) {
        window.location.replace("/");
        return;
      }
      setReady(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      if (!session) window.location.replace("/");
      else setReady(true);
    });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);

  return (
    <main className="rv2-designer" data-creative-intelligence-route="true">
      <div className="rv2-loading">
        {ready ? "Carregando inteligência criativa…" : "Validando sessão…"}
      </div>
    </main>
  );
}
