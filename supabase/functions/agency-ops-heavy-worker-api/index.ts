import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
let authCache = { value: "", expires: 0 };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function likelyWhisperHallucination(value: unknown) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return false;
  const normalizedText = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/transcricao e legendas|legendas? (?:por|pela comunidade)|amara\.org|obrigado por assistir|inscreva-se no canal|subscribe|subtitles by|transcreva literalmente/i.test(normalizedText)) return true;
  if (/^legenda\s+[a-z]{2,}(?:\s+[a-z]{2,}){0,3}[.!]?$/i.test(normalizedText)) return true;
  const words = normalizedText
    .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length < 12) return false;
  const uniqueRatio = new Set(words).size / words.length;
  if (words.length >= 20 && uniqueRatio <= 0.20) return true;
  for (const size of [2, 3, 4]) {
    if (words.length < size * 4) continue;
    const counts = new Map<string, number>();
    let max = 0;
    for (let i = 0; i <= words.length - size; i++) {
      const key = words.slice(i, i + size).join(" ");
      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      if (next > max) max = next;
    }
    if (max >= 4 && (max * size) / words.length >= 0.45) return true;
  }
  return false;
}

async function workerTokenSha256() {
  if (authCache.value && authCache.expires > Date.now()) return authCache.value;
  const sb = client("agency_ops");
  const { data, error } = await sb.from("worker_runtime_config").select("value").eq("key", "heavy_worker_auth").maybeSingle();
  if (error) throw error;
  const expected = String(data?.value?.token_sha256 ?? "");
  if (!/^[0-9a-f]{64}$/i.test(expected)) throw new Error("worker_auth_not_configured");
  authCache = { value: expected, expires: Date.now() + 300000 };
  return expected;
}

async function authorized(req: Request) {
  const token = req.headers.get("x-agency-worker-token") ?? "";
  if (!token || token.length < 32) return false;
  return (await sha256Hex(token)) === await workerTokenSha256();
}

async function authorizedCommercial(req: Request) {
  const token = req.headers.get("x-relato-commercial-secret") ?? "";
  if (!token || token.length < 32) return false;
  const expected = await secret("RELATO_COMMERCIAL_EDGE_SECRET");
  if (!expected) return false;
  return (await sha256Hex(token)) === (await sha256Hex(expected));
}

function client(schema: string) {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    db: { schema },
  });
}

