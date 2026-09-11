const api = process.env.ONBOARDING_API_URL;
const token = process.env.AGENCY_WORKER_TOKEN;
const worker = process.env.WORKER_ID || "leonardoimobi-onboarding-1";
const defaultIntervalMs = Number(process.env.ONBOARDING_DEFAULT_INTERVAL_MS || 900000);
const apiTimeoutMs = Number(process.env.API_TIMEOUT_MS || 90000);

if (!api || !token) {
  console.error("missing_onboarding_worker_configuration");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function call(action, payload = {}, timeoutMs = apiTimeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agency-worker-token": token },
      body: JSON.stringify({ action, worker, ...payload }),
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { raw: text }; }
    if (!response.ok) throw new Error(`onboarding_api_${response.status}:${JSON.stringify(body).slice(0, 1200)}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function fold(value) {
  return String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, " ").trim();
}

function bodyOf(message) {
  return `${message?.text_body ?? ""} ${message?.caption ?? ""}`.trim();
}

function eventDate(message) {
  const raw = message?.event_at || message?.received_at;
  const d = raw ? new Date(raw) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function earliest(messages, predicate) {
  return messages.filter(predicate).sort((a, b) => eventDate(a) - eventDate(b) || Number(a.id) - Number(b.id))[0] || null;
}

function latest(messages, predicate) {
  return messages.filter(predicate).sort((a, b) => eventDate(b) - eventDate(a) || Number(b.id) - Number(a.id))[0] || null;
}

function normalizePhone(value) { return String(value ?? "").replace(/\D/g, ""); }
function normalizeIdentity(value) { return fold(value).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }

function buildTeamMatcher(snapshot) {
  const phones = new Set();
  const names = new Set();
  for (const row of snapshot.team_identities || []) {
    if (row.identity_type === "PHONE") phones.add(normalizePhone(row.identity_value));
    if (row.identity_type === "NAME") names.add(normalizeIdentity(row.identity_value));
  }
  return (m) => Boolean(m?.from_me) || phones.has(normalizePhone(m?.sender_phone)) || names.has(normalizeIdentity(m?.sender_name));
}

function indicatesFormsNotUsed(text) {
  const t = fold(text);
  return /((nao vamos|nao iremos|nao utilizaremos|nao usaremos).{0,45}(formulario|formularios)|(formulario|formularios).{0,45}(nao sera usado|nao serao usados|nao sera utilizado|nao serao utilizados|nao vamos usar|nao iremos usar)|((dispensamos|dispensado|dispensada|sem necessidade de|vamos seguir sem).{0,45}(formulario|formularios)))/.test(t)
    && !/(nao vamos deixar de|nao iremos deixar de)/.test(t);
}

function indicatesFormsUsed(text) {
  const t = fold(text);
  return !indicatesFormsNotUsed(t)
    && /((vamos|iremos|vou|vai|vao).{0,35}(usar|utilizar|preencher|responder).{0,45}(formulario|formularios)|(formulario|formularios).{0,55}(vamos|iremos|vou|vai|vao).{0,30}(usar|utilizar|preencher|responder)|(utilizaremos|usaremos|preencheremos|responderemos).{0,40}(formulario|formularios))/.test(t);
}

function indicatesCampaignLive(text) {
  const t = fold(text);
  const positive = /(^|[^a-z])(ativamos|ativei|publicamos|publiquei)([^a-z]|$).{0,50}(campanha|campanhas)/.test(t)
    || /(campanha|campanhas).{0,50}(^|[^a-z])(ativamos|ativei|publicamos|publiquei)([^a-z]|$)/.test(t)
    || /(colocamos|coloquei).{0,30}(a |as )?(campanha|campanhas).{0,20}(no ar|para rodar)/.test(t)
    || /(campanha|campanhas).{0,20}(esta|estao|ficou|ficaram|foi|foram).{0,18}(no ar|rodando|ativada|ativadas|publicada|publicadas)/.test(t)
    || /(campanha|campanhas).{0,15}(no ar|rodando)/.test(t);
  if (!positive) return false;
  if (/(^|[^a-z])nao([^a-z]|$).{0,35}(ativ|public|no ar|rodando)/.test(t)) return false;
  if (/(aguard|assim que|depois que|quando|poderemos|para poder|para podermos|falta|pagamento|pix|abastecer).{0,80}(ativ|public|no ar|rodar)/.test(t)
      && !/(^|[^a-z])(ativamos|ativei|publicamos|publiquei)([^a-z]|$)/.test(t)) return false;
  return true;
}

function indicatesCampaignPrepared(text) {
  const t = fold(text);
  return !indicatesCampaignLive(t) && (
    /(campanha|campanhas).{0,70}(configurad|subindo|subida|pronta|prontas|preparad|montad|criad)/.test(t)
    || /(subindo|configurando|preparando|montando).{0,50}(campanha|campanhas)/.test(t)
    || /(campanha|campanhas).{0,100}(aguard|pagamento|pix|abastecer|ativar|ativacao)/.test(t)
  );
}

function onboardingEvidence(messages) {
  const pattern = /(meet\.google\.com|onboarding|reuniao de onboarding|reuniao de integracao|integracao|apresentar o projeto|apresentacao do projeto|formularios?|novo projeto)/;
  const hits = messages.filter((m) => m.origin !== "xlsx_historical_backfill" && pattern.test(fold(bodyOf(m))));
  if (!hits.length) return null;
  const types = new Set();
  for (const m of hits) {
    const t = fold(bodyOf(m));
    if (/meet\.google\.com/.test(t)) types.add("MEET_LINK");
    if (/onboarding/.test(t)) types.add("ONBOARDING_EXPLICITO");
    if (/integracao/.test(t)) types.add("INTEGRACAO");
    if (/formularios?/.test(t)) types.add("FORMULARIO");
    if (/(apresentar o projeto|apresentacao do projeto|novo projeto)/.test(t)) types.add("INICIO_PROJETO");
  }
  const first = hits.sort((a, b) => eventDate(a) - eventDate(b))[0];
  return { evidence_at: eventDate(first).toISOString(), evidence_types: [...types] };
}

function buildSyncCandidates(snapshot) {
  const messagesByChat = new Map();
  for (const m of snapshot.unassigned_messages || []) {
    const key = String(m.chat_id || "");
    if (!messagesByChat.has(key)) messagesByChat.set(key, []);
    messagesByChat.get(key).push(m);
  }
  const items = [];
  for (const chat of snapshot.unassigned_chats || []) {
    const name = String(chat.chat_name || "").trim();
    if (!name || /^\d+-group$/.test(name) || /duplicado/i.test(String(chat.reason || ""))) continue;
    const ev = onboardingEvidence(messagesByChat.get(String(chat.chat_id)) || []);
    if (ev) items.push({ chat_id: chat.chat_id, ...ev });
  }
  return items;
}

function buildEvidence(snapshot) {
  const teamSender = buildTeamMatcher(snapshot);
  const integrationsByClient = new Map();
  for (const i of snapshot.integrations || []) {
    const key = String(i.client_id);
    if (!integrationsByClient.has(key)) integrationsByClient.set(key, []);
    integrationsByClient.get(key).push(i);
  }
  const messagesByChat = new Map();
  for (const m of snapshot.case_messages || []) {
    const key = String(m.chat_id || "");
    if (!messagesByChat.has(key)) messagesByChat.set(key, []);
    messagesByChat.get(key).push(m);
  }
  const meetExisting = new Set((snapshot.meet_links || []).filter((x) => x.source === "whatsapp" && x.source_id).map((x) => String(x.source_id)));
  const notionByClient = new Map();
  for (const n of snapshot.notion_pages || []) {
    const key = String(n.client_id);
    if (!notionByClient.has(key)) notionByClient.set(key, []);
    notionByClient.get(key).push(n);
  }

  const actionMap = new Map();
  const forms = [];
  const meetLinks = [];
  const caseIds = [];
  let messagesScanned = 0;

  const addEarliest = (type, caseId, message, fallbackAt = null) => {
    const at = message ? eventDate(message) : new Date(fallbackAt || 0);
    const key = `${caseId}:${type}`;
    const existing = actionMap.get(key);
    if (!existing || new Date(existing.occurred_at) > at) {
      actionMap.set(key, {
        type, case_id: caseId, occurred_at: at.toISOString(),
        message_id: message?.id ?? null, body: message ? bodyOf(message) : "",
      });
    }
  };

  for (const c of snapshot.open_cases || []) {
    const caseId = Number(c.id);
    caseIds.push(caseId);
    const opened = new Date(c.opened_at).getTime();
    const integrations = integrationsByClient.get(String(c.client_id)) || [];
    const chatIds = new Set(integrations.map((i) => String(i.external_id)).filter(Boolean));
    const all = [...chatIds].flatMap((id) => messagesByChat.get(id) || []);
    const msgs = all.filter((m) => eventDate(m).getTime() >= opened);
    const replayMsgs = all.filter((m) => eventDate(m).getTime() >= opened - 15 * 60 * 1000);
    messagesScanned += msgs.length;

    if (integrations.length) addEarliest("OPERATIONAL_ACTIVATION_DONE", caseId, null, c.opened_at);

    const intro = earliest(msgs, (m) => {
      const t = fold(bodyOf(m));
      return /(onboarding|apresentacao do projeto|reuniao de apresentacao)/.test(t) && /(reuniao|meet\.google\.com|horario|\b\d{1,2}:\d{2}\b)/.test(t);
    });
    if (intro) addEarliest("INTRO_MEETING_SCHEDULED", caseId, intro);

    const pp = earliest(msgs, (m) => {
      const t = fold(bodyOf(m));
      return /reuniao/.test(t) && /(formulario|produto.{0,30}persona|persona.{0,30}produto)/.test(t)
        && /(meet\.google\.com|\b\d{1,2}:\d{2}\b|\b\d{1,2}h\b|horario|disponivel|marcar)/.test(t);
    });
    if (pp) addEarliest("PRODUCT_PERSONA_MEETING_SCHEDULED", caseId, pp);

    const integration = earliest(msgs, (m) => {
      const t = fold(bodyOf(m));
      return /integracao/.test(t) && /(meet\.google\.com|\b\d{1,2}:\d{2}\b|\b\d{1,2}h\b|segunda-feira|terca-feira|quarta-feira|quinta-feira|sexta-feira)/.test(t);
    });
    if (integration) addEarliest("INTEGRATION_MEETING_SCHEDULED", caseId, integration);

    const productForm = earliest(msgs, (m) => {
      const t = fold(bodyOf(m));
      return /(formulario de produto|produto.*formulario|formulario.*produto)/.test(t) && /(preenchido|respondido|concluido|finalizado|enviei|enviado)/.test(t);
    });
    if (productForm) addEarliest("PRODUCT_FORM_DONE", caseId, productForm);

    const personaForm = earliest(msgs, (m) => {
      const t = fold(bodyOf(m));
      return /(formulario de persona|persona.*formulario|formulario.*persona)/.test(t) && /(preenchido|respondido|concluido|finalizado|enviei|enviado)/.test(t);
    });
    if (personaForm) addEarliest("PERSONA_FORM_DONE", caseId, personaForm);

    const formEvidence = [];
    for (const m of msgs) {
      const text = bodyOf(m);
      if (indicatesFormsNotUsed(text) || indicatesFormsUsed(text)) {
        formEvidence.push({
          applicability: indicatesFormsNotUsed(text) ? "NOT_APPLICABLE" : "REQUIRED",
          source: "WHATSAPP", source_ref: String(m.id), evidence_text: text.slice(0, 2000),
          occurred_at: eventDate(m).toISOString(), priority: 2,
        });
      }
    }
    for (const n of notionByClient.get(String(c.client_id)) || []) {
      const text = `${n.content_markdown || ""} ${JSON.stringify(n.extracted_profile || {})}`;
      if (indicatesFormsNotUsed(text) || indicatesFormsUsed(text)) {
        formEvidence.push({
          applicability: indicatesFormsNotUsed(text) ? "NOT_APPLICABLE" : "REQUIRED",
          source: "NOTION", source_ref: String(n.notion_page_id), evidence_text: text.slice(0, 2000),
          occurred_at: new Date(n.notion_last_edited_at || n.updated_at).toISOString(), priority: 1,
        });
      }
    }
    formEvidence.sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at) || b.priority - a.priority);
    if (formEvidence[0]) forms.push({ case_id: caseId, ...formEvidence[0], confidence: formEvidence[0].source === "WHATSAPP" ? 0.95 : 0.90 });

    const rawAssets = earliest(msgs, (m) => /((materiais|arquivos|fotos|videos).*(enviei|enviamos|mandei|mandamos|coloquei|colocamos|adicionei|adicionamos)|(drive|pasta).*(materiais|arquivos|fotos|videos).*(enviados|adicionados|disponiveis))/.test(fold(bodyOf(m))));
    if (rawAssets) addEarliest("RAW_ASSETS_DONE", caseId, rawAssets);

    const access = earliest(msgs, (m) => {
      const t = fold(bodyOf(m));
      return /(acesso|acessos|bm|gerenciador|crm|conta de anuncio)/.test(t) && /(liberado|concedido|validado|configurado|conectado|funcionando|com os acessos|acessos aqui|consigo realizar)/.test(t);
    });
    if (access) addEarliest("ACCESS_VALIDATION_DONE", caseId, access);

    const creativeStart = earliest(msgs, (m) => /((criativo|criativos|arte|artes).*(producao|produzindo|iniciamos|fazendo))/.test(fold(bodyOf(m))));
    if (creativeStart) addEarliest("CREATIVE_PRODUCTION_STARTED", caseId, creativeStart);

    const creativeDone = earliest(msgs, (m) => {
      const t = fold(bodyOf(m));
      return /(criativo|criativos|arte|artes)/.test(t) && /(para aprovacao|segue|seguem|drive\.google|pronto|prontos|finalizad|concluid|entregue)/.test(t)
        && !/(assim que|quando.*pront|vou pedir|iremos produzir)/.test(t);
    });
    if (creativeDone) addEarliest("CREATIVE_PRODUCTION_DONE", caseId, creativeDone);

    const creativeApproval = earliest(msgs, (m) => {
      const t = fold(bodyOf(m));
      if (/((criativo|criativos|arte|artes).*(aprovado|aprovados|aprovada)|aprovado.*(criativo|arte))/.test(t)) return true;
      if (!/^(todos )?aprovad[oa]s?(\W|$)/.test(t) || teamSender(m)) return false;
      const mt = eventDate(m).getTime();
      return msgs.some((prev) => String(prev.chat_id) === String(m.chat_id)
        && eventDate(prev).getTime() <= mt && eventDate(prev).getTime() >= mt - 24 * 3600 * 1000
        && /(criativo|criativos|arte|artes).*(aprovacao|aprovar)/.test(fold(bodyOf(prev))));
    });
    if (creativeApproval) addEarliest("CREATIVE_APPROVAL_DONE", caseId, creativeApproval);

    const live = latest(msgs, (m) => indicatesCampaignLive(bodyOf(m)));
    const prepared = latest(msgs, (m) => indicatesCampaignPrepared(bodyOf(m)));
    if (live) {
      actionMap.set(`${caseId}:CAMPAIGN_LIVE`, { type: "CAMPAIGN_LIVE", case_id: caseId, occurred_at: eventDate(live).toISOString(), message_id: live.id, body: bodyOf(live) });
    } else if (prepared) {
      const blocked = /(aguard|pagamento|pix|abastecer|assim que.*ativ|poderemos ativ)/.test(fold(bodyOf(prepared)));
      const type = blocked ? "CAMPAIGN_PREPARED_BLOCKED" : "CAMPAIGN_PREPARED";
      actionMap.set(`${caseId}:${type}`, { type, case_id: caseId, occurred_at: eventDate(prepared).toISOString(), message_id: prepared.id, body: bodyOf(prepared) });
    }

    const stageLatest = new Map();
    for (const m of replayMsgs) {
      const t = fold(bodyOf(m));
      if (!/meet\.google\.com/.test(t)) continue;
      let stage = null;
      if (/(integracao|reuniao de integracao|reuniao com gt)/.test(t)) stage = "INTEGRATION_MEETING";
      else if (/(produto.{0,30}persona|persona.{0,30}produto|reuniao.{0,40}(produto|persona)|formulario.{0,30}(produto|persona))/.test(t)) stage = "PRODUCT_PERSONA_MEETING";
      else if (/(onboarding|apresentacao do projeto|reuniao de apresentacao)/.test(t)) stage = "INTRO_MEETING";
      if (!stage || meetExisting.has(String(m.id))) continue;
      const prev = stageLatest.get(stage);
      if (!prev || eventDate(m) > eventDate(prev)) stageLatest.set(stage, m);
    }
    for (const [stage, m] of stageLatest.entries()) {
      meetLinks.push({
        case_id: caseId, stage_code: stage, message_row_id: String(m.id), message_id: m.message_id,
        chat_id: m.chat_id, msg_at: eventDate(m).toISOString(), body: bodyOf(m),
      });
    }
  }

  const actions = [...actionMap.values()];
  const actionCounts = {};
  for (const a of actions) actionCounts[a.type] = (actionCounts[a.type] || 0) + 1;
  return {
    actions, forms, meetLinks, caseIds,
    stats: { open_cases: caseIds.length, messages_scanned: messagesScanned, actions: actions.length, forms: forms.length, meet_links: meetLinks.length, action_counts: actionCounts },
  };
}

async function runCycle(forcedMode = null) {
  const startedAt = new Date().toISOString();
  let snapshot = await call("snapshot");
  const mode = forcedMode || snapshot.control?.mode || "off";
  const intervalMs = Number(snapshot.control?.interval_ms || defaultIntervalMs);
  if (mode === "off") return { mode, intervalMs, skipped: true };

  let syncItems = buildSyncCandidates(snapshot);
  let evidence = buildEvidence(snapshot);

  if (mode === "shadow") {
    const result = {
      snapshot_at: snapshot.snapshot_at,
      sync_candidates: syncItems.length,
      unassigned_chats: (snapshot.unassigned_chats || []).length,
      unassigned_messages: (snapshot.unassigned_messages || []).length,
      ...evidence.stats,
    };
    await call("report", { mode, status: "ok", started_at: startedAt, result });
    console.log(JSON.stringify({ event: "onboarding_shadow", ...result }));
    return { mode, intervalMs, result };
  }

  if (mode === "execute") {
    let syncResult = null;
    if (syncItems.length) {
      syncResult = await call("apply_sync", { items: syncItems });
      snapshot = await call("snapshot");
      syncItems = buildSyncCandidates(snapshot);
      evidence = buildEvidence(snapshot);
    }
    const applyResult = await call("apply_evidence", {
      snapshot_at: snapshot.snapshot_at,
      actions: evidence.actions,
      meet_links: evidence.meetLinks,
      forms: evidence.forms,
      case_ids: evidence.caseIds,
    });
    const result = {
      snapshot_at: snapshot.snapshot_at,
      remaining_sync_candidates: syncItems.length,
      ...evidence.stats,
      sync_result: syncResult?.result ?? null,
      apply_result: applyResult?.result ?? null,
    };
    await call("report", { mode, status: "ok", started_at: startedAt, result });
    console.log(JSON.stringify({ event: "onboarding_execute", ...result }));
    return { mode, intervalMs, result };
  }

  throw new Error(`unsupported_onboarding_mode:${mode}`);
}

async function main() {
  console.log(JSON.stringify({ event: "onboarding_worker_started", worker, default_interval_ms: defaultIntervalMs }));
  let intervalMs = defaultIntervalMs;
  while (!stopping) {
    const started = Date.now();
    try {
      const result = await runCycle();
      intervalMs = Number(result.intervalMs || defaultIntervalMs);
    } catch (error) {
      const message = String(error?.message || error);
      console.error(JSON.stringify({ event: "onboarding_loop_error", error: message }));
      await call("report", { mode: "unknown", status: "error", started_at: new Date(started).toISOString(), result: {}, error: message }).catch(() => {});
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(15000, intervalMs - elapsed));
  }
  console.log(JSON.stringify({ event: "onboarding_worker_stopped", worker }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
