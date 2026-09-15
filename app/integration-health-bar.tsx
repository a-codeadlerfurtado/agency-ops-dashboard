"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY, supabase } from "./shared";

const HEALTH_API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-integration-health`;

type Integration = {
  source_key: string;
  source_label: string;
  status: "OK" | "DELAY" | "FAIL";
  last_event_at: string | null;
  lag_minutes: number | string | null;
  detail: string;
  metadata?: Record<string, unknown>;
};

type CrosscheckDetail = {
  client_id: string;
  display_name: string | null;
  crosscheck_status: "CONFLICT" | "PARTIAL";
  internal_band: string | null;
  internal_score: number | null;
  external_health_status: string | null;
  external_health_score: number | null;
  external_risk_level: string | null;
  external_summary: string | null;
  external_recommended_action: string | null;
  external_source_url: string | null;
  external_source_updated_at: string | null;
};

type HealthPayload = {
  integrations?: Integration[];
  client_health_crosscheck_summary?: Record<string, number>;
  client_health_crosscheck_details?: CrosscheckDetail[];
  generated_at?: string;
};

const meta = {
  OK: { icon: "🟢", label: "OK", color: "#22c55e", bg: "rgba(34,197,94,.08)", border: "rgba(34,197,94,.22)" },
  DELAY: { icon: "🟠", label: "Atraso", color: "#f59e0b", bg: "rgba(245,158,11,.08)", border: "rgba(245,158,11,.22)" },
  FAIL: { icon: "🔴", label: "Falha", color: "#ef4444", bg: "rgba(239,68,68,.08)", border: "rgba(239,68,68,.22)" },
} as const;

// O React nao sanitiza href. Como external_source_url chega do Notion, um
// javascript: gravado la' viraria execucao no clique - so' http(s) passa.
function safeUrl(value: string | null): string | null {
  return value && /^https?:\/\//i.test(value) ? value : null;
}

type Posicao = { x: number; y: number };
const CHAVE_POSICAO = "agency-ops:saude-integracoes:posicao";
const MARGEM = 4;
// Abaixo disso e' tremida de dedo, nao arraste. Sem essa folga, qualquer clique
// com 1px de deslize deixaria de abrir o painel.
const LIMIAR_ARRASTE = 4;

function limitar(p: Posicao, el: HTMLElement | null): Posicao {
  if (!el) return p;
  const w = el.offsetWidth, h = el.offsetHeight;
  return {
    x: Math.min(Math.max(p.x, MARGEM), Math.max(MARGEM, window.innerWidth - w - MARGEM)),
    y: Math.min(Math.max(p.y, MARGEM), Math.max(MARGEM, window.innerHeight - h - MARGEM)),
  };
}

/**
 * Deixa a caixa ser arrastada e lembra onde foi largada.
 *
 * A alca e' o proprio botao, que fechado e' a bolinha e aberto e' a barra de
 * titulo - entao os dois estados arrastam pelo mesmo lugar.
 *
 * O estado do arraste vive em ref, e move/up ficam no window: o pointermove
 * chega antes de o React re-renderizar, e o ponteiro anda mais rapido que o
 * cursor sobre a bolinha de 40px.
 */
function useArrastavel(expandido: boolean) {
  const refCaixa = useRef<HTMLElement | null>(null);
  const [posicao, setPosicao] = useState<Posicao | null>(null);
  const [arrastando, setArrastando] = useState(false);
  const arrastandoRef = useRef(false);
  const moveu = useRef(false);
  const origem = useRef({ px: 0, py: 0, x: 0, y: 0 });

  useEffect(() => {
    try {
      const bruto = window.localStorage.getItem(CHAVE_POSICAO);
      if (bruto) {
        const p = JSON.parse(bruto) as Posicao;
        if (typeof p?.x === "number" && typeof p?.y === "number") setPosicao(p);
      }
    } catch { /* preferencia corrompida nao pode derrubar a barra */ }
  }, []);

  // Janela menor, ou painel que abriu e ficou mais largo, nao pode empurrar a
  // caixa para fora da tela - de la' nao tem como trazer de volta.
  useEffect(() => {
    function reencaixar() { setPosicao((p) => (p ? limitar(p, refCaixa.current) : p)); }
    reencaixar();
    window.addEventListener("resize", reencaixar);
    return () => window.removeEventListener("resize", reencaixar);
  }, [expandido]);

  useEffect(() => {
    if (arrastando || !posicao) return;
    try { window.localStorage.setItem(CHAVE_POSICAO, JSON.stringify(posicao)); } catch { /* sem storage, so' nao lembra */ }
  }, [arrastando, posicao]);

  useEffect(() => {
    function mover(evento: PointerEvent) {
      if (!arrastandoRef.current) return;
      const dx = evento.clientX - origem.current.px;
      const dy = evento.clientY - origem.current.py;
      if (!moveu.current && Math.abs(dx) + Math.abs(dy) < LIMIAR_ARRASTE) return;
      moveu.current = true;
      evento.preventDefault();
      setPosicao(limitar({ x: origem.current.x + dx, y: origem.current.y + dy }, refCaixa.current));
    }
    function soltar() {
      if (!arrastandoRef.current) return;
      arrastandoRef.current = false;
      setArrastando(false);
    }
    window.addEventListener("pointermove", mover, { passive: false });
    window.addEventListener("pointerup", soltar);
    window.addEventListener("pointercancel", soltar);
    return () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      window.removeEventListener("pointercancel", soltar);
    };
  }, []);

  function aoPressionar(evento: React.PointerEvent<HTMLElement>) {
    const caixa = refCaixa.current;
    if (!caixa) return;
    const r = caixa.getBoundingClientRect();
    origem.current = { px: evento.clientX, py: evento.clientY, x: posicao?.x ?? r.left, y: posicao?.y ?? r.top };
    moveu.current = false;
    arrastandoRef.current = true;
    setArrastando(true);
  }

  // O clique dispara depois do pointerup. Sem isso, terminar um arraste em cima
  // da alca abriria ou fecharia o painel sem querer.
  function arrasteEngoliuOClique() {
    if (!moveu.current) return false;
    moveu.current = false;
    return true;
  }

  function reposicionar() {
    setPosicao(null);
    try { window.localStorage.removeItem(CHAVE_POSICAO); } catch { /* nada a limpar */ }
  }

  return { refCaixa, posicao, arrastando, aoPressionar, arrasteEngoliuOClique, reposicionar };
}

function clock(value: string | null) {
  if (!value) return "sem registro";
  try { return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  catch { return "sem registro"; }
}

export default function IntegrationHealthBar() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<HealthPayload | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [showDivergences, setShowDivergences] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const arraste = useArrastavel(expanded);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: auth }) => setSession(auth.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setData(null); return; }
    let active = true;
    let accessDenied = false;
    async function load() {
      if (accessDenied) return;
      setLoading(true);
      try {
        const response = await fetch(HEALTH_API_URL, {
          headers: { Authorization: `Bearer ${session!.access_token}`, apikey: SUPABASE_ANON_KEY },
          cache: "no-store",
        });
        // 403 = perfil sem acesso a esta visao. Nao e' falha: a barra some e
        // esta sessao para de consultar o endpoint para nao gerar polling inutil.
        if (response.status === 403) {
          accessDenied = true;
          if (active) { setForbidden(true); setData(null); }
          return;
        }
        if (!response.ok) throw new Error(String(response.status));
        if (active) setForbidden(false);
        const payload = await response.json();
        if (active) setData(payload);
      } catch {
        if (active) setData(null);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(load, 45_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [session?.access_token]);

  const integrations = data?.integrations || [];
  const worst = useMemo<"OK" | "DELAY" | "FAIL">(() => {
    if (integrations.some((item) => item.status === "FAIL")) return "FAIL";
    if (integrations.some((item) => item.status === "DELAY")) return "DELAY";
    return "OK";
  }, [integrations]);

  if (!session || forbidden) return null;

  const summary = data?.client_health_crosscheck_summary || {};
  const details = data?.client_health_crosscheck_details || [];
  const conflicts = details.length || Number(summary.CONFLICT || 0);
  const stale = Number(summary.STALE_EXTERNAL || 0);
  const noExternal = Number(summary.NO_EXTERNAL || 0);
  const state = meta[worst];

  return (
    <aside
      ref={arraste.refCaixa as React.RefObject<HTMLElement>}
      style={{
        position:"fixed", zIndex:9999,
        // Sem posicao salva, fica no canto de sempre. Com posicao, vira top/left
        // porque o arraste raciocina em coordenada da viewport.
        ...(arraste.posicao
          ? { left: arraste.posicao.x, top: arraste.posicao.y, right: "auto" as const }
          : { top: 12, right: 12 }),
        width: expanded ? "min(640px,calc(100vw - 36px))" : 40,
        fontFamily:"inherit",
        userSelect: arraste.arrastando ? "none" : undefined,
      }}>
      <button
        onPointerDown={arraste.aoPressionar}
        onDoubleClick={arraste.reposicionar}
        onClick={() => { if (arraste.arrasteEngoliuOClique()) return; setExpanded((v) => !v); }}
        aria-expanded={expanded}
        aria-label="Saúde das integrações"
        title="Saúde das integrações · arraste para mover · duplo clique volta ao canto"
        style={{ width: expanded ? "100%" : 40, height: expanded ? "auto" : 40, display:"flex", alignItems:"center", justifyContent: expanded ? "flex-start" : "center", gap:8, border:`1px solid ${state.border}`, background:"rgba(9,12,20,.94)", color:"#f8fafc", borderRadius: expanded ? 13 : 999, padding: expanded ? "8px 10px" : 0, boxShadow:"0 16px 50px rgba(0,0,0,.28)", cursor: arraste.arrastando ? "grabbing" : "grab", backdropFilter:"blur(16px)", touchAction:"none" }}
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
                  {item.source_key==="WHATSAPP_ZAPI" ? (()=>{
                    const md=item.metadata||{};
                    const raw=String(md.raw_last_received_at||md.last_received_at||item.last_event_at||"")||null;
                    const processor=String(md.processor_last_success_at||md.pipeline_last_success_at||"")||null;
                    const pending=Number(md.pending_count??0);
                    const errors=Number(md.error_count??0);
                    const rawOk=md.raw_receiving===true || (!!raw && Date.now()-new Date(raw).getTime()<5*60_000);
                    const processorOk=md.processor_active===true || (!!processor && Date.now()-new Date(processor).getTime()<5*60_000);
                    return <div style={{display:"grid",gap:6,margin:"8px 0 3px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",gap:8,alignItems:"center",padding:"6px 7px",borderRadius:8,background:"rgba(255,255,255,.035)"}}><span style={{color:"#cbd5e1",fontSize:11}}>Recepção Z-API</span><b style={{color:rawOk?"#22c55e":"#ef4444",fontSize:10.5}}>{rawOk?"🟢 funcionando":"🔴 sem sinal"} · {clock(raw)}</b></div>
                      <div style={{display:"flex",justifyContent:"space-between",gap:8,alignItems:"center",padding:"6px 7px",borderRadius:8,background:"rgba(255,255,255,.035)"}}><span style={{color:"#cbd5e1",fontSize:11}}>Processamento interno</span><b style={{color:processorOk?"#22c55e":"#ef4444",fontSize:10.5,textAlign:"right"}}>{processorOk?"🟢 ativo":"🔴 parado"} · {clock(processor)}{pending>0?` · ${pending.toLocaleString("pt-BR")} pendentes`:""}{errors>0?` · ${errors} erro(s)`:""}</b></div>
                      <p style={{ color:"#94a3b8", fontSize:10.5, lineHeight:1.35, margin:"1px 0 0" }}>{item.detail}</p>
                    </div>;
                  })() : <><p style={{ color:"#cbd5e1", fontSize:11.5, lineHeight:1.35, margin:"7px 0 4px" }}>{item.detail}</p><small style={{ color:"#64748b", fontSize:10.5 }}>Último sinal: {clock(item.last_event_at)}</small></>}
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
            {conflicts ? (
              <button
                onClick={() => setShowDivergences((v) => !v)}
                aria-expanded={showDivergences}
                title="Ver quais clientes divergem"
                style={{ color:"#ef4444", fontSize:11, fontWeight:700, textAlign:"right", background:"transparent", border:"1px solid rgba(239,68,68,.35)", borderRadius:9, padding:"5px 9px", cursor:"pointer" }}
              >
                ⚠ {conflicts} divergência(s) {showDivergences ? "▲" : "▼"}
              </button>
            ) : (
              <span style={{ color: stale || noExternal ? "#f59e0b" : "#22c55e", fontSize:11, fontWeight:700, textAlign:"right" }}>
                {stale ? `🟠 ${stale} atrasado(s)` : noExternal ? `🟠 ${noExternal} sem dado externo` : "🟢 Cruzamento disponível"}
              </span>
            )}
          </div>

          {showDivergences && (
            <div style={{ marginTop:8, maxHeight:260, overflowY:"auto", display:"flex", flexDirection:"column", gap:6 }}>
              {details.map((row) => (
                <div key={row.client_id} style={{ border:"1px solid rgba(239,68,68,.2)", background:"rgba(239,68,68,.06)", borderRadius:10, padding:"8px 10px" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                    <b style={{ color:"#f8fafc", fontSize:12, flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {row.display_name || "Cliente sem nome"}
                    </b>
                    <em style={{ fontStyle:"normal", fontSize:10, fontWeight:700, color: row.crosscheck_status === "CONFLICT" ? "#ef4444" : "#f59e0b" }}>
                      {row.crosscheck_status === "CONFLICT" ? "Contradição" : "Parcial"}
                    </em>
                  </div>
                  <div style={{ display:"flex", gap:10, marginTop:5, fontSize:11, color:"#cbd5e1", flexWrap:"wrap" }}>
                    <span>Interno: <b style={{ color:"#f8fafc" }}>{row.internal_band || "—"}</b>{row.internal_score != null ? ` (${row.internal_score})` : ""}</span>
                    <span style={{ color:"#475569" }}>×</span>
                    <span>Notion: <b style={{ color:"#f8fafc" }}>{row.external_health_status || "—"}</b>{row.external_health_score != null ? ` (${row.external_health_score})` : ""}{row.external_risk_level ? ` · risco ${row.external_risk_level}` : ""}</span>
                  </div>
                  {(row.external_summary || row.external_recommended_action) && (
                    <p style={{ color:"#94a3b8", fontSize:10.5, lineHeight:1.35, margin:"5px 0 0" }}>
                      {row.external_recommended_action || row.external_summary}
                    </p>
                  )}
                  {safeUrl(row.external_source_url) && (
                    <a href={safeUrl(row.external_source_url)!} target="_blank" rel="noreferrer" style={{ color:"#60a5fa", fontSize:10.5, textDecoration:"none" }}>
                      Abrir no Notion ↗
                    </a>
                  )}
                </div>
              ))}
              {!details.length && <div style={{ color:"#94a3b8", fontSize:11, padding:6 }}>Nenhuma divergência detalhada disponível.</div>}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
