import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const ops = db.schema("agency_ops");
const TZ = "America/Sao_Paulo";
const MAX_CANDIDATES = 12;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (v: unknown, n = 650) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const localDate = (v: any) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v));
const localDateTime = (v: any) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(v));
const minutesBetween = (a: any, b: any) => Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60000);

async function setting(name: string): Promise<string | null> {
  const { data, error } = await ops.from("automation_settings").select("value").eq("key", name).maybeSingle();
  if (error) return null;
  const v: any = data?.value;
  if (typeof v === "string") return v.trim() || null;
  if (v == null) return null;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const REQUEST_RE = /(precis|podem|poderia|consegue|quero|ajust|alter|trocar|nao chega|nao entra|sem lead|sem leads|erro|problema|retorno|previs|quando|subir|campanh|criativ|formular|whats|resultado|investid|metrica|demora|atras|funcion|qualidade|urgente|complicado|aparece|tem que|precisamos|focar|pode subir|como foram|o que e preciso)/;
const SEVERE_RE = /(nao entra|nao chega|sem lead|sem leads|erro|problema|urgente|complicado|parado|nao funciona|nao esta funcionando|nada)/;
const PROGRESS_RE = /(vou |vamos |iremos |irei |podemos enviar|assim que|solicitei|repass|vou pedir|irei solicitar|estamos resolvendo|faremos|ajustaremos|vamos ajustar|vamos subir|irei trazer|vamos trazer|vou enviar|iremos enviar|vou analisar|vou verificar|iremos fazer|esta resolvendo|estamos verificando)/;
const CLOSURE_RE = /(feito|feita|corrig|ajustad|alterad|subid|publicad|ativad|conectad|enviad|finalizad|resolvid|realizad|ja esta|ja foi|campanha .* no ar|numero conectado|segue o relatorio|segue a previa|segue os criativos|foi subido|foi alterado|foi corrigido|esta no ar|estao no ar)/;
const DEPENDENCY_RE = /(preencher|nos enviar|me enviar|pode enviar|precisamos de|aguardando|assim que receber|quando enviar|falta .* cliente|depende .* cliente|retorno de voces|pagamento|abastecimento|aprovar|aprovação)/;
const APPROVAL_RE = /(^| )(ok|obrigad|perfeito|show|boa|maravilha|aprovad|pode subir|valeu|deu certo|ficou bom|ficou certo)( |$)/;
const LINK_RE = /(https?:\/\/|drive\.google\.com)/;
const STOP = new Set(["para","com","sem","uma","umas","uns","que","quem","qual","quais","como","onde","quando","isso","essa","esse","esta","este","aqui","hoje","ontem","sobre","cliente","clientes","time","equipe","pessoal","agora","depois","antes","fazer","fazendo","feito","faremos","vamos","iremos","irei","vou","pedido","preciso","podem","poderia","consegue","quero","favor","obrigado","obrigada"]);
function tokens(v: unknown) { return [...new Set(norm(v).split(" ").filter((x) => x.length >= 4 && !STOP.has(x)))]; }
function topicOverlap(a: unknown, b: unknown) { const aa = new Set(tokens(a)), bb = new Set(tokens(b)); let n = 0; for (const x of aa) if (bb.has(x)) n++; return n; }

function inferArea(text: string) {
  const q = norm(text);
  if (/(criativ|arte|video|layout|logo|foto|design)/.test(q)) return "DESIGN";
  if (/(ia |inteligencia artificial|automacao|crm|dora|iara|webhook|make|integracao)/.test(q)) return "AI";
  if (/(campanh|meta|lead|cpl|segment|formulario|anuncio|publico|orcamento|resultado|investid|metrica)/.test(q)) return "GT";
  if (/(contrato|comercial|venda prometida|condicao comercial)/.test(q)) return "COMERCIAL";
  if (/(retorno|resposta|reuniao|ligar|call|agendar)/.test(q)) return "CS";
  return "CS";
}
function ownerFor(c: any, area: string) {
  if (area === "GT") return c.gt_owner || "";
  if (area === "CS") return c.cs_owner || "";
  if (area === "DESIGN") return c.designer_owner || "";
  return "";
}
function msgText(m: any) { return clip(m?.body || `[${m?.message_type || "mensagem"}]`, 240); }
function sameTopic(a: any, b: any) {
  const ov = topicOverlap(a?.body, b?.body);
  if (ov >= 1) return true;
  const x = norm(a?.body), y = norm(b?.body);
  const paired = [
    [/(telefone|whats|numero)/,/(telefone|whats|numero)/],
    [/(campanh|anuncio|meta)/,/(campanh|anuncio|meta)/],
    [/(criativ|arte|video)/,/(criativ|arte|video)/],
    [/(formulario)/,/(formulario)/],
    [/(relatorio|previa|resultado|investid|metrica)/,/(relatorio|previa|resultado|investid|metrica|lead|cpl)/],
    [/(crm|dora|iara|ia|automacao|integracao)/,/(crm|dora|iara|ia|automacao|integracao)/],
  ];
  return paired.some(([ra, rb]) => ra.test(x) && rb.test(y));
}

function matchingFutureDue(c: any, request: any, asOf: Date) {
  const items = [...(c.work_items || []), ...(c.clickup_tasks || [])];
  for (const x of items) {
    const due = x.due_at || x.due_date;
    if (!due || new Date(due) <= asOf) continue;
    const title = `${x.title || ""} ${x.name || ""} ${x.description || ""}`;
    if (topicOverlap(request?.body, title) >= 1) return due;
  }
  return null;
}

function classifyClient(c: any, asOf: Date) {
  const msgs = [...(c.whatsapp_messages || [])].sort((a, b) => new Date(a.event_at).getTime() - new Date(b.event_at).getTime());
  const clientActionable = msgs.filter((m: any) => !m.is_team && REQUEST_RE.test(norm(m.body)));
  const latestReq = clientActionable.at(-1);

  if (latestReq) {
    const later = msgs.filter((m: any) => new Date(m.event_at) > new Date(latestReq.event_at));
    const teamLater = later.filter((m: any) => m.is_team);
    const clientLater = later.filter((m: any) => !m.is_team);
    const closure = teamLater.find((m: any) => CLOSURE_RE.test(norm(m.body)) && (sameTopic(latestReq, m) || (LINK_RE.test(String(m.body || "")) && /segue|enviad|relatorio|previa|criativ/.test(norm(m.body)))));
    if (closure) {
      const approval = clientLater.find((m: any) => new Date(m.event_at) > new Date(closure.event_at) && APPROVAL_RE.test(norm(m.body)));
      return {
        kind: "NAO_COBRAR",
        reason: `O cliente pediu algo em ${localDateTime(latestReq.event_at)} e depois houve execução/entrega compatível em ${localDateTime(closure.event_at)}${approval ? `, seguida de confirmação positiva do cliente em ${localDateTime(approval.event_at)}` : ""}.`,
        confidence: "ALTA",
      };
    }

    const dependency = [...teamLater].reverse().find((m: any) => DEPENDENCY_RE.test(norm(m.body)) && (sameTopic(latestReq, m) || topicOverlap(latestReq.body, m.body) >= 1));
    if (dependency) {
      const responseAfterDependency = clientLater.find((m: any) => new Date(m.event_at) > new Date(dependency.event_at));
      if (!responseAfterDependency) {
        return { kind: "NAO_COBRAR", reason: `Existe dependência pedida ao cliente em ${localDateTime(dependency.event_at)} e não foi localizada resposta posterior dele dentro do corte.`, confidence: "ALTA" };
      }
    }

    const progress = [...teamLater].reverse().find((m: any) => PROGRESS_RE.test(norm(m.body)) && (sameTopic(latestReq, m) || topicOverlap(latestReq.body, m.body) >= 1 || /ajust|verificar|averiguar|repass|solicitei/.test(norm(m.body))));
    const area = inferArea(`${latestReq.body || ""} ${progress?.body || ""}`);
    const owner = ownerFor(c, area);
    const severe = SEVERE_RE.test(norm(latestReq.body));

    if (!teamLater.length) {
      const age = minutesBetween(latestReq.event_at, asOf);
      const level = (severe && age >= 20) || age >= 60 ? "COBRAR_AGORA" : "ACOMPANHAR_HOJE";
      return {
        kind: level,
        priority: severe ? "CRITICAL" : "HIGH",
        owner_area: area,
        owner_person: owner,
        context: `Em ${localDateTime(latestReq.event_at)}, o cliente escreveu: “${msgText(latestReq)}”. Até ${localDateTime(asOf)}, não foi localizada mensagem posterior da equipe no grupo.` ,
        situation: severe ? "Reclamação/pedido relevante do cliente ainda sem retorno posterior localizado." : "Solicitação recente do cliente ainda sem retorno posterior localizado.",
        charge_action: area === "GT" ? `Cobrar ${owner || "o GT responsável"} por um posicionamento objetivo e próximo passo sobre esse pedido.` : `Cobrar ${owner || "o responsável"} por retorno objetivo e fechamento desse pedido.`,
        confidence: "ALTA",
      };
    }

    if (progress) {
      const age = minutesBetween(progress.event_at, asOf);
      const futureDue = matchingFutureDue(c, latestReq, asOf);
      let threshold = severe ? 60 : 120;
      if (/agora/.test(norm(progress.body))) threshold = Math.min(threshold, 45);
      const level = futureDue ? "ACOMPANHAR_HOJE" : (age >= threshold ? "COBRAR_AGORA" : "ACOMPANHAR_HOJE");
      return {
        kind: level,
        priority: severe ? "CRITICAL" : "HIGH",
        owner_area: area,
        owner_person: owner,
        context: `Cliente: ${localDateTime(latestReq.event_at)} — “${msgText(latestReq)}”. Equipe: ${localDateTime(progress.event_at)} — “${msgText(progress)}”. Não foi localizada confirmação posterior de execução no mesmo assunto${futureDue ? `; há item relacionado com prazo futuro em ${localDateTime(futureDue)}` : ""}.`,
        situation: futureDue ? "Pedido reconhecido e em andamento dentro de prazo futuro registrado." : "Pedido reconhecido pela equipe, mas ainda sem evidência de fechamento no grupo.",
        charge_action: level === "COBRAR_AGORA" ? `Cobrar ${owner || "o responsável"} pela execução/retorno final desse pedido agora.` : `Acompanhar ${owner || "o responsável"} e garantir que o ajuste seja concluído e devolvido ao cliente no prazo.`,
        confidence: futureDue ? "ALTA" : "ALTA",
      };
    }

    const substantive = [...teamLater].reverse().find((m: any) => String(m.body || "").length >= 45 && sameTopic(latestReq, m));
    if (substantive) {
      return { kind: "NAO_COBRAR", reason: `O pedido do cliente em ${localDateTime(latestReq.event_at)} recebeu resposta posterior sobre o mesmo assunto em ${localDateTime(substantive.event_at)}; não há evidência suficiente para afirmar que ficou uma obrigação aberta.`, confidence: "MEDIA" };
    }

    const age = minutesBetween(latestReq.event_at, asOf);
    return {
      kind: age >= 90 ? "COBRAR_AGORA" : "ACOMPANHAR_HOJE",
      priority: severe ? "CRITICAL" : "HIGH",
      owner_area: area,
      owner_person: owner,
      context: `O cliente fez um pedido/reclamação em ${localDateTime(latestReq.event_at)}, houve atividade posterior da equipe, mas não foi localizada resposta claramente ligada ao mesmo assunto.` ,
      situation: "Há risco de o pedido ter ficado sem fechamento apesar de outras mensagens no grupo.",
      charge_action: `Cobrar ${owner || "o responsável"} para conferir o assunto e fechar o retorno ao cliente.`,
      confidence: "MEDIA",
    };
  }

  const overdueCommitment = (c.commitments || []).find((x: any) => x.confirmed_by_human && x.due_at && new Date(x.due_at) < asOf && ["OPEN","IN_PROGRESS"].includes(String(x.status)));
  if (overdueCommitment) {
    return {
      kind: "COBRAR_AGORA", priority: "HIGH", owner_area: "CS", owner_person: overdueCommitment.owner || c.cs_owner || "",
      context: `Existe compromisso humano confirmado e ainda aberto: “${clip(overdueCommitment.descricao, 280)}”, com prazo em ${localDateTime(overdueCommitment.due_at)}.`,
      situation: "Compromisso confirmado venceu sem registro de conclusão.",
      charge_action: `Cobrar ${overdueCommitment.owner || c.cs_owner || "o responsável"} pelo fechamento desse compromisso.`, confidence: "ALTA",
    };
  }

  const manualOverdue = (c.work_items || []).find((x: any) => x.due_at && new Date(x.due_at) < asOf && ["OPEN","IN_PROGRESS","WAITING"].includes(String(x.status)) && x.source !== "task_engine_ai");
  if (manualOverdue) {
    return {
      kind: "VERIFICAR_INTERNO", priority: "MEDIUM", owner_area: manualOverdue.target_role || "OPERACOES", owner_person: manualOverdue.target_person || "",
      context: `Há item manual interno vencido: “${clip(manualOverdue.title, 260)}”, prazo ${localDateTime(manualOverdue.due_at)}. Não existe sinal recente suficiente no WhatsApp para tratá-lo automaticamente como dívida ao cliente.`,
      situation: "Pendência interna a validar antes de cobrar alguém como atraso real perante o cliente.",
      charge_action: `Verificar com ${manualOverdue.target_person || "o responsável"} se o item continua aberto de fato e atualizar o status/evidência.`, confidence: "MEDIA",
    };
  }

  const oc = c.onboarding?.case;
  if (oc?.next_action_due && new Date(oc.next_action_due) < asOf && !/cliente/i.test(String(oc.blocked_by || ""))) {
    return {
      kind: "VERIFICAR_INTERNO", priority: "HIGH", owner_area: "CS", owner_person: c.cs_owner || "",
      context: `O onboarding registra próxima ação vencida em ${localDateTime(oc.next_action_due)}: “${clip(oc.next_action, 280)}”.`,
      situation: "Sinal de onboarding vencido; precisa de validação contra a conversa antes de virar cobrança formal.",
      charge_action: `Verificar com ${c.cs_owner || "o CS responsável"} se a próxima ação ainda está pendente e registrar o fechamento correto.`, confidence: "MEDIA",
    };
  }

  return { kind: "NAO_COBRAR", reason: "Os sinais existentes não sustentam uma cobrança atual da agência com segurança.", confidence: "ALTA" };
}

function buildAnalysis(ctx: any, asOf: Date) {
  const items: any[] = [], not_charge: any[] = [];
  for (const c of ctx.clients || []) {
    const r: any = classifyClient(c, asOf);
    if (r.kind === "NAO_COBRAR") {
      not_charge.push({ client_id: c.client_id, client_name: c.display_name, reason: r.reason, confidence: r.confidence, candidate_score: c.candidate_score || 0 });
    } else {
      items.push({ client_id: c.client_id, client_name: c.display_name, level: r.kind, priority: r.priority || "MEDIUM", owner_area: r.owner_area || "OPERACOES", owner_person: r.owner_person || "", context: r.context, situation: r.situation, charge_action: r.charge_action, confidence: r.confidence || "MEDIA", candidate_score: c.candidate_score || 0 });
    }
  }
  const order: any = { COBRAR_AGORA: 0, ACOMPANHAR_HOJE: 1, VERIFICAR_INTERNO: 2 };
  const prio: any = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  items.sort((a, b) => (order[a.level] - order[b.level]) || (prio[a.priority] - prio[b.priority]) || (b.candidate_score - a.candidate_score));
  not_charge.sort((a, b) => b.candidate_score - a.candidate_score);
  const red = items.filter((x) => x.level === "COBRAR_AGORA").length;
  const orange = items.filter((x) => x.level === "ACOMPANHAR_HOJE").length;
  return { items: items.slice(0, 8), not_charge: not_charge.slice(0, 5), manager_summary: red ? `${red} cliente(s) com cobrança imediata e ${orange} para acompanhamento.` : orange ? `${orange} cliente(s) para acompanhamento hoje; nenhuma cobrança imediata confirmada.` : "Nenhuma cobrança imediata confirmada neste corte." };
}

function format(slot: string, a: any, count: number) {
  const red = a.items.filter((x: any) => x.level === "COBRAR_AGORA"), orange = a.items.filter((x: any) => x.level === "ACOMPANHAR_HOJE"), verify = a.items.filter((x: any) => x.level === "VERIFICAR_INTERNO");
  const lines: string[] = [`🧭 *RADAR GERENCIAL — ${slot}*`, `_Cruzei WhatsApp + Central + compromissos + onboarding. ClickUp serve como contexto, nunca como prova isolada._`, `_Candidatos revisados: ${count}._`, ""];
  const sec = (title: string, rows: any[]) => { if (!rows.length) return; lines.push(title); rows.forEach((x: any, i: number) => { lines.push(`${i + 1}) *${x.client_name}* — ${[x.owner_person, x.owner_area].filter(Boolean).join(" · ") || x.owner_area}`); if (x.context) lines.push(`📌 ${x.context}`); if (x.situation) lines.push(`📍 Situação: ${x.situation}`); if (x.charge_action) lines.push(`🎯 Ação gerencial: ${x.charge_action}`); lines.push(`🔎 Confiança: ${String(x.confidence).toLowerCase()}`, ""); }); };
  sec(`🔴 *COBRAR AGORA (${red.length})*`, red);
  sec(`🟠 *ACOMPANHAR HOJE (${orange.length})*`, orange);
  sec(`⚪ *VERIFICAR INTERNAMENTE (${verify.length})*`, verify.slice(0, 2));
  if (a.not_charge.length) { lines.push(`✅ *FALSOS POSITIVOS / NÃO COBRAR (${a.not_charge.length})*`); a.not_charge.slice(0, 4).forEach((x: any) => lines.push(`• *${x.client_name}* — ${x.reason}`)); lines.push(""); }
  if (!a.items.length) lines.push("✅ *Nenhuma pendência real da agência foi confirmada neste corte.*", "");
  lines.push(`*Resumo:* ${a.manager_summary}`);
  return lines.join("\n").slice(0, 7600);
}

async function sha256(v: string) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("health") === "1") return json({ ok: true, service: "agency-ops-manager-attention-radar", version: 5, engine: "deterministic-temporal-v1", ai_required: false });
  if (req.method !== "POST" && req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);

  const expectedKey = await setting("MANAGER_RADAR_CRON_SECRET");
  const providedKey = req.headers.get("x-manager-radar-key") || url.searchParams.get("key");
  if (!expectedKey || providedKey !== expectedKey) return json({ ok: false, error: "unauthorized" }, 401);

  const slot = clip(url.searchParams.get("slot") || "manual", 40);
  const dryRun = url.searchParams.get("dry_run") === "1" || url.searchParams.get("validate") === "1";
  const asOfRaw = url.searchParams.get("as_of");
  const asOf = asOfRaw ? new Date(asOfRaw) : new Date();
  if (Number.isNaN(asOf.getTime())) return json({ ok: false, error: "invalid_as_of" }, 400);
  const runDate = localDate(asOf);

  const { data: ctx, error: ctxErr } = await ops.rpc("manager_attention_radar_context_v2", { p_as_of: asOf.toISOString(), p_limit: MAX_CANDIDATES });
  if (ctxErr) return json({ ok: false, error: `context:${ctxErr.message}` }, 500);
  const analysis = buildAnalysis(ctx || { clients: [] }, asOf);
  const summary = format(slot, analysis, Number(ctx?.candidate_count || 0));
  const fingerprint = await sha256(JSON.stringify(analysis.items.map((x: any) => [x.client_id, x.level, norm(x.charge_action)])));

  const { data: existing } = await ops.from("manager_attention_digest_runs").select("id,status,notification_id").eq("run_date", runDate).eq("slot", slot).maybeSingle();
  let runId = existing?.id || null;
  if (!runId) {
    const { data: inserted, error } = await ops.from("manager_attention_digest_runs").insert({ run_date: runDate, slot, status: "RUNNING", provider: "DETERMINISTIC_V5", fingerprint, context_stats: { candidate_count: Number(ctx?.candidate_count || 0), dry_run: dryRun } }).select("id").single();
    if (error) return json({ ok: false, error: `run_insert:${error.message}` }, 500);
    runId = inserted.id;
  } else {
    await ops.from("manager_attention_digest_runs").update({ status: "RUNNING", provider: "DETERMINISTIC_V5", fingerprint, error: null, skipped_reason: null, context_stats: { candidate_count: Number(ctx?.candidate_count || 0), dry_run: dryRun }, started_at: new Date().toISOString(), finished_at: null }).eq("id", runId);
  }

  if (url.searchParams.get("validate") === "1") {
    const { data: cases } = await ops.from("manager_attention_radar_validation_cases").select("case_key,client_id,expected,rationale").eq("active", true).order("id");
    const byId = new Map<string, string>();
    for (const x of analysis.items) byId.set(String(x.client_id), String(x.level));
    for (const x of analysis.not_charge) if (!byId.has(String(x.client_id))) byId.set(String(x.client_id), "NAO_COBRAR");
    const results = (cases || []).map((c: any) => { const actual = byId.get(String(c.client_id)) || "NAO_COBRAR"; return { case_key: c.case_key, expected: c.expected, actual, pass: actual === c.expected, rationale: c.rationale }; });
    const passed = results.filter((x: any) => x.pass).length;
    const failed = results.length - passed;
    await ops.from("manager_attention_digest_runs").update({ status: failed ? "ERROR" : "DONE", summary_text: summary, analysis: { ...analysis, validation: results }, context_stats: { candidate_count: Number(ctx?.candidate_count || 0), dry_run: true, validation_total: results.length, validation_passed: passed, validation_failed: failed }, error: failed ? `validation_failed:${failed}` : null, finished_at: new Date().toISOString() }).eq("id", runId);
    return json({ ok: failed === 0, validation: { total: results.length, passed, failed, results }, analysis, summary });
  }

  let notificationId: number | null = null;
  if (!dryRun) {
    const key = `manager-radar:${runDate}:${slot}`;
    const { data, error } = await ops.rpc("enqueue_notification", { p_notification_key: key, p_client_id: null, p_case_id: null, p_category: "MANAGER_RADAR", p_event_type: "MANAGER_ATTENTION_DIGEST", p_severity: analysis.items.some((x: any) => x.level === "COBRAR_AGORA") ? "HIGH" : "INFO", p_title: `Radar Gerencial ${slot}`, p_message: summary, p_destination_key: "OPS_INTERNAL", p_metadata: { slot, run_date: runDate, fingerprint, candidate_count: Number(ctx?.candidate_count || 0), engine: "deterministic-v5" } });
    if (error) {
      await ops.from("manager_attention_digest_runs").update({ status: "ERROR", summary_text: summary, analysis, error: `enqueue:${error.message}`, finished_at: new Date().toISOString() }).eq("id", runId);
      return json({ ok: false, error: `enqueue:${error.message}` }, 500);
    }
    notificationId = data == null ? null : Number(data);
  }

  await ops.from("manager_attention_digest_runs").update({ status: "DONE", summary_text: summary, analysis, notification_id: notificationId, delivery_status: dryRun ? "DRY_RUN" : (notificationId ? "QUEUED" : "DEDUPED"), finished_at: new Date().toISOString(), error: null }).eq("id", runId);
  return json({ ok: true, dry_run: dryRun, slot, run_id: runId, notification_id: notificationId, candidate_count: Number(ctx?.candidate_count || 0), analysis, summary });
});
