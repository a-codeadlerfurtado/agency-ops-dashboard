from pathlib import Path


def replace(path: str, old: str, new: str, expected: int = 1):
    p = Path(path)
    src = p.read_text()
    found = src.count(old)
    if found != expected:
        raise SystemExit(f"{path}: expected {expected}, found {found}: {old[:140]!r}")
    p.write_text(src.replace(old, new, expected))

PAGE = "app/page.tsx"
API = "supabase/functions/agency-ops-dashboard-api/index.ts"
CREATIVE = "app/views/creative.tsx"

# 1) Designers: pesquisa e tabela de Clientes mostram o GT real do banco.
replace(PAGE,
    '.filter((client) => !needle || text(client.display_name).toLocaleLowerCase("pt-BR").includes(needle))',
    '.filter((client) => !needle || [client.display_name, client.gt_owner].join(" ").toLocaleLowerCase("pt-BR").includes(needle))')
replace(PAGE,
    'if (restricted) return <section className="workspace"><div className="workspace-head"><div><h2>Clientes</h2><p>Nome e tempo de relacionamento com a agência.</p></div><span className="counter">{clients.length} de {total}</span></div><section className="card section"><div className="toolbar portfolio-tools"><input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente" /></div><div className="table-wrap"><table><thead><tr><th scope="col">Cliente</th><th scope="col">Tempo conosco</th></tr></thead><tbody>{clients.map((client) => <tr key={client.client_id}><td><div className="name">{text(client.display_name)}</div></td><td>{client.client_days == null ? "—" : `${formatNumber(client.client_days, 0)} dias`}</td></tr>)}{!clients.length && <tr><td colSpan={2} className="empty">Nenhum cliente encontrado.</td></tr>}</tbody></table></div></section></section>;',
    'if (restricted) return <section className="workspace"><div className="workspace-head"><div><h2>Clientes</h2><p>Cliente, Gestor de Tráfego responsável e tempo de relacionamento com a agência.</p></div><span className="counter">{clients.length} de {total}</span></div><section className="card section"><div className="toolbar portfolio-tools"><input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou Gestor de Tráfego" /></div><div className="table-wrap"><table><thead><tr><th scope="col">Cliente</th><th scope="col">Gestor de Tráfego</th><th scope="col">Tempo conosco</th></tr></thead><tbody>{clients.map((client) => <tr key={client.client_id}><td><div className="name">{text(client.display_name)}</div></td><td>{text(client.gt_owner || "Sem GT vinculado")}</td><td>{client.client_days == null ? "—" : `${formatNumber(client.client_days, 0)} dias`}</td></tr>)}{!clients.length && <tr><td colSpan={3} className="empty">Nenhum cliente encontrado.</td></tr>}</tbody></table></div></section></section>;')

# 2) Central de Trabalho: solicitação é o objeto; notificação é o aviso.
for old, new in [
    ('Falha ao criar demanda.', 'Falha ao criar solicitação.'),
    ('Falha ao atualizar demanda.', 'Falha ao atualizar solicitação.'),
    ('Receba, abra, execute e conclua demandas.', 'Receba, abra, execute e conclua solicitações.'),
    ('+ Nova demanda', '+ Nova solicitação'),
    ('<option value="">Demanda geral</option>', '<option value="">Solicitação geral</option>'),
    ('client.display_name || "Demanda geral"', 'client.display_name || "Solicitação geral"'),
    ('Nenhuma demanda nesse filtro.', 'Nenhuma solicitação nesse filtro.'),
    ('Carregando demandas…', 'Carregando solicitações…'),
]:
    replace(PAGE, old, new)

# 3) Foco do Dia dos perfis não-Design também recebe as próprias tasks do ClickUp.
replace(PAGE,
    '  const criticos = useMemo(() => alerts.filter((alert) => ["CRITICAL", "HIGH"].includes(alert.severity)), [alerts]);\n\n  const filas = useMemo(() => {',
    '  const criticos = useMemo(() => alerts.filter((alert) => ["CRITICAL", "HIGH"].includes(alert.severity)), [alerts]);\n  const personalClickup: Row[] = operations.personal_focus?.open_tasks || [];\n\n  const filas = useMemo(() => {')
