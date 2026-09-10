const API = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-meeting-capture-api";
const OUTBOX_KEY = "meeting_capture_outbox";
const DEVICE_KEY = "meeting_capture_device";
const STATE_KEY = "meeting_capture_state";

async function callApi(action, payload = {}, token = null) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-meeting-device-token"] = token;
  const response = await fetch(API, {
    method: "POST",
    headers,
    body: JSON.stringify({ action, ...payload }),
  });
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

async function getOutbox() {
  const data = await chrome.storage.local.get(OUTBOX_KEY);
  return Array.isArray(data[OUTBOX_KEY]) ? data[OUTBOX_KEY] : [];
}

async function setOutbox(items) {
  await chrome.storage.local.set({ [OUTBOX_KEY]: items.slice(-50) });
}

async function enqueueOutbox(payload, reason = "upload_failed") {
  const items = await getOutbox();
  const existing = items.find((item) => item?.payload?.meeting?.local_session_id === payload?.meeting?.local_session_id);
  if (existing) {
    existing.payload = payload;
    existing.last_error = reason;
    existing.updated_at = new Date().toISOString();
  } else {
    items.push({
      id: crypto.randomUUID(),
      payload,
      attempts: 0,
      last_error: reason,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  await setOutbox(items);
}

async function deliver(payload) {
  const device = await getDevice();
  if (!device?.device_token) throw new Error("extension_not_paired");
  return callApi("finalize", payload, device.device_token);
}

async function flushOutbox() {
  const device = await getDevice();
  if (!device?.device_token) return;
  const items = await getOutbox();
  if (!items.length) return;
  const remaining = [];
  for (const item of items) {
    try {
      await deliver(item.payload);
    } catch (error) {
      remaining.push({
        ...item,
        attempts: Number(item.attempts || 0) + 1,
        last_error: String(error?.message || error),
        updated_at: new Date().toISOString(),
      });
    }
  }
  await setOutbox(remaining);
}

async function setCaptureState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  await chrome.action.setBadgeText({ text: state?.active ? "REC" : state?.error ? "!" : "" });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create("meeting-capture-outbox", { periodInMinutes: 1 });
  await flushOutbox();
});

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create("meeting-capture-outbox", { periodInMinutes: 1 });
  await flushOutbox();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "meeting-capture-outbox") flushOutbox().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "PAIR") {
      const result = await callApi("pair_redeem", {
        code: String(message.code || "").trim().toUpperCase(),
        device_name: message.device_name || "Chrome",
        extension_version: chrome.runtime.getManifest().version,
      });
      await setDevice(result);
      await flushOutbox();
      return { ok: true, device: result };
    }

    if (message?.type === "GET_STATUS") {
      const [deviceData, stateData, outbox] = await Promise.all([
        chrome.storage.local.get(DEVICE_KEY),
        chrome.storage.local.get(STATE_KEY),
        getOutbox(),
      ]);
      return {
        ok: true,
        paired: Boolean(deviceData[DEVICE_KEY]?.device_token),
        device: deviceData[DEVICE_KEY] || null,
        state: stateData[STATE_KEY] || null,
        pending_uploads: outbox.length,
      };
    }

    if (message?.type === "FINALIZE") {
      try {
        const result = await deliver(message.payload);
        return { ok: true, result };
      } catch (error) {
        await enqueueOutbox(message.payload, String(error?.message || error));
        return { ok: false, queued: true, error: String(error?.message || error) };
      }
    }

    if (message?.type === "CAPTURE_STATE") {
      await setCaptureState(message.state || {});
      return { ok: true };
    }

    if (message?.type === "FLUSH_OUTBOX") {
      await flushOutbox();
      return { ok: true };
    }

    return { ok: false, error: "unknown_message" };
  })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});
