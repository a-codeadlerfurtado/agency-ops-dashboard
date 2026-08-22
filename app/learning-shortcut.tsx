"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./shared";

export default function LearningShortcut() {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  if (!session || typeof window === "undefined" || window.location.pathname === "/learning") return null;

  return (
    <>
      <style>{`@media(max-width:820px){.learning-shortcut{left:10px!important;bottom:calc(72px + env(safe-area-inset-bottom,0px))!important;padding:10px!important}.learning-shortcut .learning-shortcut-label{display:none}}`}</style>
      <button
        type="button"
        onClick={() => window.location.assign("/learning")}
        title="Abrir histórico de decisões e biblioteca de experimentos"
        style={{
          position: "fixed",
          left: "calc(var(--sidenav-width,224px) + 18px)",
          bottom: 18,
          zIndex: 10030,
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: "1px solid rgba(62,146,220,.28)",
          background: "rgba(9,18,31,.94)",
          color: "#eaf2fb",
          borderRadius: 999,
          padding: "9px 13px",
          boxShadow: "0 14px 38px rgba(0,0,0,.28)",
          backdropFilter: "blur(14px)",
          cursor: "pointer",
          fontSize: 11.5,
          fontWeight: 750,
        }}
        className="learning-shortcut"
      >
        <span style={{ color: "#72b4f0", fontSize: 15 }}>◈</span>
        <span className="learning-shortcut-label">Memória de tráfego</span>
      </button>
    </>
  );
}
