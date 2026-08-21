from pathlib import Path


def replace(path, old, new, expected=1):
    p = Path(path)
    src = p.read_text()
    found = src.count(old)
    if found != expected:
        raise SystemExit(f"{path}: expected {expected} occurrence(s), found {found}: {old[:120]!r}")
    p.write_text(src.replace(old, new))


page = "app/page.tsx"
api = "supabase/functions/agency-ops-dashboard-api/index.ts"

# Designers: busca e tabela de clientes também mostram/pesquisam o GT real do banco.
replace(
    page,
    '.filter((client) => !needle || text(client.display_name).toLocaleLowerCase("pt-BR").includes(needle))',
    '.filter((client) => !needle || [client.display_name, client.gt_owner].join(" ").toLocaleLowerCase("pt-BR").includes(needle))',
)
replace(
    page,
    'if (restricted) return <section className="workspace"><div className="workspace-head"><div><h2>Clientes</h2><p>Nome e tempo de relacionamento com a agência.</p></div><span className="counter">{clients.length} de {total}</span></div><section className="card section"><div className="toolbar portfolio-tools"><input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente" /></div><div className="table-wrap"><table><thead><tr><th scope="col">Cliente</th><th scope="col">Tempo conosco</th></tr></thead><tbody>{clients.map((client) => <tr key={client.client_id}><td><div className="name">{text(client.display_name)}</div></td><td>{client.client_days == null ? "—" : `${formatNumber(client.client_days, 0)} dias`}</td></tr>)}{!clients.length && <tr><td colSpan={2} className="empty">Nenhum cliente encontrado.</td></tr>}</tbody></table></div></section></section>;',
    'if (restricted) return <section className="workspace"><div className="workspace-head"><div><h2>Clientes</h2><p>Cliente, Gestor de Tráfego responsável e tempo de relacionamento com a agência.</p></div><span className="counter">{clients.length} de {total}</span></div><section className="card section"><div className="toolbar portfolio-tools"><input className="control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente ou Gestor de Tráfego" /></div><div className="table-wrap"><table><thead><tr><th scope="col">Cliente</th><th scope="col">Gestor de Tráfego</th><th scope="col">Tempo conosco</th></tr></thead><tbody>{clients.map((client) => <tr key={client.client_id}><td><div className="name">{text(client.display_name)}</div></td><td>{text(client.gt_owner || "Sem GT vinculado")}</td><td>{client.client_days == null ? "—" : `${formatNumber(client.client_days, 0)} dias`}</td></tr>)}{!clients.length && <tr><td colSpan={3} className="empty">Nenhum cliente encontrado.</td></tr>}</tbody></table></div></section></section>;'
)

# Central de Trabalho: solicitação é o objeto; notificação é o aviso.
for old, new in [
    ("Falha ao criar demanda.", "Falha ao criar solicitação."),
    ("Falha ao atualizar demanda.", "Falha ao atualizar solicitação."),
    ("Receba, abra, execute e conclua demandas.", "Receba, abra, execute e conclua solicitações."),
    ("+ Nova demanda", "+ Nova solicitação"),
    ('<option value="">Demanda geral</option>', '<option value="">Solicitação geral</option>'),
    ('client.display_name || "Demanda geral"', 'client.display_name || "Solicitação geral"'),
    ("Nenhuma demanda nesse filtro.", "Nenhuma solicitação nesse filtro."),
    ("Carregando demandas…", "Carregando solicitações…"),
]:
    replace(page, old, new)