replace(PAGE,
    '    const acompanhar: FocoItem[] = clients\n      .filter((client) => ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(client.priority) && client.next_step)',
    '    const now = new Date();\n    const clickupResolver: FocoItem[] = personalClickup\n      .filter((row) => row.due_date && new Date(String(row.due_date)) <= now)\n      .map((row) => ({\n        key: `clickup-${row.task_id}`, lane: "solve" as const, client_id: row.client_id ?? null,\n        cliente: nome(row.client_id, text(row.client_display_name || row.list_name || "Demanda interna")),\n        titulo: text(row.name || "Tarefa do ClickUp"), detalhe: `ClickUp · ${text(row.status || "aberta")} · ${row.due_date ? `prazo ${formatDate(row.due_date)}` : "sem prazo"}`,\n        dono: text(operations.personal_focus?.owner || "você"), horas: horasDesde(row.due_date), chip: "CLICKUP",\n      }));\n    const clickupAcompanhar: FocoItem[] = personalClickup\n      .filter((row) => !row.due_date || new Date(String(row.due_date)) > now)\n      .map((row) => ({\n        key: `clickup-${row.task_id}`, lane: "follow" as const, client_id: row.client_id ?? null,\n        cliente: nome(row.client_id, text(row.client_display_name || row.list_name || "Demanda interna")),\n        titulo: text(row.name || "Tarefa do ClickUp"), detalhe: `ClickUp · ${text(row.status || "aberta")} · ${row.due_date ? `prazo ${formatDate(row.due_date)}` : "sem prazo"}`,\n        dono: text(operations.personal_focus?.owner || "você"), horas: horasDesde(row.date_updated || row.date_created), chip: row.due_date ? "CLICKUP" : "SEM PRAZO",\n      }));\n\n    const acompanhar: FocoItem[] = clients\n      .filter((client) => ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(client.priority) && client.next_step)')
replace(PAGE,
    '      solve: [...resolverCompromissos, ...resolverAlertas].sort(porAtraso),\n      follow: acompanhar.sort(porAtraso),\n    };\n  }, [waiting, overdue, criticos, clients, clientePorId]);',
    '      solve: [...resolverCompromissos, ...resolverAlertas, ...clickupResolver].sort(porAtraso),\n      follow: [...acompanhar, ...clickupAcompanhar].sort(porAtraso),\n    };\n  }, [waiting, overdue, criticos, clients, clientePorId, personalClickup, operations.personal_focus?.owner]);')

# 4) Backend: vínculo perfil -> ClickUp por ID/username centralizado em team_identity_map.
replace(API,
    '  let profileClickupUser: string | null = null;\n  let accessLevel: AccessLevel = "FULL";',
    '  let profileClickupUser: string | null = null;\n  let profileClickupUserId: string | null = null;\n  let accessLevel: AccessLevel = "FULL";')
replace(API,
    '    if (collaboratorPerson) {\n      const { data: rosterRow } = await ops.from("team_roster").select("person,role,access_level,clickup_user").eq("person", collaboratorPerson).eq("is_former", false).maybeSingle();\n      if (rosterRow) {\n        profilePerson = rosterRow.person;\n        profileRole = rosterRow.role;\n        profileClickupUser = rosterRow.clickup_user;\n        accessLevel = (rosterRow.access_level as AccessLevel) ?? "RESTRICTED";\n      }\n    }',
    '    if (collaboratorPerson) {\n      const [{ data: rosterRow }, { data: identityRow }] = await Promise.all([\n        ops.from("team_roster").select("person,role,access_level,clickup_user").eq("person", collaboratorPerson).eq("is_former", false).maybeSingle(),\n        ops.from("team_identity_map").select("clickup_user_id,clickup_username").eq("person", collaboratorPerson).maybeSingle(),\n      ]);\n      if (rosterRow) {\n        profilePerson = rosterRow.person;\n        profileRole = rosterRow.role;\n        profileClickupUser = identityRow?.clickup_username ?? rosterRow.clickup_user;\n        profileClickupUserId = identityRow?.clickup_user_id ? String(identityRow.clickup_user_id) : null;\n        accessLevel = (rosterRow.access_level as AccessLevel) ?? "RESTRICTED";\n      }\n    }')
replace(API,
    '  const clientsBasic = activeClients.map((row) => ({ client_id: row.client_id, display_name: row.display_name, client_days: row.client_days }));',
    '  const clientsBasic = activeClients.map((row) => ({ client_id: row.client_id, display_name: row.display_name, gt_owner: row.gt_owner ?? null, client_days: row.client_days }));')

