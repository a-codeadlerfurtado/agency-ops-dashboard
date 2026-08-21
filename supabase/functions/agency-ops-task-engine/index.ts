import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ENGINE_VERSION = 11;
const VALIDATION_VERSION = "grounding-rich-context-v4.1";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ops = db.schema("agency_ops");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function segredo(name: string): Promise<string | null> {
  const { data, error } = await ops.rpc("get_secret", { p_name: name });
  return error ? null : ((data as string) || null);
}

async function config(name: string): Promise<string | null> {
  const { data, error } = await ops.from("automation_settings").select("value").eq("key", name).maybeSingle();
  if (error) return null;
  const value = data?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function norm(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function upper(v: unknown): string {
  return String(v ?? "").trim().toLocaleUpperCase("pt-BR");
}

function areaEhTrafego(area: unknown): boolean {
  const a = norm(area);
  return a === "gestor de trafego" || a === "trafego pago" || a === "gt";
}

function roleDaArea(area: unknown): "GT" | "CS" | "DESIGN" | "AI" | "MGMT" | null {
  const a = norm(area);
  if (areaEhTrafego(a)) return "GT";
  if (/\bcs\b|sucesso do cliente|atendimento/.test(a)) return "CS";
  if (/designer|design|editor de video|video/.test(a)) return "DESIGN";
  if (/\bia\b|automacao|integracao de sistema|agente/.test(a)) return "AI";
  if (/gerente operacional|operacoes|operacao|comercial|gestao/.test(a)) return "MGMT";
  return null;
}

async function resolverGtDoCliente(clientId: unknown): Promise<any> {
  if (!clientId) return { ok: false, reason: "missing_client_id" };
  const { data, error } = await ops.rpc("resolve_gt_clickup_assignee", { p_client_id: clientId });
  if (error) return { ok: false, reason: "assignment_rpc_error", detail: error.message };
  const assigneeId = Number(data?.clickup_user_id);
  if (!data?.ok || !Number.isFinite(assigneeId)) return { ...(data ?? {}), ok: false, reason: data?.reason ?? "invalid_clickup_user_id" };
  return { ...data, ok: true, clickup_user_id: String(data.clickup_user_id) };
}

function nomeEquipe(candidate: unknown, equipe: any[]): any | null {
  const alvo = norm(candidate);
  if (!alvo) return null;
  return equipe.find((p) => norm(p?.person) === alvo) ?? null;
}

function unicaPessoaDoRole(role: string | null, equipe: any[]): any | null {
  if (!role) return null;
  const matches = equipe.filter((p) => String(p?.role ?? "").toUpperCase() === role);
  return matches.length === 1 ? matches[0] : null;
}

async function resolverResponsavel(t: any, contexto: any, equipe: any[], clientId: unknown) {
  const role = roleDaArea(t?.area);
  const sugerido = nomeEquipe(t?.responsavel_sugerido, equipe);
  if (sugerido) return { role: String(sugerido.role || role || "").toUpperCase() || role, person: sugerido.person ?? null, clickup_user_id: sugerido.clickup_user_id ?? null, source: "ai_suggestion+team_identity_map" };
  if (role === "GT") {
    const gt = await resolverGtDoCliente(clientId);
    return { role, person: gt?.gt_owner ?? null, clickup_user_id: gt?.ok ? String(gt.clickup_user_id) : null, source: "clients.gt_owner+team_identity_map", ok: gt?.ok === true, reason: gt?.reason ?? null };
  }
  const owner = role === "CS" ? contexto?.cliente?.cs_owner : role === "DESIGN" ? contexto?.cliente?.designer_owner : null;
  const mapped = nomeEquipe(owner, equipe);
  if (mapped) return { role, person: mapped.person, clickup_user_id: mapped.clickup_user_id ?? null, source: `clients.${role === "CS" ? "cs_owner" : "designer_owner"}+team_identity_map` };
  const unica = unicaPessoaDoRole(role, equipe);
  if (unica && (role === "AI" || (role === "MGMT" && /gerente operacional|operacoes|operacao/.test(norm(t?.area))))) {
    return { role, person: unica.person, clickup_user_id: unica.clickup_user_id ?? null, source: "single_role_owner" };
  }
  return { role, person: null, clickup_user_id: null, source: role ? "role_only" : "unresolved" };
}

function evidenciaEstaNoEvento(evidencia: unknown, excerpt: unknown): boolean {
  const e = norm(evidencia);
  const x = norm(excerpt);
  if (!e || !x) return false;
  if (x.includes(e) || e.includes(x)) return true;
  const eTokens = [...new Set(e.split(" ").filter((t) => t.length >= 4))];
  const xTokens = [...new Set(x.split(" ").filter((t) => t.length >= 4))];
  if (!eTokens.length || !xTokens.length) return false;
  const evidenceCoverage = eTokens.filter((t) => xTokens.includes(t)).length / eTokens.length;
  const eventCoverage = xTokens.filter((t) => eTokens.includes(t)).length / xTokens.length;
  return evidenceCoverage >= 0.72 || eventCoverage >= 0.72;
}

const STOP = new Set(["para","pela","pelo","pelos","pelas","com","sem","sobre","entre","mais","menos","uma","umas","uns","dos","das","que","isso","essa","esse","esta","este","aqui","ali","como","quando","onde","depois","antes","tambem"]);
const VERBOS = new Set(["atualizar","ajustar","corrigir","alterar","trocar","inserir","adicionar","remover","retirar","enviar","mandar","responder","retornar","solicitar","pedir","dar","trazer","fazer","criar","subir","publicar","pausar","ativar","desativar","agendar","marcar","confirmar","verificar","revisar","validar","acompanhar","cobrar","avisar","informar","configurar","implementar","integrar","editar","produzir","analisar","investigar","refazer","avaliar"]);

function tokens(v: unknown): string[] {
  return [...new Set(norm(v).split(" ").filter((t) => t.length >= 4 && !STOP.has(t)))];
}

function acaoGrounded(acao: unknown, excerpt: unknown): { ok: boolean; unsupported: string[]; score: number } {
  const xt = tokens(excerpt);
  const at = tokens(acao);
  const unsupported = at.filter((token) => {
    if (VERBOS.has(token)) return false;
    if (xt.includes(token)) return false;
    if (token.length >= 5) {
      const stem = token.slice(0, 5);
      if (xt.some((x) => x.length >= 5 && x.slice(0, 5) === stem)) return false;
    }
    return true;
  });
  const score = at.length ? (at.length - unsupported.length) / at.length : 0;
  return { ok: unsupported.length === 0 && at.length > 0, unsupported, score };
}

function tarefaInterna(v: unknown): boolean {
  const t = norm(v);
  return /\btriagem\b|\btitularidade\b|\bclassificar (?:o )?grupo\b|\bvincular (?:o )?(?:cliente|grupo)\b|\bassociar (?:o )?(?:cliente|grupo)\b|\breconciliar|\bmapear (?:o )?grupo\b/.test(t);
}

type Destino = "CLICKUP" | "CENTRAL" | "IGNORE";
const TIPOS_CENTRAL = new Set(["RESPONDER","COBRAR","SOLICITAR","AVISAR","CONFIRMAR","AGENDAR","APROVAR_ENCAMINHAR","ACOMPANHAR"]);

function pareceTecnica(v: unknown): boolean {
  const t = norm(v);
  return /(subir|criar|publicar|ajustar|otimizar|pausar|ativar|desativar|alterar|corrigir|configurar|implementar|integrar|editar|produzir|refazer|analisar|investigar).{0,100}(campanh|anunci|conjunto|criativ|video|copy|crm|formulario|automacao|integracao|landing|pagina|pixel|gtm|site|conta meta|meta ads|google ads|tracking|tag|evento|api|webhook|metric|lead)/.test(t)
    || /(campanh|anunci|conjunto|criativ|video|copy|crm|formulario|automacao|integracao|landing|pagina|pixel|gtm|site|conta meta|meta ads|google ads|tracking|tag|evento|api|webhook|metric|lead).{0,100}(subir|criar|publicar|ajustar|otimizar|pausar|ativar|desativar|alterar|corrigir|configurar|implementar|integrar|editar|produzir|refazer|analisar|investigar)/.test(t)
    || /(produzir|criar|montar|analisar).{0,50}relatorio/.test(t);
}

function pareceComunicacao(v: unknown): boolean {
  const t = norm(v);
  return /\b(responder|retornar|retorno|cobrar|avisar|informar|confirmar|perguntar)\b/.test(t)
    || /\b(agendar|marcar|confirmar).{0,50}(reuniao|call|ligacao|horario|presenca)\b/.test(t)
    || /\b(coletar|pedir|solicitar).{0,80}(horario|foto|video|material|documento|acesso|permissao|aprovacao|decisao|feedback)\b/.test(t)
    || /\benviar.{0,80}(aprovacao|cliente|retorno|posicionamento)\b/.test(t);
}

function destino(t: any): Destino {
  const x = `${t?.acao ?? t?.titulo ?? ""} ${t?.tipo_demanda ?? ""}`;
  if (pareceTecnica(x)) return "CLICKUP";
  if (pareceComunicacao(x)) return "CENTRAL";
  const ai = String(t?.destino ?? "").toUpperCase();
  if (ai === "CLICKUP" || ai === "CENTRAL") return ai;
  return "IGNORE";
}

function tipoCentral(t: any): string {
  const ai = String(t?.tipo_demanda ?? "").trim().toUpperCase().replace(/[^A-Z_]/g, "_");
  if (TIPOS_CENTRAL.has(ai)) return ai;
  const x = norm(t?.acao ?? t?.titulo);
  if (/\bcobrar\b/.test(x)) return "COBRAR";
  if (/\b(agendar|marcar)\b/.test(x)) return "AGENDAR";
  if (/\bconfirmar\b/.test(x)) return "CONFIRMAR";
  if (/\b(solicitar|pedir|coletar)\b/.test(x)) return "SOLICITAR";
  if (/\b(avisar|informar)\b/.test(x)) return "AVISAR";
  if (/\b(aprovacao|aprovar|encaminhar)\b/.test(x)) return "APROVAR_ENCAMINHAR";
  if (/\b(responder|retornar|retorno)\b/.test(x)) return "RESPONDER";
  return "ACOMPANHAR";
}

const CATEGORIAS = new Set(["Campanha","Ajuste na campanha","Criativos","Integração","CRM","Automação","Relatório","Retorno ao cliente","Onboarding","Reunião","Conta/Plataforma","Outro"]);

function categoriaDeterministica(t: any, dest: Destino): string {
  const action = norm(t?.acao ?? t?.titulo ?? "");
  const campaignAdjustment = /(campanh|anunci|conjunto).{0,90}(ajust|otimiz|paus|ativ|desativ|corrig|alter|orcament|segment|ausencia de lead|sem lead)|(?:ajust|otimiz|paus|ativ|desativ|corrig|alter).{0,90}(campanh|anunci|conjunto)/;
  const campaignCreate = /\b(criar|subir|publicar|montar).{0,80}(campanh|anunci|conjunto)|(?:campanh|anunci|conjunto).{0,80}(criar|subir|publicar|montar)\b/;
  if (campaignAdjustment.test(action)) return "Ajuste na campanha";
  if (campaignCreate.test(action)) return "Campanha";
  const x = norm(`${action} ${t?.descricao_execucao ?? t?.descricao ?? ""} ${t?.categoria ?? ""}`);
  if (campaignAdjustment.test(x)) return "Ajuste na campanha";
  if (campaignCreate.test(x)) return "Campanha";
  if (/criativ|arte|video|copy|roteiro/.test(x)) return "Criativos";
  if (/\bcrm\b/.test(x)) return "CRM";
  if (/automacao|\bmake\b|webhook|z api|zapier|n8n/.test(x)) return "Automação";
  if (/integracao|integrar|api|xml|pixel|gtm|tagueamento|tracking/.test(x)) return "Integração";
  if (/relatorio|report/.test(x)) return "Relatório";
  if (/onboarding|integracao de contas|primeira reuniao|reuniao de apresentacao/.test(x)) return "Onboarding";
  if (/reuniao|call|meet|ligacao/.test(x)) return "Reunião";
  if (/conta meta|facebook|google ads|business manager|gerenciador|acesso|codigo/.test(x) && /conta|acesso|codigo|facebook|google/.test(x)) return "Conta/Plataforma";
  if (dest === "CENTRAL") return "Retorno ao cliente";
  const ai = String(t?.categoria ?? "").trim();
  return CATEGORIAS.has(ai) ? ai : "Outro";
}

function tituloPadrao(clientName: unknown, category: string, action: unknown): string {
  const client = upper(clientName || "SEM CLIENTE ESPECÍFICO");
  const act = upper(action).replace(/^[-–—\s]+|[-–—\s]+$/g, "");
  return `[${client}] - ${category} - ${act || "AÇÃO OPERACIONAL"}`.slice(0, 250);
}

function prioridadeCentral(v: unknown): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const p = norm(v);
  if (p === "urgente" || p === "critica" || p === "critico") return "CRITICAL";
  if (p === "alta" || p === "alto") return "HIGH";
  if (p === "baixa" || p === "baixo") return "LOW";
  return "MEDIUM";
}

function asArray(v: unknown): any[] { return Array.isArray(v) ? v : []; }
function cleanText(v: unknown, max = 8000): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
}

