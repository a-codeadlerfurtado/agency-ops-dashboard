import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const api = process.env.WORKER_API_URL;
const token = process.env.AGENCY_WORKER_TOKEN;
const worker = process.env.WORKER_ID || "leonardoimobi-primary-1";
const pollMinMs = Number(process.env.POLL_MIN_MS || 5000);
const pollMaxMs = Number(process.env.POLL_MAX_MS || 60000);
const overdueDefaultIntervalMs = Number(process.env.OVERDUE_DEFAULT_INTERVAL_MS || 120000);
const apiTimeoutMs = Number(process.env.API_TIMEOUT_MS || 90000);
const calendarApi = process.env.GOOGLE_CALENDAR_API_URL || "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-google-calendar-api";

if (!api || !token) {
  console.error("missing_worker_configuration");
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
    const text = await response.text();    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { raw: text }; }
    if (!response.ok) throw new Error(`worker_api_${response.status}:${JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function offsetMinutes(now, timezone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const x of dtf.formatToParts(now)) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return (asUtc - now.getTime()) / 60000;
}

function startOfWindowToday(now, config) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: config.fuso, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p = {};
  for (const x of dtf.formatToParts(now)) p[x.type] = x.value;  const [h, m] = String(config.janela_hora_inicio).split(":").map(Number);
  const off = offsetMinutes(now, config.fuso);
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day, h, m, 0) - off * 60000);
}

function localParts(now, timezone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday").value;
  const hour = Number(parts.find((p) => p.type === "hour").value);
  const minute = Number(parts.find((p) => p.type === "minute").value);
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return { weekdayIso: map[wd], minutes: hour * 60 + minute };
}

function hhmmToMinutes(value) {
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

function insideWindow(now, config) {
  const { weekdayIso, minutes } = localParts(now, config.fuso);
  if (!config.janela_dias.includes(weekdayIso)) return false;
  return minutes >= hhmmToMinutes(config.janela_hora_inicio)
    && minutes < hhmmToMinutes(config.janela_hora_fim);
}
function minutesBetween(iso, now) {
  return (now.getTime() - new Date(iso).getTime()) / 60000;
}

function dbConversation(c) {
  return {
    telefone: c.telefone,
    status: c.status,
    pendente_desde: c.pendente_desde,
    ultimo_inbound_em: c.ultimo_inbound_em,
    ultimo_reply_sdr_em: c.ultimo_reply_sdr_em,
    nivel_alerta: c.nivel_alerta,
    ultimo_alerta_em: c.ultimo_alerta_em,
    resolvido_em: c.resolvido_em,
    tempo_primeira_resposta_seg: c.tempo_primeira_resposta_seg,
  };
}

function beforeFingerprint(c) {
  return {
    telefone: c.telefone,
    status: c.status,
    pendente_desde: c.pendente_desde,
    nivel_alerta: c.nivel_alerta,
    ultimo_alerta_em: c.ultimo_alerta_em,
  };
}

function evaluateConversation(conversation, config, now) {
  const c = { ...conversation };
  const none = () => ({ alerts: [], conversation: c });
  if (!insideWindow(now, config) || !c.pendente_desde) return none();  const opening = startOfWindowToday(now, config).getTime();
  const effectiveStart = Math.max(new Date(c.pendente_desde).getTime(), opening);
  const stopped = (now.getTime() - effectiveStart) / 60000;
  const sinceLastAlert = c.ultimo_alerta_em ? minutesBetween(c.ultimo_alerta_em, now) : Infinity;

  if (c.status === "aguardando_sdr") {
    const alerts = [];
    const level0 = Number(c.nivel_alerta || 0);
    if (stopped >= config.limite_1_min && level0 === 0) {
      alerts.push({ telefone: c.telefone, tipo: "sla_resposta", nivel: 1,
        canal: "whatsapp_sdr", minutos_parado: Math.floor(stopped) });
      c.nivel_alerta = 1;
      c.ultimo_alerta_em = now.toISOString();
    } else if (stopped >= config.limite_1_min && level0 >= 1
      && sinceLastAlert >= config.intervalo_repeticao_min) {
      alerts.push({ telefone: c.telefone, tipo: "sla_resposta", nivel: 1,
        canal: "whatsapp_sdr", minutos_parado: Math.floor(stopped) });
      c.ultimo_alerta_em = now.toISOString();
    }
    if (stopped >= config.limite_escalada_min && level0 < 2) {
      alerts.push({ telefone: c.telefone, tipo: "sla_resposta", nivel: 2,
        canal: "whatsapp_gestor", minutos_parado: Math.floor(stopped) });
      c.nivel_alerta = 2;
      c.ultimo_alerta_em = now.toISOString();
    }
    return { alerts, conversation: c };
  }
  if (c.status === "aguardando_lead") {
    const windowMinutes = Number(config.janela_follow_up_horas) * 60;
    if (stopped < windowMinutes) return none();
    if (Number(c.nivel_alerta || 0) >= Number(config.follow_up_max_repeticoes || 0)) {
      c.status = "frio";
      return { alerts: [], conversation: c };
    }
    if (sinceLastAlert >= windowMinutes) {
      c.nivel_alerta = Number(c.nivel_alerta || 0) + 1;
      c.ultimo_alerta_em = now.toISOString();
      return {
        alerts: [{ telefone: c.telefone, tipo: "follow_up", nivel: c.nivel_alerta,
          canal: "whatsapp_sdr", minutos_parado: Math.floor(stopped) }],
        conversation: c,
      };
    }
  }
  return none();
}

function buildProposals(snapshot) {
  const config = snapshot.config;
  const now = new Date(snapshot.snapshot_at);
  const proposals = [];
  const candidates = [];
  for (const original of snapshot.conversations || []) {
    const evaluated = evaluateConversation(original, config, now);
    const next = evaluated.conversation;
    const changed = next.status !== original.status
      || Number(next.nivel_alerta || 0) !== Number(original.nivel_alerta || 0)
      || String(next.ultimo_alerta_em || "") !== String(original.ultimo_alerta_em || "");    if (changed || evaluated.alerts.length) {
      proposals.push({
        before: beforeFingerprint(original),
        after: dbConversation(next),
        alerts: evaluated.alerts,
      });
    }
    for (const a of evaluated.alerts) {
      candidates.push({
        telefone: a.telefone,
        tipo: a.tipo,
        nivel: a.nivel,
        canal: a.canal,
        minutos_parado: a.minutos_parado,
      });
    }
  }
  return { proposals, candidates, now };
}

function summarize(snapshot, built) {
  const alerts = built.candidates;
  return {
    snapshot_at: snapshot.snapshot_at,
    pending_count: (snapshot.conversations || []).length,
    proposals_count: built.proposals.length,
    alerts_sdr: alerts.filter((a) => a.canal === "whatsapp_sdr").length,
    alerts_gestor: alerts.filter((a) => a.canal === "whatsapp_gestor").length,
    followups: alerts.filter((a) => a.tipo === "follow_up").length,
    to_cold: built.proposals.filter((p) => p.after.status === "frio" && p.before.status !== "frio").length,
    inside_window: insideWindow(built.now, snapshot.config),
    candidates: alerts.slice(0, 50),
  };
}
async function runOverdueCycle(forcedMode = null) {
  const startedAt = new Date().toISOString();
  const snapshot = await call("overdue_snapshot");
  const mode = forcedMode || snapshot.control?.mode || "off";
  const intervalMs = Number(snapshot.control?.interval_ms || overdueDefaultIntervalMs);
  if (mode === "off") return { mode, intervalMs, skipped: true };

  if (!snapshot.config?.numero_sdr) {
    const result = { configured: false, reason: "numero_sdr_missing" };
    await call("overdue_report", { mode, status: "skipped", started_at: startedAt, result });
    return { mode, intervalMs, ...result };
  }

  const built = buildProposals(snapshot);
  const summary = summarize(snapshot, built);
  if (mode === "shadow") {
    await call("overdue_report", { mode, status: "ok", started_at: startedAt, result: summary });
    console.log(JSON.stringify({ event: "overdue_shadow", ...summary }));
    return { mode, intervalMs, summary };
  }

  if (mode === "execute") {
    const applied = await call("overdue_apply", {
      snapshot_at: snapshot.snapshot_at,
      proposals: built.proposals,
    });
    const result = { ...summary, applied };
    await call("overdue_report", { mode, status: "ok", started_at: startedAt, result });
    console.log(JSON.stringify({ event: "overdue_execute", ...result }));
    return { mode, intervalMs, result };
  }

  throw new Error(`unsupported_overdue_mode:${mode}`);
}
const ollamaUrl = String(process.env.OLLAMA_URL || "http://ollama:11434").replace(/\/$/, "");
const meetingModel = process.env.MEETING_MODEL || "qwen3:1.7b";
const meetingChunkChars = Math.max(6000, Math.min(Number(process.env.MEETING_CHUNK_CHARS || 10000), 18000));

const whisperUrl = String(process.env.WHISPER_URL || "http://agency-whisper:8000/v1").replace(/\/$/, "");
const whisperModel = process.env.RELATO_WHISPER_MODEL || "deepdml/faster-whisper-large-v3-turbo-ct2";
const whisperApiKey = process.env.WHISPER_API_KEY || "local-relato";

function segmentClock(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hh = String(Math.floor(total / 3600)).padStart(2, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function likelyWhisperHallucination(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return false;
  const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/transcricao e legendas|legenda(s)? por|legendas pela comunidade|amara\.org|obrigado por assistir|inscreva-se no canal|subscribe|subtitles by|transcreva literalmente|não complete frases|nao complete frases/i.test(normalized)) return true;
  if (/^legenda\s+[a-z]{2,}(?:\s+[a-z]{2,}){0,3}[.!]?$/i.test(normalized)) return true;
  const words = normalized.replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length < 12) return false;
  const uniqueRatio = new Set(words).size / words.length;
  if (words.length >= 20 && uniqueRatio <= 0.20) return true;
  for (const size of [2, 3, 4]) {
    if (words.length < size * 4) continue;
    const counts = new Map();
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

async function whisperTranscribe(audio, speakerName, transcriptSource = "WHATSAPP_WEB_WHISPER") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
  const dir = await mkdtemp(join(tmpdir(), "relato-stt-"));
  try {
    const source = await fetch(String(audio.signed_url), { signal: controller.signal });
    if (!source.ok) throw new Error(`call_audio_download_${source.status}`);
    const bytes = Buffer.from(await source.arrayBuffer());
    if (!bytes.length) throw new Error("call_audio_empty");
    const rawPath = String(audio.path || "").toLowerCase();
    const ext = rawPath.endsWith(".webm") ? ".webm" : rawPath.endsWith(".mp3") ? ".mp3" : ".wav";
    const input = join(dir, "input" + ext);
    const normalized = join(dir, "normalized.wav");
    await writeFile(input, bytes);
    await execFileAsync("ffmpeg", [
      "-hide_banner","-loglevel","error","-y",
      "-i",input,"-vn",
      "-af","highpass=f=80,lowpass=f=7800,dynaudnorm=f=150:g=15:p=0.9",
      "-ac","1","-ar","16000","-c:a","pcm_s16le",normalized
    ], { timeout: 120000 });
    const normalizedBytes = await readFile(normalized);
    const blob = new Blob([normalizedBytes], { type: "audio/wav" });
    const form = new FormData();
    form.append("file", blob, `${audio.role || "audio"}.wav`);
    form.append("model", whisperModel);
    form.append("language", "pt");
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    // VAD padrão do faster-whisper remove pausas longas sem alterar o relógio original
    // dos segmentos; reduz CPU e evita que silêncio vire texto inventado.
    form.append("vad_filter", "true");
    // Não enviar prompt textual ao Whisper: em áudio curto/silencioso alguns backends
    // podem ecoar o prompt como se fosse fala real.
    const response = await fetch(`${whisperUrl}/audio/transcriptions`, {
      method: "POST",
      headers: whisperApiKey ? { Authorization: `Bearer ${whisperApiKey}` } : {},
      body: form,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`whisper_${response.status}:${raw.slice(0,500)}`);
    const body = JSON.parse(raw || "{}");
    const segments = Array.isArray(body.segments) ? body.segments : [];
    return segments.map((seg, index) => {
      const avgLogprob = Number(seg.avg_logprob);
      const noSpeechProb = Number(seg.no_speech_prob);
      const confidence = Number.isFinite(avgLogprob) ? Math.max(0, Math.min(1, Math.exp(avgLogprob))) : null;
      return {
        sequence_no: index,
        started_ms: Math.max(0, Math.round(Number(seg.start || 0) * 1000)),
        ended_ms: Math.max(0, Math.round(Number(seg.end || seg.start || 0) * 1000)),
        speaker_key: speakerName,
        speaker_name: speakerName,
        device_id: null,
        text: String(seg.text || "").trim(),
        confidence,
        avg_logprob: Number.isFinite(avgLogprob) ? avgLogprob : null,
        no_speech_prob: Number.isFinite(noSpeechProb) ? noSpeechProb : null,
        source: transcriptSource,
      };
    }).filter((seg) =>
      seg.text &&
      !likelyWhisperHallucination(seg.text) &&
      (seg.no_speech_prob == null || seg.no_speech_prob < 0.65) &&
      (seg.avg_logprob == null || seg.avg_logprob > -1.15)
    );
  } finally {
    clearTimeout(timeout);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
async function ensureMixedAudio(snapshot, sessionId) {
  const upload = snapshot?.mixed_upload;
  if (!upload?.signed_url || !upload?.path || snapshot?.session?.audio_mixed_path) return null;
  const audio = Array.isArray(snapshot?.audio) ? snapshot.audio : [];
  if (!audio.length) return null;
  const dir = await mkdtemp(join(tmpdir(), "relato-mix-"));
  try {
    const inputs = [];
    for (const item of audio) {
      const response = await fetch(item.signed_url);
      if (!response.ok) throw new Error("audio_download_" + response.status);
      const ext = String(item.path || "").toLowerCase().endsWith(".webm") ? ".webm" : ".wav";
      const file = join(dir, String(item.role || "audio") + ext);
      await writeFile(file, Buffer.from(await response.arrayBuffer()));
      inputs.push(file);
    }
    const output = join(dir, "mixed.mp3");
    const args = ["-hide_banner","-loglevel","error","-y"];
    for (const file of inputs) args.push("-i", file);
    if (inputs.length >= 2) {
      args.push("-filter_complex","[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0,alimiter=limit=0.95[a]","-map","[a]");
    }
    args.push("-vn","-c:a","libmp3lame","-b:a","128k","-ac","1","-ar","48000",output);
    await execFileAsync("ffmpeg", args, { timeout: 120000 });
    const bytes = await readFile(output);
    const put = await fetch(upload.signed_url, { method: "PUT", headers: { "content-type": "audio/mpeg", "x-upsert": "true" }, body: bytes });
    if (!put.ok) throw new Error("mixed_upload_" + put.status + ":" + (await put.text()).slice(0,300));
    await call("call_audio_commit", { session_id: sessionId, path: upload.path, bytes: bytes.length }, 120000);
    return { path: upload.path, bytes: bytes.length };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function processCallJob(job) {
  const sessionId = String(job?.payload?.session_id || "").trim();
  if (!sessionId) throw new Error("call_job_missing_session_id");
  const snapshot = await call("call_snapshot", { session_id: sessionId }, 120000);
  const session = snapshot.session || {};
  await ensureMixedAudio(snapshot, sessionId).catch((error) => {
    console.error(JSON.stringify({ event: "call_audio_mix_failed", session_id: sessionId, error: String(error?.message || error) }));
  });
  const genericContactNames = new Set(["contato whatsapp","contato whatsapp desktop","contato","participante"]);
  const rawRemoteName = String(session.metadata?.remote_name || "").trim();
  const rawContactName = String(session.metadata?.contact_name || "").trim();
  const safeRemoteName = rawRemoteName && !genericContactNames.has(rawRemoteName.toLowerCase()) ? rawRemoteName : "";
  const safeContactName = rawContactName && !genericContactNames.has(rawContactName.toLowerCase()) ? rawContactName : "";
  const contactName = safeRemoteName || safeContactName || "Contato WhatsApp";
  const ownerName = String(session.owner_person || "Colaborador").trim() || "Colaborador";
  const audio = Array.isArray(snapshot.audio) ? snapshot.audio : [];
  if (!audio.length) throw new Error("call_audio_not_found");
  const transcriptSource = String(session.capture_mode || "").toUpperCase() === "WHATSAPP_DESKTOP_AUDIO"
    ? "WHATSAPP_DESKTOP_WHISPER"
    : "WHATSAPP_WEB_WHISPER";
  const channelResults = await Promise.all(audio.map(async (item) => {
    const speaker = item.role === "local" ? ownerName : contactName;
    return await whisperTranscribe(item, speaker, transcriptSource);
  }));
  const collected = channelResults.flat();
  collected.sort((a,b) => Number(a.started_ms || 0) - Number(b.started_ms || 0));
  const phraseCounts=new Map();
  for(const row of collected){
    const key=String(row.text||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    if(key) phraseCounts.set(key,(phraseCounts.get(key)||0)+1);
  }
  const cleaned=collected.filter((row)=>{
    if(likelyWhisperHallucination(row.text)) return false;
    const key=String(row.text||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
    if(!key) return false;
    const words=key.split(/\s+/).filter(Boolean).length;
    const repeats=phraseCounts.get(key)||0;
    // Whisper tende a entrar em loop no fim de áudio/silêncio. Frases iguais muitas
    // vezes na mesma call são descartadas por completo, inclusive bordões curtos.
    if(repeats>=7) return false;
    if(words>=3 && words<=12 && repeats>=4) return false;
    return true;
  });
  const segments = cleaned.map((row,index) => ({ ...row, sequence_no:index }));
  const transcriptText = segments.map((row) => `[${segmentClock(row.started_ms)}] ${row.speaker_name}: ${row.text}`).join("\n\n");
  if (transcriptText.trim().length < 3) throw new Error("call_transcript_empty");
  const committed = await call("call_commit", { session_id:sessionId, transcript_text:transcriptText, segments }, 120000);
  return { ok:true, session_id:sessionId, transcript_id:committed.transcript_id, segments:segments.length };
}


function meetingText(snapshot) {
  const segments = Array.isArray(snapshot?.segments) ? snapshot.segments : [];
  if (segments.length) return segments.map((s) => {
    const ms = Number(s.started_ms || 0);
    const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
    const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
    const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
    return `[${hh}:${mm}:${ss}] ${String(s.speaker_name || s.speaker_key || "Participante")}: ${String(s.text || "").trim()}`;
  }).filter(Boolean).join("\n");
  return String(snapshot?.transcript?.transcript_text || "");
}

function chunkText(text, maxChars = meetingChunkChars) {
  const lines = String(text || "").split("\n");
  const chunks = []; let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChars && current) { chunks.push(current); current = line; }
    else current = next;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

const analysisSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    decisions: { type: "array", items: { type: "string" } },
    commitments: { type: "array", items: { type: "string" } },
    action_items: { type: "array", items: { type: "object", properties: { title: { type: "string" }, owner: { type: "string" }, due_date: { type: "string" }, evidence: { type: "string" } }, required: ["title","owner","due_date","evidence"] } },
    summary_topics: { type: "array", items: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title","body"] } },
    highlights: { type: "object", properties: {
      opportunities: { type: "array", items: { type: "string" } }, insights: { type: "array", items: { type: "string" } },
      ideas: { type: "array", items: { type: "string" } }, objectives: { type: "array", items: { type: "string" } },
      problems: { type: "array", items: { type: "string" } }, lessons: { type: "array", items: { type: "string" } }
    }, required: ["opportunities","insights","ideas","objectives","problems","lessons"] },
    keywords: { type: "array", items: { type: "string" } },
    rewritten_notes: { type: "array", items: { type: "object", properties: { speaker: { type: "string" }, timestamp: { type: "string" }, original: { type: "string" }, rewritten: { type: "string" } }, required: ["speaker","timestamp","original","rewritten"] } },
    objections: { type: "array", items: { type: "string" } },
    pain_points: { type: "array", items: { type: "string" } },
    primary_pain: { type: "string" },
    secondary_pains: { type: "array", items: { type: "string" } },
    goals: { type: "array", items: { type: "string" } },
    urgency: { type: "string" },
    decision_role: { type: "string" },
    current_structure: { type: "string" },
    marketing_investment: { type: "string" },
    broker_count: { type: "integer" },
    services_interest: { type: "array", items: { type: "string" } },
    buying_signals: { type: "array", items: { type: "string" } },
    closing_risks: { type: "array", items: { type: "string" } },
    closer_briefing: { type: "string" },
    opportunities: { type: "array", items: { type: "string" } },
    follow_up: { type: "string" }
  },
  required: ["summary","decisions","commitments","action_items","summary_topics","highlights","keywords","rewritten_notes","objections","pain_points","primary_pain","secondary_pains","goals","urgency","decision_role","current_structure","marketing_investment","broker_count","services_interest","buying_signals","closing_risks","closer_briefing","opportunities","follow_up"]
};

async function ollamaJson(prompt, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: meetingModel,
        messages: [{ role: "system", content: "Responda somente com JSON vÃ¡lido em portuguÃªs do Brasil. NÃ£o invente fatos." }, { role: "user", content: prompt }],
        stream: false,
        think: false,
        format: analysisSchema,
        options: { temperature: 0.1, num_ctx: 8192, num_predict: 2048 },
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`ollama_${res.status}:${raw.slice(0, 500)}`);
    const envelope = JSON.parse(raw);
    const parsed = JSON.parse(String(envelope?.message?.content || "{}"));
    if (!String(parsed.summary || "").trim()) throw new Error("ollama_empty_summary");
    return parsed;
  } finally { clearTimeout(timeout); }
}

const analysisShape = `Preencha todos os campos do schema sem inventar. summary deve resumir fatos concretos. Para contexto comercial, identifique a dor primária mais determinante, dores secundárias, objetivos, urgência/timing, papel de decisão, estrutura atual, investimento em marketing, quantidade de corretores quando explicitamente dita, serviços de interesse, sinais de compra, riscos de fechamento e objeções. closer_briefing deve ser um briefing curto e acionável para o closer: contexto, o que explorar, o que evitar prometer e pontos que precisam ser validados na reunião de fechamento. decisions e commitments devem conter apenas itens explicitamente presentes. action_items precisa preservar responsável, prazo e evidência quando existirem. Se não houver dado, use array vazio, string vazia ou 0.`;

async function analyzeMeeting(snapshot) {
  const transcript = snapshot.transcript || {};
  const text = meetingText(snapshot);
  if (text.trim().length < 20) throw new Error("meeting_transcript_too_short");
  const chunks = chunkText(text);
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const prompt = `VocÃª analisa uma reuniÃ£o em portuguÃªs do Brasil. Preserve nomes, nÃºmeros, datas, promessas e responsÃ¡veis exatamente como aparecem. ${analysisShape}\n\nContexto: tÃ­tulo=${transcript.source_file_name || "ReuniÃ£o"}; cliente=${transcript.client_name_raw || "nÃ£o vinculado"}; responsÃ¡vel=${transcript.owner_person || "nÃ£o definido"}.\n\nTrecho ${i + 1}/${chunks.length}:\n${chunks[i]}`;
    partials.push(await ollamaJson(prompt));
  }
  if (partials.length === 1) return { ...partials[0], model: meetingModel };
  const packed = JSON.stringify(partials).slice(0, 30000);
  const finalPrompt = `Consolide anÃ¡lises parciais da MESMA reuniÃ£o. Remova duplicatas, preserve divergÃªncias relevantes e nÃ£o invente nada. ${analysisShape}\n\nAnÃ¡lises parciais:\n${packed}`;
  const final = await ollamaJson(finalPrompt);
  return { ...final, model: meetingModel };
}

function fallbackMeetingAnalysis(snapshot, error) {
  const raw = meetingText(snapshot).replace(/\s+/g, " ").trim();
  const summary = raw.length > 1200 ? raw.slice(0, 1197) + "..." : raw;
  return {
    summary: summary || "Transcrição capturada; resumo automático indisponível.",
    decisions: [], commitments: [], action_items: [], summary_topics: [],
    highlights: { opportunities: [], insights: [], ideas: [], objectives: [], problems: [], lessons: [] },
    keywords: [], rewritten_notes: [], objections: [], pain_points: [],
    primary_pain: "", secondary_pains: [], goals: [], urgency: "", decision_role: "",
    current_structure: "", marketing_investment: "", broker_count: 0, services_interest: [],
    buying_signals: [], closing_risks: [], closer_briefing: "", opportunities: [], follow_up: "",
    model: "extractive-fallback",
    fallback_reason: String(error?.message || error || "analysis_failed").slice(0, 500),
  };
}

async function processMeetingJob(job) {
  const transcriptId = Number(job?.payload?.transcript_id || 0);
  if (!Number.isInteger(transcriptId) || transcriptId <= 0) throw new Error("meeting_job_missing_transcript_id");
  const snapshot = await call("meeting_snapshot", { transcript_id: transcriptId }, 120000);
  let analysis;
  try {
    analysis = await analyzeMeeting(snapshot);
  } catch (error) {
    console.error(JSON.stringify({ event: "meeting_analysis_fallback", transcript_id: transcriptId, error: String(error?.message || error) }));
    analysis = fallbackMeetingAnalysis(snapshot, error);
  }
  if (String(job?.payload?.mode || "execute") === "shadow") return { ok: true, shadow: true, transcript_id: transcriptId, analysis };
  const committed = await call("meeting_commit", { transcript_id: transcriptId, analysis }, 120000);
  const notification = await call("meeting_ready_notify", { transcript_id: transcriptId }, 120000).catch((error) => ({ ok: false, error: String(error?.message || error) }));
  return { ok: true, transcript_id: transcriptId, committed, notification, model: analysis.model || meetingModel };
}
const agendaSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["CREATE_MEETING", "OTHER"] },
    has_client: { type: "boolean" },
    has_date: { type: "boolean" },
    has_time: { type: "boolean" },
    client_name: { type: "string" },
    meeting_type: { type: "string", enum: ["Alinhamento", "Reuniao Comercial", "Onboarding", "Kickoff", "Briefing", "Analise de Performance", "Planejamento", "Revisao", "Follow-up", "Entrevista", "Reuniao Interna", "Outro"] },
    subject: { type: "string" },
    title_core: { type: "string" },
    start_time: { type: "string" },
    duration_minutes: { type: "integer" },
    attendee_names: { type: "array", items: { type: "string" } },
    attendee_emails: { type: "array", items: { type: "string" } },
    description: { type: "string" },
    needs_clarification: { type: "boolean" },
    clarification_question: { type: "string" }
  },
  required: ["intent", "has_client", "has_date", "has_time", "client_name", "meeting_type", "subject", "title_core", "start_time", "duration_minutes", "attendee_names", "attendee_emails", "description", "needs_clarification", "clarification_question"]
};

function normName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, " ").trim().toLowerCase();
}
function canonicalClient(parsed, snapshot) {
  const clients = Array.isArray(snapshot?.clients) ? snapshot.clients : [];
  const aliases = Array.isArray(snapshot?.aliases) ? snapshot.aliases : [];
  const byId = new Map(clients.map((c) => [String(c.client_id || ""), String(c.display_name || "").trim()]));
  const target = normName(parsed?.client_name);
  const message = normName(snapshot?.command?.raw_text);
  if (target) {
    const exact = clients.find((c) => normName(c.display_name) === target);
    if (exact) return { name: String(exact.display_name), source: "catalog_exact" };
    const alias = aliases.find((a) => normName(a.alias) === target && byId.has(String(a.client_id || "")));
    if (alias) return { name: byId.get(String(alias.client_id)), source: "alias_exact" };
  }
  const mentioned = clients.filter((c) => {
    const n = normName(c.display_name);
    return n.length >= 3 && message.includes(n);
  }).sort((a, b) => normName(b.display_name).length - normName(a.display_name).length)[0];
  if (mentioned) return { name: String(mentioned.display_name), source: "catalog_message" };
  if (parsed?.has_client && String(parsed?.client_name || "").trim()) return { name: String(parsed.client_name).trim().toUpperCase(), source: "parsed_raw" };
  return { name: "", source: "none" };
}
function calendarCore(parsed) {
  let core = String(parsed?.title_core || "").replace(/^\s*\[[^\]]+\]\s*/, "").replace(/\s+/g, " ").trim();
  if (!core) core = [parsed?.meeting_type, parsed?.subject].filter(Boolean).join(" ").trim();
  if (!core) core = "Alinhamento";
  core = core.replace(/^reuni[aÃ£]o\s+com\s+[^:â€“â€”-]+[:â€“â€”-]?\s*/i, "").trim() || "Alinhamento";
  return core.charAt(0).toUpperCase() + core.slice(1, 119);
}
async function ollamaAgenda(snapshot) {
  const clients = (snapshot.clients || []).map((c) => c.display_name).filter(Boolean).join(" | ");
  const conversation = String(snapshot.conversation_text || snapshot.command?.raw_text || "").slice(-12000);
  const previous = snapshot.previous_event ? JSON.stringify({ title:snapshot.previous_event.calendar_title, client:snapshot.previous_event.client_name, parsed:snapshot.previous_event.parsed_intent, event_id:snapshot.previous_event.calendar_event_id }) : "null";
  const prompt = `Interprete a conversa de WhatsApp como um assistente de agenda. Agora=${snapshot.now}; fuso=${snapshot.timezone}. Conversa=${JSON.stringify(conversation)}. Evento anterior=${previous}. Clientes conhecidos=${clients}.`;
  const rules = "Regras: considere TODA a conversa, inclusive respostas curtas como hoje, 15h ou Murano. has_date/has_time indicam se a conversa cumulativa definiu dia e horario. Se um evento anterior ja tem data/hora, preserve-os quando a resposta atual trouxer apenas cliente/assunto. Duracao padrao 60 min. Nao invente e-mails. client_name deve conter apenas cliente/empresa. title_core nao pode conter cliente, data, hora ou colchetes. Escolha titulo curto e profissional. Exemplo: marca com Murano hoje 14h para discutir sistema novo de acompanhamento comercial => client_name=MURANO, title_core=Alinhamento Sistema de Acompanhamento Comercial. start_time deve ser ISO 8601 completo com offset -03:00 quando data+hora estiverem definidos. needs_clarification pode ser true para contexto ausente, mas NUNCA omita start_time se data+hora estiverem claros.";
  const res = await fetch(`${ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: meetingModel,
      messages: [{ role: "system", content: "Responda apenas JSON valido. Nao invente dados." }, { role: "user", content: `${prompt}\n${rules}` }],
      stream: false,
      think: false,
      format: agendaSchema,
      options: { temperature: 0.05, num_ctx: 8192, num_predict: 700 }
    })
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`ollama_agenda_${res.status}:${raw.slice(0, 500)}`);
  const env = JSON.parse(raw);
  return JSON.parse(String(env?.message?.content || "{}"));
}
async function calendarAction(action, payload) {
  const res = await fetch(calendarApi, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agency-worker-token": token },
    body: JSON.stringify({ action, ...payload })
  });
  const raw = await res.text();
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (!res.ok) {
    const err = new Error(`calendar_api_${res.status}:${JSON.stringify(body).slice(0, 600)}`);
    err.status = res.status; err.body = body; throw err;
  }
  return body;
}
const calendarCreate = (payload) => calendarAction("create_event", payload);
const calendarUpdate = (payload) => calendarAction("update_event", payload);
const calendarCancel = (payload) => calendarAction("cancel_event", payload);

