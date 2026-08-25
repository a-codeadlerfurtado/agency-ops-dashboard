from pathlib import Path

p = Path('app/dashboard-native.tsx')
s = p.read_text()

def rep(old, new, label):
    global s
    count = s.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, got {count}')
    s = s.replace(old, new, 1)

rep('''  const [filter, setFilter] = useState("OPEN");
  const [expanded, setExpanded] = useState<string | null>(focusId);
  const [resolution, setResolution] = useState<Record<string, string>>({});''', '''  const [filter, setFilter] = useState("OPEN");
  const [personFilter, setPersonFilter] = useState("ALL");
  const [quickFilter, setQuickFilter] = useState("ALL");
  const [workQuery, setWorkQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(focusId);
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [waitingReason, setWaitingReason] = useState<Record<string, string>>({});''', 'states')

rep('''  const items: Row[] = payload.items || [];
  const visible = items.filter((item) => filter === "ALL" || (filter === "OPEN" ? !["COMPLETED", "DISMISSED"].includes(item.status) : item.status === filter));
  const selectedClient = clients.find((client) => String(client.client_id) === String(form.client_id));''', '''  const nowMs = Date.now();
  const HOUR = 3600000;
  const dayKey = (raw: unknown) => {
    if (!raw) return "";
    const date = raw instanceof Date ? raw : new Date(String(raw));
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  };
  const todayKey = dayKey(new Date());
  const openItem = (item: Row) => !["COMPLETED", "DISMISSED"].includes(String(item.status));
  const ageHours = (item: Row) => item.created_at ? Math.max(0, (nowMs - new Date(String(item.created_at)).getTime()) / HOUR) : 0;
  const dueHours = (item: Row) => item.due_at ? (new Date(String(item.due_at)).getTime() - nowMs) / HOUR : null;
  const isOverdue = (item: Row) => openItem(item) && dueHours(item) != null && Number(dueHours(item)) < 0;
  const isDueToday = (item: Row) => openItem(item) && Boolean(item.due_at) && dayKey(item.due_at) === todayKey;
  const score = (item: Row) => {
    const base: Record<string, number> = { CRITICAL: 500, HIGH: 330, MEDIUM: 180, LOW: 80 };
    let points = base[String(item.priority)] ?? 100;
    const due = dueHours(item); const age = ageHours(item);
    if (due != null && due < 0) points += 650 + Math.min(240, Math.abs(due) * 5);
    else if (due != null && due <= 4) points += 360;
    else if (due != null && due <= 12) points += 240;
    else if (isDueToday(item)) points += 160;
    if (age >= 72) points += 220; else if (age >= 48) points += 160; else if (age >= 24) points += 110; else if (age >= 8) points += 45;
    if (item.status === "WAITING") points -= 90;
    if (item.status === "SNOOZED") points -= 180;
    return points;
  };
  const ageLabel = (item: Row) => { const h = ageHours(item); return h < 1 ? "aberta há menos de 1h" : h < 24 ? `aberta há ${Math.floor(h)}h` : `aberta há ${Math.floor(h / 24)}d`; };
  const dueLabel = (item: Row) => {
    if (!item.due_at) return "sem prazo";
    const h = dueHours(item); if (h == null) return "sem prazo";
    if (h < 0) { const late = Math.abs(h); return late < 1 ? "prazo vencido" : late < 24 ? `${Math.floor(late)}h atrasada` : `${Math.floor(late / 24)}d atrasada`; }
    const time = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(new Date(String(item.due_at)));
    if (isDueToday(item)) return `vence hoje ${time}`;
    if (h <= 24) return `vence em ${Math.max(1, Math.ceil(h))}h`;
    return `prazo ${formatDate(item.due_at)}`;
  };
  const WAIT_REASONS = [
    { value: "CLIENT", label: "Aguardando cliente" }, { value: "GT", label: "Aguardando GT" },
    { value: "CS", label: "Aguardando CS" }, { value: "DESIGN", label: "Aguardando Design" },
    { value: "APPROVAL", label: "Aguardando aprovação" }, { value: "TECHNICAL", label: "Dependência técnica" },
    { value: "OTHER", label: "Outro motivo" },
  ];
  const waitingLabel = (reason: unknown) => WAIT_REASONS.find((option) => option.value === String(reason || ""))?.label || "Aguardando";
  const items: Row[] = payload.items || [];
  const roster: Row[] = payload.roster || [];
  const ranked = [...items].sort((a, b) => score(b) - score(a));
  const needle = workQuery.trim().toLocaleLowerCase("pt-BR");
  const visible = ranked.filter((item) => {
    const statusOk = filter === "ALL" || (filter === "OPEN" ? openItem(item) : item.status === filter);
    const personOk = personFilter === "ALL" || String(item.target_person || "") === personFilter;
    const quickOk = quickFilter === "ALL"
      || (quickFilter === "MINE" && String(item.target_person || "") === String(profile.person || ""))
      || (quickFilter === "OVERDUE" && isOverdue(item))
      || (quickFilter === "TODAY" && isDueToday(item))
      || (quickFilter === "STALE" && openItem(item) && ageHours(item) >= 24)
      || (quickFilter === "CRITICAL" && openItem(item) && item.priority === "CRITICAL")
      || (quickFilter === "UNASSIGNED" && openItem(item) && !item.target_person);
    const client = item.clients || {};
    const hay = [item.title, item.description, client.display_name, item.target_person, item.target_role, item.created_by_person].join(" ").toLocaleLowerCase("pt-BR");
    return statusOk && personOk && quickOk && (!needle || hay.includes(needle));
  });
  const doNow = ranked.filter((item) => openItem(item) && !["WAITING", "SNOOZED"].includes(String(item.status))).slice(0, 5);
  const selectedClient = clients.find((client) => String(client.client_id) === String(form.client_id));''', 'ranking')

