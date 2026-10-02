"use client";

import { useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, text, useDialogFocus } from "./shared";

type Row = Record<string, any>;
type ManagerData = {
  categories: string[];
  roles: string[];
  people: string[];
  reflections: Row[];
  server_date: string;
};

const API = `${SUPABASE_URL}/functions/v1/agency-ops-reflections-api`;
const CATEGORY_LABELS: Record<string, string> = {
  FILOSOFIA: "Filosofia",
  BIBLIA: "Bíblia",
  LIDERANCA_NEGOCIOS: "Liderança e negócios",
  CIENCIA_CRIATIVIDADE: "Ciência e criatividade",
  LITERATURA_HISTORIA: "Literatura e história",
  CULTURA_BRASILEIRA: "Cultura brasileira",
};
const EMPTY_FORM: Row = {
  quote_text: "",
  author: "",
  source_reference: "",
  source_url: "",
  category: "FILOSOFIA",
  verified: true,
  active: true,
  scheduled_date: "",
  recurs_annually: false,
  target_roles: [],
  target_people: [],
  priority: 100,
  notes: "",
};

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    apikey: SUPABASE_ANON_KEY,
    "content-type": "application/json",
  };
}
function displayDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeZone: "America/Sao_Paulo" })
    .format(new Date(`${value}T12:00:00-03:00`));
}
function selectedValues(event: React.ChangeEvent<HTMLSelectElement>) {
  return Array.from(event.currentTarget.selectedOptions).map((option) => option.value);
}

export function DailyReflection({ token }: { token: string }) {
  const [reflection, setReflection] = useState<Row | null>(null);
  const [serverDate, setServerDate] = useState("");
  const [hidden, setHidden] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [manageOpen, setManageOpen] = useState(false);
  const [error, setError] = useState("");

  async function load(signal?: AbortSignal) {
    if (!token) return;
    try {
      const response = await fetch(API, { headers: headers(token), cache: "no-store", signal });
      if (!response.ok) throw new Error(`Reflexão ${response.status}`);
      const body = await response.json();
      setReflection(body.reflection || null);
      setServerDate(body.server_date || "");
      setHidden(body.hidden === true);
      setCanManage(body.can_manage === true);
      setError("");
    } catch (caught) {
      if ((caught as Error)?.name !== "AbortError") setError("A reflexão do dia não pôde ser carregada.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [token]);

  async function setVisibility(nextHidden: boolean) {
    const response = await fetch(API, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ action: "set_hidden", hidden: nextHidden }),
    });
    if (!response.ok) return;
    setHidden(nextHidden);
  }

  if (loading) {
    return <section className="card daily-reflection daily-reflection-loading" aria-label="Carregando reflexão do dia">
      <span className="skeleton reflection-skeleton" />
    </section>;
  }

  if (hidden) {
    return <div className="daily-reflection-hidden">
      <span>Reflexão do dia oculta neste perfil.</span>
      <button type="button" onClick={() => void setVisibility(false)}>Mostrar</button>
    </div>;
  }

  if (!reflection || error) {
    return canManage ? <div className="daily-reflection-hidden">
      <span>{error || "Nenhuma reflexão verificada disponível para hoje."}</span>
      <button type="button" onClick={() => setManageOpen(true)}>Gerenciar</button>
      {manageOpen && <ReflectionManager token={token} close={() => { setManageOpen(false); void load(); }} />}
    </div> : null;
  }

  return <>
    <section className="card daily-reflection" aria-label="Reflexão do dia">
      <div className="reflection-accent" aria-hidden="true">“</div>
      <div className="reflection-copy">
        <div className="reflection-topline">
          <span className="eyebrow">Reflexão do dia</span>
          <span className="reflection-category">{CATEGORY_LABELS[reflection.category] || text(reflection.category)}</span>
        </div>
        <blockquote>{text(reflection.quote_text)}</blockquote>
        <div className="reflection-credit">
          <strong>— {text(reflection.author)}</strong>
          {reflection.source_reference && <span>{text(reflection.source_reference)}</span>}
          {reflection.source_url && <a href={String(reflection.source_url)} target="_blank" rel="noreferrer" aria-label="Abrir fonte da citação">Fonte ↗</a>}
        </div>
        <small>Reflexão do dia • {displayDate(serverDate)}</small>
      </div>
      <div className="reflection-actions">
        {reflection.verified && <span className="reflection-verified" title="Fonte revisada no banco">✓ Verificada</span>}
        {canManage && <button type="button" onClick={() => setManageOpen(true)}>Gerenciar</button>}
        <button type="button" className="muted" onClick={() => void setVisibility(true)}>Ocultar</button>
      </div>
    </section>
    {manageOpen && <ReflectionManager token={token} close={() => { setManageOpen(false); void load(); }} />}
  </>;
}

