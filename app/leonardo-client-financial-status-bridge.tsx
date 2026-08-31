"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, text } from "./shared";

type Row = Record<string, any>;
type StatusValue = "REGULAR" | "INADIMPLENTE" | "JURIDICO" | "BOTH";

const STATUS_API = `${SUPABASE_URL}/functions/v1/agency-ops-leonardo-client-status-api`;

const normalize = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("pt-BR")
  .trim();

function valueFrom(row: Row): StatusValue {
  if (row.inadimplente && row.juridico) return "BOTH";
  if (row.inadimplente) return "INADIMPLENTE";
  if (row.juridico) return "JURIDICO";
  return "REGULAR";
}

function labelFrom(value: StatusValue) {
  if (value === "INADIMPLENTE") return "Inadimplente";
  if (value === "JURIDICO") return "Jurídico";
  if (value === "BOTH") return "Inadimplente + Jurídico";
  return "Regular";
}

function flagsFrom(value: StatusValue) {
  return {
    inadimplente: value === "INADIMPLENTE" || value === "BOTH",
    juridico: value === "JURIDICO" || value === "BOTH",
  };
}

function clientsWorkspace() {
  return Array.from(document.querySelectorAll<HTMLElement>("section.workspace"))
    .find((section) => section.querySelector("h2")?.textContent?.trim() === "Clientes") || null;
}

