"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient, type Session } from "@supabase/supabase-js";

const SUPABASE_URL = "https://bfzdetibfcwihfkltbkp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const HEALTH_API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-integration-health`;
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

type Integration = {
  source_key: string;
  source_label: string;
  status: "OK" | "DELAY" | "FAIL";
  last_event_at: string | null;
  lag_minutes: number | string | null;
  detail: string;
  metadata?: Record<string, unknown>;
};

type HealthPayload = {
  integrations?: Integration[];
  client_health_crosscheck_summary?: Record<string, number>;
  generated_at?: string;
};

const meta = {
  OK: { icon: "🟢", label: "OK", color: "#22c55e", bg: "rgba(34,197,94,.08)", border: "rgba(34,197,94,.22)" },
  DELAY: { icon: "🟠", label: "Atraso", color: "#f59e0b", bg: "rgba(245,158,11,.08)", border: "rgba(245,158,11,.22)" },
  FAIL: { icon: "🔴", label: "Falha", color: "#ef4444", bg: "rgba(239,68,68,.08)", border: "rgba(239,68,68,.22)" },
} as const;

function clock(value: string | null) {
  if (!value) return "sem registro";
  try { return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  catch { return "sem registro"; }
}

export default function IntegrationHealthBar() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<HealthPayload | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: auth }) => setSession(auth.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setData(null); return; }
    let active = true;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(HEALTH_API_URL, {
          headers: { Authorization: `Bearer ${session!.access_token}`, apikey: SUPABASE_ANON_KEY },
          cache: "no-store",
        });
        if (!response.ok) throw new Error(String(response.status));
        const payload = await response.json();
        if (active) setData(payload);
      } catch {
        if (active) setData(null);
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    const timer = window.setInterval(load, 30_000);
    const visibility = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [session?.access_token]);

  const integrations = data?.integrations || [];
  const worst = useMemo<"OK" | "DELAY" | "FAIL">(() => {
    if (integrations.some((item) => item.status === "FAIL")) return "FAIL";
    if (integrations.some((item) => item.status === "DELAY")) return "DELAY";
    return "OK";
  }, [integrations]);

  if (!session) return null;

  const summary = data?.client_health_crosscheck_summary || {};
  const conflicts = Number(summary.CONFLICT || 0);
  const stale = Number(summary.STALE_EXTERNAL || 0);
  const noExternal = Number(summary.NO_EXTERNAL || 0);
  const state = meta[worst];

  return (
    <aside style={{ position:"fixed", top:12, right:12, zIndex:9999, width: expanded ? "min(640px,calc(100vw - 36px))" : 40, fontFamily:"inherit" }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label="Saúde das integrações"
        title="Saúde das integrações"
        style={{ width: expanded ? "100%" : 40, height: expanded ? "auto" : 40, display:"flex", alignItems:"center", justifyContent: expanded ? "flex-start" : "center", gap:8, border:`1px solid ${state.border}`, background:"rgba(9,12,20,.94)", color:"#f8fafc", borderRadius: expanded ? 13 : 999, padding: expanded ? "8px 10px" : 0, boxShadow:"0 16px 50px rgba(0,0,0,.28)", cursor:"pointer", backdropFilter:"blur(16px)" }}
        >
        <span style={{ width:8, height:8, borderRadius:999, background:state.color, boxShadow:`0 0 0 5px ${state.bg}` }} />
        {expanded && (
          <><span style={{ display:"flex", flexDirection:"column", alignItems:"flex-start", flex:1, minWidth:0 }}>
          <b style={{ fontSize:11.5, whiteSpace:"nowrap" }}>Saúde das integrações</b>
          <small style={{ color:"#94a3b8", marginTop:2 }}>{loading ? "Atualizando…" : `${state.icon} ${state.label}`}</small>
        </span>
        <span style={{ fontSize:16, color:"#94a3b8" }}>{expanded ? "−" : "+"}</span>
          </>
          )}
      </button>

      {expanded && (
        <div style={{ marginTop:8, maxHeight:"80vh", overflowY:"auto", border:"1px solid rgba(148,163,184,.16)", background:"rgba(9,12,20,.97)", borderRadius:18, padding:12, boxShadow:"0 24px 70px rgba(0,0,0,.38)", backdropFilter:"blur(18px)" }}>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(2,minmax(0,1fr))", gap:8 }}>
            {integrations.map((item) => {
              const s = meta[item.status] || meta.DELAY;
              return (
                <article key={item.source_key} style={{ border:`1px solid ${s.border}`, background:s.bg, borderRadius:12, padding:"10px 11px", minWidth:0 }}>
                  <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                    <span>{s.icon}</span>
                    <b style={{ color:"#f8fafc", fontSize:12.5, flex:1 }}>{item.source_label}</b>
                    <em style={{ fontStyle:"normal", color:s.color, fontSize:11, fontWeight:700 }}>{s.label}</em>
                  </div>
                  <p style={{ color:"#cbd5e1", fontSize:11.5, lineHeight:1.35, margin:"7px 0 4px" }}>{item.detail}</p>
                  <small style={{ color:"#64748b", fontSize:10.5 }}>Último sinal: {clock(item.last_event_at)}</small>
                </article>
              );
            })}
            {!integrations.length && <div style={{ color:"#94a3b8", padding:8 }}>Não foi possível carregar a saúde das fontes.</div>}
          </div>

          <div style={{ marginTop:9, padding:"10px 11px", borderRadius:12, background:"rgba(59,130,246,.07)", border:"1px solid rgba(59,130,246,.16)", display:"flex", gap:12, alignItems:"center" }}>
            <div style={{ flex:1 }}>
              <b style={{ color:"#f8fafc", fontSize:12.5 }}>Cruzamento de saúde dos clientes</b>
              <div style={{ color:"#94a3b8", fontSize:11, marginTop:3 }}>Notion entra como sinal adicional junto de WhatsApp, ClickUp, CRM, campanhas e alertas.</div>
            </div>
            <span style={{ color: conflicts ? "#ef4444" : stale || noExternal ? "#f59e0b" : "#22c55e", fontSize:11, fontWeight:700, textAlign:"right" }}>
              {conflicts ? `⚠ ${conflicts} divergência(s)` : stale ? `🟠 ${stale} atrasado(s)` : noExternal ? `🟠 ${noExternal} sem dado externo` : "🟢 Cruzamento disponível"}
            </span>
          </div>
        </div>
      )}
    </aside>
  );
}