old_focus = '''  const rawProductivity30 = value<any[]>(results[12], []);
  const rawProductivityDaily = value<any[]>(results[13], []);
  const rawRecentCompleted = value<any[]>(results[14], []);
  const clickupScoped = isFull;
  const productivity30 = clickupScoped ? rawProductivity30 : rawProductivity30.filter((row) => norm(row.person) === norm(profileClickupUser));
  const productivityDaily = clickupScoped ? rawProductivityDaily : rawProductivityDaily.filter((row) => norm(row.person) === norm(profileClickupUser));
  const recentCompleted = clickupScoped ? rawRecentCompleted : rawRecentCompleted.filter((row: any) => (row.clickup_task_assignees ?? []).some((a: any) => norm(a.username) === norm(profileClickupUser)));

  // ---- Foco pessoal de Design. Nao reaproveita alertas, conversas, compromissos
  // nem prioridades de carteira: cada item nasce de uma tarefa ClickUp aberta e
  // atribuida ao designer autenticado.
  const designOwnerKeys = new Set([norm(profileClickupUser), norm(profilePerson)].filter(Boolean));
  const assignedToDesigner = (row: any) => (row.clickup_task_assignees ?? []).some((assignee: any) => {
    const email = norm(assignee.email);
    return [assignee.user_id, assignee.username, assignee.email, email.split("@")[0]]
      .some((candidate) => designOwnerKeys.has(norm(candidate)));
  });
  const exposeDesignTask = (row: any) => ({
    task_id: row.task_id,
    name: row.name,
    status: row.status,
    status_type: row.status_type ?? null,
    date_created: row.date_created ?? null,
    date_updated: row.date_updated ?? null,
    start_date: row.start_date ?? null,
    due_date: row.due_date ?? null,
    time_estimate_ms: row.time_estimate_ms ?? null,
    list_name: row.list_name ?? null,
    client_id: row.client_id ?? null,
    client_display_name: row.client_id ? (clientMeta.get(row.client_id)?.display_name ?? null) : null,
    url: row.url ?? null,
  });
  const designOpenTasks = isDesignRestricted
    ? value<any[]>(clickupData[9], []).filter(assignedToDesigner).map(exposeDesignTask)
    : [];
  const designClosedToday = isDesignRestricted
    ? value<any[]>(clickupData[10], [])
        .filter((row: any) => assignedToDesigner(row) && row.date_closed && opsDay(new Date(row.date_closed)) === opsDay())
        .map(exposeDesignTask)
    : [];
'''
new_focus = '''  const rawProductivity30 = value<any[]>(results[12], []);
  const rawProductivityDaily = value<any[]>(results[13], []);
  const rawRecentCompleted = value<any[]>(results[14], []);
  const currentOwnerKeys = new Set([norm(profileClickupUserId), norm(profileClickupUser), norm(profilePerson)].filter(Boolean));
  const assignedToCurrent = (row: any) => (row.clickup_task_assignees ?? []).some((assignee: any) => {
    const email = norm(assignee.email);
    return [assignee.user_id, assignee.username, assignee.email, email.split("@")[0]]
      .some((candidate) => currentOwnerKeys.has(norm(candidate)));
  });
  const clickupScoped = isFull;
  const productivity30 = clickupScoped ? rawProductivity30 : rawProductivity30.filter((row) => norm(row.person) === norm(profileClickupUser));
  const productivityDaily = clickupScoped ? rawProductivityDaily : rawProductivityDaily.filter((row) => norm(row.person) === norm(profileClickupUser));
  const recentCompleted = clickupScoped ? rawRecentCompleted : rawRecentCompleted.filter(assignedToCurrent);

  const exposePersonalTask = (row: any) => ({
    task_id: row.task_id,
    name: row.name,
    status: row.status,
    status_type: row.status_type ?? null,
    date_created: row.date_created ?? null,
    date_updated: row.date_updated ?? null,
    start_date: row.start_date ?? null,
    due_date: row.due_date ?? null,
    time_estimate_ms: row.time_estimate_ms ?? null,
    list_name: row.list_name ?? null,
    client_id: row.client_id ?? null,
    client_display_name: row.client_id ? (clientMeta.get(row.client_id)?.display_name ?? null) : null,
    url: row.url ?? null,
  });
  const personalOpenTasks = viaLogin
    ? value<any[]>(clickupData[9], []).filter(assignedToCurrent).map(exposePersonalTask)
    : [];
  const personalClosedToday = viaLogin
    ? value<any[]>(clickupData[10], [])
        .filter((row: any) => assignedToCurrent(row) && row.date_closed && opsDay(new Date(row.date_closed)) === opsDay())
        .map(exposePersonalTask)
    : [];

  // Design continua restrito ao trabalho criativo. A classificação usa lista +
  // categorias recorrentes do nome, sem depender apenas da palavra "design".
  const isDesignRelevantTask = (row: any) => {
    const haystack = norm(`${row.list_name ?? ""} ${row.name ?? ""}`);
    return /criativ|design|arte|video|vídeo|imagem|copy|roteiro|edicao|edição|revisao|revisão|ajuste na campanha/.test(haystack);
  };
  const designOpenTasks = isDesignRestricted
    ? value<any[]>(clickupData[9], []).filter((row: any) => assignedToCurrent(row) && isDesignRelevantTask(row)).map(exposePersonalTask)
    : [];
  const designClosedToday = isDesignRestricted
    ? value<any[]>(clickupData[10], [])
        .filter((row: any) => assignedToCurrent(row) && isDesignRelevantTask(row) && row.date_closed && opsDay(new Date(row.date_closed)) === opsDay())
        .map(exposePersonalTask)
    : [];
'''
replace(API, old_focus, new_focus)
replace(API,
    '      task_log: taskLog,\n      design_focus: isDesignRestricted ? { owner: profilePerson, open_tasks: designOpenTasks, closed_today: designClosedToday } : null,',
    '      task_log: taskLog,\n      personal_focus: viaLogin ? { owner: profilePerson, clickup_user_id: profileClickupUserId, open_tasks: personalOpenTasks, closed_today: personalClosedToday } : null,\n      design_focus: isDesignRestricted ? { owner: profilePerson, clickup_user_id: profileClickupUserId, open_tasks: designOpenTasks, closed_today: designClosedToday } : null,')
