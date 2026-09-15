import { ops } from "./supabase.js";
import type { ClientRow } from "./permissions.js";

const clip = (value: unknown, max = 3000) => {
  const text = String(value ?? "").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const jsonClip = (value: unknown, max = 7000) => clip(JSON.stringify(value ?? null), max);
const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

function relevance(name: unknown, question: string) {
  const n = norm(name);
  const q = norm(question);
  if (!n || !q) return 0;
  if (q.includes(n)) return 1000 + n.length;
  const tokens = n.split(" ").filter((t) => t.length >= 4);
  return tokens.filter((t) => q.includes(t)).reduce((score, t) => score + t.length, 0);
}

/**
 * Contexto operacional e comercial do cliente para a IA.
 *
 * A ideia aqui e' diferente de simplesmente jogar o banco inteiro no prompt:
 * reunimos as fontes que realmente mudam uma decisao/copy e mantemos data + origem
 * para o modelo conseguir resolver conflitos. Instrucoes recentes do cliente no
 * WhatsApp/observacoes podem limitar O QUE deve aparecer na comunicacao sem apagar
 * o fato original que veio do formulario.
 */
export async function buildClientContext(client: ClientRow | null, question = "") {
  if (!client?.client_id) return null;
  const clientId = String(client.client_id);

  const [
    campaign,
    health,
    conversation,
    service,
    forms,
    briefings,
    campaignNotes,
    opsNotes,
    materials,
    metaInsights,
    groups,
    teamIdentities,
  ] = await Promise.all([
    ops.from("campaign_client_latest").select("*").eq("client_id", clientId).maybeSingle(),
    ops.from("client_health_scores").select("*").eq("client_id", clientId).order("date", { ascending: false }).limit(1).maybeSingle(),
    ops.from("conversation_state").select("*").eq("client_id", clientId).order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    ops.from("client_service_overview").select("*").eq("client_id", clientId).maybeSingle(),
    ops.from("form_responses").select("id,form_type,submitted_at,product_name,answers,match_confidence,updated_at").eq("client_id", clientId).order("submitted_at", { ascending: false }).limit(12),
    ops.from("notion_briefing_pages").select("notion_page_id,title,notion_last_edited_at,last_fetched_at,content_markdown,extracted_profile,match_confidence,sync_status").eq("client_id", clientId).order("notion_last_edited_at", { ascending: false }).limit(4),
    ops.from("campaign_notes").select("campaign_id,campaign_name,note,author_person,created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(25),
    ops.from("ops_notes").select("body,author_name,occurred_at,created_at,match_confidence").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(25),
    ops.from("client_raw_material_uploads").select("file_name,mime_type,file_kind,drive_uploaded_at,detected_at,source,metadata").eq("client_id", clientId).order("detected_at", { ascending: false }).limit(30),
    ops.from("meta_campaign_insights").select("campaign_id,campaign_name,campaign_status,objective,date_start,date_stop,spend,impressions,clicks,ctr,cpc,cpm,reach,frequency,leads_estimate,cost_per_lead_estimate,result_type,result_count,cost_per_result,checked_at").eq("client_id", clientId).order("checked_at", { ascending: false }).limit(30),
    ops.from("whatsapp_group_registry").select("chat_id,chat_name,group_kind").eq("client_id", clientId),
    ops.from("whatsapp_team_identities").select("identity_type,identity_value,canonical_name,role").eq("active", true),
  ]);

  const chatIds = (groups.data ?? []).map((row: any) => String(row.chat_id)).filter(Boolean);
  let whatsappRows: any[] = [];
  if (chatIds.length) {
    const { data } = await ops
      .from("whatsapp_messages")
      .select("chat_id,chat_name,sender_name,sender_phone,sender_lid,from_me,text_body,caption,event_at,message_type")
      .in("chat_id", chatIds)
      .order("event_at", { ascending: false })
      .limit(120);
    whatsappRows = data ?? [];
  }

  const identities = (teamIdentities.data ?? []).map((row: any) => ({
    type: norm(row.identity_type),
    value: norm(row.identity_value),
    canonicalName: row.canonical_name,
    role: row.role,
  }));

  const speaker = (row: any) => {
    const candidates = [
      { type: "phone", value: norm(row.sender_phone) },
      { type: "lid", value: norm(row.sender_lid) },
      { type: "name", value: norm(row.sender_name) },
    ].filter((x) => x.value);
    const hit = identities.find((id: any) => candidates.some((candidate) =>
      id.value === candidate.value || (id.type && candidate.type.includes(id.type) && id.value === candidate.value),
    ));
    return hit
      ? { kind: "TEAM", name: hit.canonicalName || row.sender_name || null, role: hit.role || null }
      : { kind: "CLIENT_OR_EXTERNAL", name: row.sender_name || null, role: null };
  };

  const formRows = (forms.data ?? [])
    .map((row: any) => ({
      source: "FORM",
      form_type: row.form_type,
      product_name: row.product_name,
      submitted_at: row.submitted_at,
      updated_at: row.updated_at,
      relevance: relevance(row.product_name, question),
      answers_json: jsonClip(row.answers, 9000),
      match_confidence: row.match_confidence,
    }))
    .sort((a: any, b: any) => b.relevance - a.relevance || String(b.submitted_at ?? "").localeCompare(String(a.submitted_at ?? "")));

  const briefingRows = (briefings.data ?? []).map((row: any) => ({
    source: "NOTION_BRIEFING",
    title: row.title,
    edited_at: row.notion_last_edited_at,
    fetched_at: row.last_fetched_at,
    sync_status: row.sync_status,
    match_confidence: row.match_confidence,
    extracted_profile_json: jsonClip(row.extracted_profile, 6000),
    content_markdown: clip(row.content_markdown, 12000),
  }));

  const whatsapp = whatsappRows
    .map((row: any) => {
      const who = speaker(row);
      return {
        source: "WHATSAPP",
        event_at: row.event_at,
        chat_name: row.chat_name,
        speaker_kind: who.kind,
        sender_name: who.name,
        sender_role: who.role,
        text: clip(row.text_body || row.caption, 1800),
        message_type: row.message_type,
      };
    })
    .filter((row: any) => row.text)
    .slice(0, 80);

  return {
    source_policy: {
      purpose: "Use este pacote para responder com fatos e restricoes reais do cliente. Nao invente nem complete lacunas.",
      precedence: [
        "1. Pedido atual do usuario nesta conversa.",
        "2. Instrucao explicita e recente do cliente em WhatsApp/campaign_notes/ops_notes sobre o que pode ou nao pode ser comunicado.",
        "3. Fatos estruturados de produto em formularios e briefing oficial.",
        "4. Dados de Meta para orientar angulo, desempenho e decisao — nunca para inventar caracteristica do produto.",
        "5. Historico antigo da conversa somente como continuidade, nunca acima de evidencia atual.",
      ],
      conflict_rule: "Uma instrucao recente como 'nao falar de entrada' NAO apaga o valor de entrada do formulario: o dado continua verdadeiro na fonte, mas deve ser OMITIDO da copy. Se duas fontes alterarem o proprio fato (ex.: dois precos diferentes) e nao houver instrucao inequivoca mais recente, sinalize o conflito em vez de escolher silenciosamente.",
    },
    overview: client,
    campaign_snapshot: campaign.data ?? null,
    health: health.data ?? null,
    conversation_state: conversation.data ?? null,
    services: service.data ?? null,
    product_forms: formRows,
    briefings: briefingRows,
    campaign_notes: (campaignNotes.data ?? []).map((row: any) => ({
      source: "CAMPAIGN_NOTE",
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name,
      created_at: row.created_at,
      author: row.author_person,
      note: clip(row.note, 2200),
      relevance: relevance(row.campaign_name, question),
    })).sort((a: any, b: any) => b.relevance - a.relevance || String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))),
    ops_notes: (opsNotes.data ?? []).map((row: any) => ({
      source: "OPS_NOTE",
      occurred_at: row.occurred_at || row.created_at,
      author: row.author_name,
      body: clip(row.body, 2200),
      match_confidence: row.match_confidence,
    })),
    recent_whatsapp: whatsapp,
    meta_campaigns: metaInsights.data ?? [],
    materials: (materials.data ?? []).map((row: any) => ({
      source: "RAW_MATERIAL",
      file_name: row.file_name,
      mime_type: row.mime_type,
      file_kind: row.file_kind,
      uploaded_at: row.drive_uploaded_at || row.detected_at,
      source_system: row.source,
      metadata_json: jsonClip(row.metadata, 1800),
    })),
    whatsapp_groups: groups.data ?? [],
  };
}

/**
 * Evidencia operacional do OpsQuestion, usada como fonte interna adicional.
 *
 * Ela e' AUXILIAR, nao pode bloquear o chat principal. As perguntas reconhecidas
 * pelo fast-path do OpsQuestion respondem rapidamente; se a rota precisar iniciar
 * outra investigacao longa, o chat segue sem esperar duas IAs em sequencia.
 */
export async function operationalEvidence(
  supabaseUrl: string,
  publishableKey: string,
  accessToken: string,
  question: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/agency-ops-ai-ask`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        apikey: publishableKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ question }),
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; answer?: string } | null;
    if (response.ok && body?.ok && body.answer) return String(body.answer);
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
