import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ENGINE_VERSION = 9;
const VALIDATION_VERSION = "grounding-routing-v3.1";
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), {
  status: s,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ops = db.schema("agency_ops");

async function segredo(n: string): Promise<string | null> {
  const { data, error } = await ops.rpc("get_secret", { p_name: n });
  return error ? null : ((data as string) || null);
}

async function config(n: string): Promise<string | null> {
  const { data, error } = await ops.from("automation_settings").select("value").eq("key", n).maybeSingle();
  if (error) return null;
  const value = data?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizarTexto(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function areaEhTrafego(area: unknown): boolean {
  const a = normalizarTexto(area);
  return a === "gestor de trafego" || a === "trafego pago" || a === "gt";
}

function roleDaArea(area: unknown): "GT" | "CS" | "DESIGN" | "AI" | "MGMT" | null {
  const a = normalizarTexto(area);
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
  if (!data?.ok || !Number.isFinite(assigneeId)) {
    return { ...(data ?? {}), ok: false, reason: data?.reason ?? "invalid_clickup_user_id" };
  }
  return { ...data, ok: true, clickup_user_id: String(data.clickup_user_id) };
}

function relatorioSomenteInformativo(ev: any): boolean {
  const sinais = Array.isArray(ev?.signals) ? ev.signals.map((s: unknown) => String(s)) : [];
  if (sinais.length !== 1 || sinais[0] !== "RELATORIO") return false;
  const texto = normalizarTexto(ev?.excerpt);
  const temCabecalho = /segue o relatorio|relatorio das ultimas atualizacoes/.test(texto);
  const ocorrencias = (texto.match(/ultima atualizacao/g) || []).length;
  const pedidoExplicito = /\b(poderia|preciso|precisamos|favor|por favor|enviar|envie|mande|fazer|corrigir|ajustar|agendar|marcar|subir|pausar|retorno|responder|verificar)\b/.test(texto);
  return temCabecalho && ocorrencias >= 2 && !pedidoExplicito;
}

function evidenciaEstaNaMensagem(evidencia: unknown, excerpt: unknown): boolean {
  const e = normalizarTexto(evidencia);
  const x = normalizarTexto(excerpt);
  if (!e || !x) return false;
  if (x.includes(e)) return true;
  const tokens = [...new Set(e.split(" ").filter((t) => t.length >= 4))];
  if (!tokens.length) return false;
  const presentes = tokens.filter((t) => x.includes(t)).length;
  return presentes / tokens.length >= 0.78;
}

const STOPWORDS = new Set([
  "para", "pela", "pelo", "pelos", "pelas", "com", "sem", "sobre", "entre", "mais", "menos", "uma", "umas", "uns", "dos", "das", "que", "isso", "essa", "esse", "esta", "este", "aqui", "ali", "como", "quando", "onde", "depois", "antes", "tambem", "mencionada", "mencionado",
]);
const VERBOS_OPERACIONAIS = new Set([
  "atualizar", "ajustar", "corrigir", "alterar", "trocar", "inserir", "adicionar", "remover", "retirar", "enviar", "mandar", "responder", "retornar", "solicitar", "pedir", "dar", "trazer", "fazer", "criar", "subir", "publicar", "pausar", "ativar", "desativar", "agendar", "marcar", "confirmar", "verificar", "revisar", "validar", "acompanhar", "cobrar", "avisar", "informar", "configurar", "implementar", "integrar", "editar", "produzir", "analisar", "investigar",
]);
const METADADOS_GENERICOS = new Set(["cliente", "grupo", "conversa", "pedido", "mensagem", "task", "tarefa", "operacional"]);
const TOKENS_ACAO_GENERICOS = new Set([
  ...VERBOS_OPERACIONAIS,
  "retorno", "resposta", "cliente", "clientes", "demanda", "pendencia", "solicitacao", "solicitar", "pedido", "precisa", "precisamos", "poderia", "favor", "agencia", "time", "equipe",
]);

function tokensSignificativos(v: unknown): string[] {
  return [...new Set(normalizarTexto(v).split(" ").filter((t) => t.length >= 4 && !STOPWORDS.has(t)))];
}

function tokenSuportado(token: string, excerptTokens: string[]): boolean {
  if (VERBOS_OPERACIONAIS.has(token) || METADADOS_GENERICOS.has(token)) return true;
  if (excerptTokens.includes(token)) return true;
  if (token.length >= 5) {
    const stem = token.slice(0, 5);
    return excerptTokens.some((x) => x.length >= 5 && x.slice(0, 5) === stem);
  }
  return false;
}

function groundingConteudo(titulo: unknown, descricao: unknown, excerpt: unknown) {
  const excerptTokens = tokensSignificativos(excerpt);
  const titleTokens = tokensSignificativos(titulo);
  const descriptionTokens = tokensSignificativos(descricao);
  const titleUnsupported = titleTokens.filter((t) => !tokenSuportado(t, excerptTokens));
  const descUnsupported = descriptionTokens.filter((t) => !tokenSuportado(t, excerptTokens));
  const total = Math.max(1, titleTokens.length + descriptionTokens.length);
  const supported = total - titleUnsupported.length - descUnsupported.length;
  const score = Math.max(0, Math.min(1, supported / total));
  return { score, titleUnsupported, descUnsupported };
}

function tarefaInternaDoSistema(titulo: unknown, descricao: unknown): boolean {
  const t = normalizarTexto(`${titulo ?? ""} ${descricao ?? ""}`);
  return /\btriagem\b/.test(t)
    || /\btitularidade\b/.test(t)
    || /\bclassificar (?:o )?grupo\b/.test(t)
    || /\bconfirmar (?:o |a )?(?:grupo|rotulo|cadastro|vinculo)\b/.test(t)
    || /\bvincular (?:o )?(?:cliente|grupo)\b/.test(t)
    || /\bassociar (?:o )?(?:cliente|grupo)\b/.test(t)
    || /\breconciliar (?:o )?(?:cliente|grupo|cadastro)\b/.test(t)
    || /\bmapear (?:o )?grupo\b/.test(t)
    || /\bidentificar (?:de quem|titular|cliente do grupo)\b/.test(t);
}

function pareceExecucaoTecnica(v: unknown): boolean {
  const t = normalizarTexto(v);
  return /(subir|criar|publicar|ajustar|otimizar|pausar|ativar|desativar|alterar|corrigir|configurar|implementar|integrar|editar|produzir|refazer|analisar|investigar).{0,90}(campanh|anunci|conjunto|criativ|video|copy|crm|formulario|automacao|integracao|landing|pagina|pixel|gtm|site|conta meta|meta ads|google ads|tracking|tag|evento|api|webhook|metric)/.test(t)
    || /(campanh|anunci|conjunto|criativ|video|copy|crm|formulario|automacao|integracao|landing|pagina|pixel|gtm|site|conta meta|meta ads|google ads|tracking|tag|evento|api|webhook|metric).{0,90}(subir|criar|publicar|ajustar|otimizar|pausar|ativar|desativar|alterar|corrigir|configurar|implementar|integrar|editar|produzir|refazer|analisar|investigar)/.test(t)
    || /(produzir|criar|montar|analisar).{0,50}relatorio/.test(t);
}

function pareceComunicacao(v: unknown): boolean {
  const t = normalizarTexto(v);
  return /\b(responder|retornar|retorno|dar retorno|trazer retorno|cobrar|avisar|informar|confirmar|perguntar|acompanhar)\b/.test(t)
    || /\b(agendar|marcar|confirmar).{0,40}(reuniao|call|ligacao|horario|presenca)\b/.test(t)
    || /\b(coletar|pedir|solicitar).{0,70}(horario|foto|video|material|documento|acesso|permissao|aprovacao|decisao|feedback)\b/.test(t)
    || /\benviar.{0,70}(aprovacao|cliente|retorno|posicionamento)\b/.test(t);
}

type Destino = "CLICKUP" | "CENTRAL" | "IGNORE";
const TIPOS_CENTRAL = new Set(["RESPONDER", "COBRAR", "SOLICITAR", "AVISAR", "CONFIRMAR", "AGENDAR", "APROVAR_ENCAMINHAR", "ACOMPANHAR"]);

function resolverDestino(t: any): Destino {
  const texto = `${t?.titulo ?? ""} ${t?.descricao ?? ""} ${t?.tipo_demanda ?? ""}`;
  if (pareceExecucaoTecnica(texto)) return "CLICKUP";
  if (pareceComunicacao(texto)) return "CENTRAL";
  const ai = String(t?.destino ?? "").trim().toUpperCase();
  if (ai === "CLICKUP" || ai === "CENTRAL") return ai;
  return "IGNORE";
}

function tipoCentral(t: any): string {
  const ai = String(t?.tipo_demanda ?? "").trim().toUpperCase().replace(/[^A-Z_]/g, "_");
  if (TIPOS_CENTRAL.has(ai)) return ai;
  const x = normalizarTexto(`${t?.titulo ?? ""} ${t?.descricao ?? ""}`);
  if (/\bcobrar\b/.test(x)) return "COBRAR";
  if (/\b(agendar|marcar).{0,40}(reuniao|call|ligacao|horario)/.test(x)) return "AGENDAR";
  if (/\bconfirmar\b/.test(x)) return "CONFIRMAR";
  if (/\b(solicitar|pedir|coletar)\b/.test(x)) return "SOLICITAR";
  if (/\b(avisar|informar)\b/.test(x)) return "AVISAR";
  if (/\b(aprovacao|aprovar|encaminhar)\b/.test(x)) return "APROVAR_ENCAMINHAR";
  if (/\b(responder|retornar|retorno)\b/.test(x)) return "RESPONDER";
  return "ACOMPANHAR";
}

function tokensDaIntencao(v: unknown): string[] {
  return [...new Set(tokensSignificativos(v)
    .filter((t) => !TOKENS_ACAO_GENERICOS.has(t))
    .map((t) => t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t))];
}

function jaccard(a: string[], b: string[]): number {
  const aa = new Set(a);
  const bb = new Set(b);
  const uniao = new Set([...aa, ...bb]);
  if (!uniao.size) return 1;
  let inter = 0;
  for (const x of aa) if (bb.has(x)) inter++;
  return inter / uniao.size;
}

function duplicataIntraEvento(anterior: any, atual: any): boolean {
  if (anterior.destino !== atual.destino) return false;
  if (anterior.destino === "CENTRAL" && anterior.tipoCentral !== atual.tipoCentral) return false;
  const a = tokensDaIntencao(`${anterior.titulo} ${anterior.descricao ?? ""}`);
  const b = tokensDaIntencao(`${atual.titulo} ${atual.descricao ?? ""}`);
  if (!a.length && !b.length) return true;
  if (!a.length || !b.length) return false;
  const limiar = anterior.destino === "CENTRAL" ? 0.5 : 0.7;
  return jaccard(a, b) >= limiar;
}

async function sha256(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(String(v ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function prioridadeCentral(v: unknown): "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" {
  const p = normalizarTexto(v);
  if (p === "urgente" || p === "critica" || p === "critico") return "CRITICAL";
  if (p === "alta" || p === "alto") return "HIGH";
  if (p === "baixa" || p === "baixo") return "LOW";
  return "MEDIUM";
}

async function obterGrupo(chatId: unknown): Promise<{ chat_name: string | null }> {
  if (!chatId) return { chat_name: null };
  const { data } = await ops.from("whatsapp_group_registry").select("chat_name").eq("chat_id", String(chatId)).limit(1).maybeSingle();
  if (data?.chat_name) return { chat_name: String(data.chat_name) };
  const { data: msg } = await ops.from("whatsapp_messages").select("chat_name").eq("chat_id", String(chatId)).not("chat_name", "is", null).order("received_at", { ascending: false }).limit(1).maybeSingle();
  return { chat_name: msg?.chat_name ? String(msg.chat_name) : null };
}

function nomeEquipe(candidate: unknown, equipe: any[]): any | null {
  const alvo = normalizarTexto(candidate);
  if (!alvo) return null;
  return equipe.find((p) => normalizarTexto(p?.person) === alvo) ?? null;
}

function unicaPessoaDoRole(role: string | null, equipe: any[]): any | null {
  if (!role) return null;
  const matches = equipe.filter((p) => String(p?.role ?? "").toUpperCase() === role);
  return matches.length === 1 ? matches[0] : null;
}

async function resolverResponsavel(t: any, dossie: any, equipe: any[], clientId: unknown) {
  const role = roleDaArea(t?.area);
  const sugerido = nomeEquipe(t?.responsavel_sugerido, equipe);
  if (sugerido) return { role: String(sugerido.role || role || "").toUpperCase() || role, person: sugerido.person ?? null, clickup_user_id: sugerido.clickup_user_id ?? null, source: "ai_suggestion+team_identity_map" };

  if (role === "GT") {
    const gt = await resolverGtDoCliente(clientId);
    return { role, person: gt?.gt_owner ?? null, clickup_user_id: gt?.ok ? String(gt.clickup_user_id) : null, source: "clients.gt_owner+team_identity_map", ok: gt?.ok === true, reason: gt?.reason ?? null };
  }

  const owner = role === "CS" ? dossie?.cliente?.cs : role === "DESIGN" ? dossie?.cliente?.designer : null;
  const ownerTeam = nomeEquipe(owner, equipe);
  if (ownerTeam) return { role, person: ownerTeam.person ?? null, clickup_user_id: ownerTeam.clickup_user_id ?? null, source: `clients.${role === "CS" ? "cs_owner" : "designer_owner"}+team_identity_map` };

  const unica = unicaPessoaDoRole(role, equipe);
  if (unica && (role === "AI" || (role === "MGMT" && /gerente operacional|operacoes|operacao/.test(normalizarTexto(t?.area))))) {
    return { role, person: unica.person ?? null, clickup_user_id: unica.clickup_user_id ?? null, source: "single_role_owner" };
  }

  return { role, person: null, clickup_user_id: null, source: role ? "role_only" : "unresolved" };
}

function descricaoRastreavel(params: {
  descricao: string | null;
  grupo: string | null;
  chatId: unknown;
  messageId: unknown;
  evidencia: unknown;
  excerpt: unknown;
  centralType?: string | null;
}) {
  const origem = params.grupo || String(params.chatId || "grupo não identificado");
  const blocos = [
    params.descricao?.trim() || null,
    `Origem: leitura automática da IA no grupo “${origem}”.`,
    params.centralType ? `Tipo de demanda: ${params.centralType}.` : null,
    params.messageId ? `Mensagem/evento de referência: ${String(params.messageId)}.` : null,
    params.evidencia ? `Evidência literal detectada: ${String(params.evidencia)}` : null,
    "Contexto lido pela IA neste evento (sem complemento de informações externas):",
    String(params.excerpt ?? "").trim() || "[sem trecho disponível]",
    "Observação de rastreabilidade: esta demanda foi criada automaticamente pelo Task Engine. O contexto acima é o texto efetivamente presente no evento analisado; a IA não deve completar fatos ausentes.",
  ].filter(Boolean);
  return blocos.join("\n\n").slice(0, 12000);
}

async function encontrarDuplicataCentral(ev: any, atual: any): Promise<any | null> {
  if (!ev?.client_id) return null;
  const { data } = await ops.from("work_items")
    .select("id,title,status,metadata,created_at")
    .eq("client_id", ev.client_id)
    .in("status", ["OPEN", "IN_PROGRESS", "WAITING", "SNOOZED"])
    .order("created_at", { ascending: false })
    .limit(50);
  for (const row of data ?? []) {
    const rowType = String(row?.metadata?.central_type ?? "ACOMPANHAR");
    if (rowType !== atual.tipoCentral) continue;
    const candidato = { destino: "CENTRAL", tipoCentral: rowType, titulo: row.title, descricao: "" };
    if (duplicataIntraEvento(candidato, atual)) return row;
  }
  return null;
}

async function criarWorkItem(params: {
  ev: any;
  t: any;
  titulo: string;
  descricao: string | null;
  grupo: string | null;
  centralType: string;
  responsavel: any;
  generatedTaskId: unknown;
  sourceId: string;
  modelo: string;
}) {
  const dias = Number(params.t?.prazo_dias);
  const dueAt = Number.isFinite(dias) && dias > 0 ? new Date(Date.now() + dias * 86400000).toISOString() : null;
  const body = {
    client_id: params.ev.client_id ?? null,
    type: "CLIENT_FOLLOWUP",
    status: "OPEN",
    priority: prioridadeCentral(params.t?.prioridade),
    title: params.titulo,
    description: descricaoRastreavel({
      descricao: params.descricao,
      grupo: params.grupo,
      chatId: params.ev.chat_id,
      messageId: params.ev.message_id,
      evidencia: params.t?.evidencia,
      excerpt: params.ev.excerpt,
      centralType: params.centralType,
    }),
    source: "task_engine_ai",
    source_id: params.sourceId,
    created_by_user_key: "system:task-engine",
    created_by_person: "IA · Task Engine",
    target_role: params.responsavel?.role ?? null,
    target_person: params.responsavel?.person ?? null,
    due_at: dueAt,
    metadata: {
      ai_generated: true,
      source_event_id: params.ev.id,
      source_message_id: params.ev.message_id ?? null,
      source_chat_id: params.ev.chat_id ?? null,
      source_group_name: params.grupo,
      source_context: params.ev.excerpt ?? null,
      evidence: params.t?.evidencia ?? null,
      ai_reason: params.t?.motivo ?? null,
      central_type: params.centralType,
      destination: "CENTRAL",
      generated_task_id: params.generatedTaskId ?? null,
      model: params.modelo,
      validation_version: VALIDATION_VERSION,
      assignment_source: params.responsavel?.source ?? null,
    },
  };

  const { data, error } = await ops.from("work_items").insert(body).select("id").maybeSingle();
  if (!error && data?.id) return { id: data.id, existing: false };

  const { data: existing } = await ops.from("work_items").select("id").eq("source", "task_engine_ai").eq("source_id", params.sourceId).limit(1).maybeSingle();
  if (existing?.id) return { id: existing.id, existing: true };
  throw new Error(`work_item_create:${error?.message ?? "unknown"}`);
}

const SISTEMA = [
  "Voce e o motor operacional de uma agencia de trafego pago imobiliario.",
  "Recebe as mensagens de UMA conversa de grupo e um DOSSIE do cliente.",
  "Transforme SOMENTE pedidos, compromissos ou pendencias explicitamente executaveis das MENSAGENS em acoes operacionais.",
  "Responda APENAS JSON valido.",
  "",
  "REGRA DE ROTEAMENTO",
  "- CLICKUP = trabalho de execucao/producao/alteracao tecnica. Exemplos: subir/criar campanha; ajustar/otimizar/pausar/ativar campanha ou anuncio; criar/ajustar criativo ou video; configurar/corrigir CRM, formulario, automacao, integracao, landing page, site, pixel ou GTM; investigar problema tecnico; produzir analise/relatorio que exige trabalho.",
  "- CENTRAL = comunicacao, acompanhamento, cobranca, confirmacao, agendamento, solicitacao ou decisao humana. Exemplos: responder/dar retorno ao cliente; cobrar resposta; pedir material/foto/video/documento/acesso; enviar material para aprovacao; avisar que algo ficou pronto; perguntar qualidade dos leads; coletar horarios; confirmar reuniao; solicitar decisao/aprovacao.",
  "- IGNORAR = nao existe acao concreta. Saudacao, obrigado, ok, historico, status meramente informativo ou conversa sem pedido/compromisso.",
  "- A mesma mensagem pode gerar acoes diferentes em destinos diferentes. Ex.: 'ajuste a campanha e me de um retorno' = uma acao CLICKUP para ajustar + uma acao CENTRAL para retornar.",
  "",
  "REGRAS",
  "1. Uma acao por item. Nunca agrupe execucao tecnica e comunicacao no mesmo item.",
  "2. Nao crie item para conversa generica, elogio, saudacao, ok, obrigado, confirmacao simples, relatorio meramente informativo, status historico ou 'vou verificar' isolado.",
  "3. O DOSSIE serve apenas para enriquecer uma acao que JA ESTA explicita nas MENSAGENS. Nunca crie uma acao nova usando apenas o dossie, tasks_abertas, datas antigas, resumo ou contexto lateral.",
  "4. O TITULO e a DESCRICAO nao podem introduzir assunto, objeto, motivo ou qualificacao que nao esteja escrito nas MENSAGENS.",
  "5. Exemplo proibido: mensagem 'poderia dar um retorno?' -> titulo 'dar retorno sobre pagamento'. Se pagamento nao esta na mensagem, o titulo correto e apenas 'dar retorno'.",
  "6. Nunca gere acao humana para manutencao interna do sistema: triagem de grupo, titularidade, vinculo de cliente, rotulo, cadastro, reconciliacao ou classificacao.",
  "7. Se destino=CLICKUP e a mesma execucao ja aparece em tasks_abertas, marque duplicata_provavel=true. Uma task tecnica aberta no ClickUp NAO elimina uma acao CENTRAL de responder, avisar, cobrar ou acompanhar o cliente sobre aquele assunto.",
  "8. Para CENTRAL, evite repetir a mesma intencao de comunicacao dentro do mesmo evento; 'dar retorno' e 'trazer retorno' sobre a mesma intencao sao uma unica demanda.",
  "9. area: uma de Gestor de trafego | CS | Designer | Editor de video | IA/Automacao | Gerente operacional | Comercial.",
  "10. prioridade: Urgente | Alta | Media | Baixa. Campanha de imovel vendido que segue no ar e Urgente.",
  "11. evidencia deve ser um TRECHO LITERAL copiado das MENSAGENS recebidas neste evento. Nao use texto do dossie como evidencia e nao acrescente palavras ao trecho citado.",
  "12. Nunca invente fatos, acoes, responsaveis, prazos ou necessidades.",
  "13. responsavel_sugerido deve conter no maximo UMA pessoa. So escolha quando o dossie ou a propria mensagem indicar claramente o responsavel; se houver varias pessoas possiveis, deixe vazio.",
  "14. destino deve ser CLICKUP, CENTRAL ou IGNORAR.",
  "15. Se destino=CENTRAL, tipo_demanda deve ser RESPONDER | COBRAR | SOLICITAR | AVISAR | CONFIRMAR | AGENDAR | APROVAR_ENCAMINHAR | ACOMPANHAR.",
  "16. Se nao houver uma acao explicitamente pedida ou assumida nas MENSAGENS, responda {\"tasks\":[]}.",
  "",
  '{"tasks":[{"titulo":"","descricao":"","area":"","responsavel_sugerido":"",',
  '"prioridade":"","prazo_dias":0,"evidencia":"","duplicata_provavel":false,"motivo":"",',
  '"destino":"CLICKUP|CENTRAL|IGNORAR","tipo_demanda":""}]}',
].join("\n");

function parseJsonText(text: string): any {
  const limpo = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(limpo || "{}");
}

async function chamarOpenAI(chave: string, modelo: string, dossie: unknown, mensagens: string) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: modelo,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: `DOSSIE DO CLIENTE:\n${JSON.stringify(dossie, null, 1)}\n\nMENSAGENS DA CONVERSA:\n${mensagens}` },
      ],
    }),
  });
  const raw = await r.text();
  let j: any = null;
  try { j = raw ? JSON.parse(raw) : null; } catch { j = null; }
  if (!r.ok) throw new Error(`openai ${r.status}: ${raw.slice(0, 300)}`);
  return parseJsonText(j?.choices?.[0]?.message?.content || "{}");
}