function ReflectionManager({ token, close }: { token: string; close: () => void }) {
  const dialogRef = useDialogFocus(close);
  const [data, setData] = useState<ManagerData | null>(null);
  const [form, setForm] = useState<Row>({ ...EMPTY_FORM });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const visibleRows = useMemo(() => data?.reflections || [], [data]);

  async function load() {
    const response = await fetch(`${API}?manage=1`, { headers: headers(token), cache: "no-store" });
    if (!response.ok) throw new Error("Sem acesso à gestão das reflexões.");
    setData(await response.json());
  }
  useEffect(() => { void load().catch((error) => setMessage(error.message)); }, [token]);

  function edit(row: Row) {
    setForm({
      ...EMPTY_FORM,
      ...row,
      scheduled_date: row.scheduled_date || "",
      target_roles: Array.isArray(row.target_roles) ? row.target_roles : [],
      target_people: Array.isArray(row.target_people) ? row.target_people : [],
    });
    setMessage("");
  }
  function fresh() {
    setForm({ ...EMPTY_FORM, target_roles: [], target_people: [] });
    setMessage("");
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setMessage("");
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ action: "save_quote", ...form }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || "Não foi possível salvar.");
      setMessage("Reflexão salva.");
      await load();
      if (!form.id && body.reflection) edit(body.reflection);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível salvar.");
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!form.id || !window.confirm("Deseja realmente remover esta reflexão da rotação?")) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch(API, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ action: "remove_quote", id: form.id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.detail || body.error || "Não foi possível remover.");
      await load();
      fresh();
      setMessage("Reflexão removida da rotação.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível remover.");
    } finally { setBusy(false); }
  }

  return <>
    <div className="overlay open" onClick={close} />
    <section ref={dialogRef as React.RefObject<HTMLElement>} role="dialog" aria-modal="true" aria-label="Gerenciar reflexões do dia" className="reflection-manager">
      <header className="reflection-manager-head">
        <div><span className="eyebrow">Administração</span><h2>Reflexões do dia</h2><p>Cadastre apenas frases com autoria e fonte revisadas.</p></div>
        <button type="button" className="close" onClick={close}>×</button>
      </header>
      <div className="reflection-manager-body">
        <aside className="reflection-bank">
          <div className="reflection-bank-head"><b>Banco de citações</b><button type="button" onClick={fresh}>+ Nova</button></div>
          <div className="reflection-bank-list">
            {visibleRows.map((row) => <button type="button" key={row.id} className={form.id === row.id ? "active" : ""} onClick={() => edit(row)}>
              <span><b>{text(row.author)}</b><small>{CATEGORY_LABELS[row.category] || text(row.category)}{row.scheduled_date ? ` · ${row.scheduled_date}` : ""}</small></span>
              <span className={row.deleted_at ? "reflection-state off" : row.verified && row.active ? "reflection-state on" : "reflection-state"}>{row.deleted_at ? "Removida" : row.verified && row.active ? "Ativa" : "Revisar"}</span>
            </button>)}
            {!visibleRows.length && <div className="empty">Carregando banco…</div>}
          </div>
        </aside>

        <form className="reflection-editor" onSubmit={save}>
          <div className="reflection-editor-grid">
            <label className="wide">Citação<textarea required maxLength={420} value={form.quote_text || ""} onChange={(e) => setForm({ ...form, quote_text: e.target.value })} placeholder="Texto exato ou tradução livre claramente indicada na fonte" /></label>
            <label>Autor<input required value={form.author || ""} onChange={(e) => setForm({ ...form, author: e.target.value })} /></label>
            <label>Categoria<select value={form.category || "FILOSOFIA"} onChange={(e) => setForm({ ...form, category: e.target.value })}>{(data?.categories || Object.keys(CATEGORY_LABELS)).map((category) => <option value={category} key={category}>{CATEGORY_LABELS[category] || category}</option>)}</select></label>
            <label className="wide">Fonte / obra<input value={form.source_reference || ""} onChange={(e) => setForm({ ...form, source_reference: e.target.value })} placeholder="Ex.: Cartas a Lucílio, 104.26 (tradução livre)" /></label>
            <label className="wide">URL da fonte<input type="url" value={form.source_url || ""} onChange={(e) => setForm({ ...form, source_url: e.target.value })} placeholder="https://…" /></label>
            <label>Data especial<input type="date" value={form.scheduled_date || ""} onChange={(e) => setForm({ ...form, scheduled_date: e.target.value })} /></label>
            <label>Prioridade<input type="number" min={0} max={1000} value={form.priority ?? 100} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} /></label>
            <label>Perfis/cargos<select multiple value={form.target_roles || []} onChange={(e) => setForm({ ...form, target_roles: selectedValues(e) })}>{(data?.roles || []).map((role) => <option value={role} key={role}>{role}</option>)}</select><small>Vazio = todos</small></label>
            <label>Pessoas<select multiple value={form.target_people || []} onChange={(e) => setForm({ ...form, target_people: selectedValues(e) })}>{(data?.people || []).map((person) => <option value={person} key={person}>{person}</option>)}</select><small>Vazio = todos</small></label>
            <label className="wide">Nota interna<textarea value={form.notes || ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          </div>
          <div className="reflection-flags">
            <button type="button" className="setting-toggle" onClick={() => setForm({ ...form, verified: !form.verified })}><span>Fonte verificada</span><i className={form.verified ? "on" : ""} /></button>
            <button type="button" className="setting-toggle" onClick={() => setForm({ ...form, active: !form.active })}><span>Ativa na rotação</span><i className={form.active ? "on" : ""} /></button>
            <button type="button" className="setting-toggle" onClick={() => setForm({ ...form, recurs_annually: !form.recurs_annually })}><span>Repetir data anualmente</span><i className={form.recurs_annually ? "on" : ""} /></button>
          </div>
          {message && <p className="reflection-message">{message}</p>}
          <div className="reflection-editor-actions">
            {form.id && !form.deleted_at && <button type="button" className="danger-action" disabled={busy} onClick={() => void remove()}>Remover</button>}
            <span />
            <button type="button" disabled={busy} onClick={fresh}>Limpar</button>
            <button type="submit" className="primary" disabled={busy}>{busy ? "Salvando…" : "Salvar reflexão"}</button>
          </div>
        </form>
      </div>
    </section>
  </>;
}
