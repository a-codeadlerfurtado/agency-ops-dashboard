import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const ops = db.schema("agency_ops");
const TZ = "America/Sao_Paulo";
const MAX_CANDIDATES = 40;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (v: unknown, n = 650) => { const s = String(v ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n)}…` : s; };
const localDate = (v: any) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(v));
const localDateTime = (v: any) => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(v));
const minutes = (a: any, b: any) => Math.max(0, (new Date(b).getTime() - new Date(a).getTime()) / 60000);

async function setting(name: string): Promise<string | null> {
  const { data, error } = await ops.from("automation_settings").select("value").eq("key", name).maybeSingle();
  if (error) return null;
  const v: any = data?.value;
  if (typeof v === "string") return v.trim() || null;
  if (v == null) return null;
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

const SEVERE = /(nao entra|nao chega|nao vai|sem lead|sem leads|erro|problema|urgente|complicado|parado|nao funciona|nao esta funcionando|nada|perdendo tempo)/;
const PROGRESS = /(vou |vamos |iremos |irei |podemos enviar|assim que|solicitei|repass|vou pedir|irei solicitar|estamos resolvendo|faremos|ajustaremos|vamos ajustar|vamos subir|irei trazer|vamos trazer|vou enviar|iremos enviar|vou analisar|vou verificar|iremos fazer|esta resolvendo|estamos verificando|irei averiguar)/;
const CLOSED = /(feito|feita|corrig|ajustad|alterad|subid|publicad|ativad|conectad|enviad|finalizad|resolvid|realizad|cobrad|ja esta|ja foi|campanha .* no ar|numero conectado|segue o relatorio|segue a previa|segue os criativos|foi subido|foi alterado|foi corrigido|esta no ar|estao no ar)/;
const NEED_CLIENT = /(preencher|nos enviar|me enviar|pode enviar|precisamos de|aguardando|assim que receber|quando enviar|falta .* cliente|depende .* cliente|retorno de voces|pagamento|abastecimento|aprovar|aprovacao|poderia checar|poderia confirmar|consegue checar|consegue confirmar|confirma para mim|checar para mim)/;
const POSITIVE = /(^| )(ok|obrigad|perfeito|show|boa|maravilha|aprovad|pode subir|valeu|deu certo|ficou bom|ficou certo)( |$)/;
const LINK = /(https?:\/\/|drive\.google\.com)/;
const STOP = new Set(["para","com","sem","uma","umas","uns","que","quem","qual","quais","como","onde","quando","isso","essa","esse","esta","este","aqui","hoje","ontem","sobre","cliente","clientes","time","equipe","pessoal","agora","depois","antes","fazer","fazendo","feito","faremos","vamos","iremos","irei","vou","pedido","preciso","podem","poderia","consegue","quero","favor","obrigado","obrigada"]);
function toks(v: unknown) { return [...new Set(norm(v).split(" ").filter((x) => x.length >= 4 && !STOP.has(x)))]; }
function overlap(a: unknown, b: unknown) { const aa = new Set(toks(a)), bb = new Set(toks(b)); let n = 0; for (const x of aa) if (bb.has(x)) n++; return n; }
function actionable(m: any) {
  const raw = String(m?.body || "").trim(), q = norm(raw);
  if (q.length < 10 || /^precisando$/.test(q) || /trocar ideias|trocando ideias/.test(q)) return false;
  if (SEVERE.test(q)) return true;
  if (/\b(preciso|precisamos|podem|poderia|consegue|quero|tem que|pode subir|focar|ajustar|ajuste|alterar|trocar|vejam|me falem)\b/.test(q)) return true;
  if (/o que e preciso|de uma olhada|pra outras cidades ainda|para outras cidades ainda/.test(q)) return true;
  if (raw.includes("?") && /(campanh|meta|lead|formulario|criativ|whats|numero|crm|ia|resultado|saldo|cartao|relatorio|previa)/.test(q)) return true;
  if (/(resultado|investid|metrica|relatorio|previa)/.test(q) && /(passar|enviar|mandar|podem|consegue|preciso|vejam|me falem)/.test(q)) return true;
  return false;
}
function area(text: string) {
  const q = norm(text);
  if (/(criativ|arte|video|layout|logo|foto|design)/.test(q)) return "DESIGN";
  if (/(ia |inteligencia artificial|automacao|crm|dora|iara|webhook|make|integracao)/.test(q)) return "AI";
  if (/(campanh|meta|lead|cpl|segment|formulario|anuncio|publico|orcamento|resultado|investid|metrica|saldo|cartao|cobrar)/.test(q)) return "GT";
  if (/(contrato|comercial|condicao comercial)/.test(q)) return "COMERCIAL";
  return "CS";
}
function owner(c: any, a: string) { if (a === "GT") return c.gt_owner || ""; if (a === "CS") return c.cs_owner || ""; if (a === "DESIGN") return c.designer_owner || ""; return ""; }
function msg(m: any) { return clip(m?.body || `[${m?.message_type || "mensagem"}]`, 240); }
function sameTopic(a: any, b: any) {
  if (overlap(a?.body, b?.body) >= 1) return true;
  const x = norm(a?.body), y = norm(b?.body);
  const pairs = [[/(telefone|whats|numero)/,/(telefone|whats|numero)/],[/(campanh|anuncio|meta)/,/(campanh|anuncio|meta)/],[/(criativ|arte|video)/,/(criativ|arte|video)/],[/(formulario|cidade|segment)/,/(formulario|cidade|segment)/],[/(relatorio|previa|resultado|investid|metrica)/,/(relatorio|previa|resultado|investid|metrica|lead|cpl|campanh)/],[/(crm|dora|iara|ia|automacao|integracao)/,/(crm|dora|iara|ia|automacao|integracao|lead)/],[/(cobrar|cobranca|pagamento|saldo|cartao)/,/(cobrad|cobrar|pagamento|saldo|cartao|meta)/]];
  return pairs.some(([ra, rb]) => ra.test(x) && rb.test(y));
}
function futureDue(c: any, req: any, asOf: Date) {
  for (const x of [...(c.work_items || []), ...(c.clickup_tasks || [])]) {
    const due = x.due_at || x.due_date;
    if (!due || new Date(due) <= asOf) continue;
    if (overlap(req?.body, `${x.title || ""} ${x.name || ""} ${x.description || ""}`) >= 1) return due;
  }
  return null;
}

function classify(c: any, asOf: Date) {
  const messages = [...(c.whatsapp_messages || [])].sort((a, b) => new Date(a.event_at).getTime() - new Date(b.event_at).getTime());
  const req = messages.filter((m: any) => !m.is_team && actionable(m)).at(-1);
  if (req) {
    const later = messages.filter((m: any) => new Date(m.event_at) > new Date(req.event_at));
    const team = later.filter((m: any) => m.is_team), client = later.filter((m: any) => !m.is_team);
    const done = team.find((m: any) => CLOSED.test(norm(m.body)) && (sameTopic(req, m) || (LINK.test(String(m.body || "")) && /segue|enviad|relatorio|previa|criativ/.test(norm(m.body)))));
    if (done) {
      const approval = client.find((m: any) => new Date(m.event_at) > new Date(done.event_at) && POSITIVE.test(norm(m.body)));
      return { kind: "NAO_COBRAR", reason: `Pedido de ${localDateTime(req.event_at)} teve execução/entrega compatível em ${localDateTime(done.event_at)}${approval ? ` e confirmação positiva do cliente em ${localDateTime(approval.event_at)}` : ""}.`, confidence: "ALTA" };
    }
    const dependency = [...team].reverse().find((m: any) => NEED_CLIENT.test(norm(m.body)) && (sameTopic(req, m) || overlap(req.body, m.body) >= 1));
    if (dependency && !client.some((m: any) => new Date(m.event_at) > new Date(dependency.event_at))) return { kind: "NAO_COBRAR", reason: `O último avanço no assunto foi uma dependência pedida ao cliente em ${localDateTime(dependency.event_at)}, sem resposta posterior localizada.`, confidence: "ALTA" };

    const a = area(`${req.body || ""} ${team.map((x: any) => x.body || "").join(" ")}`), who = owner(c, a), severe = SEVERE.test(norm(req.body));
    if (!team.length) {
      const age = minutes(req.event_at, asOf), level = (severe && age >= 20) || age >= 60 ? "COBRAR_AGORA" : "ACOMPANHAR_HOJE";
      return { kind: level, priority: severe ? "CRITICAL" : "HIGH", owner_area: a, owner_person: who, context: `Em ${localDateTime(req.event_at)}, o cliente escreveu: “${msg(req)}”. Até ${localDateTime(asOf)}, não foi localizada mensagem posterior da equipe.`, situation: severe ? "Reclamação relevante ainda sem retorno posterior localizado." : "Solicitação recente ainda sem retorno posterior localizado.", charge_action: level === "COBRAR_AGORA" ? `Cobrar ${who || "o responsável"} por posicionamento e próximo passo agora.` : `Acompanhar ${who || "o responsável"} e garantir retorno dentro do dia.`, confidence: "ALTA" };
    }
    const progress = [...team].reverse().find((m: any) => PROGRESS.test(norm(m.body)) && (sameTopic(req, m) || /ajust|verificar|averiguar|repass|solicitei/.test(norm(m.body))));
    if (progress) {
      const due = futureDue(c, req, asOf), age = minutes(progress.event_at, asOf);
      let threshold = severe ? 60 : 120; if (/agora/.test(norm(progress.body))) threshold = Math.min(threshold, 45);
      const level = due ? "ACOMPANHAR_HOJE" : (age >= threshold ? "COBRAR_AGORA" : "ACOMPANHAR_HOJE");
      return { kind: level, priority: severe ? "CRITICAL" : "HIGH", owner_area: a, owner_person: who, context: `Cliente: ${localDateTime(req.event_at)} — “${msg(req)}”. Equipe: ${localDateTime(progress.event_at)} — “${msg(progress)}”. Não foi localizada confirmação posterior de execução no mesmo assunto${due ? `; há prazo futuro relacionado em ${localDateTime(due)}` : ""}.`, situation: due ? "Pedido reconhecido e em andamento dentro de prazo futuro." : "Pedido reconhecido, ainda sem evidência de fechamento.", charge_action: level === "COBRAR_AGORA" ? `Cobrar ${who || "o responsável"} pela execução/retorno final agora.` : `Acompanhar ${who || "o responsável"} até concluir e devolver ao cliente.`, confidence: "ALTA" };
    }
    const response = [...team].reverse().find((m: any) => String(m.body || "").length >= 35 && sameTopic(req, m));
    if (response) return { kind: "NAO_COBRAR", reason: `O pedido de ${localDateTime(req.event_at)} recebeu resposta substantiva sobre o mesmo assunto em ${localDateTime(response.event_at)}; não há prova suficiente de obrigação aberta.`, confidence: "ALTA" };
    const age = minutes(req.event_at, asOf), level = age >= 120 ? "COBRAR_AGORA" : "ACOMPANHAR_HOJE";
    return { kind: level, priority: severe ? "CRITICAL" : "HIGH", owner_area: a, owner_person: who, context: `Há pedido de ${localDateTime(req.event_at)} com atividade posterior no grupo, mas sem fechamento claramente ligado ao mesmo assunto.`, situation: "Risco de pedido sem fechamento.", charge_action: `${level === "COBRAR_AGORA" ? "Cobrar" : "Acompanhar"} ${who || "o responsável"} para conferir e fechar o retorno.`, confidence: "MEDIA" };
  }

  const cm = (c.commitments || []).find((x: any) => x.confirmed_by_human && x.due_at && new Date(x.due_at) < asOf && ["OPEN","IN_PROGRESS"].includes(String(x.status)));
  if (cm) return { kind: "COBRAR_AGORA", priority: "HIGH", owner_area: "CS", owner_person: cm.owner || c.cs_owner || "", context: `Compromisso humano confirmado ainda aberto: “${clip(cm.descricao, 280)}”, prazo ${localDateTime(cm.due_at)}.`, situation: "Compromisso confirmado vencido.", charge_action: `Cobrar ${cm.owner || c.cs_owner || "o responsável"} pelo fechamento.`, confidence: "ALTA" };
  const wi = (c.work_items || []).find((x: any) => x.due_at && new Date(x.due_at) < asOf && ["OPEN","IN_PROGRESS","WAITING"].includes(String(x.status)) && x.source !== "task_engine_ai");
  if (wi) return { kind: "VERIFICAR_INTERNO", priority: "MEDIUM", owner_area: wi.target_role || "OPERACOES", owner_person: wi.target_person || "", context: `Item manual interno vencido: “${clip(wi.title, 260)}”, prazo ${localDateTime(wi.due_at)}.`, situation: "Precisa de validação antes de virar cobrança perante o cliente.", charge_action: `Verificar com ${wi.target_person || "o responsável"} se continua aberto e atualizar evidência/status.`, confidence: "MEDIA" };
  const oc = c.onboarding?.case;
  if (oc?.next_action_due && new Date(oc.next_action_due) < asOf && !/cliente/i.test(String(oc.blocked_by || ""))) return { kind: "VERIFICAR_INTERNO", priority: "HIGH", owner_area: "CS", owner_person: c.cs_owner || "", context: `Onboarding registra próxima ação vencida em ${localDateTime(oc.next_action_due)}: “${clip(oc.next_action, 280)}”.`, situation: "Sinal de onboarding a validar contra a conversa.", charge_action: `Verificar com ${c.cs_owner || "o CS responsável"} se ainda está pendente.`, confidence: "MEDIA" };
  return { kind: "NAO_COBRAR", reason: "Os sinais existentes não sustentam cobrança atual da agência com segurança.", confidence: "ALTA" };
}

function analyze(ctx: any, asOf: Date) {
  const allItems: any[] = [], allNot: any[] = [];
  for (const c of ctx.clients || []) {
    const r: any = classify(c, asOf);
    if (r.kind === "NAO_COBRAR") allNot.push({ client_id: c.client_id, client_name: c.display_name, reason: r.reason, confidence: r.confidence, candidate_score: c.candidate_score || 0 });
    else allItems.push({ client_id: c.client_id, client_name: c.display_name, level: r.kind, priority: r.priority || "MEDIUM", owner_area: r.owner_area || "OPERACOES", owner_person: r.owner_person || "", context: r.context, situation: r.situation, charge_action: r.charge_action, confidence: r.confidence || "MEDIA", candidate_score: c.candidate_score || 0 });
  }
  const order: any = { COBRAR_AGORA: 0, ACOMPANHAR_HOJE: 1, VERIFICAR_INTERNO: 2 }, prio: any = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  allItems.sort((a, b) => (order[a.level] - order[b.level]) || (prio[a.priority] - prio[b.priority]) || (b.candidate_score - a.candidate_score)); allNot.sort((a, b) => b.candidate_score - a.candidate_score);
  const red = allItems.filter((x) => x.level === "COBRAR_AGORA").length, orange = allItems.filter((x) => x.level === "ACOMPANHAR_HOJE").length;
  return { allItems, allNot, items: allItems.slice(0, 8), not_charge: allNot.slice(0, 5), manager_summary: red ? `${red} cliente(s) com cobrança imediata e ${orange} para acompanhamento.` : orange ? `${orange} cliente(s) para acompanhamento hoje; nenhuma cobrança imediata confirmada.` : "Nenhuma cobrança imediata confirmada neste corte." };
}
function format(slot: string, a: any, count: number) {
  const red = a.items.filter((x: any) => x.level === "COBRAR_AGORA"), orange = a.items.filter((x: any) => x.level === "ACOMPANHAR_HOJE"), verify = a.items.filter((x: any) => x.level === "VERIFICAR_INTERNO");
  const lines: string[] = [`🧭 *RADAR GERENCIAL — ${slot}*`, `_Cruzei WhatsApp + Central + compromissos + onboarding. ClickUp serve como contexto, nunca como prova isolada._`, `_Candidatos revisados: ${count}._`, ""];
  const sec = (title: string, rows: any[]) => { if (!rows.length) return; lines.push(title); rows.forEach((x: any, i: number) => { lines.push(`${i + 1}) *${x.client_name}* — ${[x.owner_person, x.owner_area].filter(Boolean).join(" · ") || x.owner_area}`); if (x.context) lines.push(`📌 ${x.context}`); if (x.situation) lines.push(`📍 Situação: ${x.situation}`); if (x.charge_action) lines.push(`🎯 Ação gerencial: ${x.charge_action}`); lines.push(`🔎 Confiança: ${String(x.confidence).toLowerCase()}`, ""); }); };
  sec(`🔴 *COBRAR AGORA (${red.length})*`, red); sec(`🟠 *ACOMPANHAR HOJE (${orange.length})*`, orange); sec(`⚪ *VERIFICAR INTERNAMENTE (${verify.length})*`, verify.slice(0, 2));
  if (a.not_charge.length) { lines.push(`✅ *FALSOS POSITIVOS / NÃO COBRAR (${a.not_charge.length})*`); a.not_charge.slice(0, 4).forEach((x: any) => lines.push(`• *${x.client_name}* — ${x.reason}`)); lines.push(""); }
  if (!a.items.length) lines.push("✅ *Nenhuma pendência real da agência foi confirmada neste corte.*", ""); lines.push(`*Resumo:* ${a.manager_summary}`); return lines.join("\n").slice(0, 7600);
}
async function sha256(v: string) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)); return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""); }

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("health") === "1") return json({ ok: true, service: "agency-ops-manager-attention-radar", version: 7, engine: "deterministic-temporal-v3", ai_required: false, candidate_limit: MAX_CANDIDATES });
  if (req.method !== "POST" && req.method !== "GET") return json({ ok: false, error: "method_not_allowed" }, 405);
  const expected = await setting("MANAGER_RADAR_CRON_SECRET"), given = req.headers.get("x-manager-radar-key") || url.searchParams.get("key"); if (!expected || given !== expected) return json({ ok: false, error: "unauthorized" }, 401);
  const slot = clip(url.searchParams.get("slot") || "manual", 40), validating = url.searchParams.get("validate") === "1", dryRun = validating || url.searchParams.get("dry_run") === "1";
  const asOf = url.searchParams.get("as_of") ? new Date(url.searchParams.get("as_of")!) : new Date(); if (Number.isNaN(asOf.getTime())) return json({ ok: false, error: "invalid_as_of" }, 400);
  const runDate = localDate(asOf);
  const { data: ctx, error: ctxErr } = await ops.rpc("manager_attention_radar_context_v2", { p_as_of: asOf.toISOString(), p_limit: MAX_CANDIDATES }); if (ctxErr) return json({ ok: false, error: `context:${ctxErr.message}` }, 500);
  const a = analyze(ctx || { clients: [] }, asOf), summary = format(slot, a, Number(ctx?.candidate_count || 0)), fingerprint = await sha256(JSON.stringify(a.allItems.map((x: any) => [x.client_id, x.level, norm(x.charge_action)])));
  const storedAnalysis = { items: a.items, not_charge: a.not_charge, manager_summary: a.manager_summary };
  const { data: old } = await ops.from("manager_attention_digest_runs").select("id").eq("run_date", runDate).eq("slot", slot).maybeSingle(); let runId = old?.id || null;
  if (!runId) { const { data, error } = await ops.from("manager_attention_digest_runs").insert({ run_date: runDate, slot, status: "RUNNING", provider: "DETERMINISTIC_V7", fingerprint, context_stats: { candidate_count: Number(ctx?.candidate_count || 0), dry_run: dryRun } }).select("id").single(); if (error) return json({ ok: false, error: `run_insert:${error.message}` }, 500); runId = data.id; }
  else await ops.from("manager_attention_digest_runs").update({ status: "RUNNING", provider: "DETERMINISTIC_V7", fingerprint, error: null, context_stats: { candidate_count: Number(ctx?.candidate_count || 0), dry_run: dryRun }, started_at: new Date().toISOString(), finished_at: null }).eq("id", runId);

  if (validating) {
    const { data: cases } = await ops.from("manager_attention_radar_validation_cases").select("case_key,client_id,expected,rationale").eq("active", true).order("id");
    const actual = new Map<string, string>(); for (const x of a.allItems) actual.set(String(x.client_id), String(x.level)); for (const x of a.allNot) actual.set(String(x.client_id), "NAO_COBRAR");
    const results = (cases || []).map((c: any) => ({ case_key: c.case_key, expected: c.expected, actual: actual.get(String(c.client_id)) || "NOT_EVALUATED", pass: actual.get(String(c.client_id)) === c.expected, rationale: c.rationale }));
    const passed = results.filter((x: any) => x.pass).length, failed = results.length - passed;
    await ops.from("manager_attention_digest_runs").update({ status: failed ? "ERROR" : "DONE", summary_text: summary, analysis: { ...storedAnalysis, validation: results }, context_stats: { candidate_count: Number(ctx?.candidate_count || 0), dry_run: true, validation_total: results.length, validation_passed: passed, validation_failed: failed }, error: failed ? `validation_failed:${failed}` : null, finished_at: new Date().toISOString(), delivery_status: "DRY_RUN" }).eq("id", runId);
    return json({ ok: failed === 0, validation: { total: results.length, passed, failed, results }, analysis: storedAnalysis, summary });
  }

  let notificationId: number | null = null;
  if (!dryRun) {
    const { data, error } = await ops.rpc("enqueue_notification", { p_notification_key: `manager-radar:${runDate}:${slot}`, p_client_id: null, p_case_id: null, p_category: "MANAGER_RADAR", p_event_type: "MANAGER_ATTENTION_DIGEST", p_severity: a.allItems.some((x: any) => x.level === "COBRAR_AGORA") ? "HIGH" : "INFO", p_title: `Radar Gerencial ${slot}`, p_message: summary, p_destination_key: "OPS_INTERNAL", p_metadata: { slot, run_date: runDate, fingerprint, candidate_count: Number(ctx?.candidate_count || 0), engine: "deterministic-v7" } });
    if (error) { await ops.from("manager_attention_digest_runs").update({ status: "ERROR", summary_text: summary, analysis: storedAnalysis, error: `enqueue:${error.message}`, finished_at: new Date().toISOString() }).eq("id", runId); return json({ ok: false, error: `enqueue:${error.message}` }, 500); }
    notificationId = data == null ? null : Number(data);
  }
  await ops.from("manager_attention_digest_runs").update({ status: "DONE", summary_text: summary, analysis: storedAnalysis, notification_id: notificationId, delivery_status: dryRun ? "DRY_RUN" : (notificationId ? "QUEUED" : "DEDUPED"), finished_at: new Date().toISOString(), error: null }).eq("id", runId);
  return json({ ok: true, dry_run: dryRun, slot, run_id: runId, notification_id: notificationId, candidate_count: Number(ctx?.candidate_count || 0), analysis: storedAnalysis, summary });
});