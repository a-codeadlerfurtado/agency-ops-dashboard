import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type,authorization,apikey",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (value: unknown, max = 700) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const jsonText = (value: unknown) => { try { return JSON.stringify(value ?? ""); } catch { return String(value ?? ""); } };

type Evidence = { source: string; label: string; excerpt: string; weight: number };
type LoadRow = { person: string; clients: number; weighted_load: number; avg_health: number | null };

const GT_PROFILES: Record<string, { experience: number; hardClient: number; formal: number; relational: number; balanceBias: number; description: string }> = {
  "Felipe Oliveira": { experience: 100, hardClient: 100, formal: 78, relational: 94, balanceBias: -10, description: "mais experiente, técnico e desenrolado; reservado para clientes de maior complexidade quando necessário" },
  "Yuri Melo": { experience: 66, hardClient: 60, formal: 94, relational: 62, balanceBias: 8, description: "já domina o fluxo, comunica bem e tem perfil mais sério e contido com o cliente" },
  "Rodrigo Cavalheiro": { experience: 48, hardClient: 45, formal: 68, relational: 96, balanceBias: 12, description: "mais novo operacionalmente, porém muito desenrolado e forte no relacionamento" },
};

const SIGNALS: Array<{ label: string; terms: string[]; weight: number }> = [
  { label: "insatisfação/reclamação", terms: ["insatisfeit", "reclam", "decepcion", "nao gostei", "nao funciona"], weight: 16 },
  { label: "risco de cancelamento", terms: ["cancel", "rescind", "encerrar contrato", "sair da agencia"], weight: 20 },
  { label: "experiência ruim anterior", terms: ["outra agencia", "agencia anterior", "ja tive problema", "experiencia ruim"], weight: 11 },
  { label: "urgência elevada", terms: ["pra ontem", "urgente", "imediato", "o quanto antes", "resultado rapido"], weight: 8 },
  { label: "alta cobrança/acompanhamento", terms: ["todo dia", "diariamente", "acompanhar de perto", "cobranca", "cobrar", "retorno diario"], weight: 10 },
  { label: "muitas alterações/retrabalho", terms: ["muitas alter", "refazer", "mudar tudo", "trocar tudo", "varias mudancas"], weight: 10 },
  { label: "restrições fortes", terms: ["nao quero", "nao pode", "nao aceito", "de jeito nenhum", "proibido"], weight: 5 },
  { label: "expectativa/garantia agressiva", terms: ["garantia", "garantir resultado", "promessa de resultado", "vender rapido"], weight: 9 },
  { label: "conflito/discordância", terms: ["discord", "nao concordo", "problema com", "dificil de lidar", "exigente"], weight: 12 },
];

function containsAny(text: string, terms: string[]) { return terms.some((term) => text.includes(norm(term))); }
function scoreSignals(source: string, raw: unknown, multiplier = 1): { points: number; evidence: Evidence[] } {
  const original = clip(raw, 12000);
  const text = norm(original);
  if (!text) return { points: 0, evidence: [] };
  let points = 0;
  const evidence: Evidence[] = [];
  for (const signal of SIGNALS) {
    if (!containsAny(text, signal.terms)) continue;
    const weight = Math.round(signal.weight * multiplier);
    points += weight;
    evidence.push({ source, label: signal.label, excerpt: clip(original, 240), weight });
  }
  return { points, evidence };
}

function detectRelationship(clientMessages: any[], strongText: string) {
  const normalized = norm(strongText);
  let formal = 0, relational = 0, direct = 0;
  if (/(perfil formal|mais formal|serio|objetiv|diret|executiv|profissional)/.test(normalized)) formal += 5;
  if (/(expansiv|comunicativ|relacional|descontraid|informal|extrovert)/.test(normalized)) relational += 5;
  for (const row of clientMessages) {
    const raw = String(row.text_body || row.caption || "");
    const t = norm(raw);
    if (!t) continue;
    if (/\b(bom dia|boa tarde|boa noite|obrigad|por favor|perfeito|combinado)\b/.test(t)) formal += 1;
    if (/kkk|haha|rsrs|😂|🤣|😅|😊|😁|🚀|🔥|👏|🙌|❤️/.test(raw)) relational += 2;
    if (raw.length <= 90) direct += 1;
    if (raw.length >= 220) relational += 1;
  }
  if (clientMessages.length < 3 && formal < 5 && relational < 5) return { profile: "AINDA NÃO DETERMINADO", formal, relational, direct };
  if (formal >= relational + 3) return { profile: direct >= 3 ? "FORMAL / OBJETIVO" : "FORMAL / SÉRIO", formal, relational, direct };
  if (relational >= formal + 3) return { profile: "RELACIONAL / EXPANSIVO", formal, relational, direct };
  if (direct >= Math.max(3, clientMessages.length * .6)) return { profile: "OBJETIVO / DIRETO", formal, relational, direct };
  return { profile: "MISTO", formal, relational, direct };
}