replace(API,
    'profile: { person: profilePerson, role: profileRole, access_level: accessLevel, portfolio_scoped: isPortfolioScoped, elevated,',
    'profile: { person: profilePerson, role: profileRole, access_level: accessLevel, clickup_user: profileClickupUser, clickup_user_id: profileClickupUserId, portfolio_scoped: isPortfolioScoped, elevated,')

# 5) Central Criativa: retirar "!" dos nomes e oferecer visão Por Clientes / Por Regras.
replace(CREATIVE,
    '  const [query, setQuery] = useState("");\n  const [selectedId, setSelectedId] = useState<string | null>(null);',
    '  const [query, setQuery] = useState("");\n  const [mode, setMode] = useState<"clients" | "rules">("clients");\n  const [selectedId, setSelectedId] = useState<string | null>(null);')
replace(CREATIVE,
    '  const selected = clients.find((client) => client.client_id === selectedId) || filtered[0] || null;\n  const summary = data?.summary || {};',
    '''  const selected = clients.find((client) => client.client_id === selectedId) || filtered[0] || null;
  const ruleGroups = useMemo(() => {
    const grouped = new Map<string, Row>();
    for (const client of clients) for (const rule of (client.rules || [])) {
      const description = text(rule.rule_text || rule.description || rule.content || rule.title || rule.rule_kind || rule.kind || "Diretriz").trim();
      const kind = text(rule.rule_kind || rule.kind || rule.title || "Diretriz");
      const key = `${kind}|${description}`.toLocaleLowerCase("pt-BR");
      const current = grouped.get(key) || { key, title: text(rule.title || rule.rule_kind || rule.kind || "Diretriz"), description, kind, status: rule.status, clients: [] as Row[] };
      if (!(current.clients as Row[]).some((item) => item.client_id === client.client_id)) (current.clients as Row[]).push({ client_id: client.client_id, display_name: client.display_name });
      grouped.set(key, current);
    }
    return [...grouped.values()].sort((a, b) => text(a.title).localeCompare(text(b.title), "pt-BR"));
  }, [clients]);
  const filteredRules = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    if (!needle) return ruleGroups;
    return ruleGroups.filter((rule) => [rule.title, rule.description, rule.kind, ...(rule.clients || []).map((client: Row) => client.display_name)].join(" ").toLocaleLowerCase("pt-BR").includes(needle));
  }, [ruleGroups, query]);
  const summary = data?.summary || {};''')
