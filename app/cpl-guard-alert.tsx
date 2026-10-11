"use client";

// Aviso de tela cheia do CPL Guard: um anúncio ou conjunto foi pausado pela regra
// automática da Meta por gastar acima do CPL ideal sem lead.
//   GT:    "Ciente".
//   Adler: "Ciente" ou "Alertar GT" (reabre o aviso na tela do GT e sai da tela dele).
// Exceção deliberada à política notification-first do Adler (pedido de 11/10/2026):
// este aviso abre sozinho também no perfil dele. Não fecha com ESC nem clicando fora.

import { useCallback, useEffect, useState } from "react";
import { supabase } from "./shared";

type Payload = {
  client_name?: string;
  gt_owner?: string | null;
  level?: "AD" | "ADSET";
  entity_name?: string;
  campaign_name?: string | null;
  adset_name?: string | null;
  spend_today?: number | null;
  threshold_brl?: number;
  multiplier?: number;
  cpl_alvo?: number;
  cpl_origem?: string;
  reading?: string[];
  next_step?: string;
  url?: string;
  executed_at?: string;
};

type AlertRow = {
  id: string;
  recipient_role: "GT" | "MGMT";
  payload: Payload;
  status: string;
  escalated_count: number;
  escalated_by: string | null;
  escalated_at: string | null;
  created_at: string;
};

const COLUMNS = "id,recipient_role,payload,status,escalated_count,escalated_by,escalated_at,created_at";
const ORIGEM: Record<string, string> = {
  MANUAL: "definido manualmente",
  REGRA_TICKET: "pelo ticket médio",
  HISTORICO_30D: "média dos últimos 30 dias",
};

const money = (v: unknown) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? "-"
    : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));

const when = (v: string | null | undefined) => {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
};

