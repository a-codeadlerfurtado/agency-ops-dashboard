import { clearSession, getAudioChunks, getFrames, getSession, getSpeakers, listSessions, putAudioChunk, putFrame, putSession, putSpeaker } from "./rtc-store.js";

const API = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-meeting-capture-api";
const STT_API = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/jarvis/stt";
const DESKTOP_BRIDGE = "http://127.0.0.1:17654";
const OUTBOX_KEY = "meeting_capture_outbox";
const DEVICE_KEY = "meeting_capture_device";
const STATE_KEY = "meeting_capture_state";
const RETRY_ALARM = "meeting-capture-outbox";
const RPC_MARKER = "$rpc/google.rtc.meetings.v1.";
const liveHeartbeatAt = new Map();

function norm(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

async function callDesktopBridge(path, method = "GET", body = null) {
  const safePath = String(path || "");
  if (!(safePath === "/health" || safePath.startsWith("/meet/"))) throw new Error("invalid_desktop_bridge_path");
  const options = { method: String(method || "GET").toUpperCase(), headers: {} };
  if (body != null) { options.headers["content-type"] = "application/json"; options.body = JSON.stringify(body); }
  const response = await fetch(`${DESKTOP_BRIDGE}${safePath}`, options);
  let payload = {}; try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload?.error || `desktop_bridge_${response.status}`);
  return payload;
}

async function recordSttTelemetry(sessionId, outcome, detail = {}) {
  const row = await getSession(sessionId);
  if (!row) return null;
  const prev = row.stt_telemetry || row.metadata?.stt_telemetry || {};
  const next = {
    chunks_seen: Number(prev.chunks_seen || 0) + 1,
    text_segments: Number(prev.text_segments || 0) + (outcome === "text" ? 1 : 0),
    empty_segments: Number(prev.empty_segments || 0) + (outcome === "empty" ? 1 : 0),
    errors: Number(prev.errors || 0) + (outcome === "error" ? 1 : 0),
    last_outcome: outcome,
    last_role: detail.role || null,
    last_seq: Number(detail.seq || 0),
    last_latency_ms: Number(detail.latency_ms || 0),
    last_at: new Date().toISOString(),
    last_error: outcome === "error" ? String(detail.error || "stt_error").slice(0, 300) : null,
  };
  await putSession({ ...row, stt_telemetry: next });
  return next;
}
function normalizeDeviceKey(value) {
  const raw = norm(value);
  const canonical = raw.match(/spaces\/[A-Za-z0-9_-]+\/devices\/(\d+)/i);
  if (canonical) return `@${canonical[1]}`;
  const short = raw.match(/^@?(\d+)$/);
  return short ? `@${short[1]}` : raw.slice(0, 180);
}

async function callApi(action, payload = {}, token = null) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-meeting-device-token"] = token;
  const response = await fetch(API, { method: "POST", headers, body: JSON.stringify({ action, ...payload }) });
  let body = {};
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(body?.error || `api_${response.status}`);
    error.detail = body;
    throw error;
  }
  return body;
}


async function nativeSavedNotification(transcriptId = null) {
  try {
    await chrome.notifications.create(`relato-saved-${Date.now()}`, {
      type: "basic", iconUrl: "icon128.png", title: "Relato AI",
      message: `Transcrição enviada para o banco de dados${transcriptId ? ` · #${transcriptId}` : ""}`,
      priority: 1,
    });
  } catch {}
}

async function confirmSavedToUser(tabId, transcriptId = null) {
  let inlineShown = false;
  if (Number.isInteger(tabId)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (String(tab?.url || "").startsWith("https://meet.google.com/")) {
        await chrome.tabs.sendMessage(tabId, { type: "RELATO_UPLOAD_CONFIRMED", transcript_id: transcriptId });
        inlineShown = true;
      }
    } catch {}
  }
  await nativeSavedNotification(transcriptId);
  return inlineShown;
}

async function getDevice() {
  const data = await chrome.storage.local.get(DEVICE_KEY);
  return data[DEVICE_KEY] || null;
}

async function setDevice(device) {
  await chrome.storage.local.set({ [DEVICE_KEY]: device });
}