function identifyTeam(row: any, identities: any[]) {
  const values = [norm(row.sender_phone), norm(row.sender_lid), norm(row.sender_name)].filter(Boolean);
  return identities.some((identity) => values.includes(norm(identity.identity_value)) || values.includes(norm(identity.canonical_name)));
}

async function loadSnapshot(ops: any, candidates: string[]): Promise<LoadRow[]> {
  const { data: clients } = await ops.from("clients").select("id,gt_owner,lifecycle").in("lifecycle", ["ACTIVE", "ONBOARDING"]).in("gt_owner", candidates);
  const ids = (clients ?? []).map((row: any) => row.id);
  let healthRows: any[] = [];
  if (ids.length) {
    const { data } = await ops.from("client_health_scores").select("client_id,date,score").in("client_id", ids).order("date", { ascending: false }).limit(1000);
    healthRows = data ?? [];
  }
  const latest = new Map<string, number>();
  for (const row of healthRows) if (!latest.has(String(row.client_id))) latest.set(String(row.client_id), Number(row.score));
  return candidates.map((person) => {
    const own = (clients ?? []).filter((row: any) => row.gt_owner === person);
    let weighted = 0, healthSum = 0, healthCount = 0;
    for (const row of own) {
      const score = latest.get(String(row.id));
      let weight = row.lifecycle === "ONBOARDING" ? 1.2 : 1;
      if (Number.isFinite(score)) {
        healthSum += Number(score); healthCount += 1;
        if (Number(score) < 40) weight += 1.5;
        else if (Number(score) < 60) weight += 1;
        else if (Number(score) < 75) weight += .5;
      }
      weighted += weight;
    }
    return { person, clients: own.length, weighted_load: Number(weighted.toFixed(1)), avg_health: healthCount ? Number((healthSum / healthCount).toFixed(1)) : null };
  });
}

