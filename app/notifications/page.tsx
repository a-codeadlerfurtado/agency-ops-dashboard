"use client";

import { useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, formatDate, supabase, text } from "../shared";

type Row = Record<string, any>;
type Filter = "OPEN" | "CRITICAL" | "RESOLVED" | "ALL";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-client-notifications`;

function tone(value: unknown) {
  const raw = String(value || "").toUpperCase();
  if (["CRITICAL", "HIGH", "ERROR"].includes(raw)) return "critical";
  if (["MEDIUM", "WARNING", "WARN", "ATTENTION"].includes(raw)) return "attention";
  if (["SUCCESS", "OK", "LOW"].includes(raw)) return "ok";
  return "info";
}

export default function NotificationsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => { setSession(session); setReady(true); });
  }, []);

  useEffect(() => {
    if (!session?.access_token) return;
    let cancelled = false;
    setLoading(true); setError("");
    fetch(`${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body?.ok) throw new Error(body?.error || `HTTP ${response.status}`);
        if (!cancelled) setItems(body.items || []);
      })
      .catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "Falha ao carregar notificações."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session?.access_token]);

  const visible = useMemo(() => items.filter((item) => {
    const resolved = String(item.status || "").toUpperCase() === "RESOLVED";
    const critical = !resolved && ["CRITICAL", "HIGH"].includes(String(item.level || "").toUpperCase());
    const open = !resolved && (item.kind === "ALERT" || !item.read_at);
    if (filter === "OPEN") return open;
    if (filter === "CRITICAL") return critical;
    if (filter === "RESOLVED") return resolved;
    return true;
  }), [items, filter]);

  if (!ready) return <main className="nh-page"><style>{styles}</style><div className="nh-empty">Validando sessão…</div></main>;
  if (!session) return <main className="nh-page"><style>{styles}</style><div className="nh-empty">Faça login no dashboard para acessar as notificações.</div></main>;

  const open = items.filter((item) => String(item.status || "").toUpperCase() !== "RESOLVED" && (item.kind === "ALERT" || !item.read_at)).length;
  const critical = items.filter((item) => String(item.status || "").toUpperCase() !== "RESOLVED" && ["CRITICAL", "HIGH"].includes(String(item.level || "").toUpperCase())).length;
  const resolved = items.filter((item) => String(item.status || "").toUpperCase() === "RESOLVED").length;

  return <main className="nh-page">
    <style>{styles}</style>
    <header className="nh-head">
      <div><span>Central de Notificações</span><h1>Notificações</h1><p>Todas as notificações e alertas operacionais em uma visão completa.</p></div>
      <a href="/">Voltar para a Home</a>
    </header>

    <section className="nh-kpis">
      <article><small>ABERTAS</small><b>{open}</b></article>
      <article className={critical ? "danger" : ""}><small>CRÍTICAS</small><b>{critical}</b></article>
      <article><small>RESOLVIDAS</small><b>{resolved}</b></article>
      <article><small>TOTAL</small><b>{items.length}</b></article>
    </section>

    <nav className="nh-filters">
      {([['OPEN','Abertas'],['CRITICAL','Críticas'],['RESOLVED','Resolvidas'],['ALL','Todas']] as [Filter,string][]).map(([key,label]) => <button key={key} className={filter===key?"active":""} onClick={() => setFilter(key)}>{label}</button>)}
    </nav>

    {error && <div className="nh-error">{error}</div>}
    {loading && <div className="nh-empty">Carregando notificações…</div>}
    {!loading && !visible.length && !error && <div className="nh-empty">Nenhuma notificação neste filtro.</div>}

    <section className="nh-list">{visible.map((item) => <article className={`nh-item ${tone(item.level)}`} key={`${item.kind}:${item.id}`}>
      <div className="nh-item-top"><span>{text(item.client_name || "Operação geral")}</span><time>{formatDate(item.occurred_at)}</time></div>
      <h2>{text(item.title)}</h2>
      <p>{text(item.description)}</p>
      <div className="nh-meta"><span>{text(item.source_label || item.source || "Operação")}</span><span>{text(item.owner || item.actor || "Sem responsável")}</span><span>{String(item.status || (item.read_at ? "READ" : "OPEN"))}</span></div>
      {item.next_action && <div className="nh-next"><b>Próxima ação</b><span>{text(item.next_action)}</span></div>}
      {item.client_id && <a href={`/?client=${encodeURIComponent(String(item.client_id))}&clientNotifications=1&notification=${encodeURIComponent(String(item.title || ""))}`}>Abrir cliente →</a>}
    </article>)}</section>
  </main>;
}

const styles = `
*{box-sizing:border-box}.nh-page{min-height:100vh;background:#08111d;color:#e7f0f8;padding:34px;max-width:1500px;margin:0 auto;font-family:Inter,system-ui,sans-serif}.nh-head{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-bottom:26px}.nh-head span{font-size:11px;text-transform:uppercase;letter-spacing:.12em;color:#7392ad}.nh-head h1{font-size:34px;margin:5px 0}.nh-head p{margin:0;color:#8198ad}.nh-head a,.nh-item>a{color:#d8ecff;text-decoration:none;border:1px solid rgba(111,166,214,.25);border-radius:10px;padding:10px 14px;background:rgba(45,112,172,.1)}.nh-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}.nh-kpis article{padding:18px;border:1px solid rgba(116,156,192,.18);border-radius:15px;background:#0e1b2b}.nh-kpis small{display:block;color:#7790a7;font-size:10px;letter-spacing:.09em}.nh-kpis b{display:block;font-size:28px;margin-top:6px}.nh-kpis .danger b{color:#ff826e}.nh-filters{display:flex;gap:7px;margin-bottom:18px}.nh-filters button{border:1px solid transparent;border-radius:9px;padding:9px 13px;background:transparent;color:#88a0b6;cursor:pointer}.nh-filters button.active{background:rgba(58,139,211,.16);border-color:rgba(58,139,211,.28);color:#eef8ff}.nh-list{display:grid;gap:10px}.nh-item{padding:18px 19px;border:1px solid rgba(116,156,192,.18);border-radius:15px;background:#0d1a29;border-left:3px solid #4d83ae}.nh-item.critical{border-left-color:#ef6955}.nh-item.attention{border-left-color:#d6a247}.nh-item.ok{border-left-color:#3bb886}.nh-item-top{display:flex;justify-content:space-between;color:#7f98ae;font-size:11px}.nh-item h2{font-size:15px;margin:9px 0 6px}.nh-item p{font-size:13px;color:#9db0c2;line-height:1.55;margin:0 0 10px}.nh-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:#748da3;margin-bottom:12px}.nh-next{display:flex;gap:10px;padding:10px 12px;border-radius:10px;background:rgba(41,105,162,.1);font-size:12px;margin-bottom:13px}.nh-next b{color:#bcd9ee}.nh-next span{color:#92a9bc}.nh-item>a{display:inline-block;font-size:11px;padding:7px 10px}.nh-empty,.nh-error{padding:30px;text-align:center;border:1px dashed rgba(116,156,192,.2);border-radius:14px;color:#849db3}.nh-error{color:#ff9d8d}@media(max-width:800px){.nh-page{padding:18px}.nh-head{flex-direction:column}.nh-kpis{grid-template-columns:repeat(2,1fr)}}
`;