replace(CREATIVE,
    '    {loading && <div className="empty">Carregando diretrizes criativas…</div>}\n\n    {!loading && <div className="grid"',
    '    {loading && <div className="empty">Carregando diretrizes criativas…</div>}\n\n    {!loading && <div className="filter-tabs" style={{ marginBottom: 12 }}><button type="button" className={mode === "clients" ? "active" : ""} onClick={() => { setMode("clients"); setQuery(""); }}>Por Clientes</button><button type="button" className={mode === "rules" ? "active" : ""} onClick={() => { setMode("rules"); setQuery(""); }}>Por Regras</button></div>}\n\n    {!loading && mode === "clients" && <div className="grid"')
replace(CREATIVE,
    '            <span>{text(client.display_name)}</span>\n            {client.health?.needs_attention ? <span>!</span> : null}',
    '            <span>{text(client.display_name)}</span>')
replace(CREATIVE,
    '    </div>}\n  </section>;\n}',
    '''    </div>}

    {!loading && mode === "rules" && <section className="card section">
      <div className="workspace-head" style={{ marginBottom: 12 }}><div><div className="section-title">Regras consolidadas</div><p>Consulte uma diretriz independentemente do cliente e veja imediatamente a quais clientes ela se aplica.</p></div><span className="counter">{filteredRules.length} regras</span></div>
      <input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar regra, categoria ou cliente…" style={{ width: "100%", marginBottom: 10 }} />
      {filteredRules.map((rule) => <div className="productivity-row" key={text(rule.key)} style={{ alignItems: "flex-start" }}><div style={{ minWidth: 0 }}><b>{text(rule.title || rule.kind || "Diretriz")}</b><small>{text(rule.description)}</small><small style={{ display: "block", marginTop: 5 }}>Aplica-se a: {(rule.clients || []).map((client: Row) => text(client.display_name)).join(" · ") || "Nenhum cliente vinculado"}</small></div><strong>{labelStatus(rule.status)}</strong></div>)}
      {!filteredRules.length && <div className="empty">Nenhuma regra encontrada.</div>}
    </section>}
  </section>;
}''')

# 6) Migração idempotente para alinhar textos de notificação do Work Center.
migration = Path("supabase/migrations/20260821143500_work_center_solicitation_wording.sql")
migration.write_text('''-- Alinha a semântica: o objeto operacional é uma solicitação; notificação é o aviso.\ncreate or replace function agency_ops.audit_work_item()\nreturns trigger\nlanguage plpgsql\nset search_path to 'agency_ops', 'public'\nas $$\ndeclare\n  event_label text;\nbegin\n  event_label := case when tg_op = 'INSERT' then 'CREATED' else 'STATUS_CHANGED' end;\n  insert into agency_ops.work_item_events(work_item_id,event_type,actor_user_key,actor_person,previous_status,new_status,detail,metadata)\n  values (new.id,event_label,new.created_by_user_key,coalesce(new.completed_by,new.created_by_person),case when tg_op = 'UPDATE' then old.status else null end,new.status,case when tg_op = 'INSERT' then new.description else new.resolution end,jsonb_build_object('target_role',new.target_role,'target_person',new.target_person,'type',new.type));\n\n  if tg_op = 'INSERT' then\n    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)\n    values ('work-item-created:' || new.id::text,'WORK_ITEM_ASSIGNED',case new.priority when 'CRITICAL' then 'CRITICAL' when 'HIGH' then 'HIGH' else 'INFO' end,'Nova solicitação: ' || new.title,coalesce(new.description,'Abra a Central de Trabalho para ver e assumir.'),new.client_id,'work_center',new.created_by_person,now(),jsonb_build_object('work_item_id',new.id,'target_role',new.target_role,'target_person',new.target_person,'status',new.status));\n  elsif old.status is distinct from new.status and new.status = 'COMPLETED' then\n    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,source,actor,occurred_at,metadata)\n    values ('work-item-completed:' || new.id::text,'WORK_ITEM_COMPLETED','SUCCESS','Solicitação concluída: ' || new.title,coalesce(new.resolution,'A solicitação foi marcada como concluída.'),new.client_id,'work_center',new.completed_by,now(),jsonb_build_object('work_item_id',new.id,'target_person',new.created_by_person,'status',new.status));\n  end if;\n  return new;\nend;\n$$;\n''')
print("final consolidation patch applied")
