"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { BrandMark, SUPABASE_URL, authenticatedFetch, loadProfileLite, supabase } from "./shared";

type Row = Record<string, any>;
type View = "home" | "funnel" | "prospects" | "clients" | "campaigns" | "meetings" | "direction";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-commercial-direction-api`;
const managerViews: Array<[View, string]> = [
  ["home", "Home Comercial"],
  ["funnel", "Funil Comercial"],
  ["prospects", "Prospects / Relato"],
  ["clients", "Clientes"],
  ["campaigns", "Campanhas"],
  ["meetings", "Reuniões"],
  ["direction", "Direção Comercial"],
];
const closerViews: Array<[View, string]> = [
  ["home", "Minha visão"],
  ["funnel", "Meu Funil"],
  ["prospects", "Prospects / Relato"],
  ["meetings", "Reuniões"],
  ["clients", "Cases / Clientes"],
  ["campaigns", "Resultados / Campanhas"],
];
const stageLabel: Record<string, string> = { novo: "Novo", qualificacao: "Qualificação", reuniao: "Reunião", proposta: "Proposta", negociacao: "Negociação", fechado: "Fechado", perdido: "Perdido" };
const lifecycleLabel: Record<string, string> = { ACTIVE: "Ativo", ONBOARDING: "Onboarding", CHURNED: "Churned" };
const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const text = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;
const number = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const money = (value: unknown) => Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const dateTime = (value: unknown) => {
  if (!value) return "sem registro";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return String(value);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(parsed);
};
const dateOnly = (value: unknown) => {
  if (!value) return "—";
  const raw = String(value).slice(0, 10);
  const [year, month, day] = raw.split("-").map(Number);
  return year && month && day ? new Intl.DateTimeFormat("pt-BR").format(new Date(year, month - 1, day)) : raw;
};

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <article className="lc-kpi"><span>{label}</span><b>{value}</b><small>{hint}</small></article>;
}

function Source({ name, source }: { name: string; source: Row }) {
  const age = source?.age_hours == null ? "idade desconhecida" : Number(source.age_hours) < 24 ? `${number(source.age_hours)}h atrás` : `${number(Number(source.age_hours) / 24)}d atrás`;
  return <article className={`lc-source ${source?.stale ? "stale" : "fresh"}`}><div><i /> <b>{name}</b></div><strong>{source?.stale ? "Fonte desatualizada" : "Fonte atual"}</strong><small>{source?.updated_at ? `${dateTime(source.updated_at)} · ${age}` : "Sem registro de atualização"}</small></article>;
}

function Table({ children }: { children: React.ReactNode }) {
  return <div className="lc-table-wrap"><table>{children}</table></div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="lc-empty">{children}</div>;
}

function HomeView({ data }: { data: Row }) {
  const s = data.summary || {};
  const stages: Row[] = data.stage_summary || [];
  const performance: Row[] = data.performance || [];
  const isCloser = String(data.profile?.role || "").toUpperCase() === "CLOSER";
  return <div className="lc-stack">
    <section className="lc-kpis">
      <Kpi label={isCloser ? "Meu pipeline" : "Leads abertos"} value={number(s.open_leads)} hint={`${number(s.new_7d)} novos nos últimos 7 dias`} />
      <Kpi label="Oportunidades avançadas" value={number(s.advanced_opportunities)} hint="reunião, proposta ou negociação" />
      <Kpi label="Forecast ponderado" value={money(s.weighted_forecast_value)} hint="pipeline comercial informado" />
      <Kpi label="Fechados · 30 dias" value={number(s.won_30d)} hint={`${money(s.won_monthly_30d)} em mensalidades`} />
      <Kpi label={isCloser ? "Follow-ups vencidos" : "Clientes ativos"} value={number(isCloser ? s.followups_overdue : s.active_clients)} hint={isCloser ? "próximos passos atrasados" : "ativos + onboarding"} />
      <Kpi label={isCloser ? "Prospects com calls" : "Campanhas ativas"} value={number(isCloser ? s.prospects_with_calls : s.active_campaigns)} hint={`${number(s.meetings_7d)} reuniões em 7 dias`} />
    </section>
    <section className="lc-sources">
      <Source name="CRM Comercial" source={data.sources?.crm || {}} />
      <Source name="Reuniões" source={data.sources?.meetings || {}} />
      <Source name="Campanhas" source={data.sources?.campaigns || {}} />
    </section>
    <div className="lc-grid2">
      <section className="lc-card"><div className="lc-card-head"><span>PIPELINE</span><h3>Etapas do funil</h3></div>{stages.length ? stages.map((row) => <div className="lc-stage" key={row.stage}><div><b>{stageLabel[row.stage] || text(row.stage)}</b><small>{number(row.count)} oportunidades</small></div><strong>{money(row.weighted_value)}</strong></div>) : <Empty>Sem oportunidades no funil.</Empty>}</section>
      <section className="lc-card"><div className="lc-card-head"><span>TIME COMERCIAL</span><h3>Resultado por responsável</h3></div>{performance.length ? performance.map((row) => <div className="lc-owner" key={row.owner_id || row.owner_name}><div><b>{text(row.owner_name)}</b><small>{number(row.open_leads)} abertos · {number(row.proposals)} propostas · {number(row.negotiations)} negociações</small></div><div><strong>{money(row.weighted_value)}</strong><small>{number(row.won_30d)} fechados em 30d</small></div></div>) : <Empty>Sem responsáveis comerciais encontrados.</Empty>}</section>
    </div>
  </div>;
}

function FunnelView({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("OPEN");
  const [owner, setOwner] = useState("ALL");
  const leads: Row[] = data.leads || [];
  const owners = [...new Set(leads.map((row) => text(row.owner_name)).filter((name) => name !== "—"))].sort();
  const visible = useMemo(() => leads.filter((row) => {
    const rowStage = String(row.stage || "");
    const stageOk = stage === "ALL" || (stage === "OPEN" ? !["fechado", "perdido"].includes(rowStage) : rowStage === stage);
    const ownerOk = owner === "ALL" || row.owner_name === owner;
    const q = norm(query);
    const searchOk = !q || norm(`${row.name || ""} ${row.company || ""} ${row.owner_name || ""} ${row.source || ""}`).includes(q);
    return stageOk && ownerOk && searchOk;
  }), [leads, query, stage, owner]);
  return <section className="lc-card lc-wide"><div className="lc-view-head"><div><span>CRM COMERCIAL</span><h2>Funil Comercial</h2><p>Uma única fonte para oportunidades. Pré-clientes antigo não é usado aqui.</p></div><b>{visible.length} oportunidades</b></div>
    <div className="lc-filters"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar lead, empresa ou origem"/><select value={stage} onChange={(e) => setStage(e.target.value)}><option value="OPEN">Em aberto</option><option value="ALL">Todas</option>{Object.entries(stageLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="ALL">Todos os responsáveis</option>{owners.map((name) => <option key={name}>{name}</option>)}</select></div>
    <Table><thead><tr><th>Lead</th><th>Responsável</th><th>Etapa</th><th>Origem</th><th>Atualizado na fonte</th><th>Valor</th></tr></thead><tbody>{visible.map((row) => <tr key={row.id}><td><b>{text(row.company || row.name)}</b>{row.company && <small>{text(row.name)}</small>}</td><td>{text(row.owner_name)}</td><td><span className={`lc-pill ${row.stage}`}>{stageLabel[row.stage] || text(row.stage)}</span></td><td>{text(row.source)}</td><td>{dateTime(row.updated_at)}</td><td>{Number(row.estimated_value || 0) ? money(row.estimated_value) : "não informado"}</td></tr>)}</tbody></Table>
    {!visible.length && <Empty>Nenhuma oportunidade nesse filtro.</Empty>}
  </section>;
}

function ProspectModal({ lead, data, close, reload }: { lead: Row; data: Row; close: () => void; reload: () => void }) {
  const profile = lead.prospect_profile || {};
  const calls: Row[] = (data.commercial_calls || []).filter((row: Row) => String(row.lead_id) === String(lead.id));
  const activities: Row[] = (data.commercial_activities || []).filter((row: Row) => String(row.lead_id) === String(lead.id));
  const [stage, setStage] = useState(String(lead.stage || "novo"));
  const [value, setValue] = useState(String(lead.estimated_value || ""));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const savePipeline = async () => {
    setSaving(true); setMessage("");
    try {
      const response = await authenticatedFetch(API, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ action:"update_lead", lead_id:lead.id, stage, estimated_value:value === "" ? 0 : Number(value) }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || "Falha ao atualizar oportunidade");
      setMessage("Oportunidade atualizada."); reload();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Falha ao atualizar."); }
    finally { setSaving(false); }
  };
  const briefing = profile.closer_briefing || profile.qualification_summary || calls[0]?.transcript_summary || calls[0]?.ai_summary || lead.notes;
  return <div className="lc-modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) close(); }}><section className="lc-modal" role="dialog" aria-modal="true"><header><div><span>PROSPECT · RELATO COMERCIAL</span><h2>{text(lead.company || lead.name)}</h2><p>{text(lead.name)} · {text(lead.phone)} · {text(lead.email)}</p></div><button onClick={close}>×</button></header><div className="lc-modal-body">
    <div className="lc-detail-grid"><article><span>Etapa</span><b>{stageLabel[lead.stage] || text(lead.stage)}</b></article><article><span>Origem</span><b>{text(lead.source)}</b></article><article><span>Última call</span><b>{dateTime(profile.last_call_at || calls[0]?.created_at)}</b></article><article><span>Cidade / região</span><b>{text([profile.city, profile.region].filter(Boolean).join(" · "))}</b></article><article><span>Corretores</span><b>{profile.broker_count == null ? "—" : number(profile.broker_count)}</b></article><article><span>Investimento marketing</span><b>{text(profile.marketing_investment || lead.orcamento_mkt)}</b></article></div>
    <section className="lc-modal-section"><h3>Resumo para o closer</h3><div className="lc-brief">{text(briefing, "O Relato ainda não gerou um resumo para esta oportunidade.")}</div></section>
    <section className="lc-modal-section"><h3>Qualificação</h3><div className="lc-detail-grid"><article><span>Dores</span><b>{(profile.pain_points || []).join(" · ") || "—"}</b></article><article><span>Objetivos</span><b>{(profile.goals || []).join(" · ") || "—"}</b></article><article><span>Interesses</span><b>{(profile.services_interest || []).join(" · ") || "—"}</b></article><article><span>Objeções</span><b>{(profile.objections || []).join(" · ") || "—"}</b></article><article><span>Urgência</span><b>{text(profile.urgency)}</b></article><article><span>Próximo passo</span><b>{text(profile.next_step)}{profile.next_step_at ? ` · ${dateTime(profile.next_step_at)}` : ""}</b></article></div></section>
    <section className="lc-modal-section"><h3>Atualizar negociação</h3><div className="lc-editor"><select value={stage} onChange={(e)=>setStage(e.target.value)}>{Object.entries(stageLabel).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select><input type="number" min="0" value={value} onChange={(e)=>setValue(e.target.value)} placeholder="Valor estimado"/><button onClick={savePipeline} disabled={saving}>{saving ? "Salvando…" : "Salvar"}</button></div>{message && <small className="lc-message">{message}</small>}</section>
    <section className="lc-modal-section"><h3>Histórico de calls ({calls.length})</h3>{calls.length ? calls.slice(0,12).map((call)=><article className="lc-meeting-mini" key={call.id}><div><b>{text(call.channel, "Call comercial")}</b><small>{dateTime(call.created_at)} · SDR {text(call.sdr_person)}</small></div><p>{text(call.transcript_summary || call.ai_summary || call.notes, "Transcrição processando ou sem resumo.")}</p>{call.next_step && <small>Próximo passo: {call.next_step}</small>}</article>) : <Empty>Nenhuma call comercial vinculada ainda.</Empty>}</section>
    <section className="lc-modal-section"><h3>Atividades ({activities.length})</h3>{activities.length ? activities.slice(0,12).map((item)=><article className="lc-meeting-mini" key={item.id}><div><b>{text(item.title)}</b><small>{item.due_at ? `Prazo ${dateTime(item.due_at)}` : dateTime(item.created_at)}</small></div><p>{text(item.description, text(item.activity_type))}</p></article>) : <Empty>Nenhuma atividade registrada.</Empty>}</section>
  </div></section></div>;
}

function ProspectsView({ data, reload }: { data: Row; reload: () => void }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const leads: Row[] = data.leads || [];
  const visible = leads.filter((row) => !norm(query) || norm(`${row.name||""} ${row.company||""} ${row.phone||""} ${row.source||""}`).includes(norm(query)));
  return <><section className="lc-card lc-wide"><div className="lc-view-head"><div><span>RELATO AI · COMERCIAL</span><h2>Prospects</h2><p>Qualificação do SDR, calls, transcrições e próximos passos no mesmo registro do CRM.</p></div><b>{visible.length} prospects</b></div><div className="lc-filters"><input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="Buscar prospect, empresa, telefone ou origem"/></div><Table><thead><tr><th>Prospect</th><th>Etapa</th><th>Calls</th><th>Última call</th><th>Próximo passo</th><th>Valor</th></tr></thead><tbody>{visible.map((row)=><tr key={row.id} className="clickable" onClick={()=>setSelected(row)}><td><b>{text(row.company || row.name)}</b><small>{text(row.name)} · {text(row.phone)}</small></td><td><span className={`lc-pill ${row.stage}`}>{stageLabel[row.stage] || text(row.stage)}</span></td><td>{number(row.call_count)}</td><td>{dateTime(row.prospect_profile?.last_call_at || row.last_call?.created_at)}</td><td>{text(row.prospect_profile?.next_step)}{row.followup_overdue && <small className="lc-danger">follow-up vencido</small>}</td><td>{Number(row.estimated_value||0) ? money(row.estimated_value) : "—"}</td></tr>)}</tbody></Table>{!visible.length && <Empty>Nenhum prospect encontrado.</Empty>}</section>{selected && <ProspectModal lead={selected} data={data} close={()=>setSelected(null)} reload={reload}/>}</>;
}

function ClientModal({ client, data, close }: { client: Row; data: Row; close: () => void }) {
  const meetings: Row[] = (data.meetings || []).filter((row: Row) => String(row.client_id || "") === String(client.client_id));
  const campaign = client.campaign || null;
  return <div className="lc-modal-backdrop" onMouseDown={(e) => { if (e.currentTarget === e.target) close(); }}><section className="lc-modal" role="dialog" aria-modal="true" aria-label={`Cliente ${client.display_name}`}><header><div><span>CLIENTE · VISÃO COMERCIAL</span><h2>{text(client.display_name)}</h2><p>Somente dados comerciais e cadastrais. Sem operação, WhatsApp, saúde ou ClickUp.</p></div><button onClick={close}>×</button></header><div className="lc-modal-body"><div className="lc-detail-grid"><article><span>Status</span><b>{lifecycleLabel[client.lifecycle] || text(client.lifecycle)}</b></article><article><span>Serviço</span><b>{text(client.service)}</b></article><article><span>Tempo conosco</span><b>{client.client_days == null ? "—" : `${number(client.client_days)} dias`}</b></article><article><span>Entrada</span><b>{dateOnly(client.entrada)}</b></article><article><span>CS</span><b>{text(client.cs_owner)}</b></article><article><span>Gestor de tráfego</span><b>{text(client.gt_owner)}</b></article></div>
    <section className="lc-modal-section"><h3>Campanha atual</h3>{campaign ? <div className="lc-detail-grid"><article><span>Campanhas ativas</span><b>{number(campaign.active_campaigns)}</b></article><article><span>Investimento</span><b>{money(campaign.spend)}</b></article><article><span>Leads</span><b>{number(campaign.leads)}</b></article><article><span>Custo por resultado</span><b>{Number(campaign.cost_per_result || 0) ? money(campaign.cost_per_result) : "—"}</b></article></div> : <Empty>Sem campanha ativa vinculada.</Empty>}</section>
    <section className="lc-modal-section"><h3>Reuniões comerciais vinculadas</h3>{meetings.length ? meetings.slice(0, 8).map((row) => <article className="lc-meeting-mini" key={row.id}><div><b>{text(row.title)}</b><small>{dateTime(row.meeting_started_at)} · {text(row.owner)}</small></div><p>{text(row.summary)}</p></article>) : <Empty>Nenhuma reunião comercial vinculada a este cliente.</Empty>}</section></div></section></div>;
}

function ClientsView({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const [lifecycle, setLifecycle] = useState("ACTIVE");
  const [selected, setSelected] = useState<Row | null>(null);
  const clients: Row[] = data.portfolio_clients || [];
  const visible = useMemo(() => clients.filter((row) => {
    const lifeOk = lifecycle === "ALL" || (lifecycle === "ACTIVE" ? ["ACTIVE", "ONBOARDING"].includes(String(row.lifecycle)) : row.lifecycle === lifecycle);
    const q = norm(query);
    return lifeOk && (!q || norm(`${row.display_name || ""} ${row.service || ""} ${row.cs_owner || ""} ${row.gt_owner || ""}`).includes(q));
  }), [clients, query, lifecycle]);
  return <><section className="lc-card lc-wide"><div className="lc-view-head"><div><span>CARTEIRA COMERCIAL</span><h2>Clientes</h2><p>A mesma base de clientes da agência, reduzida aos dados que fazem sentido para a direção comercial.</p></div><b>{visible.length} clientes</b></div><div className="lc-filters"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente, serviço ou responsável"/><select value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}><option value="ACTIVE">Ativos + onboarding</option><option value="CHURNED">Churned</option><option value="ALL">Todos</option></select></div><Table><thead><tr><th>Cliente</th><th>Status</th><th>Serviço</th><th>Tempo conosco</th><th>CS</th><th>GT</th><th>Campanhas</th></tr></thead><tbody>{visible.map((row) => <tr key={row.client_id} className="clickable" onClick={() => setSelected(row)}><td><b>{text(row.display_name)}</b></td><td><span className={`lc-pill ${String(row.lifecycle).toLowerCase()}`}>{lifecycleLabel[row.lifecycle] || text(row.lifecycle)}</span></td><td>{text(row.service)}</td><td>{row.client_days == null ? "—" : `${number(row.client_days)}d`}</td><td>{text(row.cs_owner)}</td><td>{text(row.gt_owner)}</td><td>{row.campaign ? `${number(row.campaign.active_campaigns)} ativas` : "sem campanha ativa"}</td></tr>)}</tbody></Table>{!visible.length && <Empty>Nenhum cliente nesse filtro.</Empty>}</section>{selected && <ClientModal client={selected} data={data} close={() => setSelected(null)} />}</>;
}

function CampaignsView({ data }: { data: Row }) {
  const [query, setQuery] = useState("");
  const campaigns: Row[] = data.campaigns || [];
  const visible = campaigns.filter((row) => !norm(query) || norm(`${row.display_name || ""} ${row.gt_owner || ""}`).includes(norm(query)));
  return <section className="lc-card lc-wide"><div className="lc-view-head"><div><span>MÍDIA · LEITURA COMERCIAL</span><h2>Campanhas</h2><p>Performance agregada para contexto comercial. Sem controles de operação.</p></div><b>{visible.length} clientes com mídia</b></div><div className="lc-filters"><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar cliente ou gestor"/></div><Table><thead><tr><th>Cliente</th><th>GT</th><th>Campanhas ativas</th><th>Investimento</th><th>Leads</th><th>Custo/resultado</th><th>CTR</th><th>Referência</th></tr></thead><tbody>{visible.map((row) => <tr key={row.client_id}><td><b>{text(row.display_name)}</b></td><td>{text(row.gt_owner)}</td><td>{number(row.active_campaigns)}</td><td>{money(row.spend)}</td><td>{number(row.leads)}</td><td>{Number(row.cost_per_result || 0) ? money(row.cost_per_result) : "—"}</td><td>{row.ctr == null ? "—" : `${number(row.ctr)}%`}</td><td>{dateOnly(row.latest_date)}</td></tr>)}</tbody></Table>{!visible.length && <Empty>Nenhuma campanha nesse filtro.</Empty>}</section>;
}

function MeetingsView({ data }: { data: Row }) {
  const [owner, setOwner] = useState("ALL");
  const meetings: Row[] = data.meetings || [];
  const owners = [...new Set(meetings.map((row) => text(row.owner)).filter((name) => name !== "—"))].sort();
  const visible = owner === "ALL" ? meetings : meetings.filter((row) => row.owner === owner);
  return <section className="lc-card lc-wide"><div className="lc-view-head"><div><span>REUNIÕES COMERCIAIS</span><h2>Reuniões</h2><p>Calls e reuniões do Relato AI com o contexto necessário para o fechamento.</p></div><b>{visible.length} registros</b></div><div className="lc-filters"><select value={owner} onChange={(e) => setOwner(e.target.value)}><option value="ALL">Todos os registros</option>{owners.map((name) => <option key={name}>{name}</option>)}</select></div><div className="lc-meetings">{visible.slice(0, 80).map((row) => <article className="lc-meeting" key={row.id}><div className="lc-meeting-top"><div><span>{text(row.type, "reunião")}</span><h3>{text(row.title)}</h3></div><time>{dateTime(row.meeting_started_at)}</time></div><p>{text(row.summary)}</p><footer><b>{text(row.owner)}</b><span>{row.prospect_name ? `Prospect: ${row.prospect_name}` : row.client_name ? `Cliente: ${row.client_name}` : row.match_status === "MATCHED" ? "Cliente vinculado" : "Sem vínculo confirmado"}</span><span>{(row.participants || []).join(" · ") || "Participantes não informados"}</span></footer></article>)}</div>{!visible.length && <Empty>Nenhuma reunião encontrada.</Empty>}</section>;
}

function DirectionView({ data }: { data: Row }) {
  const performance: Row[] = data.performance || [];
  const goals: Row[] = data.goals || [];
  const advanced: Row[] = (data.leads || []).filter((row: Row) => ["reuniao", "proposta", "negociacao"].includes(row.stage)).slice(0, 12);
  const s = data.summary || {};
  return <div className="lc-stack"><section className="lc-kpis direction"><Kpi label="Forecast ponderado" value={money(s.weighted_forecast_value)} hint="pipeline aberto"/><Kpi label="Mensalidades fechadas · 30d" value={money(s.won_monthly_30d)} hint={`${number(s.won_30d)} contratos fechados`}/><Kpi label="Implementações · 30d" value={money(s.won_setup_30d)} hint="valor confirmado no CRM"/><Kpi label="Reuniões · 7d" value={number(s.meetings_7d)} hint="Leonardo + Vitor"/></section><div className="lc-grid2"><section className="lc-card"><div className="lc-card-head"><span>GESTÃO DO TIME</span><h3>Performance comercial</h3></div>{performance.map((row) => <div className="lc-owner" key={row.owner_id}><div><b>{text(row.owner_name)}</b><small>{number(row.open_leads)} abertos · {number(row.meetings)} reuniões · {number(row.proposals)} propostas · {number(row.negotiations)} negociações</small></div><div><strong>{number(row.won_30d)} fechados</strong><small>{money(row.weighted_value)} forecast</small></div></div>)}</section><section className="lc-card"><div className="lc-card-head"><span>METAS DO MÊS</span><h3>Metas por closer</h3></div>{goals.length ? goals.map((row) => <div className="lc-owner" key={`${row.owner_id}-${row.ano}-${row.mes}`}><div><b>{text(row.owner_name)}</b><small>Clientes: {number(row.meta_clientes)} · Mensalidade: {money(row.meta_mensalidade)}</small></div><strong>{money(row.meta_implementacao)}</strong></div>) : <Empty>Metas do mês ainda não cadastradas.</Empty>}</section></div><section className="lc-card lc-wide"><div className="lc-card-head"><span>PRIORIDADES DE VENDA</span><h3>Oportunidades avançadas</h3></div><Table><thead><tr><th>Lead</th><th>Responsável</th><th>Etapa</th><th>Atualização da fonte</th><th>Valor</th></tr></thead><tbody>{advanced.map((row) => <tr key={row.id}><td><b>{text(row.company || row.name)}</b></td><td>{text(row.owner_name)}</td><td>{stageLabel[row.stage] || text(row.stage)}</td><td>{dateTime(row.updated_at)}</td><td>{Number(row.estimated_value || 0) ? money(row.estimated_value) : "não informado"}</td></tr>)}</tbody></Table>{!advanced.length && <Empty>Sem oportunidades avançadas agora.</Empty>}</section></div>;
}

export default function CommercialProfileShell() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [person, setPerson] = useState("");
  const [view, setView] = useState<View>("home");
  const [data, setData] = useState<Row>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session?.access_token) { setRole(null); setPerson(""); return; }
    let active = true;
    loadProfileLite().then((body) => { if (active) { setRole(String(body?.profile?.role || "").toUpperCase()); setPerson(String(body?.profile?.person || "")); } }).catch(() => { if (active) { setRole(null); setPerson(""); } });
    return () => { active = false; };
  }, [session?.access_token]);

  const commercialRole = role === "COMMERCIAL" || role === "CLOSER";
  const views = role === "CLOSER" ? closerViews : managerViews;

  const load = useCallback(async () => {
    if (!session?.access_token || !commercialRole) return;
    setLoading(true); setError("");
    try {
      const response = await authenticatedFetch(API, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.detail || body?.error || `API ${response.status}`);
      setData(body || {});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível carregar a Central Comercial.");
    } finally { setLoading(false); }
  }, [session?.access_token, role]);

  useEffect(() => {
    if (!commercialRole) return;
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [commercialRole, load]);

  useEffect(() => {
    if (!commercialRole) return;
    document.documentElement.classList.add("leonardo-commercial-profile");
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.documentElement.classList.remove("leonardo-commercial-profile"); document.body.style.overflow = previous; };
  }, [role]);

  if (!commercialRole || !session) return null;

  const isCloser = role === "CLOSER";
  const displayName = data.profile?.person || person || (isCloser ? "Vitor Feitoza" : "Leonardo Augusto");
  const displayRole = data.profile?.display_role || (isCloser ? "Closer" : "Direção Comercial");
  return <div className="lc-root"><style>{styles}</style><aside className="lc-sidebar"><div className="lc-logo"><BrandMark/><div><b>Leonardo Imobi</b><span>{isCloser ? "Closer · Comercial" : "Direção Comercial"}</span></div></div><nav>{views.map(([key, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{label}</button>)}</nav><div className="lc-side-foot"><span>Perfil</span><b>{displayName}</b><small>{displayRole} · acesso comercial</small></div></aside><main className="lc-main"><header className="lc-top"><div><span>RELATO AI · CENTRAL COMERCIAL</span><h1>{views.find(([key]) => key === view)?.[1]}</h1><p>{isCloser ? "Seu pipeline, prospects, calls, reuniões e contexto para fechamento." : "Vendas, campanhas, clientes e reuniões. Operação fica fora deste perfil."}</p></div><div className="lc-top-actions"><div className={`lc-sync ${error ? "error" : loading ? "loading" : ""}`}><i/><span>{loading ? "Atualizando…" : error ? "Falha na atualização" : `Carga da tela ${dateTime(data.generated_at)}`}</span></div><button onClick={load} disabled={loading}>Atualizar</button><button className="ghost" onClick={() => supabase.auth.signOut({ scope: "local" })}>Sair</button></div></header>{error && <div className="lc-error">{error}</div>}<section className="lc-content">{view === "home" && <HomeView data={data}/>} {view === "funnel" && <FunnelView data={data}/>} {view === "prospects" && <ProspectsView data={data} reload={load}/>} {view === "clients" && <ClientsView data={data}/>} {view === "campaigns" && <CampaignsView data={data}/>} {view === "meetings" && <MeetingsView data={data}/>} {view === "direction" && !isCloser && <DirectionView data={data}/>}</section></main></div>;
}

const styles = `
html.leonardo-commercial-profile aside:has(>button[aria-label="Saúde das integrações"]),html.leonardo-commercial-profile .wba-backdrop,html.leonardo-commercial-profile .lqa-backdrop,html.leonardo-commercial-profile [data-commercial-section-nav],html.leonardo-commercial-profile [data-commercial-director-nav]{display:none!important}
.lc-root{position:fixed;inset:0;z-index:9000;display:grid;grid-template-columns:232px minmax(0,1fr);background:#071015;color:#e9f1ef;font-family:Inter,system-ui,sans-serif;overflow:hidden}.lc-sidebar{position:relative!important;inset:auto!important;width:auto!important;height:100vh!important;display:flex!important;flex-direction:column!important;background:#091417!important;border-right:1px solid #203137!important;padding:18px 12px!important;z-index:auto!important}.lc-logo{display:flex;gap:11px;align-items:center;padding:8px 8px 22px}.lc-logo svg{width:30px;height:38px;color:#f47b43}.lc-logo div{display:flex;flex-direction:column}.lc-logo b{font-size:13px}.lc-logo span{font-size:9px;color:#78908c;text-transform:uppercase;letter-spacing:.12em;margin-top:3px}.lc-sidebar nav{display:grid;gap:4px}.lc-sidebar nav button{width:100%;text-align:left;border:1px solid transparent;background:transparent;color:#8ca39e;border-radius:9px;padding:11px 12px;font:700 11.5px Inter;cursor:pointer}.lc-sidebar nav button:hover{background:#102024;color:#d9e9e5}.lc-sidebar nav button.active{background:#142b25;border-color:#285043;color:#bdf4d8}.lc-side-foot{margin-top:auto;border-top:1px solid #1b2c31;padding:15px 9px 4px;display:flex;flex-direction:column}.lc-side-foot span{font-size:8px;color:#607873;text-transform:uppercase;letter-spacing:.12em}.lc-side-foot b{font-size:11px;margin-top:5px}.lc-side-foot small{font-size:9px;color:#708783;margin-top:3px}.lc-main{height:100vh;overflow:auto;background:radial-gradient(circle at 80% -20%,rgba(45,124,94,.12),transparent 34%),#071015}.lc-top{position:sticky;top:0;z-index:20;display:flex;justify-content:space-between;gap:24px;align-items:flex-end;padding:20px 26px;border-bottom:1px solid rgba(102,139,130,.16);background:rgba(7,16,21,.94);backdrop-filter:blur(16px)}.lc-top>div:first-child>span,.lc-view-head span,.lc-card-head span,.lc-modal header span{font-size:9px;font-weight:850;color:#62cca0;letter-spacing:.13em;text-transform:uppercase}.lc-top h1{font:800 27px/1.05 'Inter Tight',Inter;margin:4px 0}.lc-top p,.lc-view-head p{margin:0;color:#78918c;font-size:11px}.lc-top-actions{display:flex;align-items:center;gap:8px}.lc-top-actions button{border:1px solid #2b4941;background:#10231f;color:#d9f5e9;border-radius:9px;padding:9px 11px;font:750 10px Inter;cursor:pointer}.lc-top-actions button.ghost{background:transparent;color:#829b96;border-color:#23363a}.lc-sync{display:flex;align-items:center;gap:6px;color:#6f8883;font-size:9px;margin-right:4px}.lc-sync i{width:7px;height:7px;border-radius:50%;background:#52c68e;box-shadow:0 0 0 3px rgba(82,198,142,.1)}.lc-sync.loading i{background:#d9a94b}.lc-sync.error i{background:#ef6b5b}.lc-content{padding:22px 26px 60px;max-width:1560px;margin:auto}.lc-stack{display:grid;gap:14px}.lc-kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:9px}.lc-kpis.direction{grid-template-columns:repeat(4,minmax(0,1fr))}.lc-kpi,.lc-card,.lc-source{border:1px solid #203338;background:#0b171b;border-radius:14px}.lc-kpi{padding:15px;min-width:0}.lc-kpi span{display:block;font-size:8.5px;color:#738b86;text-transform:uppercase;font-weight:800;letter-spacing:.08em}.lc-kpi b{display:block;font:800 22px 'Inter Tight',Inter;margin:7px 0 4px;color:#f2f8f6;overflow:hidden;text-overflow:ellipsis}.lc-kpi small{display:block;color:#67817b;font-size:9px;line-height:1.35}.lc-sources{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.lc-source{padding:13px 15px;display:grid;gap:5px}.lc-source>div{display:flex;align-items:center;gap:7px}.lc-source i{width:7px;height:7px;border-radius:50%;background:#55c98f}.lc-source.stale i{background:#e2a54e}.lc-source b{font-size:10px}.lc-source strong{font-size:11px;color:#aac4bd}.lc-source.stale strong{color:#efc46f}.lc-source small{font-size:9px;color:#687f7a}.lc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.lc-card{padding:17px;min-width:0}.lc-card.lc-wide{width:100%}.lc-card-head{margin-bottom:9px}.lc-card-head h3{font:800 17px 'Inter Tight',Inter;margin:4px 0 0}.lc-stage,.lc-owner{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:11px 2px;border-bottom:1px solid #182a2e}.lc-stage:last-child,.lc-owner:last-child{border-bottom:0}.lc-stage>div,.lc-owner>div{display:flex;flex-direction:column}.lc-stage b,.lc-owner b{font-size:11px}.lc-stage small,.lc-owner small{font-size:9px;color:#6f8882;margin-top:3px}.lc-stage strong,.lc-owner strong{font-size:11px;color:#b8d8ce;text-align:right}.lc-view-head{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:15px}.lc-view-head h2{font:800 25px 'Inter Tight',Inter;margin:4px 0}.lc-view-head>b{font-size:10px;color:#87a49d;background:#10231f;border:1px solid #233e37;border-radius:999px;padding:7px 10px}.lc-filters{display:flex;gap:8px;margin:0 0 14px}.lc-filters input,.lc-filters select{border:1px solid #263a3f;background:#081317;color:#cfe0dc;border-radius:9px;padding:9px 10px;font:600 10px Inter;min-width:170px}.lc-filters input{min-width:260px}.lc-table-wrap{width:100%;overflow:auto;border:1px solid #182b30;border-radius:11px}.lc-table-wrap table{width:100%;border-collapse:collapse;min-width:820px}.lc-table-wrap th{text-align:left;padding:9px 11px;background:#0d1d21;color:#667f7a;font-size:8px;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}.lc-table-wrap td{padding:10px 11px;border-top:1px solid #17292d;color:#9eb5af;font-size:10px}.lc-table-wrap td b{color:#dceae6;font-size:10.5px}.lc-table-wrap td small{display:block;color:#607a74;font-size:8.5px;margin-top:2px}.lc-table-wrap tr.clickable{cursor:pointer}.lc-table-wrap tr.clickable:hover td{background:#0e2022}.lc-pill{display:inline-flex;border:1px solid #2b4640;background:#10231f;color:#a7c9bd;border-radius:999px;padding:4px 7px;font-size:8px}.lc-pill.negociacao,.lc-pill.proposta{border-color:#6b5630;color:#e7c26f;background:#211d12}.lc-pill.fechado,.lc-pill.active{border-color:#2e634d;color:#83dfb1;background:#0f241c}.lc-pill.perdido,.lc-pill.churned{border-color:#633c39;color:#e39187;background:#241514}.lc-empty{padding:18px;color:#657f79;font-size:10px;text-align:center}.lc-meetings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.lc-meeting{border:1px solid #1d3135;background:#091519;border-radius:12px;padding:14px}.lc-meeting-top{display:flex;justify-content:space-between;gap:12px}.lc-meeting-top span{font-size:8px;color:#62cca0;text-transform:uppercase;font-weight:800}.lc-meeting h3{font-size:12px;margin:4px 0}.lc-meeting time{font-size:8.5px;color:#68817b;white-space:nowrap}.lc-meeting p{color:#8ca49e;font-size:10px;line-height:1.5;margin:10px 0}.lc-meeting footer{display:flex;flex-wrap:wrap;gap:7px;border-top:1px solid #182b2e;padding-top:9px}.lc-meeting footer>*{font-size:8.5px;color:#6f8982}.lc-meeting footer b{color:#a9c8bf}.lc-modal-backdrop{position:fixed;inset:0;z-index:9500;background:rgba(2,7,9,.76);display:flex;align-items:center;justify-content:center;padding:24px;backdrop-filter:blur(8px)}.lc-modal{width:min(920px,96vw);max-height:88vh;overflow:auto;background:#0a1519;border:1px solid #29413f;border-radius:16px;box-shadow:0 30px 90px rgba(0,0,0,.5)}.lc-modal header{display:flex;justify-content:space-between;gap:16px;padding:18px 20px;border-bottom:1px solid #1b2f32;position:sticky;top:0;background:#0a1519;z-index:2}.lc-modal h2{font:800 22px 'Inter Tight',Inter;margin:4px 0}.lc-modal header p{font-size:9px;color:#708984;margin:0}.lc-modal header button{width:34px;height:34px;border:1px solid #2a3d41;background:#0e1d20;color:#b7cbc6;border-radius:9px;font-size:18px;cursor:pointer}.lc-modal-body{padding:18px 20px}.lc-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.lc-detail-grid article{border:1px solid #1c3033;background:#081317;border-radius:10px;padding:11px}.lc-detail-grid span{display:block;color:#657e78;font-size:8px;text-transform:uppercase}.lc-detail-grid b{display:block;color:#d9e8e4;font-size:10.5px;margin-top:5px}.lc-modal-section{margin-top:18px}.lc-modal-section h3{font-size:12px;margin:0 0 9px}.lc-meeting-mini{padding:10px 0;border-bottom:1px solid #17292d}.lc-meeting-mini div{display:flex;justify-content:space-between;gap:10px}.lc-meeting-mini b{font-size:10px}.lc-meeting-mini small{font-size:8.5px;color:#6f8580}.lc-meeting-mini p{font-size:9.5px;color:#849b95;line-height:1.45;margin:6px 0}.lc-brief{white-space:pre-wrap;line-height:1.6;border:1px solid #1c3033;background:#081317;border-radius:10px;padding:13px;color:#b7cbc6;font-size:10px}.lc-editor{display:grid;grid-template-columns:minmax(160px,1fr) minmax(160px,1fr) auto;gap:8px}.lc-editor select,.lc-editor input{border:1px solid #263a3f;background:#081317;color:#cfe0dc;border-radius:9px;padding:9px 10px;font:600 10px Inter}.lc-editor button{border:1px solid #2b4941;background:#15352b;color:#d9f5e9;border-radius:9px;padding:9px 14px;font:750 10px Inter;cursor:pointer}.lc-message{display:block;margin-top:7px;color:#83dfb1}.lc-danger{color:#ef8d81!important;font-weight:800}.lc-error{margin:14px 26px 0;border:1px solid #663b37;background:#2a1514;color:#ef9b90;border-radius:10px;padding:10px 12px;font-size:10px}
@media(max-width:1100px){.lc-root{grid-template-columns:190px minmax(0,1fr)}.lc-kpis{grid-template-columns:repeat(3,1fr)}.lc-grid2,.lc-meetings{grid-template-columns:1fr}.lc-top{align-items:flex-start;flex-direction:column}.lc-top-actions{width:100%;flex-wrap:wrap}.lc-sources{grid-template-columns:1fr}.lc-detail-grid{grid-template-columns:repeat(2,1fr)}}
@media(max-width:720px){.lc-root{display:block;overflow:auto}.lc-sidebar{height:auto!important;position:sticky!important;top:0!important;z-index:30!important;padding:8px!important}.lc-logo,.lc-side-foot{display:none}.lc-sidebar nav{display:flex;overflow:auto}.lc-sidebar nav button{white-space:nowrap;width:auto}.lc-main{height:auto;min-height:100vh;overflow:visible}.lc-top{position:relative;padding:16px}.lc-content{padding:14px 12px 80px}.lc-kpis,.lc-kpis.direction{grid-template-columns:repeat(2,1fr)}.lc-filters{flex-direction:column}.lc-filters input,.lc-filters select{width:100%;min-width:0}.lc-detail-grid{grid-template-columns:1fr}.lc-modal-backdrop{padding:10px}}
`;