rep('''  const assigneeLabel = (person: unknown) => {
    const value = String(person || "");
    return designOptions.find((option) => option.value === value)?.label || csOptions.find((option) => option.value === value)?.label || value || "não definido";
  };''', '''  const assigneeLabel = (person: unknown) => {
    const value = String(person || "");
    return designOptions.find((option) => option.value === value)?.label || csOptions.find((option) => option.value === value)?.label || value || "não definido";
  };
  const canSeeTeamLoad = profile.person === "Adler Furtado" || profile.access_level === "FULL" || Boolean(profile.elevated);
  const teamLoad = (canSeeTeamLoad ? roster : roster.filter((person) => person.person === profile.person))
    .filter((person) => ["CS", "DESIGN", "GT", "MGMT"].includes(String(person.role)))
    .map((person) => {
      const assigned = items.filter((item) => openItem(item) && String(item.target_person || "") === String(person.person));
      return { person: String(person.person), role: String(person.role), open: assigned.length, today: assigned.filter(isDueToday).length, overdue: assigned.filter(isOverdue).length, waiting: assigned.filter((item) => item.status === "WAITING").length, critical: assigned.filter((item) => item.priority === "CRITICAL").length };
    })
    .filter((row) => row.open > 0 || row.person === profile.person)
    .sort((a, b) => b.overdue - a.overdue || b.critical - a.critical || b.open - a.open);''', 'workload')

rep('''  async function updateItem(item: Row, status: string) {
    const note = (resolution[String(item.id)] || "").trim();''', '''  async function updateItem(item: Row, status: string) {
    if (status === "WAITING") {
      const id = String(item.id); const reason = waitingReason[id] || String(item.waiting_reason || "");
      if (!reason) { setError("Selecione por que a demanda ficará aguardando."); setExpanded(id); return; }
      setBusy(id); setError("");
      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/agency-ops-work-item-wait-api`, { method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ id: item.id, waiting_reason: reason }) });
        const json = await response.json().catch(() => null);
        if (!response.ok) throw new Error(json?.error || "Falha ao registrar o motivo de espera.");
        await loadWork();
      } catch (caught) { setError(caught instanceof Error ? caught.message : "Falha ao colocar a demanda em espera."); }
      finally { setBusy(""); }
      return;
    }
    const note = (resolution[String(item.id)] || "").trim();''', 'waiting api')

rep('''    <div className="workspace-head"><div><span className="eyebrow">Execução rastreável</span><h2>Central de Trabalho</h2><p>Receba, abra, execute e conclua solicitações. Cada demanda mostra claramente para quem foi encaminhada.</p></div><button className="primary work-new" onClick={() => setFormOpen((open) => !open)}>{formOpen ? "Cancelar" : "+ Nova solicitação"}</button></div>
    <div className="grid work-kpis"><Metric label="Em aberto" value={formatNumber(summary.open, 0)} tone="blue" hint="aguardando ação" /><Metric label="Críticas" value={formatNumber(summary.critical, 0)} tone="red" hint="prioridade máxima" /><Metric label="Atrasadas" value={formatNumber(summary.overdue, 0)} tone="yellow" hint="prazo vencido" /><Metric label="Concluídas 30d" value={formatNumber(summary.completed_30d, 0)} tone="green" hint="com evidência" /></div>''', '''    <div className="workspace-head"><div><span className="eyebrow">Mesa de despacho operacional</span><h2>Central de Trabalho</h2><p>Prioridade, prazo, idade da pendência e carga por colaborador em uma única fila.</p></div><button className="primary work-new" onClick={() => setFormOpen((open) => !open)}>{formOpen ? "Cancelar" : "+ Nova solicitação"}</button></div>
    <div className="grid work-kpis"><Metric label="Em aberto" value={formatNumber(summary.open, 0)} tone="blue" hint="aguardando ação" /><Metric label="Críticas" value={formatNumber(summary.critical, 0)} tone="red" hint="prioridade máxima" /><Metric label="Atrasadas" value={formatNumber(summary.overdue, 0)} tone="yellow" hint="prazo vencido" /><Metric label="Aguardando" value={formatNumber(summary.waiting, 0)} tone="yellow" hint="dependência registrada" /></div>''', 'header')

