import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TOKEN_SHA256 = "48a435ee5c28bb73b44aeacfb8308da0f115979eda14ec9616fce4f493a5515a";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authorized(req: Request) {
  const token = req.headers.get("x-agency-worker-token") ?? "";
  if (!token || token.length < 32) return false;
  return (await sha256Hex(token)) === TOKEN_SHA256;
}

function client(schema: string) {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    db: { schema },
  });
}

async function rpc(name: string, args: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "apikey": SERVICE_ROLE_KEY,
      "authorization": `Bearer ${SERVICE_ROLE_KEY}`,
      "accept-profile": "agency_ops",
      "content-profile": "agency_ops",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`rpc_${name}_${res.status}:${typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500)}`);
  return data;
}

function normalizeConfig(data: Record<string, unknown>) {
  return {
    janela_dias: data.janela_dias,
    janela_hora_inicio: String(data.janela_hora_inicio ?? "").slice(0, 5),
    janela_hora_fim: String(data.janela_hora_fim ?? "").slice(0, 5),
    fuso: data.fuso,
    limite_1_min: data.limite_1_min,
    intervalo_repeticao_min: data.intervalo_repeticao_min,
    limite_escalada_min: data.limite_escalada_min,
    janela_follow_up_horas: data.janela_follow_up_horas,
    follow_up_max_repeticoes: data.follow_up_max_repeticoes,
    numero_sdr: data.numero_sdr,
    numero_gestor: data.numero_gestor,
  };
}