export default function LeonardoClientFinancialStatusBridge({ session }: { session: Session }) {
  const [visibleOnClients, setVisibleOnClients] = useState(false);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"CURRENT" | "INADIMPLENTE" | "JURIDICO" | "REGULAR">("CURRENT");
  const [savingId, setSavingId] = useState("");
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(STATUS_API, {
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setItems(Array.isArray(body?.items) ? body.items : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar os status financeiros.");
    } finally {
      setLoading(false);
    }
  }, [session.access_token]);

  useEffect(() => {
    const detect = () => {
      const workspace = clientsWorkspace();
      setVisibleOnClients(Boolean(workspace));
      setToolbarTarget(workspace?.querySelector<HTMLElement>(".leo-native-toolbar") || null);
    };
    detect();
    const observer = new MutationObserver(detect);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visibleOnClients) { setOpen(false); return; }
    void load();
  }, [visibleOnClients, load]);

  useEffect(() => {
    if (!visibleOnClients || !items.length) return;
    const workspace = clientsWorkspace();
    const table = workspace?.querySelector<HTMLTableElement>(".table-wrap table");
    if (!workspace || !table) return;

    const byName = new Map(items.map((row) => [normalize(row.display_name), row]));
    const applyInlineStatus = () => {
      table.querySelectorAll<HTMLTableRowElement>("tbody tr").forEach((tr) => {
        const name = tr.querySelector("td:first-child b")?.textContent?.trim() || "";
        const row = byName.get(normalize(name));
        const statusCell = tr.querySelector<HTMLTableCellElement>("td:nth-child(2)");
        if (!statusCell) return;
        const key = row ? `${Boolean(row.inadimplente)}:${Boolean(row.juridico)}` : "false:false";
        const existing = statusCell.querySelector<HTMLElement>(".leo-client-financial-inline");
        if (existing?.dataset.statusKey === key) return;
        existing?.remove();
        tr.classList.toggle("leo-client-financial-flagged", Boolean(row?.inadimplente || row?.juridico));
        tr.classList.toggle("leo-client-financial-inadimplente", Boolean(row?.inadimplente));
        tr.classList.toggle("leo-client-financial-juridico", Boolean(row?.juridico));
        if (!row?.inadimplente && !row?.juridico) return;

        const holder = document.createElement("div");
        holder.className = "leo-client-financial-inline";
        holder.dataset.statusKey = key;
        const addBadge = (label: string, className: string) => {
          const badge = document.createElement("button");
          badge.type = "button";
          badge.className = `leo-client-financial-badge ${className}`;
          badge.textContent = label;
          badge.title = "Abrir classificação financeira/jurídica";
          badge.onclick = () => {
            setQuery(name);
            setFilter(className === "inadimplente" ? "INADIMPLENTE" : "JURIDICO");
            setOpen(true);
          };
          holder.appendChild(badge);
        };
        if (row.inadimplente) addBadge("Inadimplente", "inadimplente");
        if (row.juridico) addBadge("Jurídico", "juridico");
        statusCell.appendChild(holder);
      });
    };

    applyInlineStatus();
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => { scheduled = false; applyInlineStatus(); });
    });
    observer.observe(table, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      table.querySelectorAll(".leo-client-financial-inline").forEach((node) => node.remove());
      table.querySelectorAll("tr").forEach((tr) => tr.classList.remove("leo-client-financial-flagged", "leo-client-financial-inadimplente", "leo-client-financial-juridico"));
    };
  }, [visibleOnClients, items]);

  async function saveStatus(row: Row, next: StatusValue) {
    const flags = flagsFrom(next);
    setSavingId(String(row.client_id));
    setFeedback("");
    setError("");
    try {
      const response = await fetch(STATUS_API, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_ANON_KEY,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          action: "save_client_financial_legal",
          client_id: row.client_id,
          inadimplente: flags.inadimplente,
          juridico: flags.juridico,
          since: new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()),
          note: `Status financeiro/jurídico alterado para ${labelFrom(next)} na aba Clientes.`,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setItems((current) => current.map((item) => String(item.client_id) === String(row.client_id) ? (body.client || { ...item, ...flags }) : item));
      setFeedback(`${text(row.display_name)}: ${labelFrom(next)}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível salvar o status.");
    } finally {
      setSavingId("");
    }
  }

  const current = useMemo(() => items.filter((row) => ["ACTIVE", "ONBOARDING"].includes(String(row.lifecycle))), [items]);
  const counts = useMemo(() => ({
    total: current.length,
    inadimplente: current.filter((row) => row.inadimplente).length,
    juridico: current.filter((row) => row.juridico).length,
    regular: current.filter((row) => !row.inadimplente && !row.juridico).length,
  }), [current]);

  const visible = useMemo(() => {
    const q = normalize(query);
    return current.filter((row) => {
      const statusOk = filter === "CURRENT"
        || (filter === "INADIMPLENTE" && row.inadimplente)
        || (filter === "JURIDICO" && row.juridico)
        || (filter === "REGULAR" && !row.inadimplente && !row.juridico);
      return statusOk && (!q || normalize(`${row.display_name || ""} ${row.service || ""}`).includes(q));
    });
  }, [current, query, filter]);

  const trigger = visibleOnClients ? <button className="leo-finance-status-trigger" type="button" onClick={() => { setQuery(""); setFilter("CURRENT"); setOpen(true); }}>
    <span>Financeiro / Jurídico</span>
    <i className="danger">{counts.inadimplente} inad.</i>
    <i className="warn">{counts.juridico} jur.</i>
  </button> : null;

  return <>
    {toolbarTarget && trigger ? createPortal(trigger, toolbarTarget) : null}

    {visibleOnClients && open && <div className="leo-finance-status-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target && !savingId) setOpen(false); }}>
      <section className="leo-finance-status-modal" role="dialog" aria-modal="true" aria-label="Status financeiro e jurídico dos clientes">
        <header>
          <div><span>CARTEIRA · FATURAMENTO REAL</span><h2>Status financeiro e jurídico</h2><p>Clientes marcados como inadimplentes ou jurídicos ficam fora do faturamento real, sem alterar o status operacional Ativo/Onboarding.</p></div>
          <button type="button" onClick={() => setOpen(false)} aria-label="Fechar">×</button>
        </header>

        <div className="leo-finance-status-kpis">
          <button className={filter === "CURRENT" ? "active" : ""} onClick={() => setFilter("CURRENT")}><small>Clientes atuais</small><strong>{counts.total}</strong></button>
          <button className={filter === "INADIMPLENTE" ? "active danger" : "danger"} onClick={() => setFilter("INADIMPLENTE")}><small>Inadimplentes</small><strong>{counts.inadimplente}</strong></button>
          <button className={filter === "JURIDICO" ? "active warn" : "warn"} onClick={() => setFilter("JURIDICO")}><small>Jurídico</small><strong>{counts.juridico}</strong></button>
          <button className={filter === "REGULAR" ? "active success" : "success"} onClick={() => setFilter("REGULAR")}><small>Regulares</small><strong>{counts.regular}</strong></button>
        </div>

        <div className="leo-finance-status-toolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente" autoFocus />
          <button type="button" onClick={() => void load()} disabled={loading}>{loading ? "Atualizando…" : "Atualizar"}</button>
        </div>

        {feedback && <div className="leo-finance-status-feedback success">{feedback}</div>}
        {error && <div className="leo-finance-status-feedback error">{error}</div>}

        <div className="leo-finance-status-table-wrap">
          <table>
            <thead><tr><th>Cliente</th><th>Operacional</th><th>Financeiro / Jurídico</th><th>Desde</th></tr></thead>
            <tbody>{visible.map((row) => {
              const value = valueFrom(row);
              const since = row.inadimplente_record?.since || row.juridico_record?.since || null;
              return <tr key={row.client_id}>
                <td><b>{text(row.display_name)}</b><small>{text(row.service || "serviço não informado")}</small></td>
                <td><span className="leo-finance-lifecycle">{row.lifecycle === "ONBOARDING" ? "Onboarding" : "Ativo"}</span></td>
                <td><select className={`leo-finance-status-select ${value.toLowerCase()}`} value={value} disabled={savingId === String(row.client_id)} onChange={(event) => void saveStatus(row, event.target.value as StatusValue)}>
                  <option value="REGULAR">Regular</option>
                  <option value="INADIMPLENTE">Inadimplente</option>
                  <option value="JURIDICO">Jurídico</option>
                  <option value="BOTH">Inadimplente + Jurídico</option>
                </select></td>
                <td>{since ? new Intl.DateTimeFormat("pt-BR").format(new Date(`${since}T12:00:00`)) : "—"}</td>
              </tr>;
            })}{!visible.length && <tr><td colSpan={4} className="leo-finance-status-empty">Nenhum cliente nesse filtro.</td></tr>}</tbody>
          </table>
        </div>
      </section>
    </div>}

    <style>{`
      /* Ajuste somente visual do perfil comercial: mesma estrutura, menos ruído. */
      .shell .top{gap:14px}.shell .top .brand{min-width:0}.shell .top .brand .subtitle{max-width:350px;line-height:1.35}.shell .top .live{gap:7px}.shell .top .command-trigger{min-width:134px}.shell .top .profile-trigger{min-width:168px}
      .shell>.source-banner{margin-top:10px;margin-bottom:14px;padding:9px 12px;border-radius:10px;font-size:11px;line-height:1.4}.shell .workspace{padding:18px}.shell .workspace-head{align-items:center;gap:18px;margin-bottom:12px}.shell .workspace-head h2{margin-bottom:3px}.shell .workspace-head p{max-width:660px;line-height:1.45}.shell .card.section{border-radius:14px}
      .shell .leo-native-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}.shell .leo-native-toolbar>input.control{flex:1 1 330px;min-width:220px}.shell .leo-native-toolbar>select.control{flex:0 0 auto;min-width:180px}.shell .table-wrap{border:1px solid var(--line);border-radius:12px;overflow:auto;background:color-mix(in srgb,var(--panel2) 70%,transparent)}.shell .table-wrap table{margin:0}.shell .table-wrap th{font-size:9px;letter-spacing:.07em}.shell .table-wrap td{padding-top:11px;padding-bottom:11px}.shell .table-wrap tbody tr{transition:background .14s ease}.shell .table-wrap tbody tr:hover{background:var(--wash)}.shell .side-nav-items{gap:3px}.shell .side-nav-items button{border-radius:8px}

      .leo-finance-status-trigger{margin-left:auto;display:flex;align-items:center;gap:7px;border:1px solid rgba(255,122,47,.34);border-radius:9px;background:rgba(255,122,47,.07);color:var(--text);padding:8px 10px;font:inherit;font-size:11px;font-weight:760;cursor:pointer;white-space:nowrap}.leo-finance-status-trigger:hover{border-color:#ff9a61;background:rgba(255,122,47,.11)}.leo-finance-status-trigger i{font-style:normal;border-radius:999px;padding:3px 6px;font-size:9px;font-weight:850}.leo-finance-status-trigger i.danger{background:rgba(255,118,110,.1);color:#ff968f}.leo-finance-status-trigger i.warn{background:rgba(244,189,98,.1);color:#f4bd62}
      .leo-client-financial-inline{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px}.leo-client-financial-badge{border-radius:999px;padding:3px 6px;background:transparent;font:inherit;font-size:9px;font-weight:850;line-height:1.2;cursor:pointer}.leo-client-financial-badge.inadimplente{border:1px solid rgba(255,118,110,.42);background:rgba(255,118,110,.08);color:#ff918b}.leo-client-financial-badge.juridico{border:1px solid rgba(244,189,98,.42);background:rgba(244,189,98,.08);color:#f1c879}.leo-client-financial-badge:hover{filter:brightness(1.12)}.shell .table-wrap tbody tr.leo-client-financial-inadimplente td:first-child{box-shadow:inset 3px 0 0 rgba(255,118,110,.72)}.shell .table-wrap tbody tr.leo-client-financial-juridico:not(.leo-client-financial-inadimplente) td:first-child{box-shadow:inset 3px 0 0 rgba(244,189,98,.72)}.shell .table-wrap tbody tr.leo-client-financial-flagged{background:rgba(244,189,98,.018)}

      .leo-finance-status-backdrop{position:fixed;inset:0;z-index:140;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:20px}.leo-finance-status-modal{width:min(1060px,97vw);max-height:90vh;overflow:hidden;display:flex;flex-direction:column;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:0 30px 90px rgba(0,0,0,.42);color:var(--text)}
      .leo-finance-status-modal>header{display:flex;justify-content:space-between;gap:20px;padding:20px 22px 15px;border-bottom:1px solid var(--line)}.leo-finance-status-modal>header span{font-size:9px;letter-spacing:.15em;color:#ff9a61;font-weight:850}.leo-finance-status-modal>header h2{margin:4px 0 5px;font-size:22px}.leo-finance-status-modal>header p{margin:0;color:var(--muted);font-size:12px;max-width:760px;line-height:1.5}.leo-finance-status-modal>header>button{width:34px;height:34px;border:1px solid var(--line);border-radius:9px;background:var(--panel2);color:var(--text);font-size:20px;cursor:pointer}
      .leo-finance-status-kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;padding:14px 18px 4px}.leo-finance-status-kpis button{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--panel2);color:var(--text);cursor:pointer}.leo-finance-status-kpis button.active{border-color:var(--blue);box-shadow:0 0 0 1px rgba(118,198,255,.12)}.leo-finance-status-kpis button.danger strong{color:#ff766e}.leo-finance-status-kpis button.warn strong{color:#f4bd62}.leo-finance-status-kpis button.success strong{color:#52d59d}.leo-finance-status-kpis small{color:var(--muted);font-size:10px}.leo-finance-status-kpis strong{font-size:21px}
      .leo-finance-status-toolbar{display:flex;gap:9px;padding:10px 18px}.leo-finance-status-toolbar input{flex:1;min-width:0;border:1px solid var(--line);border-radius:9px;background:var(--panel2);color:var(--text);padding:10px 12px;outline:none}.leo-finance-status-toolbar button{border:1px solid var(--line);border-radius:9px;background:var(--panel2);color:var(--text);padding:9px 12px;cursor:pointer}.leo-finance-status-feedback{margin:0 18px 8px;padding:9px 11px;border-radius:8px;font-size:11px}.leo-finance-status-feedback.success{background:rgba(82,213,157,.09);color:#7ee3b7}.leo-finance-status-feedback.error{background:rgba(255,118,110,.09);color:#ff968f}
      .leo-finance-status-table-wrap{overflow:auto;margin:0 18px 18px;border:1px solid var(--line);border-radius:11px}.leo-finance-status-table-wrap table{width:100%;border-collapse:collapse}.leo-finance-status-table-wrap th,.leo-finance-status-table-wrap td{padding:11px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:11px}.leo-finance-status-table-wrap th{position:sticky;top:0;z-index:2;background:var(--panel2);color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:.08em}.leo-finance-status-table-wrap td:first-child b,.leo-finance-status-table-wrap td:first-child small{display:block}.leo-finance-status-table-wrap td:first-child small{margin-top:3px;color:var(--muted)}.leo-finance-lifecycle{display:inline-flex;padding:5px 7px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:10px}.leo-finance-status-select{min-width:190px;border:1px solid var(--line);border-radius:8px;background:var(--panel2);color:var(--text);padding:7px 9px;outline:none}.leo-finance-status-select.inadimplente,.leo-finance-status-select.both{border-color:rgba(255,118,110,.5);color:#ff968f}.leo-finance-status-select.juridico{border-color:rgba(244,189,98,.55);color:#f4bd62}.leo-finance-status-select.regular{border-color:rgba(82,213,157,.38);color:#7ee3b7}.leo-finance-status-empty{text-align:center!important;color:var(--muted);padding:24px!important}
      @media(max-width:900px){.shell .top .brand .subtitle{display:none}.leo-finance-status-trigger{margin-left:0}.leo-finance-status-kpis{grid-template-columns:repeat(2,minmax(0,1fr))}.leo-finance-status-modal{max-height:94vh}.leo-finance-status-table-wrap{margin-left:10px;margin-right:10px}.leo-finance-status-modal>header{padding-left:14px;padding-right:14px}}
      @media(max-width:640px){.leo-finance-status-trigger span{display:none}.shell .leo-native-toolbar>select.control{min-width:0;flex:1 1 160px}}
    `}</style>
  </>;
}