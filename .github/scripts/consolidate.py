from pathlib import Path
import re

p = Path('app/shared.tsx')
s = p.read_text()
s = s.replace(' | "alerts" | "opsperf";', ' | "alerts" | "opsperf" | "creative";')
p.write_text(s)

p = Path('app/page.tsx')
s = p.read_text()
anchor = 'const OpsPerfCenter = lazy(() => import("./views/opsperf").then((m) => ({ default: m.OpsPerfCenter })));'
if 'CreativeCenter' not in s:
    s = s.replace(anchor, anchor + '\nconst CreativeCenter = lazy(() => import("./views/creative").then((m) => ({ default: m.CreativeCenter })));')
s = s.replace('  const isDesignRestricted = data?.profile?.role === "DESIGN";\n', '  const isDesignRestricted = data?.profile?.role === "DESIGN";\n  const isAdlerAccount = session?.user?.id === "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476";\n')
s = s.replace('["work", "Central de Trabalho"], ["clients", "Clientes"], ["health", "Saúde"]', '["work", "Central de Trabalho"], ["clients", "Clientes"], ["creative", "Central Criativa"], ["health", "Saúde"]')
old_ai = '''          {/* A IA e' rota propria, nao aba de estado: link de verdade, para abrir
              direto em /ia e continuar funcionando no voltar do navegador. */}
          <a href="/ia" title="IA da agência">IA</a>'''
new_ai = '''          {isAdlerAccount
            ? <a href="/ia" title="IA da agência">IA</a>
            : <button type="button" title="IA em desenvolvimento" onClick={() => window.alert("Esta função está em desenvolvimento pelo PAI DO OP.")}>IA (Beta)</button>}'''
assert old_ai in s, 'missing IA nav anchor'
s = s.replace(old_ai, new_ai, 1)
old_kpi = '''      {isDesignRestricted && view === "focus"
        ? <DesignFocusMetrics focus={data?.operations?.design_focus || {}} loading={!data} />
        : <section className="grid kpis">
            <Metric label="Clientes ativos" value={formatNumber(kpis.active_clients)} tone="blue" hint="Ativos + onboarding" loading={!data} />
            <Metric label="Atenção agora" value={formatNumber(kpis.attention_now)} tone="red" hint="prioridade operacional" loading={!data} />
            <Metric label="Follow-up" value={formatNumber(kpis.follow_up)} tone="yellow" hint="ação em acompanhamento" loading={!data} />
            <Metric label="Operação OK" value={formatNumber(kpis.ok)} tone="green" hint="sem pendência crítica" loading={!data} />
            <Metric label="Compromissos vencidos" value={formatNumber(kpis.overdue_commitments)} tone={kpis.overdue_commitments ? "red" : "green"} hint="em aberto" loading={!data} />
            <Metric label="Alertas abertos" value={formatNumber(kpis.open_alerts)} tone={kpis.critical_alerts ? "red" : "yellow"} hint={`${formatNumber(kpis.critical_alerts)} críticos/altos`} loading={!data} />
          </section>}'''
new_kpi = '''      {isDesignRestricted && view === "focus" && <DesignFocusMetrics focus={data?.operations?.design_focus || {}} loading={!data} />}
      {view === "overview" && <section className="grid kpis">
            <Metric label="Clientes ativos" value={formatNumber(kpis.active_clients)} tone="blue" hint="Ativos + onboarding" loading={!data} />
            <Metric label="Atenção agora" value={formatNumber(kpis.attention_now)} tone="red" hint="prioridade operacional" loading={!data} />
            <Metric label="Follow-up" value={formatNumber(kpis.follow_up)} tone="yellow" hint="ação em acompanhamento" loading={!data} />
            <Metric label="Operação OK" value={formatNumber(kpis.ok)} tone="green" hint="sem pendência crítica" loading={!data} />
            <Metric label="Compromissos vencidos" value={formatNumber(kpis.overdue_commitments)} tone={kpis.overdue_commitments ? "red" : "green"} hint="em aberto" loading={!data} />
            {data?.profile?.can_view_operational_alerts && <Metric label="Alertas abertos" value={formatNumber(kpis.open_alerts)} tone={kpis.critical_alerts ? "red" : "yellow"} hint={`${formatNumber(kpis.critical_alerts)} críticos/altos`} loading={!data} />}
          </section>}'''
assert old_kpi in s, 'missing KPI anchor'
s = s.replace(old_kpi, new_kpi, 1)
client_anchor = '''      {view === "clients" && canSee("clients") && (isDesignRestricted
        ? <ClientPortfolio restricted clients={clients} total={allClients.length} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} lifecycleFilter={lifecycleFilter} setLifecycleFilter={setLifecycleFilter} openClient={openClient} />
        : <><PortfolioCenter portfolio={data?.portfolio || null} openClient={openClient} />
          <details className="card portfolio-fulllist"><summary>Lista completa de clientes <span>{allClients.length}</span></summary>
          <ClientPortfolio clients={clients} total={allClients.length} query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} lifecycleFilter={lifecycleFilter} setLifecycleFilter={setLifecycleFilter} openClient={openClient} /></details></>)}'''