export default function CplGuardAlert() {
  const [userId, setUserId] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.user?.id) { setAlerts([]); return; }
    const { data, error: queryError } = await supabase
      .schema("agency_ops")
      .from("cpl_guard_screen_alerts")
      .select(COLUMNS)
      .eq("status", "OPEN")
      .order("created_at", { ascending: true })
      .limit(30);
    if (queryError) return;
    setAlerts((data || []) as AlertRow[]);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) setUserId(data.session?.user?.id || null); });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id || null);
      if (!session) setAlerts([]);
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let disposed = false;
    const channel = supabase
      .channel(`cpl-guard-alert:${userId}`)
      .on("postgres_changes", { event: "*", schema: "agency_ops", table: "cpl_guard_screen_alerts" }, (payload) => {
        if (disposed) return;
        const next = payload.new as AlertRow;
        const old = payload.old as Partial<AlertRow>;
        if (next?.id && next.status === "OPEN") {
          setAlerts((current) => [...current.filter((x) => x.id !== next.id), next]
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()));
        } else {
          const id = next?.id || old?.id;
          if (id) setAlerts((current) => current.filter((x) => x.id !== id));
        }
      })
      .subscribe((status) => { if (!disposed && status === "SUBSCRIBED") void load(); });
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => { disposed = true; window.removeEventListener("focus", onFocus); void supabase.removeChannel(channel); };
  }, [userId, load]);

  useEffect(() => {
    if (!alerts.length) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const blockEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("keydown", blockEscape, true);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", blockEscape, true); };
  }, [alerts.length]);

  useEffect(() => {
    if (index >= alerts.length) setIndex(Math.max(0, alerts.length - 1));
  }, [alerts.length, index]);

  const current = alerts[index] || null;

  async function act(action: "CIENTE" | "ALERTAR_GT") {
    if (!current || busy) return;
    setBusy(true); setError("");
    const { error: rpcError } = await supabase.schema("agency_ops").rpc("cpl_guard_alert_action", { p_id: current.id, p_action: action });
    if (rpcError) {
      setError(rpcError.message?.includes("cliente_sem_gt")
        ? "Este cliente está sem GT definido. Defina o GT para poder alertar."
        : "Não consegui registrar. Tente de novo.");
      setBusy(false);
      return;
    }
    setAlerts((rows) => rows.filter((x) => x.id !== current.id));
    setBusy(false);
  }

  if (!current) return null;
  const p = current.payload || {};
  const isManager = current.recipient_role === "MGMT";
  const what = p.level === "ADSET" ? "Conjunto" : "Anúncio";
  const reading = Array.isArray(p.reading) ? p.reading.filter(Boolean) : [];
  const escalated = !isManager && current.escalated_count > 0;

  return (
    <div className="cplg-shield" role="alertdialog" aria-modal="true" aria-labelledby="cplg-title">
      <style>{styles}</style>
      <section className="cplg-card">
        <header className="cplg-head">
          <div className="cplg-icon" aria-hidden="true">⛔</div>
          <div className="cplg-titles">
            <span className="cplg-kicker">PAUSA AUTOMÁTICA POR CPL · {when(p.executed_at || current.created_at)}</span>
            <h1 id="cplg-title">{p.client_name || "Cliente"}</h1>
            <p>{isManager ? `GT: ${p.gt_owner || "sem GT definido"}` : "Cliente da sua carteira"}</p>
          </div>
          {alerts.length > 1 && <div className="cplg-counter">{index + 1} / {alerts.length}</div>}
        </header>

        {escalated && (
          <div className="cplg-escalated">
            ⚠ {current.escalated_by || "O Adler"} pediu para você olhar isto agora{current.escalated_at ? ` (${when(current.escalated_at)})` : ""}.
          </div>
        )}

        <div className="cplg-entity">
          <small>{what.toUpperCase()} PAUSADO</small>
          <strong>{p.entity_name || "-"}</strong>
          {p.level !== "ADSET" && p.adset_name && <span>Conjunto: {p.adset_name}</span>}
          {p.campaign_name && <span>Campanha: {p.campaign_name}</span>}
        </div>

        <div className="cplg-numbers">
          <div><small>GASTO HOJE</small><b className="bad">{p.spend_today !== null && p.spend_today !== undefined ? money(p.spend_today) : `> ${money(p.threshold_brl)}`}</b><span>sem nenhum lead</span></div>
          <div><small>LIMITE</small><b>{money(p.threshold_brl)}</b><span>{p.multiplier || (p.level === "ADSET" ? 3 : 2)}x o CPL ideal</span></div>
          <div><small>CPL IDEAL</small><b>{money(p.cpl_alvo)}</b><span>{ORIGEM[p.cpl_origem || ""] || p.cpl_origem || ""}</span></div>
        </div>

        <div className="cplg-reading">
          <small>LEITURA OPERACIONAL</small>
          {reading.length ? <ul>{reading.map((r, i) => <li key={i}>{r}</li>)}</ul> : <p>Abra no Gerenciador para ver a entrega do dia.</p>}
          {p.next_step && <div className="cplg-step"><b>Primeiro passo:</b> {p.next_step}</div>}
        </div>

        {error && <div className="cplg-error">{error}</div>}

        <footer className="cplg-actions">
          {p.url && <a className="cplg-link" href={p.url} target="_blank" rel="noopener noreferrer">Abrir no Gerenciador ↗</a>}
          <div className="cplg-buttons">
            {isManager && (
              <button className="alert" disabled={busy || !p.gt_owner} onClick={() => act("ALERTAR_GT")}>
                {busy ? "Registrando…" : "Alertar GT"}
              </button>
            )}
            <button className="ok" disabled={busy} onClick={() => act("CIENTE")}>{busy ? "Registrando…" : "Ciente"}</button>
          </div>
        </footer>

        {alerts.length > 1 && (
          <nav className="cplg-nav">
            <button onClick={() => setIndex((i) => (i - 1 + alerts.length) % alerts.length)}>← anterior</button>
            <span>A tela só sai quando cada aviso recebe uma resposta.</span>
            <button onClick={() => setIndex((i) => (i + 1) % alerts.length)}>próximo →</button>
          </nav>
        )}
      </section>
    </div>
  );
}