function agendaReplyDate(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
}
function provisionalTitle(clientName, core) {
  return `[${clientName || "CLIENTE A DEFINIR"}] ${core || "Reunião"}`;
}
function startFromParsed(parsed, previous) {
  const raw = String(parsed?.start_time || previous?.parsed_intent?.start_time || "").trim();
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}
function agendaMissing(parsed, clientName) {
  if (!parsed?.has_date) return "date";
  if (!parsed?.has_time) return "time";
  if (!clientName) return "client";
  if (!String(parsed?.subject || "").trim()) return "subject";
  return null;
}
function questionFor(field) {
  if (field === "date") return "Certo. Qual é o dia da reunião?";
  if (field === "time") return "Perfeito. Qual é o horário da reunião?";
  if (field === "client") return "Com qual cliente será a reunião?";
  if (field === "subject") return "Entendi! Qual será o assunto da reunião?";
  return "Qual informação falta para eu completar a reunião?";
}
async function processAgendaJob(job) {
  const commandId = String(job?.payload?.command_id || "").trim();
  if (!commandId) throw new Error("agenda_job_missing_command_id");
  const snapshot = await call("agenda_snapshot", { command_id: commandId }, 120000);
  const parsed = await ollamaAgenda(snapshot);
  if (parsed.intent !== "CREATE_MEETING") return await call("agenda_finish", { command_id: commandId, status: "IGNORED", parsed_intent: parsed });
  const previous = snapshot.previous_event || null;
  const client = canonicalClient(parsed, snapshot);
  const clientName = client.name || String(previous?.client_name || "").trim();
  const core = calendarCore(parsed) || String(previous?.parsed_intent?.title_core || "").trim() || "Reunião";
  const title = provisionalTitle(clientName, core);
  const start = startFromParsed(parsed, previous);
  const hasDate = Boolean(parsed.has_date || previous?.parsed_intent?.has_date || start);
  const hasTime = Boolean(parsed.has_time || previous?.parsed_intent?.has_time || start);
  const enriched = { ...parsed, has_date:hasDate, has_time:hasTime, client_canonical: clientName || null, client_source: client.source, calendar_title: title, start_time:start?.toISOString() || "" };
  const timeMissing = !start || !hasDate || !hasTime;
  if (timeMissing) {
    const pending = !hasDate ? "date" : !hasTime ? "time" : "time";
    return await call("agenda_finish", { command_id:commandId, status:"NEEDS_INPUT", parsed_intent:enriched, pending_field:pending, calendar_title:title, client_name:clientName || null, reply_text:questionFor(pending) });
  }
  if (start.getTime() < Date.now()-5*60_000) return await call("agenda_finish", { command_id:commandId, status:"NEEDS_INPUT", parsed_intent:enriched, pending_field:"date", reply_text:`O horário que entendi para *${title}* já passou. Qual novo dia e horário você quer?` });
  if (snapshot.google?.status !== "ACTIVE") return await call("agenda_finish", { command_id:commandId, status:"NEEDS_GOOGLE", parsed_intent:enriched, calendar_title:title, client_name:clientName || null, reply_text:`Entendi *${title}*, mas sua Agenda Google ainda não está conectada. Conecte o Google uma vez no Dashboard > Reuniões > Integrações.` });
  const duration = Math.max(15,Math.min(Number(parsed.duration_minutes || previous?.parsed_intent?.duration_minutes || 60),480));
  const end = new Date(start.getTime()+duration*60_000);
  const explicitEmails=[...String(snapshot.conversation_text||snapshot.command?.raw_text||"").matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map(m=>m[0]);
  const payload={ owner_person:snapshot.command.owner_person, title, description:String(parsed.description||snapshot.conversation_text||snapshot.command.raw_text||"").slice(0,5000), start_time:start.toISOString(), end_time:end.toISOString(), attendee_names:parsed.attendee_names||[], attendee_emails:[...new Set([...(parsed.attendee_emails||[]),...explicitEmails])] };
  let event;
  try { event=previous?.calendar_event_id ? await calendarUpdate({ ...payload, event_id:previous.calendar_event_id }) : await calendarCreate(payload); }
  catch(error){ if(error?.status===409||error?.body?.needs_google) return await call("agenda_finish",{command_id:commandId,status:"NEEDS_GOOGLE",parsed_intent:enriched,reply_text:`Entendi *${title}*, mas preciso que você reconecte sua Agenda Google no Dashboard.`}); throw error; }
  const contextMissing = !clientName ? "client" : !String(parsed.subject||previous?.parsed_intent?.subject||"").trim() ? "subject" : null;
  const link=event.meet_url?`\n🔗 ${event.meet_url}`:"";
  const base=`✅ Reunião ${previous?.calendar_event_id?"atualizada":"marcada"}\n\n*${title}*\n${agendaReplyDate(event.start_time||start.toISOString())}${link}`;
  if(contextMissing) return await call("agenda_finish",{command_id:commandId,status:"NEEDS_INPUT",pending_field:contextMissing,parsed_intent:enriched,calendar_event_id:event.event_id,calendar_html_link:event.html_link,meet_url:event.meet_url,calendar_title:title,client_name:clientName||null,reply_text:`${base}\n\n${questionFor(contextMissing)}`});
  return await call("agenda_finish",{command_id:commandId,status:"DONE",parsed_intent:enriched,calendar_event_id:event.event_id,calendar_html_link:event.html_link,meet_url:event.meet_url,calendar_title:title,client_name:clientName||null,reply_text:base});
}
function groupTitle(snapshot) {
  const client=String(snapshot.client?.display_name||snapshot.group?.client_name||"CLIENTE A DEFINIR").trim();
  const topic=String(snapshot.event?.topic||"Reunião / alinhamento");
  const text=normName(snapshot.raw_text||"");
  let core="Alinhamento";
  if(topic==="Call de INT") core=/contas?/.test(text)?"Integração de Contas":"Reunião de Integração";
  else if(topic==="Call de PP") core=/briefing/.test(text)?"Apresentação de Briefing de Produto e Persona":"Apresentação de Produto e Persona";
  else if(topic==="Call de AP") core="Apresentação de Onboarding";
  else if(/performance|campanha|lead|resultado/.test(text)) core="Análise de Performance";
  else if(topic && topic!=="Reunião / alinhamento") core=topic;
  return `[${client}] ${core}`;
}
async function processGroupMeetingCalendarJob(job) {
  const eventId=Number(job?.payload?.agenda_event_id||0);
  if(!Number.isInteger(eventId)||eventId<=0) throw new Error("group_agenda_event_missing");
  const snap=await call("group_meeting_snapshot",{agenda_event_id:eventId},120000);
  const ev=snap.event||{};
  const oldOwner=String(ev.calendar_owner_person||"").trim();
  if(["CANCELLED","SUPERSEDED"].includes(String(ev.status||"").toUpperCase())){
    if(ev.calendar_event_id&&oldOwner) await calendarCancel({owner_person:oldOwner,event_id:ev.calendar_event_id}).catch(e=>{if(e?.status!==404&&e?.status!==410)throw e});
    return await call("group_meeting_commit",{agenda_event_id:eventId,sync_status:"CANCELLED",calendar_owner_person:oldOwner||snap.route_owner||null});
  }
  if(String(ev.status)!=="SCHEDULED") return {ok:true,ignored:true,status:ev.status};
  const owner=String(snap.route_owner||"").trim();
  if(!owner) return await call("group_meeting_commit",{agenda_event_id:eventId,sync_status:"ERROR",error:"calendar_owner_unresolved"});
  if(snap.google?.status!=="ACTIVE") return await call("group_meeting_commit",{agenda_event_id:eventId,sync_status:"NEEDS_GOOGLE",calendar_owner_person:owner,error:"google_not_connected"});
  const start=new Date(ev.scheduled_for); if(Number.isNaN(start.getTime())) throw new Error("invalid_group_meeting_time");
  const duration=Math.max(15,Math.min(Number(ev.duration_minutes||60),480)); const end=new Date(start.getTime()+duration*60_000);
  const title=groupTitle(snap);
  const description=`Agendamento detectado automaticamente no WhatsApp.\nGrupo: ${snap.group?.chat_name||ev.chat_name||""}\nEvidência: ${snap.raw_text||""}`.slice(0,5000);
  let result;
  if(ev.calendar_event_id&&oldOwner&&oldOwner!==owner){
    await calendarCancel({owner_person:oldOwner,event_id:ev.calendar_event_id}).catch(()=>{});
    result=await calendarCreate({owner_person:owner,title,description,start_time:start.toISOString(),end_time:end.toISOString(),attendee_names:[],attendee_emails:[]});
  }else if(ev.calendar_event_id){
    result=await calendarUpdate({owner_person:owner,event_id:ev.calendar_event_id,title,description,start_time:start.toISOString(),end_time:end.toISOString(),attendee_names:[],attendee_emails:[]});
  }else{
    result=await calendarCreate({owner_person:owner,title,description,start_time:start.toISOString(),end_time:end.toISOString(),attendee_names:[],attendee_emails:[]});
  }
  return await call("group_meeting_commit",{agenda_event_id:eventId,sync_status:"SYNCED",calendar_event_id:result.event_id,calendar_html_link:result.html_link,meet_url:result.meet_url,calendar_owner_person:owner,calendar_title:title});
}

async function handleQueueJob(job) {
  const type = String(job.job_type || "").toUpperCase();
  if (type === "SELF_TEST") {
    await sleep(500);
    return {
      ok: true,
      executed_by: worker,
      runtime: process.version,
      processed_at: new Date().toISOString(),
    };
  }
  if (type === "CHECK_OVERDUE_SHADOW") {
    return await runOverdueCycle("shadow");
  }
  if (type === "CHECK_OVERDUE_EXECUTE") {
    return await runOverdueCycle("execute");
  }
  if (type === "MEETING_POSTPROCESS") {
    return await processMeetingJob(job);
  }
  if (type === "CALL_TRANSCRIBE") {
    return await processCallJob(job);
  }
  if (type === "WHATSAPP_AGENDA_COMMAND") {
    return await processAgendaJob(job);
  }
  if (type === "GROUP_MEETING_CALENDAR_SYNC") {
    return await processGroupMeetingCalendarJob(job);
  }
  throw new Error(`unsupported_job_type:${type}`);
}

async function queueLoop() {
  let idleMs = Math.max(1000, pollMinMs);
  while (!stopping) {
    try {
      // Claim a small batch so recordings can be mixed/published immediately even
      // when Whisper is busy transcribing a previous call.
      const claimed = await call("claim", { limit: 3, visibility_timeout: 900 });
      const jobs = Array.isArray(claimed.jobs) ? claimed.jobs : [];
      if (!jobs.length) {
        await sleep(idleMs);
        idleMs = Math.min(Math.round(idleMs * 1.6), pollMaxMs);
        continue;
      }
      idleMs = Math.max(1000, pollMinMs);
      // Audio readiness must not wait for the STT queue. Pre-mix all call jobs in
      // the claimed batch first; transcription stays sequential to protect the 2-vCPU host.
      await Promise.all(jobs
        .filter((job) => String(job?.job_type || "").toUpperCase() === "CALL_TRANSCRIBE")
        .map(async (job) => {
          try {
            const sessionId = String(job?.payload?.session_id || "").trim();
            if (!sessionId) return;
            const snapshot = await call("call_snapshot", { session_id: sessionId }, 120000);
            await ensureMixedAudio(snapshot, sessionId);
          } catch (error) {
            console.error(JSON.stringify({ event: "call_audio_prewarm_failed", job_id: job?.job_id, error: String(error?.message || error) }));
          }
        }));
      for (const job of jobs) {
        try {
          console.log(JSON.stringify({ event: "job_claimed", job_id: job.job_id, job_type: job.job_type, attempt: job.attempt }));          await call("heartbeat", {
            job_id: job.job_id,
            message_id: job.message_id,
            progress: 10,
            visibility_timeout: 900,
          });
          const result = await handleQueueJob(job);
          await call("complete", {
            job_id: job.job_id,
            message_id: job.message_id,
            result,
          });
          console.log(JSON.stringify({ event: "job_completed", job_id: job.job_id }));
        } catch (error) {
          console.error(JSON.stringify({ event: "job_failed", job_id: job.job_id, error: String(error?.message || error) }));
          await call("fail", {
            job_id: job.job_id,
            message_id: job.message_id,
            error: String(error?.message || error),
            retry_delay_seconds: 300,
          }).catch(() => {});
        }
      }
    } catch (error) {
      console.error(JSON.stringify({ event: "worker_loop_error", error: String(error?.message || error) }));
      await sleep(Math.min(idleMs, pollMaxMs));
      idleMs = Math.min(Math.round(idleMs * 1.6), pollMaxMs);
    }
  }
}

async function overdueLoop() {
  let intervalMs = overdueDefaultIntervalMs;  while (!stopping) {
    const started = Date.now();
    try {
      const result = await runOverdueCycle();
      intervalMs = Number(result.intervalMs || overdueDefaultIntervalMs);
    } catch (error) {
      const message = String(error?.message || error);
      console.error(JSON.stringify({ event: "overdue_loop_error", error: message }));
      await call("overdue_report", {
        mode: "unknown",
        status: "error",
        started_at: new Date(started).toISOString(),
        result: {},
        error: message,
      }).catch(() => {});
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(5000, intervalMs - elapsed));
  }
}

async function main() {
  console.log(JSON.stringify({
    event: "worker_started",
    worker,
    poll_min_ms: pollMinMs,
    poll_max_ms: pollMaxMs,
    overdue_interval_ms: overdueDefaultIntervalMs,
  }));
  await Promise.all([queueLoop(), overdueLoop()]);
  console.log(JSON.stringify({ event: "worker_stopped", worker }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});