assert client_anchor in s, 'missing clients render anchor'
s = s.replace(client_anchor, client_anchor + '\n      {view === "creative" && canSee("creative") && <Suspense fallback={<div className="auth-loading"><span className="dot loading"/> Carregando Central Criativa…</div>}><CreativeCenter token={session.access_token} /></Suspense>}', 1)
s = s.replace('Registro de Tarefas', 'TaskLog')
p.write_text(s)

p = Path('app/ia/page.tsx')
s = p.read_text()
gate_anchor = '  if (!authReady) return <main className="ai-auth"><span className="ai-spinner" /> Validando sua sessão…</main>;\n  if (!session) return <main className="ai-auth"><div><h1>Faça login na Central de Operações</h1><p>A IA usa o mesmo perfil e as mesmas permissões do Dashboard.</p><a href="/">Voltar para o login</a></div></main>;'
assert gate_anchor in s, 'missing /ia gate anchor'
s = s.replace(gate_anchor, gate_anchor + '\n  if (session.user.id !== "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476") return <main className="ai-auth"><div><h1>IA (Beta)</h1><p>Esta função está em desenvolvimento pelo PAI DO OP.</p><a href="/">Voltar para a Central de Operações</a></div></main>;', 1)
p.write_text(s)

p = Path('server/src/routes/ai.ts')
s = p.read_text()
locked = '''  if (identity.locked) {
    res.status(403).json({ ok: false, error: "account_locked" });
    return;
  }
'''
assert locked in s, 'missing AI server auth anchor'
s = s.replace(locked, locked + '''
  if (identity.userId !== "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476") {
    res.status(403).json({ ok: false, error: "ai_beta" });
    return;
  }
''', 1)
p.write_text(s)

p = Path('supabase/functions/agency-ops-ai-ask/index.ts')
s = p.read_text()
legacy = '''  const isFull = accessLevel === "FULL" || elevated;
  if (!accountApproved || !person) return reply({ ok: false, error: "OpsQuestion indisponível: conta ainda não liberada." }, 403);
  if (!isFull) return reply({ ok: false, error: "OpsQuestion está liberado somente para perfis de gestão/acesso total por enquanto." }, 403);'''
assert legacy in s, 'missing legacy AI auth anchor'
s = s.replace(legacy, '''  if (!accountApproved || !person) return reply({ ok: false, error: "OpsQuestion indisponível: conta ainda não liberada." }, 403);
  if (user.id !== "794f4cd0-0279-4ad8-9cf9-a1e2c1bc4476") return reply({ ok: false, error: "OpsQuestion está em Beta e disponível somente para Adler." }, 403);''', 1)
p.write_text(s)

p = Path('supabase/functions/agency-ops-dashboard-api/index.ts')
s = p.read_text()
perms_old = '''  const canView = (key: string) => allowedViews.includes(key);
  const isAdler = !viaLogin || profilePerson === "Adler Furtado";
  const isLeonardo = profilePerson === "Leonardo Augusto";'''
assert perms_old in s, 'missing dashboard permission anchor'
s = s.replace(perms_old, '''  const isAdler = !viaLogin || profilePerson === "Adler Furtado";
  const isLeonardo = profilePerson === "Leonardo Augusto";
  // Alertas operacionais sao dados de decisao: somente Operacoes (Adler), CS e GT.
  // GT/CS continuam submetidos ao escopo da propria carteira logo abaixo.
  const canViewOperationalAlerts = isAdler || profileRole === "CS" || profileRole === "GT";
  if (!canViewOperationalAlerts) allowedViews = allowedViews.filter((key) => key !== "alerts");
  const canView = (key: string) => allowedViews.includes(key);''', 1)
new_s, count = re.subn(r'const alerts: any\[\] = value\(results\[1\], \[\]\)\.filter\(\(row: any\) => inScope\(row\.client_id\)\);', 'const alerts: any[] = canViewOperationalAlerts\n    ? value(results[1], []).filter((row: any) => inScope(row.client_id))\n    : [];', s, count=1)
assert count == 1, 'missing alerts payload anchor'
s = new_s
profile_old = 'can_decide_access_requests: canDecideAccessRequests, can_manage_finance:'
assert profile_old in s, 'missing profile permission anchor'
s = s.replace(profile_old, 'can_decide_access_requests: canDecideAccessRequests, can_view_operational_alerts: canViewOperationalAlerts, can_manage_finance:', 1)
p.write_text(s)