async function getLegacyOutbox() {
  const data = await chrome.storage.local.get(OUTBOX_KEY);
  return Array.isArray(data[OUTBOX_KEY]) ? data[OUTBOX_KEY] : [];
}

async function setLegacyOutbox(items) {
  await chrome.storage.local.set({ [OUTBOX_KEY]: items.slice(-50) });
}

async function enqueueLegacyOutbox(payload, reason = "upload_failed", tabId = null) {
  const items = await getLegacyOutbox();
  const existing = items.find((item) => item?.payload?.meeting?.local_session_id === payload?.meeting?.local_session_id);
  if (existing) {
    existing.payload = payload;
    existing.last_error = reason;
    existing.updated_at = new Date().toISOString();
    if (Number.isInteger(tabId)) existing.tab_id = tabId;
  } else {
    items.push({ id: crypto.randomUUID(), payload, tab_id: Number.isInteger(tabId) ? tabId : null, attempts: 0, last_error: reason, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  await setLegacyOutbox(items);
}

async function deliver(payload) {
  const device = await getDevice();
  if (!device?.device_token) throw new Error("extension_not_paired");
  return callApi("finalize", payload, device.device_token);
}

async function transcribeMeetAudio(base64, mimeType = "audio/webm") {
  const device = await getDevice();
  if (!device?.device_token) throw new Error("extension_not_paired");
  const bytes = decodeBase64(base64);
  const response = await fetch(STT_API, {
    method: "POST",
    headers: { "content-type": mimeType || "audio/webm", "x-meeting-device-token": device.device_token, "authorization": `Bearer ${device.device_token}` },
    body: bytes,
  });
  let body = {}; try { body = await response.json(); } catch {}
  if (!response.ok) throw new Error(body?.error || `meet_stt_${response.status}`);
  return norm(body?.text || "");
}

async function storeMeetAudioFrame(sessionId, role, chunk, text) {
  const body = norm(text);
  if (!body) return null;
  const device = await getDevice();
  const duration = Math.max(0, Number(chunk.duration_ms || 2500));
  const ended = Math.max(0, Number(chunk.offset_ms || 0));
  const started = Math.max(0, ended - duration);
  const frame = {
    message_id: `audio:${role}:${Number(chunk.seq || 0)}`, message_version: 0,
    device_key: `rtc-audio:${role}`, speaker_name: role === "local" ? (norm(device?.owner_person) || "Colaborador") : "Participantes",
    text: body, offset_ms: started, ended_ms: ended, source: "MEET_RTC_WHISPER",
    role, track_key: norm(chunk.track_key), received_at: new Date().toISOString(),
  };
  const existing = await getFrames(sessionId);
  const duplicate = existing.some((row) => String(row.message_id || "") === frame.message_id);
  if (duplicate) return null;
  await putFrame(sessionId, frame);
  return frame;
}

async function transcribeStoredMeetAudio(sessionId) {
  const chunks = await getAudioChunks(sessionId);
  const existing = new Set((await getFrames(sessionId)).map((f) => String(f.message_id || "")));
  for (const chunk of chunks) {
    const messageId = `audio:${chunk.role}:${Number(chunk.seq || 0)}`;
    if (existing.has(messageId) || !chunk.base64) continue;
    try {
      const text = await transcribeMeetAudio(chunk.base64, chunk.mime_type);
      const frame = await storeMeetAudioFrame(sessionId, chunk.role, chunk, text);
      if (frame) existing.add(messageId);
    } catch {}
  }
}

async function setCaptureState(state) {
  const previous = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
  const merged = { ...previous, ...(state || {}), updated_at: new Date().toISOString() };
  await chrome.storage.local.set({ [STATE_KEY]: merged });
  await chrome.action.setBadgeText({ text: merged?.active ? "REC" : merged?.error ? "!" : "" });
}

function resolveSpeaker(frame, speakerMap) {
  const key = normalizeDeviceKey(frame.device_key || frame.device_id || frame.deviceId);
  return speakerMap.get(key)?.display_name || speakerMap.get(key)?.displayName || norm(frame.speaker_name) || (key.match(/@(\d+)/)?.[1] ? `Participant ${key.match(/@(\d+)/)[1]}` : "Participant");
}

function buildSegments(frames, speakers) {
  const speakerMap = new Map();
  for (const speaker of speakers) {
    const key = normalizeDeviceKey(speaker.device_key || speaker.device_id || speaker.deviceId);
    if (key) speakerMap.set(key, speaker);
  }
  const ordered = [...frames].sort((a, b) => Number(a.offset_ms || a.offsetMs || 0) - Number(b.offset_ms || b.offsetMs || 0) || String(a.message_id).localeCompare(String(b.message_id)));
  const output = [];
  for (const frame of ordered) {
    const body = norm(frame.text);
    if (!body) continue;
    const deviceKey = normalizeDeviceKey(frame.device_key || frame.device_id || frame.deviceId);
    const speakerName = resolveSpeaker(frame, speakerMap);
    const offset = Math.max(0, Math.round(Number(frame.offset_ms || frame.offsetMs || 0)));
    const last = output[output.length - 1];
    if (last && last.speaker_key === deviceKey && offset - last.ended_ms <= 8_000) {
      if (body === last.text || last.text.endsWith(body)) {
        last.ended_ms = offset;
      } else if (body.startsWith(last.text)) {
        last.text = body;
        last.ended_ms = offset;
      } else {
        last.text = `${last.text} ${body}`.replace(/\s+/g, " ").trim();
        last.ended_ms = offset;
      }
      continue;
    }
    output.push({
      sequence_no: output.length,
      started_ms: offset,
      ended_ms: offset,
      speaker_key: deviceKey || null,
      speaker_name: speakerName,
      device_id: norm(frame.device_id || frame.deviceId) || null,
      message_id: norm(frame.message_id || frame.messageId) || null,
      message_version: Number.isFinite(Number(frame.message_version ?? frame.messageVersion)) ? Math.round(Number(frame.message_version ?? frame.messageVersion)) : null,
      text: body,
      confidence: null,
      source: norm(frame.source) || "MEET_RTC_CAPTIONS",
    });
  }
  return output;
}

function buildParticipants(frames, speakers) {
  const rows = new Map();
  for (const speaker of speakers) {
    const key = normalizeDeviceKey(speaker.device_key || speaker.device_id || speaker.deviceId);
    if (!key) continue;
    rows.set(key, {
      participant_key: key,
      display_name: norm(speaker.display_name || speaker.displayName) || `Participant ${key.replace("@", "")}`,
      source: norm(speaker.source) || "MEET_RTC_COLLECTIONS",
      identity_confidence: String(speaker.source || "").includes("schema") ? 0.99 : String(speaker.source || "").includes("heuristic") ? 0.85 : 0.7,
      metadata: { raw_device_id: speaker.deviceId || speaker.device_id || null },
    });
  }
  for (const frame of frames) {
    const key = normalizeDeviceKey(frame.device_key || frame.device_id || frame.deviceId);
    if (!key || rows.has(key)) continue;
    rows.set(key, {
      participant_key: key,
      display_name: norm(frame.speaker_name) || (key.match(/@(\d+)/)?.[1] ? `Participant ${key.match(/@(\d+)/)[1]}` : "Participant"),
      source: norm(frame.source) || "MEET_RTC_CAPTIONS",
      identity_confidence: norm(frame.speaker_name).startsWith("Participant ") ? 0.3 : 0.7,
      metadata: { raw_device_id: frame.device_id || frame.deviceId || null },
    });
  }
  return [...rows.values()];
}

async function finalizeStoredSession(sessionId, finishOverride = null) {
  const stored = await getSession(sessionId);
  if (!stored) return { ok: false, error: "session_not_found" };
  const captureMode = stored.capture_mode || "MEET_RTC_CAPTIONS";
  if (captureMode === "MEET_RTC_AUDIO") await transcribeStoredMeetAudio(sessionId).catch(() => {});
  const [frames, speakers] = await Promise.all([getFrames(sessionId), getSpeakers(sessionId)]);
  if (!frames.length) {
    const endedAt = finishOverride?.ended_at || stored.ended_at || new Date().toISOString();
    const failed = { ...stored, state: "NEEDS_REVIEW", ended_at: endedAt, last_error: "no_rtc_frames" };
    await putSession(failed);
    await setCaptureState({ active: false, error: "NO_RTC_FRAMES", meeting_code: stored.meeting_code, ended_at: endedAt });
    const device = await getDevice();
    if (device?.device_token) {
      await callApi("session_heartbeat", { session: {
        ...failed, local_session_id: stored.id, capture_mode: captureMode,
        captions_available: false, extension_version: chrome.runtime.getManifest().version,
        metadata: { ...(stored.metadata || {}), diagnostics: stored.diagnostics || [] },
      } }, device.device_token).catch(() => null);
    }
    return { ok: false, error: "no_rtc_frames" };
  }

  const meeting = {
    local_session_id: stored.id,
    meeting_code: stored.meeting_code,
    meeting_url: stored.meeting_url,
    title: finishOverride?.meeting?.title || stored.title || "Reunião Google Meet",
    started_at: stored.started_at,
    ended_at: finishOverride?.ended_at || stored.ended_at || new Date().toISOString(),
    capture_mode: captureMode,
    native_transcript_available: false,
    extension_version: stored.extension_version || chrome.runtime.getManifest().version,
    metadata: {
      ...(stored.metadata || {}),
      ...(finishOverride?.meeting?.metadata || {}),
      rtc_capture: true,
      direct_rtc_audio: captureMode === "MEET_RTC_AUDIO",
      captions_required: captureMode !== "MEET_RTC_AUDIO",
      rtc_frames: frames.length,
      speaker_mappings: speakers.length,
      backend_upload_mode: "FINAL_ONLY",
    },
  };
  const segments = buildSegments(frames, speakers);
  const participants = buildParticipants(frames, speakers);
  const payload = { meeting, participants, segments };
  try {
    const result = await deliver(payload);
    await setCaptureState({ active: false, saved: true, error: null, meeting_code: meeting.meeting_code, ended_at: meeting.ended_at, transcript_id: result?.transcript_id || null });
    const feedback = { local_session_id: stored.id, transcript_id: result?.transcript_id || null, capture_session_id: result?.session_id || null, channel: "MEET", title: meeting.title || "ReuniÃ£o Google Meet" };
    if (stored.tab_id != null) {
      await confirmSavedToUser(stored.tab_id, result?.transcript_id || null);
      chrome.tabs.sendMessage(stored.tab_id, { type: "RELATO_SHOW_FEEDBACK", feedback }).catch(() => {});
    }
    await clearSession(sessionId);
    return { ok: true, result };
  } catch (error) {
    const attempts = Number(stored.attempts || 0) + 1;
    await putSession({ ...stored, ...meeting, state: "PENDING_UPLOAD", attempts, last_error: String(error?.message || error), ended_at: meeting.ended_at, finish_payload: finishOverride || null });
    await setCaptureState({ active: false, saving: false, queued: true, error: null, meeting_code: meeting.meeting_code, ended_at: meeting.ended_at });
    return { ok: false, queued: true, error: String(error?.message || error) };
  }
}

function decodeBase64(value) {
  const raw = atob(String(value || ""));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function uploadSignedAudio(url, chunks, mimeType) {
  const parts = chunks.map((chunk) => decodeBase64(chunk.base64));
  const blob = new Blob(parts, { type: mimeType || "audio/webm" });
  const response = await fetch(url, { method: "PUT", headers: { "content-type": mimeType || "audio/webm", "x-upsert": "true" }, body: blob });
  if (!response.ok) throw new Error(`call_audio_upload_${response.status}:${(await response.text()).slice(0,300)}`);
  return blob.size;
}

async function finalizeCallSession(sessionId, finish = null) {
  const stored = await getSession(sessionId);
  if (!stored) return { ok: false, error: "session_not_found" };
  const chunks = await getAudioChunks(sessionId);
  if (!chunks.length) {
    await putSession({ ...stored, state: "NEEDS_REVIEW", ended_at: finish?.ended_at || new Date().toISOString(), last_error: "no_call_audio" });
    return { ok: false, error: "no_call_audio" };
  }
  const roles = [...new Set(chunks.map((chunk) => chunk.role).filter((role) => role === "local" || role === "remote"))];
  const device = await getDevice();
  if (!device?.device_token) throw new Error("extension_not_paired");
  const endedAt = finish?.ended_at || stored.ended_at || new Date().toISOString();
  const prepared = await callApi("call_prepare", {
    call: {
      local_session_id: stored.id,
      started_at: stored.started_at,
      ended_at: endedAt,
      contact_name: finish?.contact_name || stored.contact_name || "Contato WhatsApp",
      finish_reason: finish?.reason || stored.finish_reason || null,
      extension_version: chrome.runtime.getManifest().version,
    },
    roles,
  }, device.device_token);
  const uploaded = [];
  for (const item of prepared.uploads || []) {
    const roleChunks = chunks.filter((chunk) => chunk.role === item.role).sort((a,b) => Number(a.seq||0)-Number(b.seq||0));
    if (!roleChunks.length) continue;
    const mime = roleChunks.find((chunk) => chunk.mime_type)?.mime_type || "audio/webm";
    const bytes = await uploadSignedAudio(item.signed_url, roleChunks, mime);
    uploaded.push({ role: item.role, path: item.path, bytes, mime_type: mime });
  }
  try {
    const result = await callApi("call_finalize", { local_session_id: stored.id, uploaded }, device.device_token);
    await setCaptureState({ active: false, saved: true, call: true, error: null, title: stored.contact_name || "LigaÃ§Ã£o WhatsApp", ended_at: endedAt, session_id: prepared.session_id });
    const feedback = { local_session_id: stored.id, capture_session_id: prepared.session_id, channel: "WHATSAPP_WEB_CALL", title: `LigaÃ§Ã£o WhatsApp â€” ${stored.contact_name || "Contato"}` };
    await confirmSavedToUser(stored.tab_id ?? null, result?.transcript_id || null);
    if (stored.tab_id != null) chrome.tabs.sendMessage(stored.tab_id, { type: "RELATO_SHOW_FEEDBACK", feedback }).catch(() => {});
    await clearSession(sessionId);
    return { ok: true, result, capture_session_id: prepared.session_id };
  } catch (error) {
    const attempts = Number(stored.attempts || 0) + 1;
    await putSession({ ...stored, state: "CALL_PENDING_UPLOAD", attempts, last_error: String(error?.message || error), ended_at: endedAt, finish_payload: finish || null });
    return { ok: false, queued: true, error: String(error?.message || error) };
  }
}

async function flushLegacyOutbox() {
  const device = await getDevice();
  if (!device?.device_token) return;
  const items = await getLegacyOutbox();
  if (!items.length) return;
  const remaining = [];
  for (const item of items) {
    try {
      const result = await deliver(item.payload);
      await confirmSavedToUser(item.tab_id ?? null, result?.transcript_id || null);
    }
    catch (error) { remaining.push({ ...item, attempts: Number(item.attempts || 0) + 1, last_error: String(error?.message || error), updated_at: new Date().toISOString() }); }
  }
  await setLegacyOutbox(remaining);
}

async function retryStoredSessions() {
  const sessions = await listSessions();
  for (const row of sessions.filter((item) => item.state === "PENDING_UPLOAD")) await finalizeStoredSession(row.id, row.finish_payload).catch(() => {});
  for (const row of sessions.filter((item) => item.state === "CALL_PENDING_UPLOAD")) await finalizeCallSession(row.id, row.finish_payload).catch(() => {});
}

async function flushAll() {
  await flushLegacyOutbox();
  await retryStoredSessions();
}

async function injectMainCapture(_tabId) {
  // Meet 0.5+: audio capture belongs exclusively to the Desktop Agent.
  return;
}

async function injectExistingMeetTabs() {
  const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
  for (const tab of tabs) if (tab.id != null) injectMainCapture(tab.id);
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  await injectExistingMeetTabs();
  await flushAll();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 1 });
  await injectExistingMeetTabs();
  await flushAll();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RETRY_ALARM) flushAll().catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo.status === "loading" || changeInfo.url) && String(changeInfo.url || tab.url || "").startsWith("https://meet.google.com/")) injectMainCapture(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const state = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY] || {};
    if (state.active && state.mode === "MEET_DESKTOP_AGENT_AUDIO" && state.tab_id === tabId) {
      await callDesktopBridge("/meet/finish", "POST", { reason: "tab_closed" }).catch(() => null);
      await setCaptureState({ active: false, ended_at: new Date().toISOString(), mode: "MEET_DESKTOP_AGENT_AUDIO" });
    }
    const sessions = await listSessions();
    for (const row of sessions.filter((item) => item.tab_id === tabId && item.state === "CAPTURING")) {
      await putSession({ ...row, state: "FINISHING", ended_at: new Date().toISOString(), finish_reason: "tab_closed" });
      await finalizeStoredSession(row.id, { ended_at: new Date().toISOString(), meeting: { metadata: { finish_reason: "tab_closed" } } });
    }
  })().catch(() => {});
});

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId < 0 || !details.url.includes(RPC_MARKER)) return;
  const method = details.url.split(RPC_MARKER)[1]?.split(/[?#]/)[0] || "unknown";
  if (!/(MeetingDeviceService|MediaSessionService)\//.test(method)) return;
  chrome.tabs.sendMessage(details.tabId, { type: "MEET_RPC_SIGNAL", method, phase: "before_request" }).catch(() => {});
}, { urls: ["https://meet.google.com/*"] });

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "DESKTOP_BRIDGE") {
      const path = String(message.path || "");
      const method = String(message.method || "GET").toUpperCase();
      const result = await callDesktopBridge(path, method, message.body ?? null);
      if (path === "/meet/start" && method === "POST") {
        await setCaptureState({ active: true, mode: "MEET_DESKTOP_AGENT_AUDIO", meeting_code: message.body?.meeting_code || null, title: message.body?.title || "Google Meet", started_at: message.body?.started_at || new Date().toISOString(), desktop_session_id: message.body?.local_session_id || null, tab_id: sender.tab?.id ?? null, error: null });
      } else if (path === "/meet/finish" && method === "POST") {
        await setCaptureState({ active: false, mode: "MEET_DESKTOP_AGENT_AUDIO", ended_at: new Date().toISOString(), error: null });
      }
      return result;
    }
    if (message?.type === "PAIR") {
      const result = await callApi("pair_redeem", { code: norm(message.code).toUpperCase(), device_name: message.device_name || "Chrome", extension_version: chrome.runtime.getManifest().version });
      await setDevice(result);
      await flushAll();
      return { ok: true, device: result };
    }

    if (message?.type === "OPEN_LIVE_PANEL") {
      const tabId = sender.tab?.id;
      if (tabId == null) return { ok: false, error: "tab_required" };
      await chrome.sidePanel.open({ tabId });
      return { ok: true };
    }

    if (message?.type === "GET_STATUS") {
      const [deviceData, stateData, legacyOutbox, storedSessions] = await Promise.all([
        chrome.storage.local.get(DEVICE_KEY),
        chrome.storage.local.get(STATE_KEY),
        getLegacyOutbox(),
        listSessions(),
      ]);
      return {
        ok: true,
        paired: Boolean(deviceData[DEVICE_KEY]?.device_token),
        device: deviceData[DEVICE_KEY] || null,
        state: stateData[STATE_KEY] || null,
        pending_uploads: legacyOutbox.length + storedSessions.filter((row) => row.state === "PENDING_UPLOAD").length,
        local_sessions: storedSessions.length,
      };
    }

    if (message?.type === "GET_INTEGRATIONS") {
      const device = await getDevice();
      if (!device?.device_token) return { ok: false, error: "extension_not_paired", providers: [] };
      return callApi("integrations_status", {}, device.device_token);
    }

    if (message?.type === "CALL_SESSION_START") {
      const row = message.session || {};
      if (!row.id) return { ok: false, error: "session_id_required" };
      await putSession({ ...row, tab_id: sender.tab?.id ?? null, state: "CALL_CAPTURING", attempts: 0, capture_mode: "WHATSAPP_WEB_AUDIO", created_at: new Date().toISOString() });
      await setCaptureState({ active: true, call: true, title: `LigaÃ§Ã£o WhatsApp â€” ${row.contact_name || "Contato"}`, started_at: row.started_at, mode: "WHATSAPP_WEB_AUDIO" });
      return { ok: true };
    }

    if (message?.type === "CALL_AUDIO_CHUNK") {
      const chunk = message.chunk || {};
      if (!message.session_id || !["local","remote"].includes(message.role) || !chunk.base64) return { ok: false, error: "invalid_call_chunk" };
      await putAudioChunk(message.session_id, message.role, { seq: Number(chunk.seq || 0), base64: String(chunk.base64), mime_type: String(chunk.mime_type || "audio/webm"), offset_ms: Number(chunk.offset_ms || 0), track_key: String(chunk.track_key || ""), captured_at: chunk.captured_at || new Date().toISOString() });
      return { ok: true };
    }

    if (message?.type === "CALL_SESSION_FINISH") {
      const row = await getSession(message.session_id);
      if (!row) return { ok: false, error: "session_not_found" };
      const finish = { ended_at: message.ended_at || new Date().toISOString(), reason: message.reason || "call_ended", contact_name: message.contact_name || row.contact_name || null };
      await putSession({ ...row, state: "FINISHING", ended_at: finish.ended_at, finish_reason: finish.reason, finish_payload: finish });
      return finalizeCallSession(message.session_id, finish);
    }

    if (message?.type === "HUMAN_FEEDBACK_SAVE") {
      const device = await getDevice();
      if (!device?.device_token) return { ok: false, error: "extension_not_paired" };
      return callApi("human_feedback_save", { feedback: message.feedback || {} }, device.device_token);
    }

    if (message?.type === "RTC_SESSION_START") {
      const row = message.session || {};
      if (!row.id) return { ok: false, error: "session_id_required" };
      const sameTab = Number.isInteger(sender.tab?.id) ? (await listSessions()).filter((item) => item.tab_id === sender.tab.id && item.state === "CAPTURING" && item.id !== row.id) : [];
      for (const previous of sameTab) {
        await putSession({ ...previous, state: "FINISHING", ended_at: new Date().toISOString(), finish_reason: "same_tab_reloaded" });
        await finalizeStoredSession(previous.id, { ended_at: new Date().toISOString(), reason: "same_tab_reloaded", meeting: { metadata: { finish_reason: "same_tab_reloaded" } } }).catch(() => {});
      }
      const captureMode = row.capture_mode || "MEET_RTC_CAPTIONS";
      const storedRow = { ...row, capture_mode: captureMode, tab_id: sender.tab?.id ?? null, state: "CAPTURING", attempts: 0, created_at: new Date().toISOString() };
      await putSession(storedRow);
      await setCaptureState({ active: true, meeting_code: row.meeting_code, title: row.title, started_at: row.started_at, mode: captureMode });
      const device = await getDevice();
      if (device?.device_token) callApi("session_heartbeat", { session: { ...storedRow, local_session_id: row.id, capture_mode: captureMode, captions_available: false, extension_version: chrome.runtime.getManifest().version } }, device.device_token).catch(() => {});
      return { ok: true };
    }

    if (message?.type === "RTC_CAPTION") {
      if (!message.session_id || !message.frame?.text) return { ok: false, error: "invalid_rtc_frame" };
      await putFrame(message.session_id, message.frame);
      return { ok: true };
    }

    if (message?.type === "RTC_AUDIO_CHUNK") {
      const chunk = message.chunk || {};
      const role = String(message.role || "");
      if (!message.session_id || !["local", "remote"].includes(role) || !chunk.base64) return { ok: false, error: "invalid_rtc_audio_chunk" };
      await putAudioChunk(message.session_id, role, { seq: Number(chunk.seq || 0), base64: String(chunk.base64), mime_type: String(chunk.mime_type || "audio/webm"), offset_ms: Number(chunk.offset_ms || 0), duration_ms: Number(chunk.duration_ms || 2500), track_key: String(chunk.track_key || ""), captured_at: chunk.captured_at || new Date().toISOString() });
      const sttStartedAt = Date.now();
      try {
        const text = await transcribeMeetAudio(chunk.base64, chunk.mime_type);
        const segment = await storeMeetAudioFrame(message.session_id, role, chunk, text);
        await recordSttTelemetry(message.session_id, norm(text) ? "text" : "empty", { role, seq: chunk.seq, latency_ms: Date.now() - sttStartedAt });
        if (segment && sender.tab?.id != null) chrome.tabs.sendMessage(sender.tab.id, { type: "RELATO_LIVE_SEGMENT", session_id: message.session_id, segment }).catch(() => {});
        return { ok: true, empty: !segment, segment };
      } catch (error) {
        const errorText = String(error?.message || error);
        await recordSttTelemetry(message.session_id, "error", { role, seq: chunk.seq, latency_ms: Date.now() - sttStartedAt, error: errorText }).catch(() => {});
        return { ok: false, stored: true, retry_on_finalize: true, error: errorText };
      }
    }

    if (message?.type === "GET_RTC_FRAMES") {
      if (!message.session_id) return { ok: false, error: "session_id_required", frames: [] };
      return { ok: true, frames: await getFrames(message.session_id) };
    }

    if (message?.type === "RTC_SPEAKER_MAP") {
      if (!message.session_id) return { ok: false, error: "session_id_required" };
      await putSpeaker(message.session_id, message.speaker || {});
      return { ok: true };
    }

    if (message?.type === "RTC_DIAGNOSTIC") {
      if (message.session_id) {
        const row = await getSession(message.session_id);
        if (row) {
          const diagnostics = Array.isArray(row.diagnostics) ? row.diagnostics.slice(-49) : [];
          diagnostics.push({ ...(message.diagnostic || {}), at: new Date().toISOString() });
          await putSession({ ...row, diagnostics });
        }
      }
      if (message.diagnostic?.code === "no_first_caption") await setCaptureState({ ...(await chrome.storage.local.get(STATE_KEY))[STATE_KEY], error: "NO_FIRST_CAPTION" });
      return { ok: true };
    }

    if (message?.type === "RTC_SESSION_FINISH") {
      const row = await getSession(message.session_id);
      if (!row) return { ok: false, error: "session_not_found" };
      await putSession({ ...row, state: "FINISHING", ended_at: message.ended_at, finish_reason: message.reason, finish_payload: message });
      return finalizeStoredSession(message.session_id, message);
    }

    if (message?.type === "FINALIZE") {
      try {
        const result = await deliver(message.payload);
        await confirmSavedToUser(sender.tab?.id ?? null, result?.transcript_id || null);
        return { ok: true, result };
      }
      catch (error) {
        await enqueueLegacyOutbox(message.payload, String(error?.message || error), sender.tab?.id ?? null);
        return { ok: false, queued: true, error: String(error?.message || error) };
      }
    }

    if (message?.type === "CAPTURE_STATE") {
      const state = message.state || {};
      await setCaptureState(state);
      const tabId = sender.tab?.id;
      if (state.active && Number.isInteger(tabId)) {
        const sessions = await listSessions();
        const row = sessions.filter((item) => item.tab_id === tabId && item.state === "CAPTURING").sort((a,b) => String(a.created_at||"").localeCompare(String(b.created_at||""))).at(-1);
        const last = row ? Number(liveHeartbeatAt.get(row.id) || 0) : 0;
        if (row && Date.now() - last >= 8000) {
          liveHeartbeatAt.set(row.id, Date.now());
          const device = await getDevice();
          const telemetry = { rtc_active: Boolean(state.rtc_active), rtc_channels: state.rtc_channels || [], audio_tracks: Number(state.audio_tracks || 0), local_audio_tracks: Number(state.local_audio_tracks || 0), remote_audio_tracks: Number(state.remote_audio_tracks || 0), known_local_tracks: Number(state.known_local_tracks || 0), own_microphone_active: Boolean(state.own_microphone_active), local_rms: Number(state.local_rms || 0), remote_rms: Number(state.remote_rms || 0), last_audio_chunk_at: state.last_audio_chunk_at || null, stt: row.stt_telemetry || row.metadata?.stt_telemetry || null };
          if (device?.device_token) callApi("session_heartbeat", { session: { ...row, local_session_id: row.id, capture_mode: row.capture_mode || state.mode || "MEET_RTC_AUDIO", captions_available: false, extension_version: chrome.runtime.getManifest().version, metadata: { ...(row.metadata || {}), telemetry } } }, device.device_token).catch(() => {});
        }
      }
      return { ok: true };
    }

    if (message?.type === "FLUSH_OUTBOX") {
      await flushAll();
      return { ok: true };
    }

    return { ok: false, error: "unknown_message" };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