rep('''    {formOpen && <form className="card work-form"''', '''    {doNow.length > 0 && <section className="card risk-watch" style={{ marginBottom: 14 }}><div className="panel-heading" style={{ padding: "16px 17px 11px" }}><div><span className="eyebrow">Fazer agora</span><h3>Prioridade operacional automática</h3></div><span className="counter">{doNow.length}</span></div>{doNow.map((item, index) => { const client = item.clients || {}; return <button key={item.id} onClick={() => { setExpanded(String(item.id)); setFilter("ALL"); }}><span className="rank">{String(index + 1).padStart(2, "0")}</span><span><b>{text(item.title)}</b><small>{text(client.display_name || "Solicitação geral")} · {assigneeLabel(item.target_person || item.target_role)} · {dueLabel(item)} · {ageLabel(item)}</small></span><Chip value={item.priority} /></button>; })}</section>}
    {formOpen && <form className="card work-form"''', 'do now')

rep('''    {error && <div className="error-box">{error}</div>}
    <div className="filter-tabs work-filters">''', '''    {teamLoad.length > 0 && <section className="card section" style={{ marginBottom: 14 }}><div className="section-head"><div><div className="section-title">Carga por colaborador</div><div className="subtitle">Clique em uma pessoa para filtrar a fila.</div></div></div><div className="table-wrap" style={{ maxHeight: 280 }}><table><thead><tr><th>Responsável</th><th>Abertas</th><th>Hoje</th><th>Atrasadas</th><th>Aguardando</th><th>Críticas</th></tr></thead><tbody>{teamLoad.map((row) => <tr key={row.person} onClick={() => { setPersonFilter(row.person); setFilter("OPEN"); setQuickFilter("ALL"); }}><td><b>{row.person}</b><div className="small">{row.role}</div></td><td>{row.open}</td><td>{row.today}</td><td className={row.overdue ? "red" : ""}>{row.overdue}</td><td>{row.waiting}</td><td className={row.critical ? "red" : ""}>{row.critical}</td></tr>)}</tbody></table></div></section>}
    {error && <div className="error-box">{error}</div>}
    <section className="card section" style={{ marginBottom: 10 }}><div className="toolbar"><input className="control" style={{ flex: 1 }} value={workQuery} onChange={(event) => setWorkQuery(event.target.value)} placeholder="Buscar demanda, cliente ou responsável" /><select className="control" value={personFilter} onChange={(event) => setPersonFilter(event.target.value)}><option value="ALL">Todos os responsáveis</option>{roster.filter((person) => ["CS", "DESIGN", "GT", "MGMT"].includes(String(person.role))).map((person) => <option key={person.person} value={person.person}>{person.person} · {person.role}</option>)}</select></div><div className="filter-tabs" style={{ marginTop: 10 }}>{[["ALL","Tudo"],["MINE","Minhas"],["OVERDUE","Atrasadas"],["TODAY","Vencem hoje"],["STALE","Paradas +24h"],["CRITICAL","Críticas"],["UNASSIGNED","Sem responsável"]].map(([key,label]) => <button key={key} className={quickFilter === key ? "active" : ""} onClick={() => setQuickFilter(key)}>{label}</button>)}</div></section>
    <div className="filter-tabs work-filters">''', 'filters')

rep('''<small>{text(client.display_name || "Solicitação geral")} · solicitada por {text(item.created_by_person)} · encaminhada para {text(routedTo)}</small>''', '''<small>{text(client.display_name || "Solicitação geral")} · encaminhada para {text(routedTo)} · {dueLabel(item)} · {ageLabel(item)}</small>{item.status === "WAITING" && <small className="yellow">{waitingLabel(item.waiting_reason)}{item.waiting_since ? ` · desde ${formatDate(item.waiting_since)}` : ""}</small>}''', 'card summary')

rep('''<div className="work-meta"><span>Encaminhada para: {text(routedTo)}</span><span>Criada em {formatDate(item.created_at)}</span><span>Prazo: {item.due_at ? formatDate(item.due_at) : "sem prazo"}</span>{item.completed_by && <span>Concluída por {text(item.completed_by)}</span>}</div>''', '''<div className="work-meta"><span>Encaminhada para: {text(routedTo)}</span><span>{ageLabel(item)}</span><span>Prazo: {dueLabel(item)}</span>{item.status === "WAITING" && <span>{waitingLabel(item.waiting_reason)}</span>}{item.completed_by && <span>Concluída por {text(item.completed_by)}</span>}</div>''', 'card meta')

rep('''{!["COMPLETED", "DISMISSED"].includes(item.status) && <><textarea className="control"''', '''{!["COMPLETED", "DISMISSED"].includes(item.status) && <><div className="toolbar" style={{ marginTop: 12 }}><label className="small">Motivo se ficar aguardando <select className="control" value={waitingReason[String(item.id)] || String(item.waiting_reason || "")} onChange={(event) => setWaitingReason((current) => ({ ...current, [String(item.id)]: event.target.value }))}><option value="">Selecione…</option>{WAIT_REASONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label></div><textarea className="control"''', 'waiting control')

s = s.replace('{item.resolution && <div className="work-resolution">', '{item.status === "COMPLETED" && item.resolution && <div className="work-resolution">', 1)
p.write_text(s)
