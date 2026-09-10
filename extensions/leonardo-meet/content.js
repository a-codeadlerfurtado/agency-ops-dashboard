const VERSION = "0.1.0";
const SNAPSHOT_PREFIX = "meeting_capture_snapshot:";
const MEETING_CODE_RE = /\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:[/?#]|$)/i;
const LEAVE_RE = /(sair da chamada|leave call|hang up|desligar)/i;
const CAPTION_RE = /(legenda|caption)/i;
const CAPTION_OFF_RE = /(ativar legendas|turn on captions|enable captions|mostrar legendas)/i;
const CAPTION_ON_RE = /(desativar legendas|turn off captions|disable captions|ocultar legendas)/i;

let session = null;
let inCallSince = 0;
let outOfCallSince = 0;
let lastCaptionAttempt = 0;
let lastPersist = 0;
let lastScanSignature = "";

function nowIso() { return new Date().toISOString(); }
function norm(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function normKey(value) { return norm(value).toLocaleLowerCase("pt-BR").replace(/[^\p{L}\p{N}@._-]+/gu, "-").slice(0, 180); }

function getMeetingCode() {
  return location.pathname.match(MEETING_CODE_RE)?.[1]?.toLowerCase() || null;
}

function getMeetingTitle() {
  const raw = norm(document.title).replace(/\s*-\s*Google Meet\s*$/i, "").replace(/^Google Meet\s*-\s*/i, "");
  return raw || getMeetingCode() || "Reunião Google Meet";
}

function ariaLabel(element) {
  return norm(element?.getAttribute?.("aria-label") || element?.getAttribute?.("title") || "");
}

function isInCall() {
  const controls = document.querySelectorAll("button[aria-label], [role='button'][aria-label]");
  for (const control of controls) if (LEAVE_RE.test(ariaLabel(control))) return true;
  return false;
}

function hasCaptionTextNode() {
  return Boolean(document.querySelector('[jsname="tgaKEf"]'));
}

function tryEnableCaptions() {
  if (!session || Date.now() - lastCaptionAttempt < 8000) return;
  if (hasCaptionTextNode()) return;
  const controls = document.querySelectorAll("button[aria-label], [role='button'][aria-label]");
  let fallback = null;
  for (const control of controls) {
    const label = ariaLabel(control);
    if (!CAPTION_RE.test(label)) continue;
    if (CAPTION_ON_RE.test(label)) return;
    if (CAPTION_OFF_RE.test(label)) {
      lastCaptionAttempt = Date.now();
      control.click();
      return;
    }
    fallback ||= control;
  }
  if (fallback) {
    lastCaptionAttempt = Date.now();
    fallback.click();
  }
}

function speakerFromNode(textNode) {
  let cursor = textNode;
  for (let depth = 0; cursor && depth < 6; depth++, cursor = cursor.parentElement) {
    const participantId = norm(cursor.getAttribute?.("data-participant-id"));
    const selfName = norm(cursor.getAttribute?.("data-self-name"));
    const named = cursor.querySelector?.("[data-self-name]");
    const namedValue = norm(named?.getAttribute?.("data-self-name") || named?.textContent);
    if (selfName || namedValue) return { key: participantId || normKey(selfName || namedValue), name: selfName || namedValue };
    if (participantId) {
      const parts = Array.from(cursor.querySelectorAll?.("div,span") || []).map((el) => norm(el.textContent)).filter((v) => v && v.length < 100);
      const candidate = parts.find((v) => v !== norm(textNode.textContent) && !CAPTION_RE.test(v));
      if (candidate) return { key: participantId, name: candidate };
    }
  }
  const block = textNode.parentElement?.parentElement || textNode.parentElement;
  const lines = norm(block?.innerText || "").split(/\n+/).map(norm).filter(Boolean);
  const caption = norm(textNode.textContent);
  const candidate = lines.find((line) => line !== caption && line.length <= 100);
  return { key: normKey(candidate || "participante"), name: candidate || "Participante" };
}

function collectParticipantDom() {
  if (!session) return;
  const nodes = document.querySelectorAll("[data-participant-id], [data-self-name]");
  for (const node of nodes) {
    const id = norm(node.getAttribute("data-participant-id"));
    const self = norm(node.getAttribute("data-self-name"));
    let name = self;
    if (!name) {
      const named = node.querySelector("[data-self-name]");
      name = norm(named?.getAttribute("data-self-name") || named?.textContent);
    }
    if (!name) continue;
    const key = id || normKey(name);
    const prev = session.participants[key] || {};
    session.participants[key] = {
      participant_key: key,
      display_name: name,
      source: id ? "MEET_DOM" : "CAPTIONS",
      joined_at: prev.joined_at || nowIso(),
      ...prev,
    };
  }
}

function pushRawEvent(event) {
  if (!session) return;
  const text = norm(event.text);
  const name = norm(event.speaker_name) || "Participante";
  if (!text || text.length > 8000) return;
  const key = norm(event.speaker_key) || normKey(name);
  const atMs = Math.max(0, Date.now() - session.startedEpoch);
  const signature = `${key}|${text}`;
  const recent = session.rawEvents[session.rawEvents.length - 1];
  if (recent?.signature === signature && atMs - recent.at_ms < 3000) return;
  session.rawEvents.push({ signature, speaker_key: key, speaker_name: name, text, at_ms: atMs, source: event.source || "MEET_CAPTIONS" });
  if (session.rawEvents.length > 30000) session.rawEvents.splice(0, session.rawEvents.length - 30000);
  const prev = session.participants[key] || {};
  session.participants[key] = { participant_key: key, display_name: name, source: event.source || prev.source || "CAPTIONS", joined_at: prev.joined_at || nowIso(), ...prev };
}

function scanCaptions() {
  if (!session) return;
  const nodes = Array.from(document.querySelectorAll('[jsname="tgaKEf"]'));
  if (nodes.length) {
    for (const node of nodes) {
      const text = norm(node.textContent);
      if (!text) continue;
      const speaker = speakerFromNode(node);
      pushRawEvent({ speaker_key: speaker.key, speaker_name: speaker.name, text, source: "MEET_CAPTIONS" });
    }
    session.captionsSeen = true;
    return;
  }

  const liveRegions = Array.from(document.querySelectorAll('[aria-live="polite"], [aria-live="assertive"]'));
  for (const region of liveRegions) {
    const raw = String(region.innerText || "").trim();
    if (!raw || raw.length > 4000) continue;
    const lines = raw.split(/\n+/).map(norm).filter(Boolean);
    if (lines.length < 2) continue;
    const name = lines[0].slice(0, 100);
    const text = lines.slice(1).join(" ");
    if (!CAPTION_RE.test(name) && text) {
      pushRawEvent({ speaker_key: normKey(name), speaker_name: name, text, source: "MEET_CAPTIONS_FALLBACK" });
      session.captionsSeen = true;
    }
  }
}

function overlapSize(a, b) {
  const max = Math.min(a.length, b.length, 180);
  for (let size = max; size >= 8; size--) if (a.slice(-size) === b.slice(0, size)) return size;
  return 0;
}

function normalizeSegments(rawEvents) {
  const output = [];
  for (const raw of rawEvents) {
    const text = norm(raw.text);
    if (!text) continue;
    const last = output[output.length - 1];
    if (last && last.speaker_key === raw.speaker_key && raw.at_ms - last.ended_ms <= 5500) {
      if (text === last.text) { last.ended_ms = raw.at_ms; continue; }
      if (text.startsWith(last.text)) { last.text = text; last.ended_ms = raw.at_ms; continue; }
      if (last.text.startsWith(text)) { last.ended_ms = raw.at_ms; continue; }
      const overlap = overlapSize(last.text, text);
      if (overlap) { last.text += text.slice(overlap); last.ended_ms = raw.at_ms; continue; }
    }
    output.push({
      sequence_no: output.length,
      started_ms: raw.at_ms,
      ended_ms: raw.at_ms,
      speaker_key: raw.speaker_key,
      speaker_name: raw.speaker_name,
      text,
      source: raw.source || "MEET_CAPTIONS",
    });
  }
  return output.filter((segment) => segment.text.length >= 2);
}

async function persistSnapshot(force = false) {
  if (!session) return;
  if (!force && Date.now() - lastPersist < 5000) return;
  lastPersist = Date.now();
  const key = `${SNAPSHOT_PREFIX}${session.meetingCode || "unknown"}`;
  await chrome.storage.local.set({ [key]: { ...session, startedEpoch: session.startedEpoch, saved_at: nowIso() } });
}

async function restoreSnapshot(code) {
  const key = `${SNAPSHOT_PREFIX}${code || "unknown"}`;
  const data = await chrome.storage.local.get(key);
  const saved = data[key];
  if (!saved?.started_at || Date.now() - Date.parse(saved.started_at) > 6 * 3600_000) return null;
  return { ...saved, rawEvents: Array.isArray(saved.rawEvents) ? saved.rawEvents : [], participants: saved.participants || {}, startedEpoch: Number(saved.startedEpoch || Date.parse(saved.started_at)) };
}

async function startSession() {
  if (session) return;
  const meetingCode = getMeetingCode();
  session = await restoreSnapshot(meetingCode);
  if (!session) {
    const started = Date.now();
    session = {
      local_session_id: `${meetingCode || "meet"}-${started}-${crypto.randomUUID()}`,
      meetingCode,
      meetingUrl: location.href,
      title: getMeetingTitle(),
      started_at: new Date(started).toISOString(),
      startedEpoch: started,
      rawEvents: [],
      participants: {},
      captionsSeen: false,
    };
  }
  await chrome.runtime.sendMessage({ type: "CAPTURE_STATE", state: { active: true, meeting_code: meetingCode, title: session.title, started_at: session.started_at } }).catch(() => {});
  await persistSnapshot(true);
}

async function finishSession() {
  if (!session) return;
  scanCaptions();
  collectParticipantDom();
  const endedAt = nowIso();
  const segments = normalizeSegments(session.rawEvents);
  const participants = Object.values(session.participants || {});
  const payload = {
    meeting: {
      local_session_id: session.local_session_id,
      meeting_code: session.meetingCode,
      meeting_url: session.meetingUrl,
      title: session.title,
      started_at: session.started_at,
      ended_at: endedAt,
      capture_mode: "MEET_CAPTIONS",
      native_transcript_available: false,
      extension_version: VERSION,
      metadata: { captions_seen: Boolean(session.captionsSeen), raw_events: session.rawEvents.length },
    },
    participants,
    segments,
  };
  const code = session.meetingCode;
  const result = segments.length ? await chrome.runtime.sendMessage({ type: "FINALIZE", payload }).catch((error) => ({ ok: false, error: String(error) })) : { ok: false, error: "no_caption_segments" };
  const key = `${SNAPSHOT_PREFIX}${code || "unknown"}`;
  if (segments.length && (result?.ok || result?.queued)) await chrome.storage.local.remove(key);
  else await persistSnapshot(true);
  await chrome.runtime.sendMessage({ type: "CAPTURE_STATE", state: { active: false, error: segments.length ? null : "NO_CAPTIONS", meeting_code: code, ended_at: endedAt, queued: Boolean(result?.queued) } }).catch(() => {});
  session = null;
}

const observer = new MutationObserver(() => {
  if (!session) return;
  const signature = `${document.querySelectorAll('[jsname="tgaKEf"]').length}|${document.body?.childElementCount || 0}`;
  if (signature !== lastScanSignature) lastScanSignature = signature;
  scanCaptions();
});
observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

setInterval(async () => {
  const active = isInCall();
  if (active) {
    outOfCallSince = 0;
    if (!inCallSince) inCallSince = Date.now();
    if (!session && Date.now() - inCallSince >= 1200) await startSession();
    if (session) {
      tryEnableCaptions();
      collectParticipantDom();
      scanCaptions();
      await persistSnapshot();
    }
  } else {
    inCallSince = 0;
    if (session) {
      if (!outOfCallSince) outOfCallSince = Date.now();
      if (Date.now() - outOfCallSince >= 7000) await finishSession();
    }
  }
}, 1000);

window.addEventListener("pagehide", () => { persistSnapshot(true).catch(() => {}); });
