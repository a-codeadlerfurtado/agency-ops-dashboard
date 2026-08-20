import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};

const SOURCE_GUIDE = `FONTES PREFERENCIAIS NO SCHEMA agency_ops:
- Carteira atual, lifecycle, GT/CS, próxima ação e visão geral: dashboard_client_overview, clients, client_operational_snapshot, client_operational_status.
- Onboarding: dashboard_client_overview, onboarding_cases, onboarding_stages.
- Campanhas/Meta Ads: campaign_client_latest, campaign_latest_details, meta_campaign_insights, meta_campaign_inventory, client_integrations.
- Saúde, risco e churn: client_health_scores, client_health_attention_queue, client_health_crosscheck, client_health_timeline, client_health_trends, complaint_events, client_churn_log, client_lifecycle_events.
- WhatsApp e atendimento: conversation_state, whatsapp_messages, whatsapp_daily_group_status, whatsapp_group_registry.
- Compromissos e pendências: commitments, operational_alerts.
- Reuniões Donnah/Google Meet: meeting_transcripts, meeting_transcript_actions, donnah_ingestion_overview, donnah_transcript_health.
- ClickUp e produtividade: clickup_tasks, clickup_productivity_daily, clickup_productivity_30d, task_log_entries.
- Serviços e IA dos clientes: client_service_overview, client_services, client_ai_evidence, client_ai_overrides, ai_source_registry, ai_source_discovery.
- Formulários e materiais: form_responses, client_raw_material_uploads, client_raw_material_uploads_summary.
- CRM e pré-clientes: crm_preclients.
- Anotações escritas pelo time no perfil do cliente: ops_notes (o que o GT sabe e nenhum coletor automático vê — reclamação por telefone, combinado informal, contexto de bastidor). ops_notes_pendentes são as que ainda não têm cliente definido. Ao responder sobre um cliente, verifique ops_notes: quando houver anotação, ela costuma explicar o que os números só mostram.
- Saúde das integrações: integration_health_overview.
- Carteira/retention: portfolio_live, portfolio_client_status, portfolio_gt_retention.
Se uma fonte não trouxer o dado, consulte as fontes adjacentes acima. Não conclua pela ausência numa única tabela.`;

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const money = (value: unknown) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(value ?? 0));
const pct = (value: unknown) => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(Number(value ?? 0))}%`;
const genericNameTokens = new Set(["imoveis", "imobiliaria", "negocios", "corretora", "residencial", "empreendimentos", "mkt", "marketing", "ltda"]);

type ClientRef = { id: string; display_name: string; lifecycle: string | null };
type FastAnswer = { answer: string; source: string; tables: string[] } | null;

function safeAnswer(body: any, raw: string): string | null {
  const candidates = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message];
  for (const value of candidates) if (typeof value === "string" && value.trim()) return value.trim();
  if (!body && raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
}

async function resolveClient(question: string, ops: any): Promise<ClientRef | null> {
  const { data } = await ops.from("clients").select("id,display_name,lifecycle");
  const clients = (data ?? []) as ClientRef[];
  const q = norm(question);
  const qTokens = new Set(q.split(" ").filter(Boolean));
  const ranked = clients.map((client) => {
    const n = norm(client.display_name);
    if (n.length >= 4 && q.includes(n)) return { client, score: 1000 + n.length };
    const tokens = n.split(" ").filter((t) => t.length >= 3 && !genericNameTokens.has(t));
    const hits = tokens.filter((t) => qTokens.has(t));
    if (tokens.length && hits.length === tokens.length) return { client, score: 500 + hits.reduce((a, t) => a + t.length, 0) };
    if (hits.length >= 2) return { client, score: 400 + hits.reduce((a, t) => a + t.length, 0) };
    if (hits.length === 1 && hits[0].length >= 5) return { client, score: 300 + hits[0].length };
    return { client, score: 0 };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const best = ranked[0], second = ranked[1];
  if (best.score >= 500 || !second || best.score - second.score >= 80) return best.client;
  return null;
}

async function tryFastAnswer(question: string, ops: any, client: ClientRef | null): Promise<FastAnswer> {
  const q = norm(question);
  const currentLifecycles = ["ACTIVE", "ONBOARDING"];

  if (client) {
    if (/\b(campanha|meta|ctr|cpl|cpm|investimento|lead|resultado)\b/.test(q) && !/\b(ultimos|dias|mes|periodo|desde|entre|hoje|ontem)\b/.test(q)) {
      const { data } = await ops.from("campaign_client_latest").select("*").eq("client_id", client.id).maybeSingle();
      if (data) {
        return {
          answer: `${client.display_name}: ${data.active_campaigns ?? 0} campanha(s) ativa(s) de ${data.campaign_count ?? 0} no inventário. Situação: ${data.delivery_status ?? "—"}. Na referência ${data.latest_date ?? "sem data"}, investimento ${money(data.spend)}, ${Number(data.results ?? 0)} resultado(s), custo por resultado ${Number(data.results ?? 0) > 0 ? money(data.cost_per_result) : "—"}, CTR ${data.ctr == null ? "—" : pct(data.ctr)}.`,
          source: "agency_ops direto",
          tables: ["campaign_client_latest"],
        };
      }
    }

    if (/\b(saude|risco|churn|score|red|yellow|green)\b/.test(q)) {
      const { data } = await ops.from("client_health_scores").select("date,score,band").eq("client_id", client.id).order("date", { ascending: false }).limit(1).maybeSingle();
      const { data: cross } = await ops.from("client_health_crosscheck").select("crosscheck_status,external_health_status,external_risk_level,external_source_updated_at").eq("client_id", client.id).maybeSingle();
      if (data || cross) {
        return {
          answer: `${client.display_name}: saúde interna ${data?.band ?? "sem faixa"}${data?.score != null ? `, score ${Number(data.score).toFixed(0)}` : ""}${data?.date ? ` em ${data.date}` : ""}. Cruzamento externo: ${cross?.crosscheck_status ?? "sem dado externo"}${cross?.external_health_status ? `; saúde externa ${cross.external_health_status}` : ""}${cross?.external_risk_level ? `; risco externo ${cross.external_risk_level}` : ""}.`,
          source: "agency_ops direto",
          tables: ["client_health_scores", "client_health_crosscheck"],
        };
      }
    }

    if (/\b(ia|airys|lais|agente|fornecedor|provider|openai|ycloud)\b/.test(q)) {
      const { data } = await ops.from("client_service_overview").select("*").eq("client_id", client.id).maybeSingle();
      if (data) {
        const previous = Array.isArray(data.ai_provider_previous) && data.ai_provider_previous.length ? data.ai_provider_previous.join(", ") : "nenhum confirmado";
        const ownership = data.ai_owner === "OURS" ? "IA nossa" : data.ai_owner === "EXTERNAL" ? "IA externa" : data.ai_owner === "CRM_NATIVE" ? "IA nativa do CRM" : "origem não confirmada";
        return {
          answer: `${client.display_name}: ${data.has_ai_history ? "há histórico de IA" : "não há histórico de IA confirmado"}. Classificação atual: ${ownership}; status ${data.ai_status ?? "UNKNOWN"}; fornecedor atual ${data.ai_provider_current ?? "não informado"}; fornecedor(es) anterior(es): ${previous}${data.ai_agent_name ? `; agente ${data.ai_agent_name}` : ""}. Confiança ${data.ai_confidence != null ? `${Math.round(Number(data.ai_confidence) * 100)}%` : "não informada"}${data.ai_evidence_sources ? `. Evidências: ${data.ai_evidence_sources}.` : "."}`,
          source: "agency_ops direto",
          tables: ["client_service_overview"],
        };
      }
    }

    if (/\b(onboarding|integracao|formulario|persona|produto|etapa)\b/.test(q)) {
      const { data } = await ops.from("dashboard_client_overview").select("display_name,lifecycle,onboarding_status,onboarding_stage,onboarding_risk,onboarding_blocked_by,onboarding_next_action,next_step,gt_owner,cs_owner").eq("client_id", client.id).maybeSingle();
      if (data) {
        return {
          answer: `${client.display_name}: lifecycle ${data.lifecycle ?? "—"}; onboarding ${data.onboarding_status ?? "sem caso"}; etapa ${data.onboarding_stage ?? "—"}${data.onboarding_risk ? `; risco ${data.onboarding_risk}` : ""}${data.onboarding_blocked_by ? `; bloqueado por ${data.onboarding_blocked_by}` : ""}. Próxima ação: ${data.onboarding_next_action ?? data.next_step ?? "não registrada"}.`,
          source: "agency_ops direto",
          tables: ["dashboard_client_overview"],
        };
      }
    }

    if (/\b(esperando|resposta|whatsapp|conversa|atendimento)\b/.test(q)) {
      const { data } = await ops.from("conversation_state").select("waiting_for_agency,waiting_since,waiting_for_client,open_question,conversation_status,sla_level,last_summary,updated_at").eq("client_id", client.id).order("updated_at", { ascending: false }).limit(1).maybeSingle();
      if (data) {
        return {
          answer: `${client.display_name}: ${data.waiting_for_agency ? `está aguardando a agência desde ${data.waiting_since ?? "horário não registrado"}` : data.waiting_for_client ? "a agência está aguardando o cliente" : "não está marcado como aguardando resposta"}. Status da conversa: ${data.conversation_status ?? "—"}; SLA ${data.sla_level ?? "—"}${data.open_question ? `. Questão aberta: ${data.open_question}` : ""}${data.last_summary ? `. Último resumo: ${data.last_summary}` : ""}.`,
          source: "agency_ops direto",
          tables: ["conversation_state"],
        };
      }
    }

    if (/\b(status|gt|gestor|cs|responsavel|entrada|proxima acao|proximo passo|prioridade)\b/.test(q)) {
      const { data } = await ops.from("dashboard_client_overview").select("display_name,lifecycle,entrada,cs_owner,gt_owner,designer_owner,priority,current_subject,next_step,next_step_due,last_activity_at").eq("client_id", client.id).maybeSingle();
      if (data) {
        return {
          answer: `${client.display_name}: ${data.lifecycle ?? "—"}; entrada ${data.entrada ?? "—"}; GT ${data.gt_owner ?? "não atribuído"}; CS ${data.cs_owner ?? "não atribuído"}; prioridade ${data.priority ?? "—"}. Assunto atual: ${data.current_subject ?? "não registrado"}. Próximo passo: ${data.next_step ?? "não registrado"}.`,
          source: "agency_ops direto",
          tables: ["dashboard_client_overview"],
        };
      }
    }
  }

  if (/\b(onboarding)\b/.test(q) && /\b(quem|quais|qual|quantos|clientes|etapa)\b/.test(q)) {
    const { data } = await ops.from("dashboard_client_overview").select("display_name,onboarding_stage,onboarding_status,onboarding_next_action,gt_owner").or("lifecycle.eq.ONBOARDING,onboarding_status.eq.OPEN").order("display_name");
    const rows = data ?? [];
    if (!rows.length) return { answer: "Não há clientes com onboarding aberto no momento.", source: "agency_ops direto", tables: ["dashboard_client_overview"] };
    const lines = rows.slice(0, 30).map((r: any) => `- ${r.display_name}: ${r.onboarding_stage ?? r.onboarding_status ?? "sem etapa"}${r.gt_owner ? ` · GT ${r.gt_owner}` : ""}${r.onboarding_next_action ? ` · próxima ação: ${r.onboarding_next_action}` : ""}`);
    return { answer: `Há ${rows.length} cliente(s) com onboarding aberto:\n${lines.join("\n")}`, source: "agency_ops direto", tables: ["dashboard_client_overview"] };
  }

  if (/quantos clientes ativos/.test(q)) {
    const { count } = await ops.from("clients").select("id", { count: "exact", head: true }).eq("lifecycle", "ACTIVE");
    return { answer: `Há ${count ?? 0} clientes com lifecycle ACTIVE.`, source: "agency_ops direto", tables: ["clients"] };
  }

  if (/quantos clientes atuais|tamanho da carteira atual|quantos clientes temos hoje/.test(q)) {
    const { count } = await ops.from("clients").select("id", { count: "exact", head: true }).in("lifecycle", currentLifecycles);
    return { answer: `A carteira atual tem ${count ?? 0} clientes considerando ACTIVE + ONBOARDING.`, source: "agency_ops direto", tables: ["clients"] };
  }

  if (/\bmarketing\b/.test(q) && /\bia\b/.test(q) && /\b(quem|quais|clientes|tambem|também)\b/.test(q)) {
    const { data } = await ops.from("client_service_overview").select("display_name,ai_status,ai_owner,ai_provider_current,ai_provider_previous").in("lifecycle", currentLifecycles).eq("has_marketing", true).eq("has_ai_history", true).order("display_name");
    const rows = data ?? [];
    const lines = rows.slice(0, 40).map((r: any) => `- ${r.display_name}: ${r.ai_owner ?? "UNKNOWN"} · ${r.ai_status ?? "UNKNOWN"}${r.ai_provider_current ? ` · ${r.ai_provider_current}` : ""}`);
    return { answer: `Encontrei ${rows.length} cliente(s) atuais de Marketing com histórico de IA:\n${lines.join("\n")}`, source: "agency_ops direto", tables: ["client_service_overview"] };
  }

  if (/\bia externa\b|\bexterna.*ia\b/.test(q)) {
    const { data } = await ops.from("client_service_overview").select("display_name,ai_status,ai_provider_current").in("lifecycle", currentLifecycles).eq("ai_owner", "EXTERNAL").order("display_name");
    const rows = data ?? [];
    return { answer: rows.length ? `IA externa confirmada em ${rows.length} cliente(s):\n${rows.map((r: any) => `- ${r.display_name}: ${r.ai_provider_current ?? "fornecedor a confirmar"} · ${r.ai_status ?? "UNKNOWN"}`).join("\n")}` : "Não há cliente atual classificado com IA externa.", source: "agency_ops direto", tables: ["client_service_overview"] };
  }

  if (/sem conta meta/.test(q)) {
    const { data } = await ops.from("campaign_client_latest").select("display_name,gt_owner").in("lifecycle", currentLifecycles).eq("delivery_status", "NO_META_ACCOUNT").order("display_name");
    const rows = data ?? [];
    return { answer: `${rows.length} cliente(s) de Marketing estão sem conta Meta vinculada:\n${rows.slice(0, 50).map((r: any) => `- ${r.display_name}${r.gt_owner ? ` · GT ${r.gt_owner}` : ""}`).join("\n")}`, source: "agency_ops direto", tables: ["campaign_client_latest"] };
  }

  if (/campanha ativa sem entrega|ativas sem entrega/.test(q)) {
    const { data } = await ops.from("campaign_client_latest").select("display_name,active_campaigns,gt_owner,checked_at").in("lifecycle", currentLifecycles).eq("delivery_status", "NO_DELIVERY").order("display_name");
    const rows = data ?? [];
    return { answer: `${rows.length} cliente(s) têm campanha ativa sem entrega no snapshot atual:\n${rows.slice(0, 50).map((r: any) => `- ${r.display_name}: ${r.active_campaigns ?? 0} ativa(s)${r.gt_owner ? ` · GT ${r.gt_owner}` : ""}`).join("\n")}`, source: "agency_ops direto", tables: ["campaign_client_latest"] };
  }

  if (/churned com entrega|churn.*campanha.*rodando/.test(q)) {
    const { data } = await ops.from("campaign_client_latest").select("display_name,active_campaigns,spend,results,latest_date").eq("lifecycle", "CHURNED").eq("delivery_status", "CHURNED_WITH_DELIVERY").order("display_name");
    const rows = data ?? [];
    return { answer: rows.length ? `${rows.length} cliente(s) CHURNED ainda aparecem com entrega:\n${rows.map((r: any) => `- ${r.display_name}: ${r.active_campaigns ?? 0} ativa(s), ${money(r.spend)} no snapshot ${r.latest_date ?? "sem data"}`).join("\n")}` : "Nenhum cliente CHURNED aparece com entrega no snapshot atual.", source: "agency_ops direto", tables: ["campaign_client_latest"] };
  }

  if (/esperando resposta|aguardando resposta|sem resposta/.test(q)) {
    const { data: states } = await ops.from("conversation_state").select("client_id,waiting_since,sla_level,open_question").eq("waiting_for_agency", true).order("waiting_since");
    const ids = (states ?? []).map((r: any) => r.client_id).filter(Boolean);
    if (!ids.length) return { answer: "Nenhum cliente está marcado como aguardando resposta da agência.", source: "agency_ops direto", tables: ["conversation_state"] };
    const { data: clients } = await ops.from("clients").select("id,display_name,lifecycle,gt_owner").in("id", ids).in("lifecycle", currentLifecycles);
    const map = new Map((clients ?? []).map((r: any) => [r.id, r]));
    const rows = (states ?? []).filter((r: any) => map.has(r.client_id));
    return { answer: `${rows.length} cliente(s) atuais aguardam resposta da agência:\n${rows.slice(0, 40).map((r: any) => { const c: any = map.get(r.client_id); return `- ${c.display_name}: desde ${r.waiting_since ?? "sem horário"}${r.sla_level ? ` · SLA ${r.sla_level}` : ""}${c.gt_owner ? ` · GT ${c.gt_owner}` : ""}`; }).join("\n")}`, source: "agency_ops direto", tables: ["conversation_state", "clients"] };
  }

  if (/compromissos? atrasad|pendencias? vencid|pendências? vencid/.test(q)) {
    const now = new Date().toISOString();
    const { data: commitments } = await ops.from("commitments").select("client_id,descricao,owner,due_at,status").in("status", ["OPEN", "IN_PROGRESS"]).lt("due_at", now).order("due_at").limit(100);
    const ids = [...new Set((commitments ?? []).map((r: any) => r.client_id).filter(Boolean))];
    const { data: clients } = ids.length ? await ops.from("clients").select("id,display_name,lifecycle").in("id", ids) : { data: [] } as any;
    const map = new Map((clients ?? []).map((r: any) => [r.id, r]));
    const rows = (commitments ?? []).filter((r: any) => { const c: any = map.get(r.client_id); return !c || currentLifecycles.includes(c.lifecycle); });
    return { answer: rows.length ? `Há ${rows.length} compromisso(s) vencido(s) aberto(s):\n${rows.slice(0, 40).map((r: any) => `- ${(map.get(r.client_id) as any)?.display_name ?? "sem cliente"}: ${r.descricao ?? "sem descrição"} · responsável ${r.owner ?? "—"} · prazo ${r.due_at ?? "—"}`).join("\n")}` : "Não há compromissos vencidos abertos para clientes atuais.", source: "agency_ops direto", tables: ["commitments", "clients"] };
  }

  if (/quem precisa de atencao|quem precisa de atenção|clientes em atencao|clientes em atenção/.test(q)) {
    const { data } = await ops.from("dashboard_client_overview").select("display_name,priority,next_step,current_subject,gt_owner,overdue_commitments,open_complaints").in("lifecycle", currentLifecycles).in("priority", ["ATTENTION", "FOLLOW_UP", "DATA_INCOMPLETE"]).order("priority").limit(30);
    const rows = data ?? [];
    return { answer: rows.length ? `${rows.length} cliente(s) estão marcados para atenção operacional:\n${rows.map((r: any) => `- ${r.display_name}: ${r.priority}${r.gt_owner ? ` · GT ${r.gt_owner}` : ""} · ${r.next_step ?? r.current_subject ?? "sem próxima ação"}`).join("\n")}` : "Nenhum cliente atual está marcado nas prioridades de atenção configuradas.", source: "agency_ops direto", tables: ["dashboard_client_overview"] };
  }

  return null;
}

async function buildClientContext(client: ClientRef | null, ops: any): Promise<string | null> {
  if (!client) return null;
  const [overview, service, campaign, health, conversation, commitments] = await Promise.all([
    ops.from("dashboard_client_overview").select("display_name,lifecycle,entrada,cs_owner,gt_owner,priority,current_subject,next_step,next_step_due,onboarding_status,onboarding_stage,onboarding_risk,onboarding_blocked_by,onboarding_next_action,last_activity_at").eq("client_id", client.id).maybeSingle(),
    ops.from("client_service_overview").select("display_name,has_marketing,has_ai_history,ai_status,ai_owner,ai_provider_current,ai_provider_previous,ai_agent_name,ai_confidence,ai_evidence_sources,ai_last_evidence_at").eq("client_id", client.id).maybeSingle(),
    ops.from("campaign_client_latest").select("delivery_status,active_campaigns,campaign_count,spend,results,cost_per_result,ctr,latest_date,checked_at").eq("client_id", client.id).maybeSingle(),
    ops.from("client_health_scores").select("date,score,band").eq("client_id", client.id).order("date", { ascending: false }).limit(3),
    ops.from("conversation_state").select("waiting_for_agency,waiting_since,waiting_for_client,conversation_status,sla_level,open_question,last_summary,updated_at").eq("client_id", client.id).order("updated_at", { ascending: false }).limit(1),
    ops.from("commitments").select("descricao,owner,due_at,status,created_at").eq("client_id", client.id).in("status", ["OPEN", "IN_PROGRESS"]).order("due_at").limit(20),
  ]);
  return JSON.stringify({
    client: { id: client.id, display_name: client.display_name },
    overview: overview.data ?? null,
    service: service.data ?? null,
    campaign_latest: campaign.data ?? null,
    health_recent: health.data ?? [],
    conversation: conversation.data?.[0] ?? null,
    open_commitments: commitments.data ?? [],
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ ok: false, error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply({ ok: false, error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return reply({ ok: false, error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle();
  const person = pref?.collaborator_person ?? null;
  let role: string | null = null, accessLevel = "RESTRICTED";
  if (person) {
    const { data: roster } = await ops.from("team_roster").select("role,access_level").eq("person", person).eq("is_former", false).maybeSingle();
    role = roster?.role ?? null; accessLevel = roster?.access_level ?? "RESTRICTED";
  }
  const { data: approvals } = await ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("status", "APPROVED");
  const approved = approvals ?? [];
  const accountApproved = approved.some((r: any) => r.kind === "SIGNUP");
  const elevated = accessLevel === "RESTRICTED" && approved.some((r: any) => r.kind === "ELEVATION");
  const isFull = accessLevel === "FULL" || elevated;
  if (!accountApproved || !person) return reply({ ok: false, error: "OpsQuestion indisponível: conta ainda não liberada." }, 403);
  if (!isFull) return reply({ ok: false, error: "OpsQuestion está liberado somente para perfis de gestão/acesso total por enquanto." }, 403);

  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return reply({ ok: false, error: "missing_question" }, 400);
  if (question.length > 2500) return reply({ ok: false, error: "question_too_long", max_chars: 2500 }, 400);

  const since = new Date(Date.now() - 60_000).toISOString();
  const { count: recentCount } = await ops.from("opsquestion_interactions").select("id", { count: "exact", head: true }).eq("user_key", user.id).gte("created_at", since);
  if ((recentCount ?? 0) >= 12) return reply({ ok: false, error: "Muitas perguntas em sequência. Aguarde alguns segundos." }, 429);

  const requestId = crypto.randomUUID();
  const started = Date.now();
  const client = await resolveClient(question, ops);
  const fast = await tryFastAnswer(question, ops, client);
  if (fast) {
    const latency = Date.now() - started;
    await ops.from("opsquestion_interactions").insert({ user_key: user.id, person, role, access_level: accessLevel, question, answer: fast.answer.slice(0, 20000), status: "SUCCESS", source: "DIRECT_DB", latency_ms: latency, request_id: requestId, answered_at: new Date().toISOString() });
    return reply({ ok: true, name: "OpsQuestion", answer: fast.answer, source: `${fast.source} · ${fast.tables.join(", ")}`, read_only: true, mode: "DIRECT_DB", request_id: requestId, latency_ms: latency, generated_at: new Date().toISOString() });
  }

  // Para onde a pergunta vai e' configuracao, nao codigo. AI_ASK_ENDPOINT_URL manda;
  // MAKE_AI_ASK_WEBHOOK_URL fica como a rota atual enquanto ninguem definir a nova.
  // Trocar Make por VPS vira um insert em automation_settings, sem deploy.
  const [{ data: endpointCfg }, { data: webhookCfg }, { data: secretCfg }, clientContext] = await Promise.all([
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_ENDPOINT_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "MAKE_AI_ASK_WEBHOOK_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_READ_SECRET").maybeSingle(),
    buildClientContext(client, ops),
  ]);
  const directUrl = typeof endpointCfg?.value === "string" ? endpointCfg.value : null;
  const webhookUrl = directUrl ?? (typeof webhookCfg?.value === "string" ? webhookCfg.value : null);
  const readSecret = typeof secretCfg?.value === "string" ? secretCfg.value : null;
  // O log tem que dizer por onde a resposta passou de verdade - senao, depois da
  // troca, o historico continua alegando Make para respostas que vieram da VPS.
  const routeMode = directUrl ? "DIRECT_AI" : "MAKE_AI";
  const routeLabel = directUrl ? "agency_ops via IA direta" : "agency_ops via Make/IA";

  await ops.from("opsquestion_interactions").insert({ user_key: user.id, person, role, access_level: accessLevel, question, status: "PENDING", source: routeMode, request_id: requestId });
  if (!webhookUrl || !readSecret) {
    const latency = Date.now() - started;
    await ops.from("opsquestion_interactions").update({ status: "ERROR", error: "missing_ai_configuration", latency_ms: latency }).eq("request_id", requestId);
    return reply({ ok: false, error: "OpsQuestion não está configurado no backend." }, 503);
  }

  const promptParts = [
    "Você é o OpsQuestion, copiloto operacional da Leonardo Imobi.",
    "Responda em português do Brasil usando SOMENTE dados encontrados no banco agency_ops ou no CONTEXTO DIRETO fornecido abaixo.",
    "Nunca invente fatos, números, responsáveis, status, datas ou evidências.",
    "Se os dados não forem suficientes, diga claramente que não encontrou evidência suficiente.",
    "A conexão de banco usada por você é SOMENTE LEITURA; não proponha nem execute INSERT, UPDATE, DELETE, DDL ou alterações.",
    "Quando a pergunta disser 'clientes atuais', considere ACTIVE + ONBOARDING. Quando disser apenas 'ativos', respeite literalmente ACTIVE, salvo se o contexto pedir carteira atual.",
    "Sempre prefira a fonte operacional mais recente disponível e confira mais de uma fonte quando houver risco de ambiguidade.",
    SOURCE_GUIDE,
    clientContext ? `CONTEXTO DIRETO DO CLIENTE IDENTIFICADO (já consultado no banco, pode responder sem novo SQL se bastar):\n${clientContext}` : null,
    `Usuário: ${person}${role ? ` (${role})` : ""}.`,
    `Pergunta do usuário: ${question}`,
  ].filter(Boolean);
  const prompt = promptParts.join("\n\n");

  // Uma tentativa por rota, com o relogio do chamador em mente: o dashboard corta em
  // 60s, entao a rota principal ganha 50s e sobra folga para o plano B.
  const enviar = (url: string, tempoMs: number) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), tempoMs);
    return fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-ai-read-secret": readSecret }, body: JSON.stringify({ question: prompt, original_question: question, source: "OpsQuestion", request_id: requestId, user: { person, role, access_level: accessLevel, scope: "FULL" }, constraints: { read_only: true, schema: "agency_ops", timezone: "America/Sao_Paulo", no_invention: true } }), signal: controller.signal })
      .then(async (response) => {
        const raw = await response.text();
        let parsed: unknown = null; try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
        const answer = safeAnswer(parsed, raw);
        if (!response.ok) return { answer: null as string | null, error: `http_${response.status}` };
        if (!answer) return { answer: null as string | null, error: "empty_ai_answer" };
        return { answer: answer as string | null, error: null as string | null };
      })
      .catch((error) => {
        const abortou = error instanceof DOMException && error.name === "AbortError";
        return { answer: null as string | null, error: abortou ? "ai_timeout" : String(error instanceof Error ? error.message : error).slice(0, 300) };
      })
      .finally(() => clearTimeout(timeout));
  };

  const makeUrl = typeof webhookCfg?.value === "string" ? webhookCfg.value : null;
  let modo = routeMode;
  let rotulo = routeLabel;
  // 55s para a tentativa principal, nao 50s. Os 50s existiam para sobrar janela ao
  // plano B, mas o plano B so' dispara em falha rapida (<25s) - reservar tempo no fim
  // nunca ajudou ninguem e custava as perguntas que levam ~50s. Uma real estourou em
  // 50,6s em 20/08 e o usuario recebeu erro.
  let tentativa = await enviar(webhookUrl, 55_000);

  // Virar a chave para a VPS nao pode ser aposta. Se a rota nova falhar rapido - VPS
  // fora do ar, certificado vencido, servico reiniciando - o Make continua de pe' e
  // responde, e o time nao fica sem OpsQuestion por causa de uma migracao.
  // Falha lenta nao tem plano B: o tempo do usuario ja' foi gasto, e insistir so'
  // entregaria um timeout mais longo.
  if (!tentativa.answer && directUrl && makeUrl && makeUrl !== directUrl
      && tentativa.error !== "ai_timeout" && Date.now() - started < 25_000) {
    const erroVps = tentativa.error;
    const plano = await enviar(makeUrl, 30_000);
    if (plano.answer) {
      modo = "DIRECT_AI_FALLBACK";
      rotulo = "agency_ops via Make/IA (VPS indisponível)";
      tentativa = plano;
      console.error(`[ai-ask] ${requestId} VPS falhou (${erroVps}); respondido pelo Make`);
    }
  }

  const latency = Date.now() - started;
  if (!tentativa.answer) {
    const error = `${routeMode === "DIRECT_AI" ? "vps" : "make"}_${tentativa.error}`;
    await ops.from("opsquestion_interactions").update({ status: "ERROR", error, latency_ms: latency, answered_at: new Date().toISOString() }).eq("request_id", requestId);
    const amigavel = tentativa.error === "ai_timeout"
      ? "OpsQuestion demorou demais para responder. Tente uma pergunta mais específica."
      : "Falha temporária no OpsQuestion.";
    return reply({ ok: false, error: amigavel, detail: error, request_id: requestId }, 502);
  }

  // source grava a rota que de fato respondeu, inclusive quando foi o plano B.
  await ops.from("opsquestion_interactions").update({ status: "SUCCESS", source: modo, answer: tentativa.answer.slice(0, 20000), latency_ms: latency, answered_at: new Date().toISOString() }).eq("request_id", requestId);
  return reply({ ok: true, name: "OpsQuestion", answer: tentativa.answer, source: rotulo, read_only: true, mode: modo, request_id: requestId, latency_ms: latency, generated_at: new Date().toISOString() });
});