async function secret(name: string): Promise<string | null> {
  const sb = client("agency_ops");
  const { data, error } = await sb.rpc("get_secret", { p_name: name });
  return error ? null : (String(data || "").trim() || null);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  const raw = String(value ?? "").trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/i, "");
  const parsed = JSON.parse(raw || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function normalizePhone(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

function safeProspectName(value: unknown) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
  if (!name) return null;
  const generic = new Set(["contato","contato whatsapp","contato whatsapp desktop","whatsapp","participante","prospect"]);
  if (generic.has(name.toLowerCase()) || /@(?:lid|c\.us)$/i.test(name)) return null;
  return name;
}

function normalizedNameKey(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function inferProspectNameFromSegments(segments: any[], ownerName: string) {
  const ownerKey = normalizedNameKey(ownerName);
  const stop = new Set(["tudo","bem","aqui","quem","gente","sim","claro","hoje","agora","voce","você","senhor","senhora","amigo","cara","bom","boa"]);
  const scores = new Map<string, { score: number; name: string }>();
  const add = (raw: string, score: number) => {
    const name = safeProspectName(raw);
    if (!name) return;
    const key = normalizedNameKey(name);
    if (!key || stop.has(key) || key === ownerKey) return;
    const prev = scores.get(key);
    scores.set(key, { score: (prev?.score || 0) + score, name });
  };
  for (const seg of segments || []) {
    const speaker = normalizedNameKey(seg?.speaker_name || seg?.speaker_key || "");
    if (!speaker || (ownerKey && speaker !== ownerKey && !speaker.startsWith(ownerKey))) continue;
    const text = String(seg?.text || "").trim();
    if (!text) continue;
    for (const m of text.matchAll(/(?:^|\b)(?:al[oô]|oi|ol[aá]|bom dia|boa tarde|boa noite)\s*[,!:\-]?\s+([\p{L}][\p{L}'’\-]{1,30})\b/giu))
      add(m[1], 5);
    for (const m of text.matchAll(/\b([\p{L}][\p{L}'’\-]{1,30})\s*[,!?]\s*(?:o motivo|tudo bem|voc[eê]|lembra|tem disponibilidade|a gente|eu falei)/giu))
      add(m[1], 4);
  }
  const ranked = [...scores.values()].sort((a,b) => b.score - a.score);
  return ranked[0] && ranked[0].score >= 4 ? ranked[0].name : null;
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

async function sendWhatsApp(numero: string, texto: string, expectedInstance = "") {
  const instancia = Deno.env.get("RELATO_ZAPI_INSTANCE_ID") ?? "";
  const token = Deno.env.get("RELATO_ZAPI_TOKEN") ?? "";
  const clientToken = Deno.env.get("RELATO_ZAPI_CLIENT_TOKEN") ?? Deno.env.get("ZAPI_CLIENT_TOKEN") ?? "";
  if (expectedInstance && instancia !== expectedInstance) throw new Error("relato_zapi_wrong_instance");
  if (!token || !clientToken) throw new Error("relato_zapi_not_configured");
  const phone = numero.replace(/\D/g, "");
  const res = await fetch(`https://api.z-api.io/instances/${instancia}/token/${token}/send-text`, {
    method: "POST",
    headers: { "content-type": "application/json", "Client-Token": clientToken },
    body: JSON.stringify({ phone, message: texto }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`zapi_${res.status}:${raw.slice(0, 500)}`);
  let data: Record<string, unknown> = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch {}
  const messageId = String(data.messageId ?? data.message_id ?? data.zaapId ?? data.id ?? "").trim();
  if (!messageId) throw new Error(`zapi_missing_message_id:${raw.slice(0, 300)}`);
  return { message_id: messageId, instance_id: instancia, recipient_phone: phone };
}

async function confirmRelatoDelivery(messageId: string, recipientPhone: string, expectedInstance: string, expectedConnectedPhone: string, timeoutMs = 45000) {
  const sb = client("agency_ops");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data, error } = await sb.from("whatsapp_zapi_raw")
      .select("message_id,instance_id,connected_phone,chat_id,from_me,status,received_at")
      .eq("message_id", messageId)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      if (String(data.instance_id ?? "") !== expectedInstance) throw new Error(`relato_zapi_delivery_wrong_instance:${String(data.instance_id ?? "")}`);
      if (String(data.connected_phone ?? "") !== expectedConnectedPhone) throw new Error(`relato_zapi_delivery_wrong_phone:${String(data.connected_phone ?? "")}`);
      if (!data.from_me) throw new Error("relato_zapi_delivery_not_from_me");
      const expectedChat = recipientPhone.replace(/\D/g, "");
      if (expectedChat && String(data.chat_id ?? "").replace(/\D/g, "") !== expectedChat) throw new Error(`relato_zapi_delivery_wrong_recipient:${String(data.chat_id ?? "")}`);
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`relato_zapi_delivery_unconfirmed:${messageId}`);
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
  if (req.method === "GET") return json({ ok: true, service: "agency-ops-heavy-worker-api", version: 13 });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: "server_not_configured" }, 500);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "").toLowerCase();
  const commercialActions = new Set(["meeting_commercial_process","meeting_ai_analyze","meeting_commit"]);
  const commercialAuthorized = commercialActions.has(action) && await authorizedCommercial(req);
  if (!commercialAuthorized && !(await authorized(req))) return json({ error: "unauthorized" }, 401);

  try {
    const worker = String(body.worker ?? (commercialAuthorized ? "relato-commercial-edge" : "")).trim().slice(0, 120);
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

    if (action === "meeting_audio_snapshot") {
      const sessionId = String(body.session_id || "").trim();
      if (!sessionId) return json({ error: "session_id_required" }, 400);
      const sb = client("agency_ops");
      const { data: session, error } = await sb.from("meeting_capture_sessions")
        .select("id,device_id,owner_person,local_session_id,started_at,ended_at,audio_local_path,audio_remote_path,audio_mixed_path,audio_status,audio_source,audio_duration_ms,audio_retention_until,metadata")
        .eq("id", sessionId).maybeSingle();
      if (error) throw error;
      if (!session) return json({ error: "meeting_audio_session_not_found" }, 404);
      const paths = [["local", session.audio_local_path], ["remote", session.audio_remote_path]].filter((row) => Boolean(row[1]));
      if (!paths.length) return json({ error: "meeting_audio_originals_not_found" }, 404);
      const storage = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from("relato-call-audio");
      const originals: Record<string, unknown>[] = [];
      for (const [role, path] of paths) {
        const { data: signed, error: signedError } = await storage.createSignedUrl(String(path), 3600);
        if (signedError || !signed?.signedUrl) throw signedError || new Error("meeting_audio_signed_url_failed");
        originals.push({ role, path, signed_url: signed.signedUrl });
      }
      const safeLocal = String(session.local_session_id || "session").replace(/[^a-zA-Z0-9._-]/g, "_");
      const mixedPath = String(session.audio_mixed_path || ("meetings/" + session.device_id + "/" + safeLocal + "/meeting.webm"));
      const { data: upload, error: uploadError } = await storage.createSignedUploadUrl(mixedPath, { upsert: true });
      if (uploadError || !upload?.signedUrl) throw uploadError || new Error("meeting_audio_mixed_upload_url_failed");
      return json({ ok: true, session: { ...session, audio_mixed_path: mixedPath }, originals, mixed_upload: { path: mixedPath, signed_url: upload.signedUrl, mime_type: "audio/webm" } });
    }

    if (action === "meeting_audio_commit") {
      const sessionId = String(body.session_id || "").trim();
      const mixedPath = String(body.mixed_path || "").trim();
      const bytes = Math.max(0, Math.round(Number(body.bytes || 0)));
      if (!sessionId || !mixedPath || !bytes) return json({ error: "meeting_audio_commit_data_required" }, 400);
      const sb = client("agency_ops");
      const { data: session, error } = await sb.from("meeting_capture_sessions").select("id,audio_mixed_path,audio_status,metadata").eq("id", sessionId).maybeSingle();
      if (error) throw error;
      if (!session) return json({ error: "meeting_audio_session_not_found" }, 404);
      if (session.audio_status === "READY" && session.audio_mixed_path === mixedPath) return json({ ok: true, session_id: sessionId, state: "READY", idempotent: true });
      if (session.audio_mixed_path && String(session.audio_mixed_path) !== mixedPath) return json({ error: "meeting_audio_mixed_path_mismatch" }, 400);
      const durationMs = Number.isFinite(Number(body.duration_ms)) ? Math.max(0, Math.round(Number(body.duration_ms))) : null;
      const metadata = { ...(session.metadata || {}), audio_player: { path: mixedPath, bytes, mime_type: "audio/webm", codec: "opus", bitrate_kbps: 48, generated_at: new Date().toISOString() } };
      const { error: updateError } = await sb.from("meeting_capture_sessions").update({
        audio_status: "READY", audio_mixed_path: mixedPath, audio_size_bytes: bytes, audio_mime_type: "audio/webm",
        ...(durationMs != null ? { audio_duration_ms: durationMs } : {}), audio_last_error: null, audio_updated_at: new Date().toISOString(), metadata, updated_at: new Date().toISOString(),
      }).eq("id", sessionId);
      if (updateError) throw updateError;
      return json({ ok: true, session_id: sessionId, state: "READY", mixed_path: mixedPath, bytes });
    }

    if (action === "meeting_audio_failed") {
      const sessionId = String(body.session_id || "").trim();
      if (!sessionId) return json({ error: "session_id_required" }, 400);
      const sb = client("agency_ops");
      const message = String(body.error || "meeting_audio_processing_failed").slice(0, 4000);
      const { error } = await sb.from("meeting_capture_sessions").update({ audio_status: "STORED", audio_last_error: message, audio_updated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", sessionId);
      if (error) throw error;
      return json({ ok: true, session_id: sessionId, state: "STORED", retryable: true });
    }
    if (action === "call_snapshot") {
      const sessionId = String(body.session_id || "").trim();
      if (!sessionId) return json({ error: "session_id_required" }, 400);
      const sb = client("agency_ops");
      const { data: session, error } = await sb.from("meeting_capture_sessions")
        .select("id,device_id,owner_person,local_session_id,title,started_at,ended_at,state,capture_mode,transcript_id,metadata,audio_mixed_path,audio_mime_type,audio_status")
        .eq("id", sessionId).maybeSingle();
      if (error) throw error;
      if (!session) return json({ error: "call_session_not_found" }, 404);
      await sb.from("meeting_capture_sessions").update({ state: "PROCESSING", updated_at: new Date().toISOString() }).eq("id", sessionId).in("state", ["QUEUED","CAPTURED"]);
      session.state = "PROCESSING";
      const audioPaths = session.metadata?.audio_paths && typeof session.metadata.audio_paths === "object" ? session.metadata.audio_paths : {};
      const audio: Record<string, unknown>[] = [];
      for (const [role, path] of Object.entries(audioPaths)) {
        if (!["local","remote"].includes(role) || !path) continue;
        const { data: signed, error: signedError } = await createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
          .storage.from("relato-call-audio").createSignedUrl(String(path), 3600);
        if (signedError || !signed?.signedUrl) throw signedError || new Error("call_audio_signed_url_failed");
        audio.push({ role, path, signed_url: signed.signedUrl });
      }
      let mixed_upload: Record<string, unknown> | null = null;
      if (!session.audio_mixed_path) {
        const safeLocal = String(session.local_session_id || "session").replace(/[^a-zA-Z0-9._-]/g, "_");
        const mixedPath = `calls/${session.device_id}/${safeLocal}/mixed.mp3`;
        const storage = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from("relato-call-audio");
        const { data: upload, error: uploadError } = await storage.createSignedUploadUrl(mixedPath, { upsert: true });
        if (!uploadError && upload?.signedUrl) mixed_upload = { path: mixedPath, signed_url: upload.signedUrl };
      }
      return json({ ok: true, session, audio, mixed_upload });
    }

    if (action === "call_audio_commit") {
      const sessionId = String(body.session_id || "").trim();
      const suppliedPath = String(body.path || "").trim();
      const suppliedBytes = Math.max(0, Math.round(Number(body.bytes || 0)));
      if (!sessionId || !suppliedPath || suppliedBytes < 1000) return json({ error: "call_audio_commit_data_required" }, 400);
      const sb = client("agency_ops");
      const { data: session, error } = await sb.from("meeting_capture_sessions")
        .select("id,device_id,local_session_id,metadata").eq("id", sessionId).maybeSingle();
      if (error) throw error;
      if (!session) return json({ error: "call_session_not_found" }, 404);
      const safeLocal = String(session.local_session_id || "session").replace(/[^a-zA-Z0-9._-]/g, "_");
      const expectedPath = `calls/${session.device_id}/${safeLocal}/mixed.mp3`;
      if (suppliedPath !== expectedPath) return json({ error: "call_audio_path_mismatch" }, 400);
      const folder = suppliedPath.slice(0, suppliedPath.lastIndexOf("/"));
      const filename = suppliedPath.slice(suppliedPath.lastIndexOf("/") + 1);
      const storage = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } }).storage.from("relato-call-audio");
      const { data: objects, error: listError } = await storage.list(folder, { limit: 20, search: filename });
      if (listError) throw listError;
      const object = (objects || []).find((row: Record<string, unknown>) => String(row.name) === filename);
      const bytes = Math.max(suppliedBytes, Math.round(Number((object as any)?.metadata?.size || 0)));
      if (!object || bytes < 1000) return json({ error: "call_audio_object_missing" }, 400);
      const now = new Date().toISOString();
      const metadata = {
        ...(session.metadata || {}),
        audio_player: { path: suppliedPath, bytes, mime_type: "audio/mpeg", codec: "mp3", generated_at: now, source: "HEAVY_WORKER" }
      };
      const { error: updateError } = await sb.from("meeting_capture_sessions").update({
        audio_mixed_path: suppliedPath, audio_mime_type: "audio/mpeg", audio_size_bytes: bytes,
        audio_status: "READY", audio_last_error: null, audio_updated_at: now, metadata, updated_at: now
      }).eq("id", sessionId);
      if (updateError) throw updateError;
      return json({ ok: true, session_id: sessionId, path: suppliedPath, bytes });
    }

    if (action === "call_commit") {
      const sessionId = String(body.session_id || "").trim();
      const transcriptText = String(body.transcript_text || "").trim();
      if (!sessionId || !transcriptText) return json({ error: "call_commit_data_required" }, 400);
      const sb = client("agency_ops");
      const { data: session, error: sessionError } = await sb.from("meeting_capture_sessions")
        .select("id,owner_person,local_session_id,title,started_at,ended_at,capture_mode,metadata,transcript_id")
        .eq("id", sessionId).maybeSingle();
      if (sessionError) throw sessionError;
      if (!session) return json({ error: "call_session_not_found" }, 404);
      const isDesktop = String(session.capture_mode || "").toUpperCase() === "WHATSAPP_DESKTOP_AUDIO";
      const transcriptSource = isDesktop ? "WHATSAPP_DESKTOP_WHISPER" : "WHATSAPP_WEB_AUDIO_WHISPER";
      const channel = isDesktop ? "WHATSAPP_DESKTOP_CALL" : "WHATSAPP_WEB_CALL";
      const phone = (value: unknown) => { const digits = String(value || "").replace(/\D/g, ""); return digits.length >= 10 && digits.length <= 15 ? digits : null; };
      const localPhone = phone(session.metadata?.local_phone);
      const remotePhone = phone(session.metadata?.remote_phone);
      const contactName = String(session.metadata?.contact_name || "Contato WhatsApp").slice(0,160);
      const ownerName = String(session.owner_person || "Colaborador").slice(0,160);
      const rawSegments = Array.isArray(body.segments) ? body.segments.slice(0, 20000) : [];
      const inferredName = inferProspectNameFromSegments(rawSegments as any[], ownerName);
      const resolvedRemoteName = safeProspectName(session.metadata?.remote_name)
        || safeProspectName(contactName)
        || inferredName;
      const formatPhone = (value: string | null) => value ? `+${value}` : "";
      const localLabel = localPhone ? `${ownerName} · ${formatPhone(localPhone)}` : ownerName;
      const remoteBase = resolvedRemoteName || "Contato WhatsApp";
      const remoteLabel = remotePhone ? `${remoteBase} · ${formatPhone(remotePhone)}` : remoteBase;
      const segments = rawSegments.map((seg: Record<string, unknown>, index: number) => {
        const rawKey = String(seg.speaker_key || "").slice(0,180);
        const rawName = String(seg.speaker_name || "Participante").slice(0,160);
        const isLocal = rawKey === ownerName || rawName === ownerName;
        return {
          sequence_no: Number.isFinite(Number(seg.sequence_no)) ? Number(seg.sequence_no) : index,
          started_ms: Number.isFinite(Number(seg.started_ms)) ? Math.max(0, Math.round(Number(seg.started_ms))) : null,
          ended_ms: Number.isFinite(Number(seg.ended_ms)) ? Math.max(0, Math.round(Number(seg.ended_ms))) : null,
          speaker_key: isLocal ? (localPhone || rawKey || ownerName) : (remotePhone || rawKey || remoteBase),
          speaker_name: isLocal ? localLabel : remoteLabel,
          text: String(seg.text || "").trim().slice(0,8000),
          confidence: seg.confidence == null || seg.confidence === ""
            ? null
            : (Number.isFinite(Number(seg.confidence)) ? Math.max(0, Math.min(1, Number(seg.confidence))) : null),
          source: transcriptSource,
        };
      }).filter((seg: Record<string, unknown>) => {
        const text = String(seg.text || "").trim();
        return text.length > 0 && !likelyWhisperHallucination(text);
      });
      const durationSeconds = session.started_at && session.ended_at
        ? Math.max(0, Math.round((Date.parse(String(session.ended_at)) - Date.parse(String(session.started_at))) / 1000)) : null;
      const clock = (value: unknown) => {
        const total = Math.max(0, Math.floor(Number(value || 0) / 1000));
        const hh = String(Math.floor(total / 3600)).padStart(2, "0");
        const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
        const ss = String(total % 60).padStart(2, "0");
        return `${hh}:${mm}:${ss}`;
      };
      const canonicalTranscriptText = segments.length
        ? segments.map((seg: Record<string, unknown>) => `[${clock(seg.started_ms)}] ${String(seg.speaker_name || "Participante")}: ${String(seg.text || "")}`).join("\n\n")
        : rawSegments.length ? "" : (likelyWhisperHallucination(transcriptText) ? "" : transcriptText);

      if (!canonicalTranscriptText.trim()) {
        const now = new Date().toISOString();
        if (session.transcript_id) {
          await sb.from("meeting_transcript_segments").delete().eq("session_id", session.id);
          await sb.from("meeting_transcripts").update({
            processing_status: "REJECTED",
            metadata: { ...(session.metadata || {}), transcript_quality: { status: "REJECTED", reason: "WHISPER_PATHOLOGICAL_REPETITION", rejected_at: now } },
            updated_at: now,
          }).eq("id", session.transcript_id);
        }
        await sb.from("meeting_capture_sessions").update({
          state: "NEEDS_REVIEW",
          metadata: { ...(session.metadata || {}), transcript_quality: { status: "REJECTED", reason: "WHISPER_PATHOLOGICAL_REPETITION", rejected_at: now } },
          updated_at: now,
        }).eq("id", session.id);
        return json({ ok: true, rejected: true, reason: "WHISPER_PATHOLOGICAL_REPETITION", transcript_id: session.transcript_id || null, segments: 0 });
      }

      const contentHash = await sha256Hex(canonicalTranscriptText);
      const participants = [...new Set([localLabel, remoteLabel].filter(Boolean))];
      const identityResolution = resolvedRemoteName ? {
        ...(session.metadata?.identity_resolution || {}),
        auto: true,
        name: resolvedRemoteName,
        phone: remotePhone,
        role: session.metadata?.remote_role || "PROSPECT",
        side: "EXTERNAL",
        status: inferredName && !safeProspectName(session.metadata?.remote_name) ? "AUTO_TRANSCRIPT_NAME" : (session.metadata?.identity_resolution?.status || "AUTO_NAME"),
        source: inferredName && !safeProspectName(session.metadata?.remote_name) ? "TRANSCRIPT_DIRECT_ADDRESS" : (session.metadata?.identity_resolution?.source || session.metadata?.identity_source || "RELATO_AI"),
        confidence: inferredName && !safeProspectName(session.metadata?.remote_name) ? 0.86 : (session.metadata?.identity_resolution?.confidence || null),
      } : (session.metadata?.identity_resolution || null);
      const resolvedMetadata = {
        ...(session.metadata || {}),
        ...(resolvedRemoteName ? { remote_name: resolvedRemoteName } : {}),
        ...(identityResolution ? { identity_resolution: identityResolution } : {}),
        ...(inferredName ? { transcript_inferred_name: inferredName } : {}),
        capture_mode: session.capture_mode,
        channel,
      };

      const transcriptPayload = {
        source_system: "RELATO_AI",
        source_file_id: session.local_session_id,
        source_file_name: `WhatsApp Call - ${remoteLabel}.txt`,
        source_url: isDesktop ? null : "https://web.whatsapp.com/",
        meeting_key: `relato:whatsapp:${session.owner_person}:${session.local_session_id}:${session.started_at}`,
        meeting_code: null,
        meeting_started_at: session.started_at,
        meeting_ended_at: session.ended_at,
        duration_seconds: durationSeconds,
        transcript_text: canonicalTranscriptText,
        content_sha256: contentHash,
        source_file_ids: [session.local_session_id],
        copies_seen: 1,
        participants,
        owner_person: session.owner_person,
        processing_status: "PROCESSING",
        transcript_source: transcriptSource,
        capture_session_id: session.id,
        metadata: resolvedMetadata,
        updated_at: new Date().toISOString(),
      };
      let transcript: Record<string, unknown> | null = null;
      if (session.transcript_id) {
        const { data, error } = await sb.from("meeting_transcripts").update(transcriptPayload).eq("id", session.transcript_id).select("id").single();
        if (error) throw error; transcript = data;
      } else {
        const { data, error } = await sb.from("meeting_transcripts").insert(transcriptPayload).select("id").single();
        if (error) throw error; transcript = data;
      }
      const transcriptId = Number(transcript?.id || session.transcript_id || 0);
      if (!transcriptId) return json({ error: "call_transcript_missing" }, 500);
      const { error: clearSegmentsError } = await sb.from("meeting_transcript_segments").delete().eq("session_id", session.id);
      if (clearSegmentsError) throw clearSegmentsError;
      if (segments.length) {
        const rows = segments.map((seg: Record<string, unknown>) => ({ ...seg, transcript_id: transcriptId, session_id: session.id }));
        const { error } = await sb.from("meeting_transcript_segments").upsert(rows, { onConflict: "session_id,sequence_no" });
        if (error) throw error;
      }
      const now = new Date().toISOString();
      await sb.from("meeting_capture_sessions").update({
        transcript_id: transcriptId,
        state: "PROCESSING",
        metadata: resolvedMetadata,
        updated_at: now
      }).eq("id", session.id);
      if (remotePhone && inferredName && !safeProspectName(session.metadata?.remote_name)) {
        await sb.from("whatsapp_participant_identity").upsert({
          chat_id: "relato-transcript",
          identity_key: `phone:${remotePhone}`,
          phone: remotePhone,
          sender_lid: null,
          canonical_name: inferredName,
          client_id: null,
          side: "EXTERNAL",
          role_hint: "PROSPECT",
          confidence: 0.86,
          source: "TRANSCRIPT_DIRECT_ADDRESS",
          first_seen_at: now,
          last_seen_at: now,
          last_message_id: null,
          metadata: { transcript_id: transcriptId, capture_session_id: session.id },
          updated_at: now,
        }, { onConflict: "chat_id,identity_key" }).catch(() => {});
      }
      await sb.from("meeting_human_feedback").update({ transcript_id: transcriptId, updated_at: now })
        .eq("capture_session_id", session.id).is("transcript_id", null);

      const { data: roster } = await sb.from("team_roster")
        .select("role").eq("person", session.owner_person).eq("is_former", false).maybeSingle();
      if (String(roster?.role || "").toUpperCase() === "SDR") {
        const confidenceValues = segments
          .map((seg: Record<string, unknown>) => seg.confidence == null ? null : Number(seg.confidence))
          .filter((value: number | null): value is number => value != null && Number.isFinite(value));
        const avgConfidence = confidenceValues.length
          ? confidenceValues.reduce((sum: number, value: number) => sum + value, 0) / confidenceValues.length
          : null;
        const lowConfidence = avgConfidence != null && avgConfidence < 0.60;
        const transcriptMetadata = {
          ...resolvedMetadata,
          postprocess_mode: "SDR_COMMERCIAL_AI",
          transcript_quality: {
            status: lowConfidence ? "NEEDS_REVIEW" : "ACCEPTED",
            average_confidence: avgConfidence,
            threshold: 0.60,
            evaluated_at: now,
          },
        };
        if (lowConfidence) {
          const { error: rejectedError } = await sb.from("meeting_transcripts").update({
            summary: null,
            processing_status: "REJECTED",
            transcript_quality: avgConfidence,
            processed_at: now,
            metadata: transcriptMetadata,
            updated_at: now,
          }).eq("id", transcriptId);
          if (rejectedError) throw rejectedError;
          await sb.from("meeting_capture_sessions").update({
            state: "NEEDS_REVIEW", metadata: transcriptMetadata, updated_at: now
          }).eq("id", session.id);
          return json({
            ok: true, transcript_id: transcriptId, segments: segments.length, job_id: null,
            postprocess: "SDR_LOW_CONFIDENCE_REVIEW", transcript_quality: avgConfidence,
          });
        }
        const extractiveSummary = canonicalTranscriptText.replace(/\s+/g, " ").trim().slice(0, 1200);
        const readyMetadata = {
          ...transcriptMetadata,
          commercial_analysis_status: "PENDING",
          transcript_ready_at: now,
        };
        const { error: readyError } = await sb.from("meeting_transcripts").update({
          summary: extractiveSummary || null,
          processing_status: "READY",
          transcript_quality: avgConfidence,
          processed_at: now,
          metadata: readyMetadata,
          updated_at: now,
        }).eq("id", transcriptId);
        if (readyError) throw readyError;
        const commercialSecret = await secret("RELATO_COMMERCIAL_EDGE_SECRET");
        if (!commercialSecret) throw new Error("relato_commercial_edge_secret_missing");
        const commercialEndpoint = `${SUPABASE_URL}/functions/v1/agency-ops-heavy-worker-api`;
        const commercialTask = fetch(commercialEndpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-relato-commercial-secret": commercialSecret,
          },
          body: JSON.stringify({
            action: "meeting_commercial_process",
            worker: "relato-commercial-edge",
            transcript_id: transcriptId,
            session_id: session.id,
          }),
        }).then(async (response) => {
          const raw = await response.text();
          if (!response.ok) throw new Error(`commercial_edge_${response.status}:${raw.slice(0,500)}`);
          return raw;
        }).catch(async (error) => {
          const failedAt = new Date().toISOString();
          const failure = {
            ...readyMetadata,
            commercial_analysis_status: "FALLBACK_QUEUED",
            commercial_analysis_error: String(error instanceof Error ? error.message : error).slice(0,1000),
            commercial_analysis_updated_at: failedAt,
          };
          await sb.from("meeting_transcripts").update({ metadata: failure, updated_at: failedAt }).eq("id", transcriptId);
          await sb.from("meeting_capture_sessions").update({ metadata: failure, updated_at: failedAt }).eq("id", session.id);
          const { error: fallbackQueueError } = await sb.rpc("enqueue_heavy_job", {
            p_job_type: "MEETING_POSTPROCESS",
            p_payload: { transcript_id: transcriptId, session_id: session.id, mode: "execute", commercial: true, fallback_from: "EDGE_BACKGROUND_OPENAI" },
            p_dedupe_key: `meeting:fallback:${transcriptId}`,
            p_max_attempts: 3,
            p_available_at: failedAt,
          });
          console.error("commercial_edge_background_failed", transcriptId, failure.commercial_analysis_error, fallbackQueueError?.message || "");
        });
        const runtime = (globalThis as any).EdgeRuntime;
        if (runtime?.waitUntil) runtime.waitUntil(commercialTask);
        else await commercialTask;
        const queuedMetadata = {
          ...readyMetadata,
          commercial_processing_route: "EDGE_BACKGROUND_OPENAI",
        };
        await sb.from("meeting_capture_sessions").update({
          state: "READY", metadata: queuedMetadata, updated_at: now
        }).eq("id", session.id);
        await sb.from("meeting_transcripts").update({
          metadata: queuedMetadata, updated_at: now
        }).eq("id", transcriptId);
        return json({
          ok: true,
          transcript_id: transcriptId,
          segments: segments.length,
          job_id: null,
          postprocess: "SDR_TRANSCRIPT_READY_COMMERCIAL_EDGE_QUEUED",
          transcript_quality: avgConfidence,
        });
      }

      const { data: jobId, error: jobError } = await sb.rpc("enqueue_heavy_job", {
        p_job_type: "MEETING_POSTPROCESS",
        p_payload: { transcript_id: transcriptId, session_id: session.id, mode: "execute" },
        p_dedupe_key: `meeting:${transcriptId}`,
        p_max_attempts: 5,
        p_available_at: now,
      });
      if (jobError) throw jobError;
      await sb.from("meeting_capture_sessions").update({ state: "PROCESSING", updated_at: now }).eq("id", session.id);
      return json({ ok: true, transcript_id: transcriptId, segments: segments.length, job_id: jobId || null });
    }

    if (action === "meeting_commercial_process") {
      const transcriptId = Number(body.transcript_id || 0);
      if (!Number.isInteger(transcriptId) || transcriptId <= 0) return json({ error: "transcript_id_required" }, 400);
      const commercialSecret = await secret("RELATO_COMMERCIAL_EDGE_SECRET");
      if (!commercialSecret) return json({ error: "relato_commercial_edge_secret_missing" }, 500);
      const endpoint = `${SUPABASE_URL}/functions/v1/agency-ops-heavy-worker-api`;
      const callCommercial = async (payload: Record<string, unknown>) => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-relato-commercial-secret": commercialSecret,
          },
          body: JSON.stringify({ worker: "relato-commercial-edge", ...payload }),
        });
        const raw = await response.text();
        let parsed: Record<string, any> = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
        if (!response.ok) throw new Error(`commercial_internal_${response.status}:${raw.slice(0,500)}`);
        return parsed;
      };
      try {
        const analyzed = await callCommercial({ action: "meeting_ai_analyze", transcript_id: transcriptId });
        const committed = await callCommercial({ action: "meeting_commit", transcript_id: transcriptId, analysis: analyzed.analysis || {} });
        return json({
          ok: true,
          transcript_id: transcriptId,
          route: "EDGE_BACKGROUND_OPENAI",
          provider: analyzed.provider || "OPENAI",
          model: analyzed.model || analyzed.analysis?.model || null,
          committed,
        });
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error).slice(0,1000);
        const failedAt = new Date().toISOString();
        const sb = client("agency_ops");
        const { data: transcriptRow } = await sb.from("meeting_transcripts").select("metadata,capture_session_id").eq("id", transcriptId).maybeSingle();
        const failedMetadata = {
          ...(transcriptRow?.metadata || {}),
          commercial_analysis_status: "ERROR",
          commercial_analysis_error: message,
          commercial_analysis_updated_at: failedAt,
        };
        await sb.from("meeting_transcripts").update({ metadata: failedMetadata, updated_at: failedAt }).eq("id", transcriptId);
        if (transcriptRow?.capture_session_id) {
          await sb.from("meeting_capture_sessions").update({ metadata: failedMetadata, updated_at: failedAt }).eq("id", transcriptRow.capture_session_id);
        }
        throw error;
      }
    }

    if (action === "meeting_ai_analyze") {
      const transcriptId = Number(body.transcript_id || 0);
      if (!Number.isInteger(transcriptId) || transcriptId <= 0) return json({ error: "transcript_id_required" }, 400);
      const sb = client("agency_ops");
      const { data: transcript, error: transcriptError } = await sb.from("meeting_transcripts")
        .select("id,source_file_name,client_name_raw,owner_person,transcript_text,participants,meeting_started_at,meeting_ended_at,transcript_source")
        .eq("id", transcriptId).maybeSingle();
      if (transcriptError) throw transcriptError;
      if (!transcript?.transcript_text) return json({ error: "transcript_not_ready" }, 409);

      const [openaiKey, relatoModel, taskModel] = await Promise.all([
        secret("OPENAI_API_KEY"), secret("RELATO_AI_MODEL"), secret("TASK_ENGINE_MODEL")
      ]);
      if (!openaiKey) {
        const commercialSecret = await secret("RELATO_COMMERCIAL_EDGE_SECRET");
        if (!commercialSecret) return json({ error: "commercial_ai_not_configured" }, 428);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
          const response = await fetch("https://relato-commercial-ai.lakassessoriadigital.workers.dev", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-relato-commercial-secret": commercialSecret,
            },
            body: JSON.stringify({
              transcript: String(transcript.transcript_text).slice(0,50000),
              owner_person: String(transcript.owner_person || ""),
              client_name_raw: String(transcript.client_name_raw || ""),
              transcript_source: String(transcript.transcript_source || ""),
            }),
            signal: controller.signal,
          });
          const raw = await response.text();
          let envelope: Record<string, any> = {};
          try { envelope = raw ? JSON.parse(raw) : {}; } catch { envelope = { raw }; }
          if (!response.ok || !envelope?.ok) throw new Error(`cloudflare_ai_${response.status}:${raw.slice(0,500)}`);
          const analysis = envelope.analysis && typeof envelope.analysis === "object" ? envelope.analysis : {};
          if (!String(analysis.summary || "").trim()) throw new Error("cloudflare_ai_empty_summary");
          const model = String(envelope.model || "@cf/meta/llama-3.3-70b-instruct-fp8-fast");
          return json({
            ok: true,
            transcript_id: transcriptId,
            model,
            provider: "CLOUDFLARE_WORKERS_AI",
            latency_ms: envelope.latency_ms || null,
            analysis: { ...analysis, model, provider: "CLOUDFLARE_WORKERS_AI" },
          });
        } finally {
          clearTimeout(timeout);
        }
      }
      const model = relatoModel || taskModel || "gpt-5-mini";
      const system = [
        "Você analisa ligações e reuniões comerciais de SDR em português do Brasil.",
        "Use somente fatos presentes na transcrição. Nunca invente.",
        "Retorne APENAS JSON válido.",
        "O objetivo é preparar o closer para a reunião de fechamento.",
        "Separe dor primária de dores secundárias, objetivos, urgência, decisor, estrutura atual, investimento, equipe, serviços de interesse, objeções, sinais de compra, riscos e próximo passo.",
        "closer_briefing deve ser curto, acionável e dizer o que explorar, o que validar e o que evitar prometer.",
        "Se um dado não existir, use string vazia, 0 ou array vazio."
      ].join("\n");
      const expected = {
        summary: "", decisions: [], commitments: [], action_items: [], summary_topics: [],
        highlights: { opportunities: [], insights: [], ideas: [], objectives: [], problems: [], lessons: [] },
        keywords: [], rewritten_notes: [], objections: [], pain_points: [],
        primary_pain: "", secondary_pains: [], goals: [], urgency: "", decision_role: "",
        current_structure: "", marketing_investment: "", broker_count: 0, services_interest: [],
        buying_signals: [], closing_risks: [], closer_briefing: "", opportunities: [], follow_up: ""
      };
      const user = [
        `SDR/RESPONSÁVEL: ${String(transcript.owner_person || "")}`,
        `PROSPECT/CLIENTE ATUAL: ${String(transcript.client_name_raw || "")}`,
        `FONTE: ${String(transcript.transcript_source || "")}`,
        `FORMATO JSON OBRIGATÓRIO: ${JSON.stringify(expected)}`,
        "",
        "TRANSCRIÇÃO:",
        String(transcript.transcript_text).slice(0, 50000)
      ].join("\n");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 90_000);
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${openaiKey}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
          }),
          signal: controller.signal,
        });
        const raw = await response.text();
        if (!response.ok) throw new Error(`openai_${response.status}:${raw.slice(0,500)}`);
        const envelope = JSON.parse(raw || "{}");
        const analysis = parseJsonObject(envelope?.choices?.[0]?.message?.content || "{}");
        if (!String(analysis.summary || "").trim()) throw new Error("openai_empty_summary");
        return json({ ok: true, transcript_id: transcriptId, model, provider: "OPENAI", analysis: { ...analysis, model } });
      } finally {
        clearTimeout(timeout);
      }
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
      let analysis = body.analysis && typeof body.analysis === "object" && !Array.isArray(body.analysis)
        ? body.analysis as Record<string, unknown>
        : {};

      // The VPS keeps a tiny local model as a resilience fallback. If that model
      // times out, enrich the same transcript with OpenAI here before touching CRM.
      // This keeps automatic CRM handoff useful even when Ollama is cold/slow.
      const fallbackModel = String(analysis.model || "").toLowerCase();
      const needsReliableCommercialAnalysis = fallbackModel.includes("fallback") || Boolean(analysis.fallback_reason);
      if (needsReliableCommercialAnalysis) {
        try {
          const analysisDb = client("agency_ops");
          const { data: transcriptForAi } = await analysisDb.from("meeting_transcripts")
            .select("id,source_file_name,client_name_raw,owner_person,transcript_text,transcript_source")
            .eq("id", transcriptId).maybeSingle();
          const [openaiKey, relatoModel, taskModel] = await Promise.all([
            secret("OPENAI_API_KEY"), secret("RELATO_AI_MODEL"), secret("TASK_ENGINE_MODEL")
          ]);
          if (openaiKey && transcriptForAi?.transcript_text) {
            const model = relatoModel || taskModel || "gpt-5-mini";
            const expected = {
              summary: "", decisions: [], commitments: [], action_items: [], summary_topics: [],
              highlights: { opportunities: [], insights: [], ideas: [], objectives: [], problems: [], lessons: [] },
              keywords: [], rewritten_notes: [], objections: [], pain_points: [],
              primary_pain: "", secondary_pains: [], goals: [], urgency: "", decision_role: "",
              current_structure: "", marketing_investment: "", broker_count: 0, services_interest: [],
              buying_signals: [], closing_risks: [], closer_briefing: "", opportunities: [], follow_up: ""
            };
            const system = [
              "Você analisa ligações e reuniões comerciais de SDR em português do Brasil.",
              "Use somente fatos presentes na transcrição. Nunca invente.",
              "Retorne APENAS JSON válido.",
              "Separe dor primária e secundárias, objetivos, urgência, decisor, estrutura atual, investimento, equipe, serviços de interesse, objeções, sinais de compra, riscos e próximo passo.",
              "closer_briefing deve preparar o closer: contexto, o que explorar, o que validar e o que evitar prometer.",
              "Se um dado não existir, use string vazia, 0 ou array vazio."
            ].join("\n");
            const user = [
              `SDR/RESPONSÁVEL: ${String(transcriptForAi.owner_person || "")}`,
              `PROSPECT/CLIENTE: ${String(transcriptForAi.client_name_raw || "")}`,
              `FONTE: ${String(transcriptForAi.transcript_source || "")}`,
              `FORMATO JSON OBRIGATÓRIO: ${JSON.stringify(expected)}`,
              "",
              "TRANSCRIÇÃO:",
              String(transcriptForAi.transcript_text).slice(0, 50000)
            ].join("\n");
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 90_000);
            try {
              const response = await fetch("https://api.openai.com/v1/chat/completions", {
                method: "POST",
                headers: { authorization: `Bearer ${openaiKey}`, "content-type": "application/json" },
                body: JSON.stringify({
                  model,
                  response_format: { type: "json_object" },
                  messages: [{ role: "system", content: system }, { role: "user", content: user }],
                }),
                signal: controller.signal,
              });
              const raw = await response.text();
              if (!response.ok) throw new Error(`openai_${response.status}:${raw.slice(0,500)}`);
              const envelope = JSON.parse(raw || "{}");
              const enriched = parseJsonObject(envelope?.choices?.[0]?.message?.content || "{}");
              if (String(enriched.summary || "").trim())
                analysis = { ...enriched, model, provider: "OPENAI_FALLBACK" };
            } finally {
              clearTimeout(timeout);
            }
          }
        } catch (error) {
          console.error("commercial_openai_fallback_failed", String(error instanceof Error ? error.message : error));
        }
      }

      let summary = String(analysis.summary ?? "").trim().slice(0, 20000);
      if (!summary) return json({ error: "summary_required" }, 400);
      const arr = (value: unknown, max = 100) => Array.isArray(value) ? value.slice(0, max) : [];
      const sb = client("agency_ops");

      // Commercial AI is allowed to summarize, but not to manufacture qualification.
      // Every structured field below needs explicit evidence in the transcript.
      const { data: evidenceTranscript } = await sb.from("meeting_transcripts")
        .select("transcript_text,owner_person,transcript_source")
        .eq("id", transcriptId).maybeSingle();
      const evidence = String(evidenceTranscript?.transcript_text || "").normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const hasBrokerEvidence = /\b\d{1,4}\s+(?:corretores?|vendedores?|consultores?)\b/i.test(evidence);
      const hasInvestmentEvidence = /\b(?:investe|investimento|verba|orcamento|midia|trafego|meta)[^\n]{0,80}(?:r\$\s*[\d.,]+|\d[\d.,]*\s*(?:mil|k))\b/i.test(evidence)
        || /\b(?:r\$\s*[\d.,]+|\d[\d.,]*\s*(?:mil|k))[^\n]{0,80}(?:investe|investimento|verba|orcamento|midia|trafego|meta)\b/i.test(evidence);
      const hasDecisionEvidence = /\b(?:quem decide|decis(?:ao|or)|socio|socia|dono|dona|proprietario|proprietaria|diretor|diretora|responsavel pela decisao)\b/i.test(evidence);
      const hasStructureEvidence = /\b(?:equipe|corretores?|vendedores?|consultores?|crm|agencia|gestor(?:a)?|time comercial|time de vendas)\b/i.test(evidence);
      const hasServiceEvidence = /\b(?:trafego|marketing|anuncios?|meta ads|google ads|criativos?|crm|automacao|site|landing page|captacao|gestao de trafego|social media|conteudo|leads?)\b/i.test(evidence);
      const hasPainEvidence = /\b(?:problema|dificuldade|dor|insatisfeit|nao funciona|nao vende|nao converte|lead(?:s)? (?:ruins?|fracos?|desqualificados?)|sem leads?|falta de leads?|cpl|custo por lead|retorno baixo|resultado ruim|vendas? baixas?)\b/i.test(evidence);
      const hasGoalEvidence = /\b(?:quero|queremos|preciso|precisamos|objetivo|meta)\b[^\n]{0,100}\b(?:vender|vendas|captar|captacao|lead|crescer|aumentar|melhorar|reduzir|escalar|faturar|resultado|conversao)\b/i.test(evidence)
        || /\b(?:aumentar|melhorar|reduzir|escalar|crescer|gerar)\b[^\n]{0,80}\b(?:vendas?|leads?|conversao|faturamento|resultado)\b/i.test(evidence);
      const hasUrgencyEvidence = /\b(?:urgente|urgencia|o quanto antes|quanto antes|preciso resolver|precisamos resolver|ainda este mes|ate o fim do mes|para ontem)\b/i.test(evidence);
      const hasBuyingEvidence = /\b(?:quero contratar|queremos contratar|vamos fechar|fechar contrato|mandar proposta|envia a proposta|gostei da proposta|podemos comecar|vamos comecar|qual o valor|quanto custa)\b/i.test(evidence);
      const schedulingEvidence = /\b(?:reuniao marcada|agendar|marcar|horario|disponibilidade|reagendar|remarcar|antecipar a reuniao)\b/i.test(evidence);
      const substantiveCommercialEvidence = hasPainEvidence || hasGoalEvidence || hasInvestmentEvidence || hasBrokerEvidence
        || hasDecisionEvidence || hasServiceEvidence || hasBuyingEvidence;

      if (!hasBrokerEvidence) analysis.broker_count = 0;
      if (!hasInvestmentEvidence) analysis.marketing_investment = "";
      if (!hasDecisionEvidence) analysis.decision_role = "";
      if (!hasStructureEvidence) analysis.current_structure = "";
      if (!hasServiceEvidence) analysis.services_interest = [];
      if (!hasPainEvidence) {
        analysis.primary_pain = "";
        analysis.secondary_pains = [];
        analysis.pain_points = [];
      }
      if (!hasGoalEvidence) analysis.goals = [];
      if (!hasUrgencyEvidence) analysis.urgency = "";
      if (!hasBuyingEvidence) analysis.buying_signals = [];

      if (schedulingEvidence && !substantiveCommercialEvidence) {
        summary = "Ligação de agendamento, confirmação ou reagendamento. Não houve qualificação comercial suficiente nesta interação; manter a reunião como próximo passo e validar dores, cenário atual, orçamento, decisor e objetivos na conversa de fechamento.";
        analysis.primary_pain = "";
        analysis.secondary_pains = [];
        analysis.pain_points = [];
        analysis.goals = [];
        analysis.urgency = "";
        analysis.decision_role = "";
        analysis.current_structure = "";
        analysis.marketing_investment = "";
        analysis.broker_count = 0;
        analysis.services_interest = [];
        analysis.objections = [];
        analysis.buying_signals = [];
        analysis.closing_risks = [];
        analysis.follow_up = "Confirmar ou realizar a reunião comercial já combinada.";
        analysis.closer_briefing = "Contato usado apenas para agendamento/confirmação. Não tratar disponibilidade de agenda como dor comercial. Na reunião, validar dores primárias e secundárias, cenário atual, objetivos, investimento, decisor, objeções e urgência antes de avançar para proposta.";
      }

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
        primary_pain: String(analysis.primary_pain ?? "").trim() || null,
        secondary_pains: arr(analysis.secondary_pains),
        goals: arr(analysis.goals),
        urgency: String(analysis.urgency ?? "").trim() || null,
        decision_role: String(analysis.decision_role ?? "").trim() || null,
        current_structure: String(analysis.current_structure ?? "").trim() || null,
        marketing_investment: String(analysis.marketing_investment ?? "").trim() || null,
        broker_count: Number.isFinite(Number(analysis.broker_count)) && Number(analysis.broker_count) > 0 ? Math.round(Number(analysis.broker_count)) : null,
        services_interest: arr(analysis.services_interest),
        buying_signals: arr(analysis.buying_signals),
        closing_risks: arr(analysis.closing_risks),
        closer_briefing: String(analysis.closer_briefing ?? "").trim() || null,
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

      let commercialSync: Record<string, unknown> = { status: "SKIPPED_NON_SDR" };
      const { data: transcriptRow } = await sb.from("meeting_transcripts")
        .select("id,capture_session_id,owner_person,transcript_source,meeting_started_at,metadata,participants,client_name_raw,source_file_name")
        .eq("id", transcriptId).maybeSingle();
      const { data: roster } = transcriptRow?.owner_person
        ? await sb.from("team_roster").select("role").eq("person", transcriptRow.owner_person).eq("is_former", false).maybeSingle()
        : { data: null };
      if (String(roster?.role || "").toUpperCase() === "SDR") {
        const crm = client("crm");
        const captureSessionId = String(transcriptRow?.capture_session_id || "").trim() || null;
        let session: Record<string, any> | null = null;
        if (captureSessionId) {
          const { data } = await sb.from("meeting_capture_sessions")
            .select("id,owner_person,metadata,capture_mode,started_at,ended_at")
            .eq("id", captureSessionId).maybeSingle();
          session = data || null;
        }
        let leadId = String(
          session?.metadata?.commercial_prospect?.lead_id
          || transcriptRow?.metadata?.commercial_prospect?.lead_id
          || ""
        ).trim() || null;
        if (!leadId) {
          const query = sb.from("commercial_call_records").select("lead_id,updated_at").order("updated_at", { ascending: false }).limit(1);
          const { data } = captureSessionId
            ? await query.eq("capture_session_id", captureSessionId)
            : await query.eq("transcript_id", transcriptId);
          leadId = String(data?.[0]?.lead_id || "").trim() || null;
        }
        const remotePhone = normalizePhone(session?.metadata?.remote_phone || transcriptRow?.metadata?.remote_phone);
        const participantCandidates = (Array.isArray(transcriptRow?.participants) ? transcriptRow.participants : [])
          .map((v: unknown) => safeProspectName(v))
          .filter((v: string | null): v is string => Boolean(v))
          .filter((v: string) => normalizedNameKey(v) !== normalizedNameKey(transcriptRow?.owner_person))
          .filter((v: string) => !v.includes("+"));
        const uniqueParticipantNames = [...new Map(participantCandidates.map((v: string) => [normalizedNameKey(v), v])).values()];
        const remoteName = safeProspectName(
          session?.metadata?.remote_name
          || session?.metadata?.contact_name
          || transcriptRow?.metadata?.remote_name
          || transcriptRow?.metadata?.contact_name
          || transcriptRow?.client_name_raw
        ) || (uniqueParticipantNames.length === 1 ? uniqueParticipantNames[0] : null);
        const identityResolution = (session?.metadata?.identity_resolution || transcriptRow?.metadata?.identity_resolution || {}) as Record<string, unknown>;
        const identitySide = String(identityResolution.side || "").toUpperCase();
        const identityStatus = String(identityResolution.status || "").toUpperCase();
        const reviewClassification = String(
          session?.metadata?.backfill_review?.classification
          || transcriptRow?.metadata?.backfill_review?.classification
          || ""
        ).toUpperCase();
        const explicitCommercialBinding = Boolean(leadId);
        const nonCommercialClassifications = new Set([
          "TEST_OR_INTERNAL_CALL","TEST_OR_NOISY_CALL","INTERNAL_TEAM_CALL","CLIENT_CALL",
          "NON_COMMERCIAL_CALL","UNUSABLE_AUDIO","NO_TRANSCRIPT","UNRESOLVED_NO_RELIABLE_AUDIO"
        ]);
        let commercialSkipReason = "";
        if (identitySide === "TEAM" || identitySide === "INTERNAL_TEST") commercialSkipReason = "identity_internal_team";
        else if (identitySide === "CLIENT_SIDE") commercialSkipReason = "identity_client_side";
        else if (["AUTO_NON_CLIENT","AUTO_TEAM","AUTO_CLIENT_SIDE","TEST_CALL"].includes(identityStatus)) commercialSkipReason = "identity_not_commercial";
        else if (nonCommercialClassifications.has(reviewClassification)) commercialSkipReason = "call_classification_not_commercial";
        else if (!explicitCommercialBinding && (!identityStatus || identityStatus === "UNRESOLVED" || identityStatus === "REVIEWED_UNRESOLVED")) commercialSkipReason = "identity_unresolved";
        if (commercialSkipReason) leadId = null;

        const core = client("public");
        const { data: closerProfile } = await core.from("profiles")
          .select("id,email").eq("email", "feitozaluizvitor@gmail.com").maybeSingle();

        if (!commercialSkipReason && !leadId && remotePhone) {
          const variants = [remotePhone, "+" + remotePhone];
          const { data } = await crm.from("leads").select("id").in("phone", variants)
            .is("archived_at", null).order("updated_at", { ascending: false }).limit(2);
          if ((data || []).length === 1) leadId = String(data?.[0]?.id || "") || null;
        }
        if (!commercialSkipReason && !leadId && remoteName && closerProfile?.id) {
          const { data } = await crm.from("leads").select("id,name")
            .eq("owner_id", closerProfile.id).ilike("name", remoteName)
            .is("archived_at", null).order("updated_at", { ascending: false }).limit(2);
          if ((data || []).length === 1) leadId = String(data?.[0]?.id || "") || null;
        }
        if (!commercialSkipReason && !leadId && remoteName && closerProfile?.id) {
          const externalId = remotePhone
            ? `relato-phone:${remotePhone}`
            : `relato-name:${normalizedNameKey(remoteName)}`;
          const insert = await crm.from("leads").insert({
            owner_id: closerProfile.id,
            name: remoteName,
            phone: remotePhone,
            stage: "qualificacao",
            source: "RELATO_AI_SDR",
            external_id: externalId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).select("id").single();
          if (insert.data?.id) leadId = String(insert.data.id);
          else if (insert.error?.code === "23505") {
            const { data } = await crm.from("leads").select("id")
              .eq("source", "RELATO_AI_SDR").eq("external_id", externalId).maybeSingle();
            leadId = String(data?.id || "") || null;
          } else if (insert.error) {
            throw insert.error;
          }
        }

        const toStrings = (value: unknown, max = 30) => Array.isArray(value)
          ? value.map((x) => String(x || "").trim()).filter(Boolean).slice(0, max)
          : [];
        const uniq = (...sets: unknown[][]) => [...new Set(sets.flat().map((x) => String(x || "").trim()).filter(Boolean))].slice(0, 50);
        const primaryPain = String(signals.primary_pain || "").trim() || null;
        const secondaryPains = toStrings(signals.secondary_pains);
        const painPoints = uniq(primaryPain ? [primaryPain] : [], secondaryPains, toStrings(signals.pain_points));
        const goals = toStrings(signals.goals);
        const objections = toStrings(signals.objections);
        const servicesInterest = toStrings(signals.services_interest);
        const buyingSignals = toStrings(signals.buying_signals);
        const closingRisks = toStrings(signals.closing_risks);
        const closerBriefing = String(signals.closer_briefing || "").trim() || summary;
        const followUp = String(signals.follow_up || "").trim() || null;
        const now = new Date().toISOString();

        if (leadId) {
          const { data: existingProfile } = await sb.from("commercial_prospect_profiles")
            .select("*").eq("lead_id", leadId).maybeSingle();
          const sameAutoTranscript = Number(existingProfile?.last_transcript_id || 0) === transcriptId
            && existingProfile?.metadata?.human_confirmed !== true;
          const mergedPain = sameAutoTranscript ? painPoints : uniq(existingProfile?.pain_points || [], painPoints);
          const mergedSecondary = sameAutoTranscript ? secondaryPains : uniq(existingProfile?.secondary_pains || [], secondaryPains);
          const mergedGoals = sameAutoTranscript ? goals : uniq(existingProfile?.goals || [], goals);
          const mergedObjections = sameAutoTranscript ? objections : uniq(existingProfile?.objections || [], objections);
          const mergedServices = sameAutoTranscript ? servicesInterest : uniq(existingProfile?.services_interest || [], servicesInterest);
          const mergedBuying = sameAutoTranscript ? buyingSignals : uniq(existingProfile?.buying_signals || [], buyingSignals);
          const mergedRisks = sameAutoTranscript ? closingRisks : uniq(existingProfile?.closing_risks || [], closingRisks);
          const currentUrgency = String(signals.urgency || "").trim() || null;
          const currentDecisionRole = String(signals.decision_role || "").trim() || null;
          const currentStructure = String(signals.current_structure || "").trim() || null;
          const currentInvestment = String(signals.marketing_investment || "").trim() || null;
          const currentBrokerCount = signals.broker_count || null;

          const { error: profileError } = await sb.from("commercial_prospect_profiles").upsert({
            lead_id: leadId,
            primary_pain: sameAutoTranscript ? primaryPain : (primaryPain || existingProfile?.primary_pain || null),
            secondary_pains: mergedSecondary,
            pain_points: mergedPain,
            goals: mergedGoals,
            objections: mergedObjections,
            services_interest: mergedServices,
            buying_signals: mergedBuying,
            closing_risks: mergedRisks,
            urgency: sameAutoTranscript ? currentUrgency : (currentUrgency || existingProfile?.urgency || null),
            decision_role: sameAutoTranscript ? currentDecisionRole : (currentDecisionRole || existingProfile?.decision_role || null),
            current_structure: sameAutoTranscript ? currentStructure : (currentStructure || existingProfile?.current_structure || null),
            marketing_investment: sameAutoTranscript ? currentInvestment : (currentInvestment || existingProfile?.marketing_investment || null),
            broker_count: sameAutoTranscript ? currentBrokerCount : (currentBrokerCount || existingProfile?.broker_count || null),
            qualification_summary: summary,
            closer_briefing: closerBriefing,
            next_step: followUp || existingProfile?.next_step || null,
            sdr_person: transcriptRow?.owner_person || existingProfile?.sdr_person || null,
            closer_person: existingProfile?.closer_person || "Vitor Feitoza",
            last_call_at: transcriptRow?.meeting_started_at || now,
            last_transcript_id: transcriptId,
            metadata: {
              ...(existingProfile?.metadata || {}),
              last_ai_analysis: signals,
              last_interaction_type: String(transcriptRow?.transcript_source || "").includes("WHATSAPP") ? "CALL" : "MEETING",
              capture_session_id: captureSessionId,
              ai_updated_at: now,
            },
            updated_at: now,
          }, { onConflict: "lead_id" });
          if (profileError) throw profileError;

          const callPatch = {
            lead_id: leadId,
            capture_session_id: captureSessionId,
            transcript_id: transcriptId,
            sdr_person: transcriptRow?.owner_person || null,
            closer_person: "Vitor Feitoza",
            channel: String(transcriptRow?.transcript_source || "").includes("WHATSAPP") ? "WHATSAPP_DESKTOP" : "MEET",
            remote_phone: remotePhone || null,
            remote_name: session?.metadata?.remote_name || null,
            ai_summary: summary,
            primary_pain: primaryPain,
            secondary_pains: secondaryPains,
            pain_points: painPoints,
            goals,
            urgency: String(signals.urgency || "").trim() || null,
            decision_role: String(signals.decision_role || "").trim() || null,
            current_structure: String(signals.current_structure || "").trim() || null,
            services_interest: servicesInterest,
            objections,
            buying_signals: buyingSignals,
            closing_risks: closingRisks,
            closer_briefing: closerBriefing,
            next_step: followUp,
            metadata: {
              source: "RELATO_AI_AUTO",
              transcript_id: transcriptId,
              analysis_model: signals.model || null,
              human_confirmed: false,
            },
            updated_at: now,
          };
          if (captureSessionId) {
            const { error: callError } = await sb.from("commercial_call_records")
              .upsert(callPatch, { onConflict: "capture_session_id" });
            if (callError) throw callError;
          } else {
            const { data: existingCall } = await sb.from("commercial_call_records")
              .select("id").eq("transcript_id", transcriptId).limit(1).maybeSingle();
            const result = existingCall?.id
              ? await sb.from("commercial_call_records").update(callPatch).eq("id", existingCall.id)
              : await sb.from("commercial_call_records").insert(callPatch);
            if (result.error) throw result.error;
          }

          const activityType = String(transcriptRow?.transcript_source || "").includes("WHATSAPP") ? "ligacao" : "reuniao";
          const activityExternalId = `relato-transcript:${transcriptId}`;
          const activityContent = [
            `[RELATO AI] ${summary}`,
            primaryPain ? `Dor principal: ${primaryPain}` : null,
            secondaryPains.length ? `Dores secundárias: ${secondaryPains.join(" · ")}` : null,
            goals.length ? `Objetivos: ${goals.join(" · ")}` : null,
            signals.urgency ? `Urgência: ${String(signals.urgency)}` : null,
            signals.decision_role ? `Decisão: ${String(signals.decision_role)}` : null,
            objections.length ? `Objeções: ${objections.join(" · ")}` : null,
            buyingSignals.length ? `Sinais de compra: ${buyingSignals.join(" · ")}` : null,
            closingRisks.length ? `Riscos: ${closingRisks.join(" · ")}` : null,
            followUp ? `Próximo passo: ${followUp}` : null,
            closerBriefing ? `Briefing para closer: ${closerBriefing}` : null,
          ].filter(Boolean).join("\n");
          const { data: existingActivity } = await crm.from("lead_activities")
            .select("id").eq("external_id", activityExternalId).maybeSingle();
          const activityPatch = {
            lead_id: leadId,
            type: activityType,
            content: activityContent.slice(0, 20000),
            done: true,
            external_id: activityExternalId,
            metadata: {
              source: "RELATO_AI",
              transcript_id: transcriptId,
              capture_session_id: captureSessionId,
              sdr_person: transcriptRow?.owner_person || null,
              ai_generated: true,
              human_confirmed: false,
            },
          };
          const activityResult = existingActivity?.id
            ? await crm.from("lead_activities").update(activityPatch).eq("id", existingActivity.id)
            : await crm.from("lead_activities").insert(activityPatch);
          if (activityResult.error) throw activityResult.error;

          commercialSync = { status: "SYNCED", lead_id: leadId, activity_external_id: activityExternalId };
        } else {
          commercialSync = commercialSkipReason
            ? { status: "SKIPPED_NOT_COMMERCIAL", reason: commercialSkipReason, identity_status: identityStatus || null, identity_side: identitySide || null, classification: reviewClassification || null }
            : { status: "PENDING_BINDING", reason: "lead_id_not_resolved" };
        }

        const commercialProspect = leadId ? {
          lead_id: leadId,
          name: remoteName,
          phone: remotePhone,
          sdr_person: transcriptRow?.owner_person || null,
          closer_person: "Vitor Feitoza",
        } : null;
        const commercialMetadata = {
          ...(transcriptRow?.metadata || {}),
          commercial_analysis: signals,
          commercial_sync: commercialSync,
          ...(commercialProspect ? { commercial_prospect: commercialProspect } : {}),
          commercial_analysis_status: "READY",
          commercial_analysis_updated_at: now,
        };
        await sb.from("meeting_transcripts").update({ metadata: commercialMetadata, updated_at: now }).eq("id", transcriptId);
        if (captureSessionId) {
          await sb.from("meeting_capture_sessions").update({
            metadata: {
              ...(session?.metadata || {}),
              commercial_analysis: signals,
              commercial_sync: commercialSync,
              ...(commercialProspect ? { commercial_prospect: commercialProspect } : {}),
              commercial_analysis_status: "READY",
            },
            updated_at: now,
          }).eq("id", captureSessionId);
        }
      }

      await sb.from("meeting_capture_sessions").update({ state: "READY", updated_at: new Date().toISOString() }).eq("transcript_id", transcriptId);
      return json({ ok: true, transcript_id: transcriptId, status: "READY", commercial_sync: commercialSync });
    }
    if (action === "meeting_ready_notify") {
      const transcriptId = Number(body.transcript_id || 0);
      if (!Number.isInteger(transcriptId) || transcriptId <= 0) return json({ error: "transcript_id_required" }, 400);
      const sb = client("agency_ops");
      const { data: cfgRow, error: cfgError } = await sb.from("worker_runtime_config").select("value").eq("key", "meeting_notifications").maybeSingle();
      if (cfgError) throw cfgError;
      const cfg = (cfgRow?.value ?? {}) as Record<string, unknown>;
      if (String(cfg.mode ?? "off") !== "execute") return json({ ok: true, skipped: true, reason: "meeting_notifications_off" });
      const expectedInstance = String(cfg.instance_id ?? "").trim();
      const expectedConnectedPhone = String(cfg.connected_phone ?? "").replace(/\D/g, "");
      if (!expectedInstance || !expectedConnectedPhone) throw new Error("meeting_notifications_sender_not_configured");

      const claimed = await rpc("claim_meeting_ready_notification", { p_transcript_id: transcriptId }) as Array<Record<string, unknown>>;
      const notification = Array.isArray(claimed) ? claimed[0] : null;
      if (!notification?.notification_id) return json({ ok: true, skipped: true, reason: "not_ready_already_sent_or_no_phone" });

      const message = `? Reunião processada\n\n${String(notification.title ?? "Reunião")}\n${String(notification.client_name ?? "Cliente não vinculado")}\n\nResumo e transcrição já estão disponíveis no Dashboard.`;
      try {
        const recipientPhone = String(notification.recipient_phone ?? "");
        const queued = await sendWhatsApp(recipientPhone, message, expectedInstance);
        const delivery = await confirmRelatoDelivery(queued.message_id, recipientPhone, expectedInstance, expectedConnectedPhone);
        await rpc("finish_meeting_ready_notification", { p_notification_id: notification.notification_id, p_ok: true, p_error: null });
        return json({ ok: true, sent: true, confirmed: true, notification_id: notification.notification_id, message_id: queued.message_id, delivery });
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
