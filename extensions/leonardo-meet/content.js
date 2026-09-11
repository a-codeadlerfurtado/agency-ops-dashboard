const VERSION = "0.2.0";
const MEETING_CODE_RE = /\/([a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3})(?:[/?#]|$)/i;
const LEAVE_RE = /(sair da chamada|encerrar chamada|sair da reunião|leave call|leave meeting|hang up|desligar)/i;
const JOIN_RE = /(participar agora|pedir para participar|join now|ask to join)/i;
const RTC_FRESH_MS = 30_000;
const CAPTION_FRESH_MS = 45_000;
const JOIN_STABLE_MS = 1_200;
const HEALTH_INTERVAL_MS = 10_000;
const RTC_SILENCE_RECOVERY_MS = 30_000;
const NO_FIRST_CAPTION_WARN_MS = 90_000;

let session = null;
let inCallSince = 0;
let outOfCallSince = 0;
let lastRtcSignalAt = 0;
let lastCaptionAt = 0;
let lastRequestAt = 0;
let lastPath = location.pathname;
let pageReady = false;
let warningSent = false;
let manualPaused = false;
const prebuffer = [];
const speakerPrebuffer = new Map();

function nowIso() { return new Date().toISOString(); }
function norm(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function getMeetingCode(pathname = location.pathname) {
  return pathname.match(MEETING_CODE_RE)?.[1]?.toLowerCase() || null;
}

function getMeetingTitle() {
  const byAttr = norm(document.querySelector("[data-meeting-title]")?.getAttribute("data-meeting-title") || document.querySelector("[data-meeting-title]")?.textContent);
  if (byAttr && !MEETING_CODE_RE.test(`/${byAttr}`)) return byAttr.slice(0, 500);
  const byCall = norm(document.querySelector("[data-call-title]")?.getAttribute("data-call-title") || document.querySelector("[data-call-title]")?.textContent);
  if (byCall && !MEETING_CODE_RE.test(`/${byCall}`)) return byCall.slice(0, 500);
  const fromTitle = norm(document.title)
    .replace(/\s*-\s*Google Meet\s*$/i, "")
    .replace(/^Google Meet\s*-\s*/i, "")
    .replace(/\s*-\s*Meet\s*$/i, "");
  if (fromTitle && fromTitle.toLowerCase() !== "google meet" && !MEETING_CODE_RE.test(`/${fromTitle}`)) return fromTitle.slice(0, 500);
  return getMeetingCode() || "Reunião Google Meet";
}

function labelOf(element) {
  return norm(element?.getAttribute?.("aria-label") || element?.getAttribute?.("data-tooltip") || element?.getAttribute?.("title") || "");
}

function hasEndCallControl() {
  const controls = document.querySelectorAll("button[aria-label], [role='button'][aria-label], [data-tooltip]");
  for (const control of controls) if (LEAVE_RE.test(labelOf(control))) return true;
  return false;
}

function hasJoinControl() {
  const controls = document.querySelectorAll("button[aria-label], [role='button'][aria-label], button");
  for (const control of controls) {
    const value = `${labelOf(control)} ${norm(control.textContent)}`;
    if (JOIN_RE.test(value)) return true;
  }
  return false;
}

function transportFresh() {
  return lastRtcSignalAt > 0 && Date.now() - lastRtcSignalAt <= RTC_FRESH_MS;
}

function captionFresh() {
  return lastCaptionAt > 0 && Date.now() - lastCaptionAt <= CAPTION_FRESH_MS;
}

function detectState() {
  if (!getMeetingCode()) return "unknown";
  if (hasEndCallControl()) return "in_call";
  if (transportFresh()) return "in_call";
  if (session && captionFresh()) return "in_call";
  if (hasJoinControl() || document.querySelector("[data-lobby-state]")) return "lobby";
  return "lobby";
}

function requestRtcCapture(force = false) {
  if (!force && Date.now() - lastRequestAt < 8_000) return;
  lastRequestAt = Date.now();
  window.postMessage({
    source: "leonardo-meet-content",
    type: "REQUEST_CAPTIONS",
    language: navigator.language || "pt-BR",
    meeting_code: getMeetingCode(),
  }, "*");
}

async function runtime(message) {
  try { return await chrome.runtime.sendMessage(message); }
  catch { return null; }
}

async function beginSession() {
  if (session || manualPaused) return;
  const meetingCode = getMeetingCode();
  if (!meetingCode) return;
  const started = Date.now();
  session = {
    id: `${meetingCode}-${started}-${crypto.randomUUID()}`,
    meeting_code: meetingCode,
    meeting_url: location.href,
    title: getMeetingTitle(),
    started_at: new Date(started).toISOString(),
    started_epoch: started,
    path: location.pathname,
  };
  warningSent = false;
  await runtime({ type: "RTC_SESSION_START", session: { ...session, extension_version: VERSION } });
  for (const speaker of speakerPrebuffer.values()) await runtime({ type: "RTC_SPEAKER_MAP", session_id: session.id, speaker });
  speakerPrebuffer.clear();
  for (const frame of prebuffer.splice(0)) await runtime({ type: "RTC_CAPTION", session_id: session.id, frame: { ...frame, offset_ms: Math.max(0, Number(frame.observed_at || Date.now()) - started) } });
  await runtime({ type: "CAPTURE_STATE", state: { active: true, meeting_code: meetingCode, title: session.title, started_at: session.started_at, mode: "MEET_RTC_CAPTIONS" } });
  requestRtcCapture(true);
}

async function endSession(reason = "left_call") {
  if (!session) return;
  const closing = session;
  session = null;
  const endedAt = nowIso();
  await runtime({
    type: "RTC_SESSION_FINISH",
    session_id: closing.id,
    ended_at: endedAt,
    reason,
    meeting: {
      local_session_id: closing.id,
      meeting_code: closing.meeting_code,
      meeting_url: closing.meeting_url,
      title: getMeetingTitle() || closing.title,
      started_at: closing.started_at,
      ended_at: endedAt,
      capture_mode: "MEET_RTC_CAPTIONS",
      native_transcript_available: false,
      extension_version: VERSION,
      metadata: { rtc_capture: true, finish_reason: reason },
    },
  });
  await runtime({ type: "CAPTURE_STATE", state: { active: false, meeting_code: closing.meeting_code, ended_at: endedAt, saving: true } });
  outOfCallSince = 0;
  inCallSince = 0;
}

function handleRtcCaption(payload) {
  const frame = {
    ...payload,
    observed_at: Date.now(),
    source: "MEET_RTC_CAPTIONS",
  };
  lastRtcSignalAt = Date.now();
  lastCaptionAt = Date.now();
  warningSent = false;
  if (!session) {
    prebuffer.push(frame);
    if (prebuffer.length > 150) prebuffer.splice(0, prebuffer.length - 150);
    return;
  }
  runtime({
    type: "RTC_CAPTION",
    session_id: session.id,
    frame: { ...frame, offset_ms: Math.max(0, Date.now() - session.started_epoch) },
  });
}

function handleSpeaker(payload) {
  if (!payload?.deviceKey && !payload?.deviceId) return;
  const key = String(payload.deviceKey || payload.deviceId);
  if (!session) speakerPrebuffer.set(key, payload);
  else runtime({ type: "RTC_SPEAKER_MAP", session_id: session.id, speaker: payload });
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.data?.source !== "leonardo-meet-rtc") return;
  const type = event.data.type;
  const payload = event.data.payload || {};
  if (type === "READY") {
    pageReady = true;
    lastRtcSignalAt = Date.now();
    requestRtcCapture(true);
  } else if (type === "RTC_STATUS") {
    pageReady = true;
    if (payload.active || (Array.isArray(payload.channels) && payload.channels.length)) lastRtcSignalAt = Date.now();
  } else if (type === "CAPTION") {
    handleRtcCaption(payload);
  } else if (type === "SPEAKER_MAP") {
    handleSpeaker(payload);
  } else if (type === "DIAGNOSTIC") {
    runtime({ type: "RTC_DIAGNOSTIC", session_id: session?.id || null, diagnostic: payload });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "MEET_RPC_SIGNAL") {
    lastRtcSignalAt = Date.now();
    requestRtcCapture();
  }
  if (message?.type === "REINJECT_RTC") requestRtcCapture(true);
  if (message?.type === "RELATO_CAPTURE_CONTROL") {
    const paused = Boolean(message.paused);
    manualPaused = paused;
    if (paused && session) endSession("manual_pause").catch(() => {});
    if (!paused) {
      inCallSince = Date.now() - JOIN_STABLE_MS;
      requestRtcCapture(true);
    }
    runtime({ type: "CAPTURE_STATE", state: { active: !paused && Boolean(session), paused, meeting_code: getMeetingCode(), title: getMeetingTitle(), mode: "MEET_RTC_CAPTIONS" } });
  }
});

setInterval(async () => {
  const currentPath = location.pathname;
  if (session && currentPath !== lastPath && getMeetingCode(currentPath) !== session.meeting_code) {
    await endSession("spa_meeting_switch");
  }
  lastPath = currentPath;

  const state = detectState();
  if (state === "in_call") {
    outOfCallSince = 0;
    if (!inCallSince) inCallSince = Date.now();
    if (!session && Date.now() - inCallSince >= JOIN_STABLE_MS) await beginSession();
    if (session) {
      if (!pageReady || Date.now() - lastRtcSignalAt > RTC_SILENCE_RECOVERY_MS) requestRtcCapture(true);
      if (!lastCaptionAt && Date.now() - session.started_epoch > NO_FIRST_CAPTION_WARN_MS && !warningSent) {
        warningSent = true;
        await runtime({ type: "RTC_DIAGNOSTIC", session_id: session.id, diagnostic: { code: "no_first_caption", message: "RTC ativo, mas nenhum frame de transcrição chegou nos primeiros 90s." } });
      }
    }
  } else {
    inCallSince = 0;
    if (session) {
      if (!outOfCallSince) outOfCallSince = Date.now();
      const debounce = document.visibilityState === "hidden" ? 45_000 : 15_000;
      if (!transportFresh() && !captionFresh() && Date.now() - outOfCallSince >= debounce) await endSession("left_call_confirmed");
    }
  }
}, 1_000);

setInterval(() => {
  if (!session) return;
  if (Date.now() - lastRtcSignalAt > RTC_SILENCE_RECOVERY_MS) requestRtcCapture(true);
}, HEALTH_INTERVAL_MS);

window.addEventListener("pageshow", () => requestRtcCapture(true));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestRtcCapture(true); });
requestRtcCapture(true);