function normTs(value: unknown) {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function sameBefore(current: Record<string, unknown>, before: Record<string, unknown>) {
  return String(current.status ?? "") === String(before.status ?? "")
    && normTs(current.pendente_desde) === normTs(before.pendente_desde)
    && Number(current.nivel_alerta ?? 0) === Number(before.nivel_alerta ?? 0)
    && normTs(current.ultimo_alerta_em) === normTs(before.ultimo_alerta_em);
}

function nome(tel: string, nomes: Record<string, string>) { return nomes[tel] ?? tel; }

function linha(a: Record<string, unknown>, nomes: Record<string, string>) {
  const tel = String(a.telefone ?? "");
  const quem = nome(tel, nomes);
  const mins = Number(a.minutos_parado ?? 0);
  if (a.tipo === "follow_up") return `â€¢ ${quem} nÃ£o responde hÃ¡ ~${Math.floor(mins / 60)}h â€” faÃ§a um follow-up.`;
  return `â€¢ ${quem} estÃ¡ hÃ¡ ${mins}min sem resposta.`;
}

function blocoSdr(alertas: Record<string, unknown>[], nomes: Record<string, string>) {
  if (!alertas.length) return null;
  if (alertas.length === 1) {
    const a = alertas[0];
    const quem = nome(String(a.telefone ?? ""), nomes);
    const mins = Number(a.minutos_parado ?? 0);
    if (a.tipo === "follow_up") return `â° Follow-up: ${quem} nÃ£o responde hÃ¡ ~${Math.floor(mins / 60)}h. Que tal retomar o contato?`;
    return `ðŸ”” ${quem} estÃ¡ hÃ¡ ${mins}min sem resposta. Responde aÃ­!`;
  }
  return `ðŸ”” VocÃª tem leads esperando:\n${alertas.map((a) => linha(a, nomes)).join("\n")}`;
}

function blocoGestor(alertas: Record<string, unknown>[], nomes: Record<string, string>) {
  if (!alertas.length) return null;
  if (alertas.length === 1) {
    const a = alertas[0];
    const quem = nome(String(a.telefone ?? ""), nomes);
    return `âš ï¸ SLA estourado: ${quem} estÃ¡ hÃ¡ ${Number(a.minutos_parado ?? 0)}min sem resposta. A SDR precisa falar com esse lead.`;
  }
  return `âš ï¸ SLA estourado â€” a SDR precisa responder estes leads:\n${alertas.map((a) => linha(a, nomes)).join("\n")}`;
}

async function sendWhatsApp(numero: string, texto: string) {
  const instancia = Deno.env.get("ZAPI_INSTANCIA") ?? "";
  const token = Deno.env.get("ZAPI_TOKEN") ?? "";
  const clientToken = Deno.env.get("ZAPI_CLIENT_TOKEN") ?? "";
  if (!instancia || !token || !clientToken) throw new Error("zapi_not_configured");
  const phone = numero.replace(/\D/g, "");
  const res = await fetch(`https://api.z-api.io/instances/${instancia}/token/${token}/send-text`, {
    method: "POST",
    headers: { "content-type": "application/json", "Client-Token": clientToken },
    body: JSON.stringify({ phone, message: texto }),
  });
  if (!res.ok) throw new Error(`zapi_${res.status}:${(await res.text()).slice(0, 500)}`);
}

async function getControl() {
  const sb = client("agency_ops");
  const { data, error } = await sb.from("worker_runtime_config").select("value").eq("key", "check_overdue").single();
  if (error) throw error;
  const value = (data?.value ?? {}) as Record<string, unknown>;
  return {
    mode: ["off", "shadow", "execute"].includes(String(value.mode)) ? String(value.mode) : "off",
    interval_ms: Math.max(60000, Math.min(Number(value.interval_ms ?? 120000), 900000)),
  };
}

Deno.serve(async (req) => {
  if (req.method === "GET") return json({ ok: true, service: "agency-ops-heavy-worker-api", version: 11 });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!(await authorized(req))) return json({ error: "unauthorized" }, 401);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: "server_not_configured" }, 500);

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "").toLowerCase();
    const worker = String(body.worker ?? "").trim().slice(0, 120);
    if (!worker) return json({ error: "worker_required" }, 400);

    if (action === "claim") {
      return json({ ok: true, jobs: await rpc("claim_heavy_jobs", {
        p_worker: worker,
        p_limit: Math.max(1, Math.min(Number(body.limit ?? 1), 5)),
        p_visibility_timeout: Math.max(60, Math.min(Number(body.visibility_timeout ?? 900), 7200)),
      }) ?? [] });
    }
    if (action === "heartbeat") {
      return json({ ok: true, result: await rpc("heartbeat_heavy_job", {
        p_job_id: body.job_id, p_message_id: body.message_id, p_worker: worker,
        p_progress: body.progress ?? null,
        p_visibility_timeout: Math.max(60, Math.min(Number(body.visibility_timeout ?? 900), 7200)),
      }) });
    }
    if (action === "complete") {
      return json({ ok: true, result: await rpc("complete_heavy_job", {
        p_job_id: body.job_id, p_message_id: body.message_id, p_worker: worker, p_result: body.result ?? {},
      }) });
    }
    if (action === "fail") {
      return json({ ok: true, result: await rpc("fail_heavy_job", {
        p_job_id: body.job_id, p_message_id: body.message_id, p_worker: worker,
        p_error: String(body.error ?? "worker_failed").slice(0, 4000),
        p_retry_delay_seconds: Math.max(5, Math.min(Number(body.retry_delay_seconds ?? 60), 86400)),
      }) });
    }

    if (action === "meeting_snapshot") {
      const transcriptId = Number(body.transcript_id || 0);
      if (!Number.isInteger(transcriptId) || transcriptId <= 0) return json({ error: "transcript_id_required" }, 400);
      const sb = client("agency_ops");
      const [{ data: transcript, error: transcriptError }, { data: segments, error: segmentsError }] = await Promise.all([
        sb.from("meeting_transcripts")
          .select("id,source_file_name,source_url,client_id,client_name_raw,owner_person,participants,transcript_text,duration_seconds,processing_status,meeting_started_at,meeting_ended_at,metadata")
          .eq("id", transcriptId).maybeSingle(),
        sb.from("meeting_transcript_segments")
          .select("sequence_no,started_ms,ended_ms,speaker_key,speaker_name,text,device_id,source")
          .eq("transcript_id", transcriptId).order("sequence_no", { ascending: true }),
      ]);
      if (transcriptError || segmentsError) throw transcriptError || segmentsError;
      if (!transcript) return json({ error: "meeting_not_found" }, 404);
      return json({ ok: true, transcript, segments: segments ?? [] });
    }

    if (action === "meeting_commit") {
      const transcriptId = Number(body.transcript_id || 0);
      if (!Number.isInteger(transcriptId) || transcriptId <= 0) return json({ error: "transcript_id_required" }, 400);
      const analysis = body.analysis && typeof body.analysis === "object" && !Array.isArray(body.analysis) ? body.analysis as Record<string, unknown> : {};
      const summary = String(analysis.summary ?? "").trim().slice(0, 20000);
      if (!summary) return json({ error: "summary_required" }, 400);
      const arr = (value: unknown, max = 100) => Array.isArray(value) ? value.slice(0, max) : [];
      const sb = client("agency_ops");
      const highlights = analysis.highlights && typeof analysis.highlights === "object" && !Array.isArray(analysis.highlights) ? analysis.highlights as Record<string, unknown> : {};
      const signals = {
        action_items: arr(analysis.action_items),
        summary_topics: arr(analysis.summary_topics),
        keywords: arr(analysis.keywords),
        rewritten_notes: arr(analysis.rewritten_notes, 80),
        highlights: {
          opportunities: arr(highlights.opportunities), insights: arr(highlights.insights), ideas: arr(highlights.ideas),
          objectives: arr(highlights.objectives), problems: arr(highlights.problems), lessons: arr(highlights.lessons),
        },
        opportunities: arr(analysis.opportunities), objections: arr(analysis.objections), pain_points: arr(analysis.pain_points),
        follow_up: analysis.follow_up ?? null, model: String(analysis.model ?? "local"), processed_by: worker,
      };
      const { error: updateError } = await sb.from("meeting_transcripts").update({
        summary,
        decisions: arr(analysis.decisions),
        commitments: arr(analysis.commitments),
        ai_signals: signals,
        processing_status: "READY",
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", transcriptId);
      if (updateError) throw updateError;
      await sb.from("meeting_capture_sessions").update({ state: "READY", updated_at: new Date().toISOString() }).eq("transcript_id", transcriptId);
      return json({ ok: true, transcript_id: transcriptId, status: "READY" });
    }
    if (action === "meeting_ready_notify") {
      const transcriptId = Number(body.transcript_id || 0);
      if (!Number.isInteger(transcriptId) || transcriptId <= 0) return json({ error: "transcript_id_required" }, 400);
      const sb = client("agency_ops");
      const { data: cfgRow, error: cfgError } = await sb.from("worker_runtime_config").select("value").eq("key", "meeting_notifications").maybeSingle();
      if (cfgError) throw cfgError;
      const cfg = (cfgRow?.value ?? {}) as Record<string, unknown>;
      if (String(cfg.mode ?? "off") !== "execute") return json({ ok: true, skipped: true, reason: "meeting_notifications_off" });

      const claimed = await rpc("claim_meeting_ready_notification", { p_transcript_id: transcriptId }) as Array<Record<string, unknown>>;
      const notification = Array.isArray(claimed) ? claimed[0] : null;
      if (!notification?.notification_id) return json({ ok: true, skipped: true, reason: "not_ready_already_sent_or_no_phone" });

      const message = `? Reunião processada\n\n${String(notification.title ?? "Reunião")}\n${String(notification.client_name ?? "Cliente não vinculado")}\n\nResumo e transcrição já estão disponíveis no Dashboard.`;
      try {
        await sendWhatsApp(String(notification.recipient_phone ?? ""), message);
        await rpc("finish_meeting_ready_notification", { p_notification_id: notification.notification_id, p_ok: true, p_error: null });
        return json({ ok: true, sent: true, notification_id: notification.notification_id });
      } catch (error) {
        await rpc("finish_meeting_ready_notification", { p_notification_id: notification.notification_id, p_ok: false, p_error: String(error instanceof Error ? error.message : error) });
        throw error;
      }
    }
    if (action === "agenda_snapshot") {
      const commandId = String(body.command_id || "").trim();
      if (!commandId) return json({ error: "command_id_required" }, 400);
      const sb = client("agency_ops");
      const [{ data: command, error: commandError }, { data: cfgRow }] = await Promise.all([
        sb.from("whatsapp_agenda_commands").select("*").eq("id", commandId).maybeSingle(),
        sb.from("worker_runtime_config").select("value").eq("key", "whatsapp_agenda_commands").maybeSingle(),
      ]);
      if (commandError) throw commandError;
      if (!command) return json({ error: "agenda_command_not_found" }, 404);
      const rootId = command.root_command_id || command.id;
      const [{ data: google }, { data: clients }, { data: aliases }, { data: thread }] = await Promise.all([
        sb.from("meeting_integration_accounts").select("account_email,status,token_expires_at,last_error").eq("provider_key", "GOOGLE_WORKSPACE").eq("account_slot", "primary").eq("owner_person", command.owner_person).maybeSingle(),
        sb.from("client_dossier").select("client_id,display_name,lifecycle,gt_owner,cs_owner").in("lifecycle", ["ACTIVE","ONBOARDING"]).order("display_name").limit(250),
        sb.from("clickup_client_aliases").select("alias,client_id").eq("active", true).limit(500),
        sb.from("whatsapp_agenda_commands").select("id,root_command_id,parent_command_id,raw_text,reply_text,parsed_intent,calendar_event_id,calendar_html_link,meet_url,calendar_title,client_id,client_name,received_at,status").or(`id.eq.${rootId},root_command_id.eq.${rootId}`).order("received_at", { ascending: true }),
      ]);
      const rows = thread || [];
      const previousEvent = [...rows].reverse().find((row) => row.calendar_event_id) || null;
      const conversationText = rows.map((row) => {
        const user = String(row.raw_text || "").trim();
        const assistant = String(row.reply_text || "").trim();
        return assistant ? `COLABORADOR: ${user}\\nASSISTENTE: ${assistant}` : `COLABORADOR: ${user}`;
      }).join("\\n\\n");
      await sb.from("whatsapp_agenda_commands").update({ status: "PARSING", updated_at: new Date().toISOString() }).eq("id", commandId).in("status", ["RECEIVED","QUEUED","ERROR"]);
      return json({ ok: true, command, root_command_id: rootId, thread: rows, previous_event: previousEvent, conversation_text: conversationText, config: cfgRow?.value ?? {}, google: google ?? null, clients: clients ?? [], aliases: aliases ?? [], now: new Date().toISOString(), timezone: "America/Sao_Paulo" });
    }

    if (action === "agenda_finish") {
      const commandId = String(body.command_id || "").trim();
      const status = String(body.status || "ERROR").toUpperCase();
      if (!commandId || !["DONE","NEEDS_GOOGLE","NEEDS_INPUT","IGNORED","ERROR"].includes(status)) return json({ error: "invalid_agenda_finish" }, 400);
      const sb = client("agency_ops");
      const { data: current } = await sb.from("whatsapp_agenda_commands").select("*").eq("id", commandId).maybeSingle();
      if (!current) return json({ error: "agenda_command_not_found" }, 404);
      const parsedIntent = body.parsed_intent && typeof body.parsed_intent === "object" ? body.parsed_intent : current.parsed_intent || {};
      const reply = String(body.reply_text || "").trim().slice(0, 4000);
      const update = {
        status,
        parsed_intent: parsedIntent,
        pending_field: status === "NEEDS_INPUT" ? (String(body.pending_field || parsedIntent.pending_field || "").slice(0,60) || null) : null,
        calendar_event_id: body.calendar_event_id ?? current.calendar_event_id ?? null,
        calendar_html_link: body.calendar_html_link ?? current.calendar_html_link ?? null,
        meet_url: body.meet_url ?? current.meet_url ?? null,
        calendar_title: body.calendar_title || parsedIntent.calendar_title || current.calendar_title || null,
        client_id: body.client_id || current.client_id || null,
        client_name: body.client_name || parsedIntent.client_canonical || current.client_name || null,
        reply_text: reply || current.reply_text || null,
        error: body.error ? String(body.error).slice(0, 4000) : null,
        processed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      const { error: updateError } = await sb.from("whatsapp_agenda_commands").update(update).eq("id", commandId);
      if (updateError) throw updateError;
      let sent = false;
      if (reply && !current.reply_sent_at) {
        await sendWhatsApp(String(current.sender_phone || ""), reply);
        const { error: sentError } = await sb.from("whatsapp_agenda_commands").update({ reply_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", commandId).is("reply_sent_at", null);
        if (sentError) throw sentError;
        sent = true;
      }
      return json({ ok: true, command_id: commandId, status, sent });
    }

    if (action === "group_meeting_snapshot") {
      const eventId = Number(body.agenda_event_id || 0);
      if (!Number.isInteger(eventId) || eventId <= 0) return json({ error: "agenda_event_id_required" }, 400);
      const sb = client("agency_ops");
      const { data: event, error: eventError } = await sb.from("meeting_agenda_events").select("*").eq("id", eventId).maybeSingle();
      if (eventError) throw eventError;
      if (!event) return json({ error: "meeting_agenda_event_not_found" }, 404);
      const sourceId = Number(event.source_record_id || event.confirmation_message_id || event.proposal_message_id || 0);
      const [{ data: sourceMessage }, { data: clientRow }, { data: groupRow }] = await Promise.all([
        sourceId ? sb.from("whatsapp_messages").select("id,message_id,chat_id,chat_name,sender_name,sender_phone,text_body,caption,event_at,received_at").eq("id", sourceId).maybeSingle() : Promise.resolve({ data: null }),
        event.client_id ? sb.from("client_dossier").select("client_id,display_name,lifecycle,gt_owner,cs_owner").eq("client_id", event.client_id).maybeSingle() : Promise.resolve({ data: null }),
        event.chat_id ? sb.from("whatsapp_group_registry").select("chat_id,chat_name,client_id,client_name,gt_owner,cs_owner,lifecycle").eq("chat_id", event.chat_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const rawText = `${String(sourceMessage?.text_body || "")} ${String(sourceMessage?.caption || "")}`.trim();
      const norm = rawText.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase();
      const topic = String(event.topic || "");
      let owner = event.person || null;
      let routeReason = "actor";
      if (topic === "Call de INT" || /(integracao de contas|reuniao de integracao|integracao com (o )?gt)/.test(norm)) {
        owner = clientRow?.gt_owner || groupRow?.gt_owner || owner; routeReason = "integration_gt_owner";
      } else if (topic === "Call de PP" || /(formular|forms|persona|briefing.{0,25}(produto|persona)|(produto|persona).{0,25}briefing)/.test(norm)) {
        owner = "Gustavo Lima"; routeReason = "product_persona_gustavo";
      } else if (topic === "Call de AP" || /(apresentacao.{0,20}onboarding|onboarding.{0,20}apresentacao|primeira reuniao|1a reuniao)/.test(norm)) {
        owner = "Joel Antoniete"; routeReason = "onboarding_presentation_joel";
      }
      const { data: google } = owner ? await sb.from("meeting_integration_accounts").select("account_email,status,token_expires_at,last_error").eq("provider_key","GOOGLE_WORKSPACE").eq("account_slot","primary").eq("owner_person",owner).maybeSingle() : { data: null };
      return json({ ok: true, event, source_message: sourceMessage || null, client: clientRow || null, group: groupRow || null, raw_text: rawText, route_owner: owner, route_reason: routeReason, google: google || null });
    }

    if (action === "group_meeting_commit") {
      const eventId = Number(body.agenda_event_id || 0);
      const syncStatus = String(body.sync_status || "ERROR").toUpperCase();
      if (!Number.isInteger(eventId) || eventId <= 0) return json({ error: "agenda_event_id_required" }, 400);
      if (!["SYNCED","NEEDS_GOOGLE","ERROR","CANCELLED","QUEUED"].includes(syncStatus)) return json({ error: "invalid_sync_status" }, 400);
      const sb = client("agency_ops");
      const { data: current } = await sb.from("meeting_agenda_events").select("*").eq("id",eventId).maybeSingle();
      if (!current) return json({ error: "meeting_agenda_event_not_found" },404);
      const update = {
        calendar_sync_status: syncStatus,
        calendar_event_id: body.calendar_event_id ?? current.calendar_event_id ?? null,
        calendar_html_link: body.calendar_html_link ?? current.calendar_html_link ?? null,
        calendar_owner_person: body.calendar_owner_person || current.calendar_owner_person || null,
        calendar_title: body.calendar_title || current.calendar_title || null,
        calendar_error: body.error ? String(body.error).slice(0,2000) : null,
        calendar_synced_at: ["SYNCED","CANCELLED"].includes(syncStatus) ? new Date().toISOString() : current.calendar_synced_at,
        updated_at: new Date().toISOString(),
      };
      const { error } = await sb.from("meeting_agenda_events").update(update).eq("id",eventId);
      if (error) throw error;
      return json({ ok: true, agenda_event_id: eventId, sync_status: syncStatus });
    }

    if (action === "agenda_configure_webhook") {
      const webhookSecret = Deno.env.get("AGENDA_WEBHOOK_SECRET") ?? "";
      const instancia = Deno.env.get("ZAPI_INSTANCIA") ?? "";
      const token = Deno.env.get("ZAPI_TOKEN") ?? "";
      const clientToken = Deno.env.get("ZAPI_CLIENT_TOKEN") ?? "";
      if (!webhookSecret || !instancia || !token || !clientToken) return json({ error: "agenda_webhook_not_configured" }, 500);
      const callback = `${SUPABASE_URL}/functions/v1/agency-ops-whatsapp-agenda-webhook?k=${encodeURIComponent(webhookSecret)}`;
      const response = await fetch(`https://api.z-api.io/instances/${instancia}/token/${token}/update-webhook-received`, {
        method: "PUT",
        headers: { "content-type": "application/json", "Client-Token": clientToken },
        body: JSON.stringify({ value: callback }),
      });
      const detail = await response.text();
      if (!response.ok) throw new Error(`zapi_webhook_${response.status}:${detail.slice(0,500)}`);
      const sb = client("agency_ops");
      await sb.from("meeting_integration_events").insert({
        owner_person: "SYSTEM", provider_key: "ZAPI_NOTIFIER", event_type: "AGENDA_WEBHOOK_CONFIGURED", status: "OK",
        detail: { endpoint: "/functions/v1/agency-ops-whatsapp-agenda-webhook", configured_at: new Date().toISOString() },
      });
      return json({ ok: true, configured: true });
    }

    if (action === "overdue_snapshot") {
      const t0 = Date.now();
      const sb = client("sdr_monitor");
      const [control, cfgRes, rowsRes] = await Promise.all([
        getControl(),
        sb.from("config").select("*").eq("id", 1).single(),
        sb.from("conversas").select("*, contatos!inner(nome,is_mudo)")
          .in("status", ["aguardando_sdr", "aguardando_lead"]).eq("contatos.is_mudo", false),
      ]);
      if (cfgRes.error) throw cfgRes.error;
      if (rowsRes.error) throw rowsRes.error;
      const cfg = cfgRes.data as Record<string, unknown>;
      if (control.mode === "off") return json({ ok: true, snapshot_at: new Date().toISOString(), control, config: normalizeConfig(cfg), conversations: [], gateway_ms: Date.now() - t0 });
      const conversations = (rowsRes.data ?? []).map((r: Record<string, unknown>) => {
        const contato = (r.contatos ?? {}) as Record<string, unknown>;
        const { contatos: _ignored, ...conversa } = r;
        return { ...conversa, nome: contato.nome ?? null };
      });
      return json({ ok: true, snapshot_at: new Date().toISOString(), control, config: normalizeConfig(cfg), conversations, gateway_ms: Date.now() - t0 });
    }

    if (action === "overdue_report") {
      const sb = client("agency_ops");
      const { error } = await sb.from("worker_runs").insert({
        worker,
        task: "check_overdue",
        mode: String(body.mode ?? "unknown").slice(0, 20),
        status: String(body.status ?? "ok").slice(0, 20),
        started_at: body.started_at ?? new Date().toISOString(),
        finished_at: new Date().toISOString(),
        result: body.result ?? {},
        error: body.error ? String(body.error).slice(0, 4000) : null,
      });
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "overdue_apply") {
      const proposals = Array.isArray(body.proposals) ? body.proposals.slice(0, 500) : [];
      const phones = [...new Set(proposals.map((p: Record<string, unknown>) => String((p.before as Record<string, unknown>)?.telefone ?? "")).filter(Boolean))];
      const sb = client("sdr_monitor");
      const [control, cfgRes, rowsRes] = await Promise.all([
        getControl(),
        sb.from("config").select("*").eq("id", 1).single(),
        phones.length ? sb.from("conversas").select("*, contatos!inner(nome,is_mudo)").in("telefone", phones) : Promise.resolve({ data: [], error: null }),
      ]);
      if (control.mode !== "execute") return json({ error: "overdue_not_in_execute_mode", mode: control.mode }, 409);
      const snapshotAt = new Date(String(body.snapshot_at ?? ""));
      if (Number.isNaN(snapshotAt.getTime()) || Date.now() - snapshotAt.getTime() > 90000) return json({ error: "stale_snapshot" }, 409);
      if (!proposals.length) return json({ ok: true, accepted: 0, stale: 0, sent_sdr: false, sent_gestor: false, persisted: { updates: 0, alerts: 0 } });
      if (cfgRes.error) throw cfgRes.error;
      if (rowsRes.error) throw rowsRes.error;

      const currentByPhone = new Map<string, Record<string, unknown>>();
      const nomes: Record<string, string> = {};
      for (const r of rowsRes.data ?? []) {
        const row = r as Record<string, unknown>;
        const tel = String(row.telefone ?? "");
        currentByPhone.set(tel, row);
        const contato = (row.contatos ?? {}) as Record<string, unknown>;
        if (contato.nome) nomes[tel] = String(contato.nome);
      }

      const accepted: Record<string, unknown>[] = [];
      for (const raw of proposals) {
        const p = raw as Record<string, unknown>;
        const before = (p.before ?? {}) as Record<string, unknown>;
        const tel = String(before.telefone ?? "");
        const current = currentByPhone.get(tel);
        if (current && sameBefore(current, before)) accepted.push(p);
      }
      const alerts = accepted.flatMap((p) => Array.isArray(p.alerts) ? p.alerts as Record<string, unknown>[] : []);
      const updates = accepted.map((p) => p.after as Record<string, unknown>).filter(Boolean);
      const sdrAlerts = alerts.filter((a) => a.canal === "whatsapp_sdr");
      const gestorAlerts = alerts.filter((a) => a.canal === "whatsapp_gestor");
      const config = normalizeConfig(cfgRes.data as Record<string, unknown>);
      const msgSdr = blocoSdr(sdrAlerts, nomes);
      const msgGestor = blocoGestor(gestorAlerts, nomes);
      if (msgSdr) {
        const numero = String(config.numero_sdr ?? "");
        if (!numero) throw new Error("numero_sdr_not_configured");
        await sendWhatsApp(numero, msgSdr);
      }
      if (msgGestor) {
        const numero = String(config.numero_gestor ?? "");
        if (!numero) throw new Error("numero_gestor_not_configured");
        await sendWhatsApp(numero, msgGestor);
      }
      const persisted = await rpc("apply_overdue_batch", {
        p_updates: updates,
        p_alerts: alerts.map((a) => ({ telefone: a.telefone, tipo: a.tipo, nivel: a.nivel, canal: a.canal })),
      });
      return json({ ok: true, accepted: accepted.length, stale: proposals.length - accepted.length, sent_sdr: Boolean(msgSdr), sent_gestor: Boolean(msgGestor), persisted });
    }

    return json({ error: "invalid_action" }, 400);
  } catch (error) {
    console.error("worker_api_error", error);
    return json({ error: "worker_api_failed", detail: String((error as Error)?.message ?? error).slice(0, 700) }, 500);
  }
});