function matchRequester(contexto: any, evidence: unknown, fallbackMessageId: unknown) {
  const ev = norm(evidence);
  const pool = [...asArray(contexto?.mensagens_evento), ...asArray(contexto?.mensagens_relevantes_historico), ...asArray(contexto?.mensagens_recentes)];
  let best: any = null;
  let bestScore = 0;
  for (const m of pool) {
    const body = norm(m?.body);
    if (!body || !ev) continue;
    let score = 0;
    if (body.includes(ev) || ev.includes(body)) score = 1;
    else {
      const et = [...new Set(ev.split(" ").filter((x) => x.length >= 4))];
      score = et.length ? et.filter((x) => body.includes(x)).length / et.length : 0;
    }
    if (score > bestScore) { best = m; bestScore = score; }
  }
  if (bestScore >= 0.65) return best;
  return pool.find((m) => String(m?.message_id ?? "") === String(fallbackMessageId ?? "")) ?? null;
}

function formatList(items: unknown, empty = "Nenhum item adicional confirmado."): string {
  const arr = asArray(items).map((x) => typeof x === "string" ? x.trim() : JSON.stringify(x)).filter(Boolean).slice(0, 12);
  return arr.length ? arr.map((x) => `- ${x}`).join("\n") : empty;
}

function formatConfig(cfg: any): string {
  if (!cfg || typeof cfg !== "object") return "- Nenhuma configuração adicional confirmada para esta ação.";
  const labels: Record<string,string> = {
    budget: "Budget", crm: "CRM", usa_make: "Usa Make", destino_leads_make: "Destino dos leads via Make",
    usa_crm_e_make: "CRM + Make", destino_leads: "Destino dos leads", gt: "GT", cs: "CS",
    designer: "Designer", plataforma: "Plataforma", observacoes: "Observações"
  };
  const rows = Object.entries(cfg).filter(([,v]) => v !== null && v !== undefined && String(v).trim() !== "").slice(0, 20);
  return rows.length ? rows.map(([k,v]) => `- ${labels[k] || k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n") : "- Nenhuma configuração adicional confirmada para esta ação.";
}

function descricaoRica(params: { t: any; contexto: any; grupo: string | null; requester: any; event: any; category: string; model: string }) {
  const requesterName = params.requester?.sender_name || cleanText(params.t?.quem_pediu, 200) || "Solicitante não identificado com segurança";
  const requesterPhone = params.requester?.sender_phone || null;
  const requesterWhen = params.requester?.occurred_at || params.event?.created_at || null;
  const group = params.grupo || params.requester?.chat_name || params.event?.chat_id || "grupo não identificado";
  const actionDescription = cleanText(params.t?.descricao_execucao, 12000) || cleanText(params.t?.descricao, 12000) || "Executar a ação descrita no título, respeitando o contexto validado abaixo.";
  const contextRelevant = cleanText(params.t?.contexto_relevante, 12000) || "Nenhum contexto adicional foi necessário além do pedido comprovado.";
  const conflicts = asArray(params.t?.conflitos);
  const sources = asArray(params.t?.fontes_usadas);
  const history = asArray(params.t?.historico_relevante);
  const completion = asArray(params.t?.criterios_conclusao);
  const lines = [
    "🤖 ORIGEM DA DEMANDA",
    `Task identificada automaticamente pela IA através da leitura do grupo “${group}”.`,
    `Categoria operacional: ${params.category}.`,
    `Motor: Task Engine v${ENGINE_VERSION} · ${params.model}.`,
    "",
    "📌 O QUE PRECISA SER FEITO",
    actionDescription,
    "",
    "👤 QUEM PEDIU / ORIGEM DO PEDIDO",
    `Solicitante: ${requesterName}${requesterPhone ? ` · ${requesterPhone}` : ""}.`,
    requesterWhen ? `Data/hora da mensagem localizada: ${requesterWhen}.` : null,
    params.requester?.message_id ? `Message ID: ${params.requester.message_id}.` : (params.event?.message_id ? `Evento de referência: ${params.event.message_id}.` : null),
    "",
    "💬 PEDIDO IDENTIFICADO",
    String(params.t?.evidencia ?? "[evidência não disponível]").trim(),
    "",
    "🧠 CONTEXTO OPERACIONAL DO CLIENTE",
    contextRelevant,
    "",
    "📊 CONFIGURAÇÃO DO CLIENTE",
    formatConfig(params.t?.configuracao_cliente),
    "",
    "🕘 HISTÓRICO RELACIONADO",
    formatList(history, "- Nenhuma mensagem histórica adicional foi necessária para executar esta ação."),
    "",
    "⚠️ DIVERGÊNCIAS / PONTOS A CONFIRMAR",
    formatList(conflicts, "- Nenhuma divergência relevante encontrada nas fontes consultadas."),
    "",
    "✅ CRITÉRIOS DE CONCLUSÃO",
    formatList(completion, "- Concluir a ação comprovada e registrar o resultado no fluxo operacional."),
    "",
    "🔎 FONTES CONSULTADAS",
    formatList(sources, "- WhatsApp: evento atual + busca no histórico completo dos grupos vinculados ao cliente.\n- Notion: briefing mais recente vinculado ao cliente, quando disponível.\n- Banco operacional: integrações, responsáveis e tasks abertas."),
    "",
    "Rastreabilidade: a AÇÃO acima só foi aceita porque está comprovada nas mensagens do evento. O CONTEXTO pode usar histórico do WhatsApp, briefing do Notion e configurações do banco; informação conflitante deve aparecer como divergência, nunca ser resolvida por suposição da IA."
  ].filter((x) => x !== null && x !== undefined);
  return lines.join("\n").slice(0, 30000);
}

function intentTokens(v: unknown): string[] {
  const generic = new Set([...VERBOS, "retorno","resposta","cliente","clientes","demanda","pendencia","solicitacao","pedido","agencia","time","equipe"]);
  return [...new Set(tokens(v).filter((t) => !generic.has(t)).map((t) => t.length > 4 && t.endsWith("s") ? t.slice(0,-1) : t))];
}

function jaccard(a: string[], b: string[]): number {
  const aa = new Set(a), bb = new Set(b), union = new Set([...aa,...bb]);
  if (!union.size) return 1;
  let inter = 0; for (const x of aa) if (bb.has(x)) inter++;
  return inter / union.size;
}

function intraDup(prev: any, curr: any): boolean {
  if (prev.destino !== curr.destino) return false;
  if (prev.destino === "CENTRAL" && prev.central !== curr.central) return false;
  const a = intentTokens(prev.action), b = intentTokens(curr.action);
  if (!a.length && !b.length) return true;
  if (!a.length || !b.length) return false;
  return jaccard(a,b) >= (prev.destino === "CENTRAL" ? 0.5 : 0.7);
}

async function sha256(v: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(v ?? "")));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2,"0")).join("");
}

async function encontrarDuplicataCentral(clientId: unknown, action: string, central: string) {
  if (!clientId) return null;
  const { data } = await ops.from("work_items").select("id,title,status,metadata,created_at")
    .eq("client_id", clientId).in("status", ["OPEN","IN_PROGRESS","WAITING","SNOOZED"])
    .order("created_at", { ascending: false }).limit(60);
  const cur = { destino: "CENTRAL", central, action };
  for (const row of data ?? []) {
    const rowType = String(row?.metadata?.central_type ?? "ACOMPANHAR");
    if (rowType !== central) continue;
    if (intraDup({ destino: "CENTRAL", central: rowType, action: row.title }, cur)) return row;
  }
  return null;
}

async function criarWorkItem(params: any) {
  const dias = Number(params.t?.prazo_dias);
  const dueAt = Number.isFinite(dias) && dias > 0 ? new Date(Date.now() + dias * 86400000).toISOString() : null;
  const body = {
    client_id: params.ev.client_id ?? null,
    type: "CLIENT_FOLLOWUP",
    status: "OPEN",
    priority: prioridadeCentral(params.t?.prioridade),
    title: params.titulo,
    description: params.description,
    source: "task_engine_ai",
    source_id: params.sourceId,
    created_by_user_key: "system:task-engine",
    created_by_person: "IA · Task Engine",
    target_role: params.responsavel?.role ?? null,
    target_person: params.responsavel?.person ?? null,
    due_at: dueAt,
    metadata: {
      ai_generated: true, source_event_id: params.ev.id, source_message_id: params.requester?.message_id ?? params.ev.message_id ?? null,
      source_chat_id: params.ev.chat_id ?? null, source_group_name: params.group, requester_name: params.requester?.sender_name ?? params.t?.quem_pediu ?? null,
      requester_phone: params.requester?.sender_phone ?? null, evidence: params.t?.evidencia ?? null, central_type: params.central,
      destination: "CENTRAL", generated_task_id: params.generatedTaskId ?? null, model: params.model,
      validation_version: VALIDATION_VERSION, assignment_source: params.responsavel?.source ?? null,
      context_sources: params.t?.fontes_usadas ?? [], context_conflicts: params.t?.conflitos ?? [], operational_context: params.t?.configuracao_cliente ?? {},
    },
  };
  const { data, error } = await ops.from("work_items").insert(body).select("id").maybeSingle();
  if (!error && data?.id) return { id: data.id, existing: false };
  const { data: existing } = await ops.from("work_items").select("id").eq("source","task_engine_ai").eq("source_id",params.sourceId).limit(1).maybeSingle();
  if (existing?.id) return { id: existing.id, existing: true };
  throw new Error(`work_item_create:${error?.message ?? "unknown"}`);
}

const SISTEMA = [
  "Voce e o Task Engine de uma agencia de trafego pago imobiliario.",
  "Sua tarefa e identificar ACOES reais e montar contexto operacional profundo SEM inventar a acao.",
  "Responda APENAS JSON valido.",
  "",
  "PRINCIPIO CENTRAL",
  "- A ACAO precisa estar comprovada nas MENSAGENS DO EVENTO ATUAL. Nunca crie uma acao so porque o briefing ou o historico sugerem que seria util.",
  "- Depois que a acao estiver comprovada, a DESCRICAO e o CONTEXTO devem ser enriquecidos com fontes verificadas: historico relevante do WhatsApp, briefing Notion, integracoes/configuracoes e tasks abertas.",
  "- O contexto recebido ja inclui busca no corpus inteiro de mensagens dos grupos vinculados ao cliente; use mensagens_relevantes_historico e mensagens_recentes para recuperar o que for util.",
  "",
  "ROTEAMENTO",
  "- CLICKUP: execucao/producao/alteracao tecnica: criar/subir campanha, ajuste/otimizacao de campanha, pausar/ativar, criativos, CRM, Make/automacao, integracoes, LP/site, pixel/GTM, problemas de conta/plataforma, analise tecnica ou relatorio que exige trabalho.",
  "- CENTRAL: comunicacao/follow-up/decisao humana: responder, dar retorno, cobrar, pedir material/acesso, avisar, confirmar, agendar, solicitar aprovacao/decisao, perguntar/acompanhar feedback.",
  "- IGNORAR: nenhuma acao concreta.",
  "- Uma mesma conversa pode gerar uma acao CLICKUP e outra CENTRAL se forem acoes diferentes.",
  "",
  "CATEGORIAS OFICIAIS",
  "Campanha | Ajuste na campanha | Criativos | Integracao | CRM | Automacao | Relatorio | Retorno ao cliente | Onboarding | Reuniao | Conta/Plataforma | Outro.",
  "REGRA ABSOLUTA: se for AJUSTE, OTIMIZACAO, PAUSA, ATIVACAO, CORRECAO ou ALTERACAO em campanha/anuncio/conjunto, categoria deve ser 'Ajuste na campanha', NUNCA 'Campanha'.",
  "Campanha e usada para CRIAR/SUBIR/PUBLICAR uma campanha nova.",
  "",
  "CONTEXTO E CONFLITOS",
  "- Prioridade de fonte: mensagem explicita mais recente > alteracao operacional recente > briefing Notion > historico antigo.",
  "- Uma fonte mais recente so substitui outra se estiver claro que e uma atualizacao. Se houver conflito ambiguo, coloque em conflitos e NAO escolha no chute.",
  "- Extraia, quando realmente relevante e presente nas fontes: budget atual, CRM, se usa Make, destino/numero dos leads via Make, se usa CRM+Make, responsaveis, plataforma e outras configuracoes necessarias para executar.",
  "- Nao despeje todo o briefing. Traga somente informacoes que mudam ou ajudam a execucao desta acao.",
  "- historico_relevante deve citar/resumir apenas mensagens relacionadas a esta acao, de preferencia com data e autor quando disponiveis.",
  "- fontes_usadas deve indicar quais fontes realmente sustentaram o contexto (WhatsApp atual, WhatsApp historico, Notion, integracoes, tasks abertas).",
  "",
  "REGRAS DE SEGURANCA",
  "1. Uma acao por item; nao misture execucao tecnica e comunicacao.",
  "2. evidencia e SOMENTE um TRECHO LITERAL copiado das MENSAGENS DO EVENTO ATUAL que prova a acao. Nao coloque aspas extras, autor, data, explicacao ou parenteses no campo evidencia.",
  "3. acao deve ser curta, objetiva e usar somente o objeto/assunto comprovado no evento atual. O detalhe extra vai em descricao_execucao/contexto, nao na acao.",
  "4. descricao_execucao deve explicar exatamente o que fazer usando contexto verificado; nao invente requisito.",
  "5. criterios_conclusao devem ser verificaveis e coerentes com a acao; nao invente condicao comercial.",
  "6. Se uma execucao CLICKUP ja existir em tasks_abertas, marque duplicata_provavel=true. Isso nao elimina uma acao CENTRAL de comunicar o cliente.",
  "7. responsavel_sugerido: no maximo uma pessoa e apenas se claramente sustentada; senao vazio.",
  "8. area: Gestor de trafego | CS | Designer | Editor de video | IA/Automacao | Gerente operacional | Comercial.",
  "9. prioridade: Urgente | Alta | Media | Baixa.",
  "10. CENTRAL tipo_demanda: RESPONDER | COBRAR | SOLICITAR | AVISAR | CONFIRMAR | AGENDAR | APROVAR_ENCAMINHAR | ACOMPANHAR.",
  "11. Nunca crie acao interna de triagem, vinculo, classificacao ou reconciliacao do proprio sistema.",
  "12. Se nao existir acao comprovada no evento atual, tasks deve ser [].",
  "",
  '{"tasks":[{"acao":"","categoria":"","descricao_execucao":"","area":"","responsavel_sugerido":"","prioridade":"","prazo_dias":0,"evidencia":"","duplicata_provavel":false,"motivo":"","destino":"CLICKUP|CENTRAL|IGNORAR","tipo_demanda":"","quem_pediu":"","contexto_relevante":"","configuracao_cliente":{"budget":"","crm":"","usa_make":"","destino_leads_make":"","usa_crm_e_make":"","destino_leads":"","gt":"","cs":"","designer":"","plataforma":"","observacoes":""},"historico_relevante":[],"conflitos":[],"criterios_conclusao":[],"fontes_usadas":[]}]}',
].join("\n");

function parseJsonText(text: string): any {
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"") || "{}");
}

async function chamarOpenAI(key: string, model: string, contexto: any, excerpt: string) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, response_format: { type: "json_object" }, messages: [
      { role: "system", content: SISTEMA },
      { role: "user", content: `CONTEXTO VERIFICADO DO CLIENTE:\n${JSON.stringify(contexto)}\n\nMENSAGENS DO EVENTO ATUAL (UNICA FONTE PERMITIDA PARA EXISTENCIA DA ACAO):\n${excerpt}` },
    ]}),
  });
  const raw = await r.text(); let j: any = null; try { j = raw ? JSON.parse(raw) : null; } catch { j = null; }
  if (!r.ok) throw new Error(`openai ${r.status}: ${raw.slice(0,300)}`);
  return parseJsonText(j?.choices?.[0]?.message?.content || "{}");
}

async function chamarBackend(endpoint: string, secret: string, contexto: any, excerpt: string) {
  const prompt = `${SISTEMA}\n\nCONTEXTO VERIFICADO DO CLIENTE:\n${JSON.stringify(contexto)}\n\nMENSAGENS DO EVENTO ATUAL:\n${excerpt}`;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const r = await fetch(endpoint, { method: "POST", headers: { "content-type":"application/json", "x-ai-read-secret":secret }, body: JSON.stringify({
      question: prompt, original_question: "Gerar e rotear demandas operacionais com contexto rico", source: "TaskEngine",
      request_id: crypto.randomUUID(), constraints: { read_only:true, schema:"agency_ops", timezone:"America/Sao_Paulo", no_invention:true },
    }), signal: controller.signal });
    const raw = await r.text(); let body: any = null; try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    if (!r.ok) throw new Error(`ai_backend ${r.status}: ${raw.slice(0,300)}`);
    const answer = [body?.answer,body?.response,body?.output,body?.result,body?.text,body?.message].find((v) => typeof v === "string" && v.trim());
    if (!answer) throw new Error("ai_backend empty_answer");
    return parseJsonText(answer);
  } finally { clearTimeout(timeout); }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("health") === "1") return json({
    ok:true, service:"agency-ops-task-engine", version:ENGINE_VERSION, validation_version:VALIDATION_VERSION,
    naming:"[CLIENTE] - CATEGORIA - ACAO", campaign_adjustment_category:"Ajuste na campanha",
    context:"whatsapp_full_corpus_search+notion+integrations+open_tasks", routing:"CLICKUP|CENTRAL|IGNORE"
  });

  const cronSecret = await segredo("TASK_ENGINE_CRON_SECRET");
  if (!cronSecret || req.headers.get("x-task-engine-key") !== cronSecret) return json({ ok:false, error:"unauthorized" },401);

  const [openaiKey, modelSecret, endpoint, readSecret] = await Promise.all([
    segredo("OPENAI_API_KEY"), segredo("TASK_ENGINE_MODEL"), config("AI_ASK_ENDPOINT_URL"), config("AI_ASK_READ_SECRET")
  ]);
  const provider = openaiKey ? "OPENAI" : (endpoint && readSecret ? "OPSQUESTION_BACKEND" : null);
  if (!provider) return json({ ok:false,error:"missing_ai_configuration" },428);
  const model = openaiKey ? (modelSecret || "gpt-5-mini") : "opsquestion-backend";
  const mode = url.searchParams.get("modo") === "LIVE" ? "LIVE" : "SHADOW";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limite") || 1),1),25);
  const now = new Date().toISOString();

  await ops.from("task_generation_events").update({ status:"ERROR", last_error:"stale_processing_recovered", available_at:now })
    .eq("status","PROCESSING").lt("locked_at",new Date(Date.now()-10*60_000).toISOString());

  const { data:eventos,error:queueError } = await ops.from("task_generation_events").select("*")
    .in("status",["PENDING","ERROR"]).lte("available_at",now).order("urgency",{ascending:true}).order("id",{ascending:true}).limit(limit);
  if (queueError) return json({ok:false,error:queueError.message},500);
  if (!eventos?.length) return json({ok:true,processados:0,modo:mode,provider,modelo:model,validation_version:VALIDATION_VERSION});

  const { data:equipe } = await ops.from("team_identity_map").select("person,role,clickup_user_id");
  const team = equipe ?? [];
  const resumo = { processados:0,ignorados:0,propostas:0,duplicadas:0,duplicadas_intraevento:0,descartadas:0,enviadas_clickup:0,enviadas_central:0,bloqueadas_atribuicao:0,erros:0 };

  for (const ev of eventos) {
    await ops.from("task_generation_events").update({ status:"PROCESSING",locked_at:new Date().toISOString(),attempt_count:(ev.attempt_count ?? 0)+1 }).eq("id",ev.id);
    try {
      const { data:contexto,error:ctxErr } = await ops.rpc("task_engine_context_v2", {
        p_client_id:ev.client_id, p_chat_id:ev.chat_id, p_excerpt:ev.excerpt || "", p_event_created_at:ev.created_at || new Date().toISOString()
      });
      if (ctxErr) throw new Error(`context_v2:${ctxErr.message}`);
      const group = contexto?.mensagens_evento?.find?.((m:any) => m?.chat_name)?.chat_name
        || contexto?.mensagens_recentes?.find?.((m:any) => m?.chat_name)?.chat_name
        || ev.chat_id || null;
      const clientName = contexto?.cliente?.display_name || "SEM CLIENTE ESPECÍFICO";
      const ai = openaiKey ? await chamarOpenAI(openaiKey,model,contexto ?? {},ev.excerpt || "") : await chamarBackend(endpoint!,readSecret!,contexto ?? {},ev.excerpt || "");
      const proposals:any[] = Array.isArray(ai?.tasks) ? ai.tasks : [];
      const sourceHash = await sha256(ev.excerpt || "");
      const accepted:any[] = [];

      for (const t of proposals) {
        const action = cleanText(t?.acao ?? t?.titulo,500);
        if (!action) continue;
        const dest = destino(t);
        const central = dest === "CENTRAL" ? tipoCentral(t) : null;
        const category = categoriaDeterministica(t,dest);
        const title = tituloPadrao(clientName,category,action);
        const requester = matchRequester(contexto,t?.evidencia,ev.message_id);
        const canonicalEvidence = requester?.body && evidenciaEstaNoEvento(requester.body, ev.excerpt)
          ? String(requester.body)
          : t?.evidencia;
        const effectiveTask = { ...t, evidencia: canonicalEvidence };
        const responsavel = await resolverResponsavel(effectiveTask,contexto ?? {},team,ev.client_id);
        const traffic = areaEhTrafego(effectiveTask?.area);
        const gtRouteOk = !traffic || (responsavel?.role === "GT" && responsavel?.person && responsavel?.clickup_user_id);
        const evidenceOk = evidenciaEstaNoEvento(canonicalEvidence,ev.excerpt);
        const actionCheck = acaoGrounded(action,ev.excerpt);
        const internal = tarefaInterna(action);
        const ignored = dest === "IGNORE";
        const grounded = evidenceOk && actionCheck.ok && !internal && !ignored;
        const reason = internal ? "internal_system_task" : ignored ? "routing_ignore" : !evidenceOk ? "evidence_not_in_current_event" : !actionCheck.ok ? `unsupported_action:${actionCheck.unsupported.slice(0,8).join(",")}` : "accepted";
        const current = { destino:dest,central,action };
        const duplicateInEvent = grounded && accepted.some((p) => intraDup(p,current));
        if (duplicateInEvent) resumo.duplicadas_intraevento++;

        let clickupDup:any = null, centralDup:any = null;
        if (grounded && !duplicateInEvent && dest === "CLICKUP") {
          const { data:dup } = await ops.rpc("find_duplicate_task", { p_client_id:ev.client_id,p_titulo:title });
          clickupDup = Array.isArray(dup) ? dup[0] : dup;
        } else if (grounded && !duplicateInEvent && dest === "CENTRAL") {
          centralDup = await encontrarDuplicataCentral(ev.client_id,action,central || "ACOMPANHAR");
        }
        const aiDup = dest === "CLICKUP" && t?.duplicata_provavel === true;
        const duplicated = grounded && (duplicateInEvent || Boolean(clickupDup) || Boolean(centralDup) || aiDup);
        const discarded = !grounded;
        if (grounded && !duplicated) accepted.push(current);

        const description = descricaoRica({ t:effectiveTask,contexto,grupo:group,requester,event:ev,category,model });
        const { data:normTitle } = await ops.rpc("normalize_task_subject",{p_nome:title});
        const normalizedTitle = String(normTitle || norm(title));
        const prazoDias = Number(t?.prazo_dias);
        const contextSources = asArray(effectiveTask?.fontes_usadas);
        const conflicts = asArray(effectiveTask?.conflitos);
        const completion = asArray(effectiveTask?.criterios_conclusao);

        const row:any = {
          event_id:ev.id,client_id:ev.client_id,chat_id:ev.chat_id,titulo:title,titulo_norm:normalizedTitle,descricao:description,
          area:effectiveTask?.area ?? null,responsavel_sugerido:responsavel?.person ?? effectiveTask?.responsavel_sugerido ?? null,
          resolved_assignee_person:responsavel?.person ?? null,resolved_clickup_user_id:responsavel?.clickup_user_id ? String(responsavel.clickup_user_id) : null,
          assignment_source:responsavel?.source ?? null,prioridade:effectiveTask?.prioridade ?? null,
          prazo_sugerido:Number.isFinite(prazoDias) ? new Date(Date.now()+prazoDias*86400000).toISOString().slice(0,10) : null,
          urgencia:ev.urgency,sinais:ev.signals,contexto:contexto ?? null,grounding_score:Number(actionCheck.score.toFixed(4)),grounding_reason:reason,
          source_excerpt_hash:sourceHash,validation_version:VALIDATION_VERSION,destination:dest,central_type:central,task_category:category,
          source_group_name:group,requester_name:requester?.sender_name ?? cleanText(effectiveTask?.quem_pediu,200),requester_phone:requester?.sender_phone ?? null,
          requester_message_id:requester?.message_id ?? ev.message_id ?? null,operational_context:effectiveTask?.configuracao_cliente ?? {},context_conflicts:conflicts,
          context_sources:contextSources,completion_criteria:completion,
          evidencia:{ trecho:canonicalEvidence ?? null,motivo:effectiveTask?.motivo ?? null,message_id:requester?.message_id ?? ev.message_id,chat_id:ev.chat_id,group_name:group,
            requester_name:requester?.sender_name ?? effectiveTask?.quem_pediu ?? null,requester_phone:requester?.sender_phone ?? null,provider,destination:dest,central_type:central,
            category,duplicate_intra_event:duplicateInEvent,duplicate_work_item_id:centralDup?.id ?? null,duplicata_provavel_ia:aiDup,
            grounded_in_current_event:evidenceOk,action_grounded_in_current_event:actionCheck.ok,unsupported_action_terms:actionCheck.unsupported,
            discard_reason:discarded ? reason : null,validation_version:VALIDATION_VERSION,context_search:contexto?.historico_search ?? null,
            assignment:{role:responsavel?.role ?? null,person:responsavel?.person ?? null,clickup_user_id:responsavel?.clickup_user_id ?? null,source:responsavel?.source ?? null,reason:responsavel?.reason ?? null}
          },
          modelo:model,modo:mode,status:discarded ? "DESCARTADA" : (duplicated ? "DUPLICADA" : "PROPOSTA"),similaridade:clickupDup?.similaridade ?? null,
        };
        const { data:saved,error:saveErr } = await ops.from("generated_tasks").insert(row).select("id").maybeSingle();
        if (saveErr) throw new Error(`generated_task_insert:${saveErr.message}`);
        if (discarded) { resumo.descartadas++; continue; }
        if (duplicated) { resumo.duplicadas++; continue; }
        if (mode === "LIVE" && dest === "CLICKUP" && traffic && !gtRouteOk) {
          await ops.from("generated_tasks").update({status:"ERRO",erro:`gt_assignment_unresolved:${String(responsavel?.reason ?? "unknown")}`.slice(0,500)}).eq("id",saved?.id);
          resumo.bloqueadas_atribuicao++; continue;
        }
        resumo.propostas++;
        if (mode !== "LIVE") continue;
        const intentHash = (await sha256(`${ev.id}|${dest}|${central ?? ""}|${normalizedTitle}|${norm(canonicalEvidence)}`)).slice(0,24);

        if (dest === "CENTRAL") {
          const wi = await criarWorkItem({ ev,t:effectiveTask,titulo:title,description,group,requester,central:central || "ACOMPANHAR",responsavel,generatedTaskId:saved?.id,sourceId:`task-event:${ev.id}:${intentHash}`,model });
          await ops.from("generated_tasks").update({status:"CENTRAL",work_item_id:wi.id,erro:null}).eq("id",saved?.id);
          resumo.enviadas_central++; continue;
        }

        if (dest === "CLICKUP") {
          const [tokenCu,list] = await Promise.all([segredo("CLICKUP_API_TOKEN"),segredo("TASK_ENGINE_CLICKUP_LIST")]);
          if (!tokenCu || !list) { await ops.from("generated_tasks").update({status:"ERRO",erro:"missing_clickup_configuration"}).eq("id",saved?.id); continue; }
          const prio:Record<string,number> = {Urgente:1,Alta:2,Media:3,"Média":3,Baixa:4};
          const body:any = { name:title,description,priority:prio[String(effectiveTask?.prioridade)] ?? 3 };
          const assignee = Number(responsavel?.clickup_user_id); if (Number.isFinite(assignee)) body.assignees=[assignee];
          const r = await fetch(`https://api.clickup.com/api/v2/list/${list}/task`,{method:"POST",headers:{Authorization:tokenCu,"content-type":"application/json"},body:JSON.stringify(body)});
          const jr = await r.json().catch(()=>({}));
          await ops.from("generated_tasks").update(r.ok ? {status:"ENVIADA",clickup_task_id:jr?.id ?? null,sent_at:new Date().toISOString()} : {status:"ERRO",erro:JSON.stringify(jr).slice(0,500)}).eq("id",saved?.id);
          if (r.ok) resumo.enviadas_clickup++;
        }
      }
      await ops.from("task_generation_events").update({status:"DONE",processed_at:new Date().toISOString(),last_error:null}).eq("id",ev.id);
      resumo.processados++;
    } catch (e) {
      resumo.erros++;
      await ops.from("task_generation_events").update({status:"ERROR",last_error:String(e).slice(0,500),available_at:new Date(Date.now()+300000).toISOString()}).eq("id",ev.id);
    }
  }
  return json({ok:true,modo:mode,provider,modelo:model,validation_version:VALIDATION_VERSION,...resumo});
});
