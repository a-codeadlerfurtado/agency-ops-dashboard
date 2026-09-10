import { clearSession, getFrames, getSession, getSpeakers, listSessions, putFrame, putSession, putSpeaker } from "./rtc-store.js";

const API = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-meeting-capture-api";
const OUTBOX_KEY = "meeting_capture_outbox";
const DEVICE_KEY = "meeting_capture_device";
const STATE_KEY = "meeting_capture_state";
const RETRY_ALARM = "meeting-capture-outbox";
const RPC_MARKER = "$rpc/google.rtc.meetings.v1.";

function norm(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
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

async function enqueueLegacyOutbox(payload, reason = "upload_failed") {
  const items = await getLegacyOutbox();
  const existing = items.find((item) => item?.payload?.meeting?.local_session_id === payload?.meeting?.local_session_id);
  if (existing) {
    existing.payload = payload;
    existing.last_error = reason;
    existing.updated_at = new Date().toISOString();
  } else {
    items.push({ id: crypto.randomUUID(), payload, attempts: 0, last_error: reason, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  await setLegacyOutbox(items);
}

async function deliver(payload) {
  const device = await getDevice();
  if (!device?.device_token) throw new Error("extension_not_paired");
  return callApi("finalize", payload, device.device_token);
}

async function setCaptureState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  await chrome.action.setBadgeText({ text: state?.active ? "REC" : state?.error ? "!" : "" });
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
      source: "MEET_RTC_CAPTIONS",
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
      source: "MEET_RTC_CAPTIONS",
      identity_confidence: norm(frame.speaker_name).startsWith("Participant ") ? 0.3 : 0.7,
      metadata: { raw_device_id: frame.device_id || frame.deviceId || null },
    });
  }
  return [...rows.values()];
}

async function finalizeStoredSession(sessionId, finishOverride = null) {
  const stored = await getSession(sessionId);
  if (!stored) return { ok: false, error: "session_not_found" };
  const [frames, speakers] = await Promise.all([getFrames(sessionId), getSpeakers(sessionId)]);
  if (!frames.length) {
    await putSession({ ...stored, state: "NEEDS_REVIEW", ended_at: finishOverride?.ended_at || stored.ended_at || new Date().toISOString(), last_error: "no_rtc_frames" });
    await setCaptureState({ active: false, error: "NO_RTC_FRAMES", meeting_code: stored.meeting_code, ended_at: finishOverride?.ended_at || stored.ended_at });
    return { ok: false, error: "no_rtc_frames" };
  }

  const meeting = {
    local_session_id: stored.id,
    meeting_code: stored.meeting_code,
    meeting_url: stored.meeting_url,
    title: finishOverride?.meeting?.title || stored.title || "Reunião Google Meet",
    started_at: stored.started_at,
    ended_at: finishOverride?.ended_at || stored.ended_at || new Date().toISOString(),
    capture_mode: "MEET_RTC_CAPTIONS",
    native_transcript_available: false,
    extension_version: stored.extension_version || chrome.runtime.getManifest().version,
    metadata: {
      ...(stored.metadata || {}),
      ...(finishOverride?.meeting?.metadata || {}),
      rtc_capture: true,
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
    await clearSession(sessionId);
    await setCaptureState({ active: false, saved: true, error: null, meeting_code: meeting.meeting_code, ended_at: meeting.ended_at, transcript_id: result?.transcript_id || null });
    return { ok: true, result };
  } catch (error) {
    const attempts = Number(stored.attempts || 0) + 1;
    await putSession({ ...stored, ...meeting, state: "PENDING_UPLOAD", attempts, last_error: String(error?.message || error), ended_at: meeting.ended_at, finish_payload: finishOverride || null });
    await setCaptureState({ active: false, saving: false, queued: true, error: null, meeting_code: meeting.meeting_code, ended_at: meeting.ended_at });
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
    try { await deliver(item.payload); }
    catch (error) { remaining.push({ ...item, attempts: Number(item.attempts || 0) + 1, last_error: String(error?.message || error), updated_at: new Date().toISOString() }); }
  }
  await setLegacyOutbox(remaining);
}

async function retryStoredSessions() {
  const sessions = await listSessions();
  for (const row of sessions.filter((item) => item.state === "PENDING_UPLOAD")) await finalizeStoredSession(row.id, row.finish_payload).catch(() => {});
}

async function flushAll() {
  await flushLegacyOutbox();
  await retryStoredSessions();
}

async function injectMainCapture(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["page-rtc-capture.js"], injectImmediately: true });
  } catch {}
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
    if (message?.type === "PAIR") {
      const result = await callApi("pair_redeem", { code: norm(message.code).toUpperCase(), device_name: message.device_name || "Chrome", extension_version: chrome.runtime.getManifest().version });
      await setDevice(result);
      await flushAll();
      return { ok: true, device: result };
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

    if (message?.type === "RTC_SESSION_START") {
      const row = message.session || {};
      if (!row.id) return { ok: false, error: "session_id_required" };
      await putSession({ ...row, tab_id: sender.tab?.id ?? null, state: "CAPTURING", attempts: 0, created_at: new Date().toISOString() });
      await setCaptureState({ active: true, meeting_code: row.meeting_code, title: row.title, started_at: row.started_at, mode: "MEET_RTC_CAPTIONS" });
      return { ok: true };
    }

    if (message?.type === "RTC_CAPTION") {
      if (!message.session_id || !message.frame?.text) return { ok: false, error: "invalid_rtc_frame" };
      await putFrame(message.session_id, message.frame);
      return { ok: true };
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
      try { return { ok: true, result: await deliver(message.payload) }; }
      catch (error) {
        await enqueueLegacyOutbox(message.payload, String(error?.message || error));
        return { ok: false, queued: true, error: String(error?.message || error) };
      }
    }

    if (message?.type === "CAPTURE_STATE") {
      await setCaptureState(message.state || {});
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