const styles = `
.cplg-shield{position:fixed;inset:0;z-index:2147482000;display:grid;place-items:center;padding:22px;background:rgba(4,8,15,.95);backdrop-filter:blur(12px);color:#eef4ff;font-family:Inter,ui-sans-serif,system-ui,sans-serif;overflow:auto}
.cplg-card{width:min(860px,100%);border:1px solid rgba(253,104,1,.55);border-radius:22px;padding:26px;background:radial-gradient(circle at 12% 0,rgba(253,104,1,.14),transparent 38%),linear-gradient(180deg,#0f1828,#080d16);box-shadow:0 35px 120px rgba(0,0,0,.72),0 0 70px rgba(253,104,1,.08)}
.cplg-head{display:flex;gap:16px;align-items:flex-start}
.cplg-icon{flex:0 0 62px;height:62px;border-radius:16px;display:grid;place-items:center;font-size:32px;background:rgba(253,104,1,.14);border:1px solid rgba(253,104,1,.45)}
.cplg-titles{flex:1;min-width:0}
.cplg-kicker{display:block;color:#ff9a4d;font-size:11px;font-weight:850;letter-spacing:.12em}
.cplg-titles h1{margin:7px 0 4px;font-family:"Inter Tight",Inter,sans-serif;font-size:clamp(28px,4.6vw,46px);line-height:1;letter-spacing:-.035em}
.cplg-titles p{margin:0;color:#9fb0c8;font-size:13px}
.cplg-counter{padding:8px 11px;border:1px solid rgba(255,255,255,.12);border-radius:9px;color:#aab8ce;font-weight:800;white-space:nowrap}
.cplg-escalated{margin-top:16px;padding:12px 14px;border-radius:12px;background:rgba(255,80,80,.12);border:1px solid rgba(255,90,90,.45);color:#ffb3b3;font-weight:700;font-size:13px}
.cplg-entity{margin-top:16px;padding:16px 18px;border-radius:13px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.10)}
.cplg-entity small,.cplg-numbers small,.cplg-reading small{display:block;color:#8194b1;font-size:9px;font-weight:850;letter-spacing:.13em}
.cplg-entity strong{display:block;margin-top:5px;font-size:20px;word-break:break-word}
.cplg-entity span{display:block;margin-top:4px;color:#98a9c1;font-size:12px;word-break:break-word}
.cplg-numbers{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px}
.cplg-numbers>div{padding:14px 16px;border-radius:13px;background:#0c1422;border:1px solid rgba(255,255,255,.08)}
.cplg-numbers b{display:block;margin-top:6px;font-family:"Inter Tight",Inter,sans-serif;font-size:24px}
.cplg-numbers b.bad{color:#ff8a3d}
.cplg-numbers span{display:block;margin-top:3px;color:#8796aa;font-size:11px}
.cplg-reading{margin-top:10px;padding:16px 18px;border-radius:13px;background:#0c1422;border:1px solid rgba(3,84,155,.45)}
.cplg-reading ul{margin:9px 0 0;padding-left:18px}
.cplg-reading li{margin:0 0 7px;font-size:14px;line-height:1.5;color:#dce5f2}
.cplg-reading p{margin:8px 0 0;color:#dce5f2;font-size:14px}
.cplg-step{margin-top:10px;padding:10px 12px;border-radius:10px;background:rgba(3,84,155,.18);color:#d6e6fb;font-size:13px;line-height:1.5}
.cplg-error{margin-top:12px;padding:10px 12px;border-radius:9px;background:rgba(255,90,90,.12);color:#ffadad;font-size:12px}
.cplg-actions{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:18px;flex-wrap:wrap}
.cplg-link{color:#8fc1ff;font-weight:700;font-size:13px;text-decoration:none}
.cplg-link:hover{text-decoration:underline}
.cplg-buttons{display:flex;gap:8px;flex-wrap:wrap}
.cplg-buttons button{border-radius:11px;padding:12px 20px;font-weight:850;font-size:13px;cursor:pointer;border:1px solid transparent}
.cplg-buttons .ok{background:#fd6801;border-color:#fd6801;color:#160a02}
.cplg-buttons .alert{background:#1b2a42;border-color:#3a5578;color:#e6eefa}
.cplg-buttons button:hover{filter:brightness(1.1)}
.cplg-buttons button:disabled{opacity:.55;cursor:not-allowed}
.cplg-nav{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08)}
.cplg-nav span{font-size:10px;color:#7587a1;text-align:center}
.cplg-nav button{border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px 10px;background:transparent;color:#dbe7f7;font-size:11px;font-weight:800;cursor:pointer}
@media(max-width:700px){.cplg-shield{padding:10px}.cplg-card{padding:18px}.cplg-icon{flex-basis:48px;height:48px;font-size:24px}.cplg-numbers{grid-template-columns:1fr}.cplg-actions{flex-direction:column;align-items:stretch}.cplg-buttons{display:grid;grid-template-columns:1fr}.cplg-buttons button{width:100%}.cplg-nav span{display:none}}
`;