# Foco do dia dos demais perfis: cruza sinais operacionais com as próprias tasks ClickUp.
replace(
    page,
    '  const criticos = useMemo(() => alerts.filter((alert) => ["CRITICAL", "HIGH"].includes(alert.severity)), [alerts]);\n\n  const filas = useMemo(() => {',
    '  const criticos = useMemo(() => alerts.filter((alert) => ["CRITICAL", "HIGH"].includes(alert.severity)), [alerts]);\n  const personalClickup: Row[] = operations.personal_focus?.open_tasks || [];\n\n  const filas = useMemo(() => {'
)
replace(
    page,
    '    const acompanhar: FocoItem[] = clients\n      .filter((client) => ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(client.priority) && client.next_step)',
    '''    const now = new Date();
    const clickupResolver: FocoItem[] = personalClickup
      .filter((row) => row.due_date && new Date(String(row.due_date)) <= now)
      .map((row) => ({
        key: `clickup-${row.task_id}`, lane: "solve" as const, client_id: row.client_id ?? null,
        cliente: nome(row.client_id, text(row.client_display_name || row.list_name || "Demanda interna")),
        titulo: text(row.name || "Tarefa do ClickUp"), detalhe: `ClickUp · ${text(row.status || "aberta")} · ${row.due_date ? `prazo ${formatDate(row.due_date)}` : "sem prazo"}`,
        dono: text(operations.personal_focus?.owner || "você"), horas: horasDesde(row.due_date), chip: "CLICKUP",
      }));
    const clickupAcompanhar: FocoItem[] = personalClickup
      .filter((row) => !row.due_date || new Date(String(row.due_date)) > now)
      .map((row) => ({
        key: `clickup-${row.task_id}`, lane: "follow" as const, client_id: row.client_id ?? null,
        cliente: nome(row.client_id, text(row.client_display_name || row.list_name || "Demanda interna")),
        titulo: text(row.name || "Tarefa do ClickUp"), detalhe: `ClickUp · ${text(row.status || "aberta")} · ${row.due_date ? `prazo ${formatDate(row.due_date)}` : "sem prazo"}`,
        dono: text(operations.personal_focus?.owner || "você"), horas: horasDesde(row.date_updated || row.date_created), chip: row.due_date ? "CLICKUP" : "SEM PRAZO",
      }));

    const acompanhar: FocoItem[] = clients
      .filter((client) => ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"].includes(client.priority) && client.next_step)'''
)
replace(
    page,
    '      solve: [...resolverCompromissos, ...resolverAlertas].sort(porAtraso),\n      follow: acompanhar.sort(porAtraso),\n    };\n  }, [waiting, overdue, criticos, clients, clientePorId]);',
    '      solve: [...resolverCompromissos, ...resolverAlertas, ...clickupResolver].sort(porAtraso),\n      follow: [...acompanhar, ...clickupAcompanhar].sort(porAtraso),\n    };\n  }, [waiting, overdue, criticos, clients, clientePorId, personalClickup, operations.personal_focus?.owner]);'
)
replace(
    page,
    '{ key: "solve" as const, verbo: "Resolver", titulo: "Venceu ou alertou", ajuda: "Compromissos com prazo estourado e alertas críticos/altos em aberto.", itens: filas.solve, tom: "warn" },\n    { key: "follow" as const, verbo: "Acompanhar", titulo: "Não venceu, mas não pode dormir", ajuda: "Próximas ações da carteira em atenção ou follow-up.", itens: filas.follow, tom: "" },',
    '{ key: "solve" as const, verbo: "Resolver", titulo: "Venceu, alertou ou está no seu ClickUp", ajuda: "Suas tarefas vencidas, compromissos estourados e alertas críticos/altos em aberto.", itens: filas.solve, tom: "warn" },\n    { key: "follow" as const, verbo: "Acompanhar", titulo: "Próximas ações e sua fila pessoal", ajuda: "Suas próximas tarefas do ClickUp e ações da carteira que não podem dormir.", itens: filas.follow, tom: "" },'
)