async function buildRecommendation(ops: any, request: any, clientName: string, gtOptions: any[]) {
  const clientId = String(request.client_id);
  const candidates = gtOptions.map((row: any) => String(row.person)).filter((name: string) => GT_PROFILES[name]);
  const [formsR, briefsR, meetingsR, opsNotesR, campaignNotesR, groupsR, identitiesR] = await Promise.all([
    ops.from("form_responses").select("form_type,product_name,answers,submitted_at").eq("client_id", clientId).order("submitted_at", { ascending: false }).limit(12),
    ops.from("notion_briefing_pages").select("title,content_markdown,extracted_profile,notion_last_edited_at").eq("client_id", clientId).order("notion_last_edited_at", { ascending: false }).limit(4),
    ops.from("meeting_transcripts").select("source_file_name,meeting_started_at,summary,decisions,ai_signals,transcript_text,participants").eq("client_id", clientId).order("meeting_started_at", { ascending: false }).limit(6),
    ops.from("ops_notes").select("body,author_name,occurred_at").eq("client_id", clientId).order("occurred_at", { ascending: false }).limit(25),
    ops.from("campaign_notes").select("note,campaign_name,created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(25),
    ops.from("whatsapp_group_registry").select("chat_id,chat_name").eq("client_id", clientId),
    ops.from("whatsapp_team_identities").select("identity_type,identity_value,canonical_name,role").eq("active", true),
  ]);
  const forms = formsR.data ?? [], briefs = briefsR.data ?? [], meetings = meetingsR.data ?? [];
  const opsNotes = opsNotesR.data ?? [], campaignNotes = campaignNotesR.data ?? [], groups = groupsR.data ?? [], identities = identitiesR.data ?? [];
  let messages: any[] = [];
  const chatIds = groups.map((row: any) => String(row.chat_id)).filter(Boolean);
  if (chatIds.length) {
    const { data } = await ops.from("whatsapp_messages")
      .select("chat_id,sender_name,sender_phone,sender_lid,text_body,caption,event_at")
      .in("chat_id", chatIds).order("event_at", { ascending: false }).limit(180);
    messages = data ?? [];
  }
  const clientMessages = messages.filter((row: any) => !identifyTeam(row, identities));

  const formText = forms.map((row: any) => `${row.product_name || ""} ${jsonText(row.answers)}`).join("\n");
  const briefingText = briefs.map((row: any) => `${row.title || ""} ${row.content_markdown || ""} ${jsonText(row.extracted_profile)}`).join("\n");
  const meetingText = meetings.map((row: any) => `${row.summary || ""} ${jsonText(row.decisions)} ${jsonText(row.ai_signals)} ${row.transcript_text || ""}`).join("\n");
  const notesText = [...opsNotes.map((row: any) => row.body), ...campaignNotes.map((row: any) => row.note)].join("\n");
  const whatsappText = clientMessages.map((row: any) => row.text_body || row.caption || "").join("\n");

  let complexity = 22;
  const evidence: Evidence[] = [];
  const scored = [
    scoreSignals("REUNIÃO", meetingText, 1.15),
    scoreSignals("BRIEFING", briefingText, 1.0),
    scoreSignals("FORMULÁRIO", formText, .9),
    scoreSignals("WHATSAPP_CLIENTE", whatsappText, .85),
    scoreSignals("NOTAS_INTERNAS", notesText, .9),
  ];
  for (const item of scored) { complexity += item.points; evidence.push(...item.evidence); }
  const products = new Set(forms.map((row: any) => norm(row.product_name)).filter(Boolean));
  if (products.size >= 3) { complexity += 8; evidence.push({ source: "FORMULÁRIO", label: "múltiplos produtos", excerpt: `${products.size} produtos identificados nos formulários`, weight: 8 }); }
  if (clientMessages.length >= 35) { complexity += 5; evidence.push({ source: "WHATSAPP_CLIENTE", label: "alto volume inicial de interação", excerpt: `${clientMessages.length} mensagens externas recentes no(s) grupo(s)`, weight: 5 }); }
  const participantNames = new Set(clientMessages.map((row: any) => norm(row.sender_name || row.sender_phone)).filter(Boolean));
  if (participantNames.size >= 3) { complexity += 6; evidence.push({ source: "WHATSAPP_CLIENTE", label: "múltiplos decisores/interlocutores", excerpt: `${participantNames.size} interlocutores externos identificados`, weight: 6 }); }
  complexity = Math.max(0, Math.min(100, complexity));
  const complexityBand = complexity >= 72 ? "ALTA" : complexity >= 50 ? "MÉDIA" : complexity >= 32 ? "BAIXA" : "MUITO BAIXA";

  const strongText = `${briefingText}\n${meetingText}\n${formText}`;
  const relationship = detectRelationship(clientMessages, strongText);
  const sourceCoverage = {
    forms: forms.length,
    briefings: briefs.length,
    meeting_transcripts: meetings.length,
    client_whatsapp_messages: clientMessages.length,
    internal_notes: opsNotes.length + campaignNotes.length,
  };
  let confidence = 18;
  if (forms.length) confidence += 14;
  if (briefs.length) confidence += 18;
  if (meetings.length) confidence += 34;
  if (clientMessages.length >= 3) confidence += 18; else if (clientMessages.length) confidence += 7;
  if (opsNotes.length + campaignNotes.length) confidence += 8;
  confidence = Math.min(96, confidence);

  const loadSnapshot = await loadSnapshot(ops, candidates);
  const loads = loadSnapshot.map((row) => row.weighted_load);
  const minLoad = Math.min(...loads), maxLoad = Math.max(...loads);
  const scores = candidates.map((person) => {
    const profile = GT_PROFILES[person];
    const load = loadSnapshot.find((row) => row.person === person)?.weighted_load ?? maxLoad;
    const loadPenalty = maxLoad > minLoad ? ((load - minLoad) / (maxLoad - minLoad)) * 30 : 0;
    let score = 68 + profile.balanceBias - loadPenalty;
    if (complexity >= 72) score += person === "Felipe Oliveira" ? 34 : person === "Yuri Melo" ? 2 : -10;
    else if (complexity >= 50) score += person === "Felipe Oliveira" ? 10 : person === "Yuri Melo" ? 8 : 4;
    else score += person === "Felipe Oliveira" ? -10 : person === "Yuri Melo" ? 9 : 13;
    if (relationship.profile.startsWith("FORMAL")) score += person === "Yuri Melo" ? 14 : person === "Felipe Oliveira" ? 5 : 3;
    if (relationship.profile === "RELACIONAL / EXPANSIVO") score += person === "Rodrigo Cavalheiro" ? 14 : person === "Felipe Oliveira" ? 8 : 2;
    if (relationship.profile === "OBJETIVO / DIRETO") score += person === "Yuri Melo" ? 9 : person === "Felipe Oliveira" ? 6 : 5;
    score = Math.max(0, Math.min(100, Math.round(score)));
    return { person, score, weighted_load: load, clients: loadSnapshot.find((row) => row.person === person)?.clients ?? 0, profile: profile.description };
  }).sort((a, b) => b.score - a.score);

  const recommended = scores[0]?.person ?? null;
  const recommendedLoad = scores[0]?.weighted_load ?? 0;
  const why: string[] = [];
  if (complexity >= 72 && recommended === "Felipe Oliveira") why.push("A complexidade identificada supera a prioridade de equalização e justifica usar o GT mais experiente.");
  else if (recommended === "Rodrigo Cavalheiro") why.push("O cenário não exige Felipe e a equalização favorece Rodrigo, hoje com menor carga ponderada.");
  else if (recommended === "Yuri Melo") why.push("O cenário não exige Felipe e o perfil/experiência atual de Yuri oferece melhor aderência sem abandonar a equalização.");
  if (relationship.profile !== "AINDA NÃO DETERMINADO") why.push(`Perfil de relacionamento estimado: ${relationship.profile.toLowerCase()}.`);
  why.push(`Carga ponderada do recomendado: ${recommendedLoad.toFixed(1)}. Complexidade: ${complexityBand.toLowerCase()} (${complexity}/100).`);
  if (confidence < 55) why.push("Há pouca evidência disponível; trate a recomendação como provisória e use a leitura humana da reunião.");
  const rationale = why.join(" ");

  const payload = {
    request_id: request.id,
    client_id: clientId,
    recommended_gt: recommended,
    confidence,
    complexity_score: complexity,
    complexity_band: complexityBand,
    relationship_profile: relationship.profile,
    relationship_detail: relationship,
    gt_scores: scores,
    rationale,
    evidence: evidence.sort((a, b) => b.weight - a.weight).slice(0, 8),
    source_coverage: sourceCoverage,
    load_snapshot: loadSnapshot,
    engine_version: "gt-fit-v1.1",
    updated_at: new Date().toISOString(),
  };
  const { error } = await ops.from("onboarding_gt_recommendations").upsert(payload, { onConflict: "request_id" });
  if (error) throw new Error(`recommendation_persist_failed:${error.message}`);
  return { ...payload, client_name: clientName, decision_mode: "HUMAN_REQUIRED" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL"), serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return respond({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return respond({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return respond({ error: "unauthorized" }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person ?? null;
  if (!person || !(approvals ?? []).length) return respond({ error: "forbidden" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  const role = String(roster?.role ?? "");
  if (!(person === "Adler Furtado" || role === "CS")) return respond({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const requestId = String(body.request_id ?? "");
  const clientId = String(body.client_id ?? "");
  const force = body.force === true;
  if (!requestId || !clientId) return respond({ error: "missing_fields" }, 400);
  const { data: request } = await ops.from("onboarding_gt_assignment_requests").select("id,client_id,status,requested_at").eq("id", requestId).eq("client_id", clientId).maybeSingle();
  if (!request) return respond({ error: "request_not_found" }, 404);
  const { data: client } = await ops.from("clients").select("id,display_name").eq("id", clientId).maybeSingle();
  if (!client) return respond({ error: "client_not_found" }, 404);

  const { data: existing } = await ops.from("onboarding_gt_recommendations").select("*").eq("request_id", requestId).maybeSingle();
  if (existing && !force) {
    const age = Date.now() - new Date(existing.updated_at).getTime();
    if (age < 10 * 60_000) return respond({ ok: true, recommendation: { ...existing, client_name: client.display_name, decision_mode: "HUMAN_REQUIRED" }, cached: true });
  }

  const [{ data: walletRows }, { data: activeGts }] = await Promise.all([
    ops.from("wallet_registry").select("gt_owner,carteira,ordem").order("ordem"),
    ops.from("team_roster").select("person").eq("role", "GT").eq("is_former", false),
  ]);
  const active = new Set((activeGts ?? []).map((row: any) => String(row.person)));
  const gtOptions = (walletRows ?? []).filter((row: any) => active.has(String(row.gt_owner)) && GT_PROFILES[String(row.gt_owner)]).slice(0, 3);
  try {
    const recommendation = await buildRecommendation(ops, request, String(client.display_name ?? "Cliente"), gtOptions);
    return respond({ ok: true, recommendation, cached: false });
  } catch (error) {
    return respond({ error: "recommendation_failed", detail: error instanceof Error ? error.message : String(error) }, 500);
  }
});