async function chamarBackend(endpoint: string, readSecret: string, dossie: unknown, mensagens: string) {
  const prompt = `${SISTEMA}\n\nDOSSIE DO CLIENTE:\n${JSON.stringify(dossie, null, 1)}\n\nMENSAGENS DA CONVERSA:\n${mensagens}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-read-secret": readSecret },
      body: JSON.stringify({
        question: prompt,
        original_question: "Gerar e rotear demandas operacionais desta conversa",
        source: "TaskEngine",
        request_id: crypto.randomUUID(),
        constraints: { read_only: true, schema: "agency_ops", timezone: "America/Sao_Paulo", no_invention: true },
      }),
      signal: controller.signal,
    });
    const raw = await r.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    if (!r.ok) throw new Error(`ai_backend ${r.status}: ${raw.slice(0, 300)}`);
    const answer = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message]
      .find((v) => typeof v === "string" && v.trim());
    if (!answer) throw new Error("ai_backend empty_answer");
    return parseJsonText(answer);
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("health") === "1") {
    return json({
      ok: true,
      service: "agency-ops-task-engine",
      modo_padrao: "SHADOW",
      version: ENGINE_VERSION,
      validation_version: VALIDATION_VERSION,
      routing: "CLICKUP=execucao_tecnica; CENTRAL=comunicacao_followup; IGNORE=sem_acao",
      gt_routing: "clients.gt_owner+team_identity_map",
    });
  }

  const cronSecret = await segredo("TASK_ENGINE_CRON_SECRET");
  if (!cronSecret || req.headers.get("x-task-engine-key") !== cronSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const [chave, modeloSecret, endpoint, readSecret] = await Promise.all([
    segredo("OPENAI_API_KEY"),
    segredo("TASK_ENGINE_MODEL"),
    config("AI_ASK_ENDPOINT_URL"),
    config("AI_ASK_READ_SECRET"),
  ]);
  const provider = chave ? "OPENAI" : (endpoint && readSecret ? "OPSQUESTION_BACKEND" : null);
  if (!provider) {
    return json({ ok: false, error: "missing_ai_configuration", detail: "Sem OPENAI_API_KEY e sem backend AI alternativo configurado. Fila preservada." }, 428);
  }
  const modelo = chave ? (modeloSecret || "gpt-5-mini") : "opsquestion-backend";

  const modo = url.searchParams.get("modo") === "LIVE" ? "LIVE" : "SHADOW";
  const limite = Math.min(Math.max(Number(url.searchParams.get("limite") || 1), 1), 25);

  const agora = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  await ops.from("task_generation_events")
    .update({ status: "ERROR", last_error: "stale_processing_recovered", available_at: agora })
    .eq("status", "PROCESSING")
    .lt("locked_at", staleBefore);

  const { data: eventos, error: erroFila } = await ops.from("task_generation_events")
    .select("*").in("status", ["PENDING", "ERROR"]).lte("available_at", agora)
    .order("urgency", { ascending: true }).order("id", { ascending: true }).limit(limite);
  if (erroFila) return json({ ok: false, error: erroFila.message }, 500);
  if (!eventos?.length) return json({ ok: true, processados: 0, modo, provider, modelo, validation_version: VALIDATION_VERSION });

  const { data: equipe } = await ops.from("team_identity_map").select("person,role,clickup_user_id");
  const team = equipe ?? [];
  const resumo = {
    processados: 0,
    ignorados: 0,
    propostas: 0,
    duplicadas: 0,
    duplicadas_intraevento: 0,
    descartadas: 0,
    revisao_sistema: 0,
    bloqueadas_atribuicao: 0,
    enviadas_clickup: 0,
    enviadas_central: 0,
    erros: 0,
  };

  for (const ev of eventos) {
    await ops.from("task_generation_events")
      .update({ status: "PROCESSING", locked_at: new Date().toISOString(), attempt_count: (ev.attempt_count ?? 0) + 1 })
      .eq("id", ev.id);

    try {
      if (relatorioSomenteInformativo(ev)) {
        await ops.from("task_generation_events")
          .update({ status: "DONE", processed_at: new Date().toISOString(), last_error: null }).eq("id", ev.id);
        resumo.processados++;
        resumo.ignorados++;
        continue;
      }

      const [{ data: dossie }, grupo] = await Promise.all([
        ops.rpc("build_task_context", { p_client_id: ev.client_id, p_chat_id: ev.chat_id }),
        obterGrupo(ev.chat_id),
      ]);
      const saida = chave
        ? await chamarOpenAI(chave, modelo, dossie ?? {}, ev.excerpt || "")
        : await chamarBackend(endpoint!, readSecret!, dossie ?? {}, ev.excerpt || "");
      const propostas: any[] = Array.isArray(saida?.tasks) ? saida.tasks : [];
      const sourceHash = await sha256(ev.excerpt || "");
      const intencoesAceitas: any[] = [];

      for (const t of propostas) {
        if (!t?.titulo) continue;
        const titulo = String(t.titulo).slice(0, 250);
        const descricao = t.descricao == null ? null : String(t.descricao).slice(0, 4000);
        const destino = resolverDestino(t);
        const central = destino === "CENTRAL" ? tipoCentral(t) : null;
        const responsavel = await resolverResponsavel(t, dossie ?? {}, team, ev.client_id);
        const isTrafficTask = areaEhTrafego(t.area);
        const gtRouteOk = !isTrafficTask || (responsavel?.role === "GT" && responsavel?.person && responsavel?.clickup_user_id);

        const evidenceGrounded = evidenciaEstaNaMensagem(t.evidencia, ev.excerpt);
        const internalSystemTask = tarefaInternaDoSistema(titulo, descricao);
        const grounding = groundingConteudo(titulo, descricao, ev.excerpt);
        const unsupported = [...grounding.titleUnsupported, ...grounding.descUnsupported];
        const contentGrounded = unsupported.length === 0;
        const routingIgnored = destino === "IGNORE";
        const grounded = evidenceGrounded && contentGrounded && !internalSystemTask && !routingIgnored;
        const groundingReason = internalSystemTask
          ? "internal_system_task"
          : routingIgnored
            ? "routing_ignore"
            : !evidenceGrounded
              ? "evidence_not_in_current_event"
              : !contentGrounded
                ? `unsupported_context:${unsupported.slice(0, 8).join(",")}`
                : "accepted";

        const { data: norm } = await ops.rpc("normalize_task_subject", { p_nome: titulo });
        const tituloNorm = String(norm || titulo.toLowerCase());
        const atual = { destino, tipoCentral: central, titulo, descricao };
        const intraDup = grounded && intencoesAceitas.some((prev) => duplicataIntraEvento(prev, atual));

        let achou: any = null;
        let centralDup: any = null;
        if (grounded && !intraDup && destino === "CLICKUP") {
          const { data: dup } = await ops.rpc("find_duplicate_task", { p_client_id: ev.client_id, p_titulo: titulo });
          achou = Array.isArray(dup) ? dup[0] : dup;
        } else if (grounded && !intraDup && destino === "CENTRAL") {
          centralDup = await encontrarDuplicataCentral(ev, atual);
        }

        const duplicataIA = destino === "CLICKUP" && t.duplicata_provavel === true;
        const duplicada = grounded && (intraDup || Boolean(achou) || Boolean(centralDup) || duplicataIA);
        const descartada = !grounded;
        if (grounded && !duplicada) intencoesAceitas.push(atual);
        if (intraDup) resumo.duplicadas_intraevento++;

        if (internalSystemTask) {
          await ops.from("system_review_events").upsert({
            source_event_id: ev.id,
            client_id: ev.client_id,
            chat_id: ev.chat_id,
            proposed_title: titulo,
            proposed_title_norm: tituloNorm,
            proposed_description: descricao,
            reason: "internal_system_task",
            validation_version: VALIDATION_VERSION,
            source_excerpt_hash: sourceHash,
            payload: {
              message_id: ev.message_id,
              signals: ev.signals,
              ai_evidence: t.evidencia ?? null,
              ai_reason: t.motivo ?? null,
              provider,
              model: modelo,
              destination: destino,
            },
          }, { onConflict: "source_event_id,reason,proposed_title_norm", ignoreDuplicates: true });
          resumo.revisao_sistema++;
        }

        const prazoDias = Number(t.prazo_dias);
        const linha: Record<string, unknown> = {
          event_id: ev.id,
          client_id: ev.client_id,
          chat_id: ev.chat_id,
          titulo,
          titulo_norm: tituloNorm,
          descricao,
          area: t.area ?? null,
          responsavel_sugerido: responsavel?.person ?? t.responsavel_sugerido ?? null,
          resolved_assignee_person: responsavel?.person ?? null,
          resolved_clickup_user_id: responsavel?.clickup_user_id ? String(responsavel.clickup_user_id) : null,
          assignment_source: responsavel?.source ?? null,
          prioridade: t.prioridade ?? null,
          prazo_sugerido: Number.isFinite(prazoDias)
            ? new Date(Date.now() + prazoDias * 86400000).toISOString().slice(0, 10)
            : null,
          urgencia: ev.urgency,
          sinais: ev.signals,
          contexto: dossie ?? null,
          grounding_score: Number(grounding.score.toFixed(4)),
          grounding_reason: groundingReason,
          source_excerpt_hash: sourceHash,
          validation_version: VALIDATION_VERSION,
          destination: destino,
          central_type: central,
          evidencia: {
            trecho: t.evidencia ?? null,
            motivo: t.motivo ?? null,
            message_id: ev.message_id,
            chat_id: ev.chat_id,
            group_name: grupo.chat_name,
            source_context: ev.excerpt ?? null,
            provider,
            destination: destino,
            central_type: central,
            duplicata_provavel_ia: duplicataIA,
            duplicate_intra_event: intraDup,
            duplicate_work_item_id: centralDup?.id ?? null,
            grounded_in_current_event: evidenceGrounded,
            content_grounded_in_current_event: contentGrounded,
            unsupported_terms: unsupported,
            internal_system_task: internalSystemTask,
            discard_reason: descartada ? groundingReason : null,
            validation_version: VALIDATION_VERSION,
            assignment: {
              role: responsavel?.role ?? null,
              person: responsavel?.person ?? null,
              clickup_user_id: responsavel?.clickup_user_id ?? null,
              source: responsavel?.source ?? null,
              reason: responsavel?.reason ?? null,
            },
          },
          modelo,
          modo,
          status: descartada ? "DESCARTADA" : (duplicada ? "DUPLICADA" : "PROPOSTA"),
          similaridade: achou?.similaridade ?? null,
        };

        const { data: gravada, error: erroGravacao } = await ops.from("generated_tasks").insert(linha).select("id").maybeSingle();
        if (erroGravacao) throw new Error(`generated_task_insert:${erroGravacao.message}`);
        if (descartada) { resumo.descartadas++; continue; }
        if (duplicada) { resumo.duplicadas++; continue; }

        if (modo === "LIVE" && destino === "CLICKUP" && isTrafficTask && !gtRouteOk) {
          await ops.from("generated_tasks").update({
            status: "ERRO",
            erro: `gt_assignment_unresolved:${String(responsavel?.reason ?? "unknown")}`.slice(0, 500),
          }).eq("id", gravada?.id);
          resumo.bloqueadas_atribuicao++;
          continue;
        }

        resumo.propostas++;
        if (modo !== "LIVE") continue;

        const intentHash = (await sha256(`${ev.id}|${destino}|${central ?? ""}|${tituloNorm}|${normalizarTexto(t.evidencia)}`)).slice(0, 24);

        if (destino === "CENTRAL") {
          const sourceId = `task-event:${ev.id}:${intentHash}`;
          const wi = await criarWorkItem({
            ev,
            t,
            titulo,
            descricao,
            grupo: grupo.chat_name,
            centralType: central || "ACOMPANHAR",
            responsavel,
            generatedTaskId: gravada?.id,
            sourceId,
            modelo,
          });
          await ops.from("generated_tasks").update({ status: "CENTRAL", work_item_id: wi.id, erro: null }).eq("id", gravada?.id);
          resumo.enviadas_central++;
          continue;
        }

        if (destino === "CLICKUP") {
          const tokenCu = await segredo("CLICKUP_API_TOKEN");
          const lista = await segredo("TASK_ENGINE_CLICKUP_LIST");
          if (!tokenCu || !lista) {
            await ops.from("generated_tasks").update({ status: "ERRO", erro: "missing_clickup_configuration" }).eq("id", gravada?.id);
            continue;
          }

          const prio: Record<string, number> = { Urgente: 1, Alta: 2, Media: 3, "Média": 3, Baixa: 4 };
          const clickupBody: Record<string, unknown> = {
            name: titulo,
            description: descricaoRastreavel({
              descricao,
              grupo: grupo.chat_name,
              chatId: ev.chat_id,
              messageId: ev.message_id,
              evidencia: t.evidencia,
              excerpt: ev.excerpt,
            }),
            priority: prio[String(t.prioridade)] ?? 3,
          };
          const clickupAssignee = Number(responsavel?.clickup_user_id);
          if (Number.isFinite(clickupAssignee)) clickupBody.assignees = [clickupAssignee];

          const r = await fetch(`https://api.clickup.com/api/v2/list/${lista}/task`, {
            method: "POST",
            headers: { Authorization: tokenCu, "content-type": "application/json" },
            body: JSON.stringify(clickupBody),
          });
          const jr = await r.json().catch(() => ({}));
          await ops.from("generated_tasks").update(
            r.ok
              ? { status: "ENVIADA", clickup_task_id: jr?.id ?? null, sent_at: new Date().toISOString() }
              : { status: "ERRO", erro: JSON.stringify(jr).slice(0, 500) },
          ).eq("id", gravada?.id);
          if (r.ok) resumo.enviadas_clickup++;
        }
      }

      await ops.from("task_generation_events")
        .update({ status: "DONE", processed_at: new Date().toISOString(), last_error: null }).eq("id", ev.id);
      resumo.processados++;
    } catch (e) {
      resumo.erros++;
      await ops.from("task_generation_events")
        .update({ status: "ERROR", last_error: String(e).slice(0, 500), available_at: new Date(Date.now() + 300000).toISOString() })
        .eq("id", ev.id);
    }
  }

  return json({ ok: true, modo, provider, modelo, validation_version: VALIDATION_VERSION, ...resumo });
});
