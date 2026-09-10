import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TOKEN_SHA256 = "856985480bfa2b9125b7fa82b92602295920f76cc1b595e51a441dbbb16a13ad";

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
  if (a.tipo === "follow_up") return `• ${quem} não responde há ~${Math.floor(mins / 60)}h — faça um follow-up.`;
  return `• ${quem} está há ${mins}min sem resposta.`;
}

function blocoSdr(alertas: Record<string, unknown>[], nomes: Record<string, string>) {
  if (!alertas.length) return null;
  if (alertas.length === 1) {
    const a = alertas[0];
    const quem = nome(String(a.telefone ?? ""), nomes);
    const mins = Number(a.minutos_parado ?? 0);
    if (a.tipo === "follow_up") return `⏰ Follow-up: ${quem} não responde há ~${Math.floor(mins / 60)}h. Que tal retomar o contato?`;
    return `🔔 ${quem} está há ${mins}min sem resposta. Responde aí!`;
  }
  return `🔔 Você tem leads esperando:\n${alertas.map((a) => linha(a, nomes)).join("\n")}`;
}

function blocoGestor(alertas: Record<string, unknown>[], nomes: Record<string, string>) {
  if (!alertas.length) return null;
  if (alertas.length === 1) {
    const a = alertas[0];
    const quem = nome(String(a.telefone ?? ""), nomes);
    return `⚠️ SLA estourado: ${quem} está há ${Number(a.minutos_parado ?? 0)}min sem resposta. A SDR precisa falar com esse lead.`;
  }
  return `⚠️ SLA estourado — a SDR precisa responder estes leads:\n${alertas.map((a) => linha(a, nomes)).join("\n")}`;
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
  if (req.method === "GET") return json({ ok: true, service: "agency-ops-heavy-worker-api", version: 9 });
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

      const message = `? Reuni�o processada\n\n${String(notification.title ?? "Reuni�o")}\n${String(notification.client_name ?? "Cliente n�o vinculado")}\n\nResumo e transcri��o j� est�o dispon�veis no Dashboard.`;
      try {
        await sendWhatsApp(String(notification.recipient_phone ?? ""), message);
        await rpc("finish_meeting_ready_notification", { p_notification_id: notification.notification_id, p_ok: true, p_error: null });
        return json({ ok: true, sent: true, notification_id: notification.notification_id });
      } catch (error) {
        await rpc("finish_meeting_ready_notification", { p_notification_id: notification.notification_id, p_ok: false, p_error: String(error instanceof Error ? error.message : error) });
        throw error;
      }
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