# Backend: ClickUp por ID é fonte primária; username/email ficam só como fallback.
replace(
    api,
    '  let profileClickupUser: string | null = null;\n  let accessLevel: AccessLevel = "FULL";',
    '  let profileClickupUser: string | null = null;\n  let profileClickupUserId: string | null = null;\n  let accessLevel: AccessLevel = "FULL";'
)
replace(
    api,
    '''    if (collaboratorPerson) {
      const { data: rosterRow } = await ops.from("team_roster").select("person,role,access_level,clickup_user").eq("person", collaboratorPerson).eq("is_former", false).maybeSingle();
      if (rosterRow) {
        profilePerson = rosterRow.person;
        profileRole = rosterRow.role;
        profileClickupUser = rosterRow.clickup_user;
        accessLevel = (rosterRow.access_level as AccessLevel) ?? "RESTRICTED";
      }
    }''',
    '''    if (collaboratorPerson) {
      const [{ data: rosterRow }, { data: identityRow }] = await Promise.all([
        ops.from("team_roster").select("person,role,access_level,clickup_user").eq("person", collaboratorPerson).eq("is_former", false).maybeSingle(),
        ops.from("team_identity_map").select("clickup_user_id,clickup_username").eq("person", collaboratorPerson).maybeSingle(),
      ]);
      if (rosterRow) {
        profilePerson = rosterRow.person;
        profileRole = rosterRow.role;
        profileClickupUser = identityRow?.clickup_username ?? rosterRow.clickup_user;
        profileClickupUserId = identityRow?.clickup_user_id ? String(identityRow.clickup_user_id) : null;
        accessLevel = (rosterRow.access_level as AccessLevel) ?? "RESTRICTED";
      }
    }'''
)
replace(
    api,
    '  const clientsBasic = activeClients.map((row) => ({ client_id: row.client_id, display_name: row.display_name, client_days: row.client_days }));',
    '  const clientsBasic = activeClients.map((row) => ({ client_id: row.client_id, display_name: row.display_name, gt_owner: row.gt_owner ?? null, client_days: row.client_days }));'
)
replace(
    api,
    '''  const designOwnerKeys = new Set([norm(profileClickupUser), norm(profilePerson)].filter(Boolean));
  const assignedToDesigner = (row: any) => (row.clickup_task_assignees ?? []).some((assignee: any) => {
    const email = norm(assignee.email);
    return [assignee.user_id, assignee.username, assignee.email, email.split("@")[0]]
      .some((candidate) => designOwnerKeys.has(norm(candidate)));
  });''',
    '''  const profileOwnerKeys = new Set([norm(profileClickupUser), norm(profilePerson)].filter(Boolean));
  const assignedToProfile = (row: any) => (row.clickup_task_assignees ?? []).some((assignee: any) => {
    if (profileClickupUserId && String(assignee.user_id ?? "") === profileClickupUserId) return true;
    const email = norm(assignee.email);
    return [assignee.username, assignee.email, email.split("@")[0]]
      .some((candidate) => profileOwnerKeys.has(norm(candidate)));
  });'''
)
replace(
    api,
    '''  const designOpenTasks = isDesignRestricted
    ? value<any[]>(clickupData[9], []).filter(assignedToDesigner).map(exposeDesignTask)
    : [];
  const designClosedToday = isDesignRestricted
    ? value<any[]>(clickupData[10], [])
        .filter((row: any) => assignedToDesigner(row) && row.date_closed && opsDay(new Date(row.date_closed)) === opsDay())
        .map(exposeDesignTask)
    : [];''',
    '''  const scopedPersonalTask = (row: any) => assignedToProfile(row) && (!row.client_id || inScope(row.client_id));
  const designOpenTasks = isDesignRestricted
    ? value<any[]>(clickupData[9], []).filter(scopedPersonalTask).map(exposeDesignTask)
    : [];
  const designClosedToday = isDesignRestricted
    ? value<any[]>(clickupData[10], [])
        .filter((row: any) => scopedPersonalTask(row) && row.date_closed && opsDay(new Date(row.date_closed)) === opsDay())
        .map(exposeDesignTask)
    : [];
  const personalOpenTasks = !isDesignRestricted && profilePerson
    ? value<any[]>(clickupData[9], []).filter(scopedPersonalTask).map(exposeDesignTask)
    : [];
  const personalClosedToday = !isDesignRestricted && profilePerson
    ? value<any[]>(clickupData[10], []).filter((row: any) => scopedPersonalTask(row) && row.date_closed && opsDay(new Date(row.date_closed)) === opsDay()).map(exposeDesignTask)
    : [];'''
)
replace(
    api,
    '      design_focus: isDesignRestricted ? { owner: profilePerson, open_tasks: designOpenTasks, closed_today: designClosedToday } : null,',
    '      design_focus: isDesignRestricted ? { owner: profilePerson, clickup_user_id: profileClickupUserId, open_tasks: designOpenTasks, closed_today: designClosedToday } : null,\n      personal_focus: !isDesignRestricted && profilePerson ? { owner: profilePerson, clickup_user_id: profileClickupUserId, open_tasks: personalOpenTasks, closed_today: personalClosedToday } : null,'
)
replace(
    api,
    'profile: { person: profilePerson, role: profileRole, access_level: accessLevel, portfolio_scoped: isPortfolioScoped, elevated, can_decide_access_requests: canDecideAccessRequests, can_view_operational_alerts: canViewOperationalAlerts, can_manage_finance: isAdler && canView("finance"), is_executive: isLeonardo && canView("executive"), locked: isLocked, account_approved: accountApproved, views: allowedViews, views_stale: viewsStale, carteira: walletName(profilePerson) },',
    'profile: { person: profilePerson, role: profileRole, access_level: accessLevel, portfolio_scoped: isPortfolioScoped, elevated, clickup_user_id: profileClickupUserId, can_decide_access_requests: canDecideAccessRequests, can_view_operational_alerts: canViewOperationalAlerts, can_manage_finance: isAdler && canView("finance"), is_executive: isLeonardo && canView("executive"), locked: isLocked, account_approved: accountApproved, views: allowedViews, views_stale: viewsStale, carteira: walletName(profilePerson) },'
)
