const VERSION = "0.3.6";
const MEETING_CODE_RE = /\/([a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3})(?:[/?#]|$)/i;
const LEAVE_RE = /(sair da chamada|encerrar chamada|sair da reunião|leave call|leave meeting|hang up|desligar)/i;
const JOIN_RE = /(participar agora|pedir para participar|join now|ask to join)/i;
const RTC_FRESH_MS = 30_000;
const CAPTION_FRESH_MS = 45_000;
const JOIN_STABLE_MS = 1_200;
const HEALTH_INTERVAL_MS = 10_000;
const RTC_SILENCE_RECOVERY_MS = 30_000;
const NO_FIRST_CAPTION_WARN_MS = 25_000;
const CAPTION_WATCHDOG_MS = 10_000;
const CAPTION_ATTEMPT_WINDOW_MS = 60_000;
const CAPTION_ATTEMPT_MAX = 3;
const CAPTION_LABEL_RE = /(legendas|caption|captions|subtitles|closed captions)/i;
const CAPTION_ENABLE_RE = /(ativar|mostrar|enable|turn on|show)/i;
const CAPTION_DISABLE_RE = /(desativar|ocultar|disable|turn off|hide)/i;
const LOCAL_CAPTION_LABEL_RE = /^(você|voce|you)$/i;

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
let captionsState = "unknown";
let lastDiagnostic = null;
let lastRtcStatus = null;
let captionAttemptTimestamps = [];
let ownerPerson = "";
let localDeviceKey = "";
let recordingOverlay = null;
let liveTranscriptPanel = null;
let domCaptionObserver = null;
let domCaptionScanTimer = null;
let domCaptionCounter = 0;
let lastRtcDataCaptionAt = 0;
const domCaptionState = new Map();
const liveTranscriptRows = new Map();
const prebuffer = [];
const speakerPrebuffer = new Map();

function nowIso() { return new Date().toISOString(); }
function norm(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

function showRecordingOverlay(source = "Google Meet") {
  if (recordingOverlay) return;
  recordingOverlay = document.createElement("div");
  recordingOverlay.id = "relato-recording-indicator";
  recordingOverlay.innerHTML = `<span data-relato-dot>●</span><span><strong>Relato AI</strong> · Gravando e transcrevendo<small>${source}</small></span>`;
  Object.assign(recordingOverlay.style, {
    position: "fixed", top: "14px", right: "14px", zIndex: "2147483647",
    display: "flex", alignItems: "center", gap: "9px", padding: "9px 12px",
    borderRadius: "999px", background: "rgba(11,22,43,.96)", color: "#f3f7ff",
    border: "1px solid rgba(79,108,166,.75)", font: "600 12px system-ui",
    boxShadow: "0 10px 28px rgba(0,0,0,.32)", pointerEvents: "auto", cursor: "pointer",
    userSelect: "none", backdropFilter: "blur(10px)"
  });
  recordingOverlay.title = "Abrir transcrição ao vivo";
  recordingOverlay.setAttribute("role", "button");
  recordingOverlay.setAttribute("tabindex", "0");
  const openLive = () => toggleLiveTranscriptPanel();
  recordingOverlay.addEventListener("click", openLive);
  recordingOverlay.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openLive(); }
  });
  const dot = recordingOverlay.querySelector("[data-relato-dot]");
  Object.assign(dot.style, { color: "#ef4444", fontSize: "16px", lineHeight: "1" });
  const small = recordingOverlay.querySelector("small");
  Object.assign(small.style, { display: "block", color: "#97a9ca", fontSize: "10px", marginTop: "1px" });
  dot.animate([{ opacity: .45, transform: "scale(.86)" }, { opacity: 1, transform: "scale(1.06)" }, { opacity: .45, transform: "scale(.86)" }], { duration: 1400, iterations: Infinity });
  document.documentElement.appendChild(recordingOverlay);
}

function hideRecordingOverlay() { recordingOverlay?.remove(); recordingOverlay = null; }

function renderLiveTranscript() {
  if (!liveTranscriptPanel) return;
  const body = liveTranscriptPanel.querySelector("[data-relato-live-body]");
  if (!body) return;
  body.replaceChildren();
  const rows = [...liveTranscriptRows.values()].slice(-120);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.textContent = "Aguardando a primeira fala…";
    Object.assign(empty.style, { color: "#97a9ca", padding: "18px 4px", textAlign: "center", fontSize: "12px" });
    body.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("article");
    Object.assign(item.style, { padding: "10px 0", borderBottom: "1px solid rgba(148,163,184,.12)" });
    const who = document.createElement("div");
    who.textContent = norm(row.speaker_name) || "Participante";
    Object.assign(who.style, { color: "#8fb4ff", fontWeight: "700", fontSize: "11px", marginBottom: "3px" });
    const text = document.createElement("div");
    text.textContent = norm(row.text);
    Object.assign(text.style, { color: "#eef4ff", fontSize: "13px", lineHeight: "1.45" });
    item.append(who, text);
    body.appendChild(item);
  }
  body.scrollTop = body.scrollHeight;
}

function ensureLiveTranscriptPanel() {
  if (liveTranscriptPanel) return liveTranscriptPanel;
  liveTranscriptPanel = document.createElement("section");
  liveTranscriptPanel.id = "relato-live-transcript-panel";
  Object.assign(liveTranscriptPanel.style, {
    position: "fixed", top: "72px", right: "14px", zIndex: "2147483646", width: "390px",
    height: "min(72vh, 680px)", display: "flex", flexDirection: "column", overflow: "hidden",
    borderRadius: "18px", background: "rgba(9,18,34,.98)", color: "#eef4ff",
    border: "1px solid rgba(79,108,166,.72)", boxShadow: "0 18px 52px rgba(0,0,0,.42)",
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", backdropFilter: "blur(14px)"
  });
  const header = document.createElement("div");
  Object.assign(header.style, { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid rgba(148,163,184,.14)" });
  const title = document.createElement("div");
  title.innerHTML = '<strong style="font-size:14px">Transcrição ao vivo</strong><small style="display:block;color:#97a9ca;margin-top:2px">Relato AI · Google Meet</small>';
  const close = document.createElement("button");
  close.type = "button"; close.textContent = "×"; close.title = "Fechar";
  Object.assign(close.style, { border: "0", background: "transparent", color: "#c9d5ea", fontSize: "24px", cursor: "pointer", lineHeight: "1" });
  close.addEventListener("click", () => { liveTranscriptPanel?.remove(); liveTranscriptPanel = null; });
  header.append(title, close);
  const body = document.createElement("div");
  body.dataset.relatoLiveBody = "1";
  Object.assign(body.style, { flex: "1", overflowY: "auto", padding: "6px 16px 14px" });
  liveTranscriptPanel.append(header, body);
  document.documentElement.appendChild(liveTranscriptPanel);
  renderLiveTranscript();
  return liveTranscriptPanel;
}

function toggleLiveTranscriptPanel() {
  if (liveTranscriptPanel) { liveTranscriptPanel.remove(); liveTranscriptPanel = null; return; }
  ensureLiveTranscriptPanel();
}

function pushLiveTranscript(frame) {
  const text = norm(frame?.text);
  if (!text) return;
  const rawKey = norm(frame?.message_id || frame?.messageId);
  const fallbackKey = `${norm(frame?.device_key || frame?.device_id || frame?.deviceId)}:${Math.floor(Number(frame?.offset_ms || Date.now()) / 1000)}`;
  const key = rawKey || fallbackKey;
  const version = Number(frame?.message_version ?? frame?.messageVersion ?? 0);
  const previous = liveTranscriptRows.get(key);
  if (previous && Number(previous.message_version ?? previous.messageVersion ?? 0) > version) return;
  liveTranscriptRows.set(key, { ...frame, text });
  while (liveTranscriptRows.size > 200) liveTranscriptRows.delete(liveTranscriptRows.keys().next().value);
  renderLiveTranscript();
}

function domCaptionCandidate(element) {
  if (!(element instanceof HTMLElement)) return null;
  const knownText = element.matches?.(".ygicle,.VbkSUe") ? norm(element.textContent) : "";
  let row = element;
  for (let depth = 0; row && depth < 5; depth++, row = row.parentElement) {
    const label = labelOf(row);
    const hasSignal = CAPTION_LABEL_RE.test(label) || row.matches?.("[aria-live='polite'],[aria-live='assertive'],.iTTPOb,.a4cQT,.ygicle,.VbkSUe");
    if (!hasSignal && !knownText) continue;
    const speakerNode = row.querySelector?.(".NWpY1d,.zs7s8d,[data-speaker-name]");
    let speaker = norm(speakerNode?.textContent || speakerNode?.getAttribute?.("data-speaker-name"));
    let text = knownText || norm(row.querySelector?.(".ygicle,.VbkSUe")?.textContent);
    if (!text) {
      const lines = String(row.innerText || row.textContent || "").split(/\n+/).map(norm).filter(Boolean);
      if (lines.length >= 2 && lines[0].length <= 100) {
        speaker ||= lines[0];
        text = norm(lines.slice(1).join(" "));
      } else text = norm(row.textContent);
    }
    if (!text || text.length < 2 || text.length > 900) continue;
    if (CAPTION_LABEL_RE.test(text) && text.length < 90) continue;
    if (/^(você|voce|you)$/i.test(speaker)) speaker = ownerPerson || "Você";
    return { speaker: speaker || "Participante", text };
  }
  return null;
}

function emitDomCaption(speaker, text) {
  const now = Date.now();
  if (lastRtcDataCaptionAt && now - lastRtcDataCaptionAt < 2500) return;
  const normalizedSpeaker = norm(speaker) || "Participante";
  const normalizedText = norm(text);
  if (!normalizedText) return;
  const key = normalizedSpeaker.toLocaleLowerCase("pt-BR");
  const previous = domCaptionState.get(key);
  if (previous && previous.text === normalizedText && now - previous.at < 12000) return;
  const extendsPrevious = previous && now - previous.at < 9000 && (normalizedText.startsWith(previous.text) || previous.text.startsWith(normalizedText));
  const messageId = extendsPrevious ? previous.message_id : `dom-${now}-${++domCaptionCounter}`;
  const version = extendsPrevious ? previous.version + 1 : 0;
  domCaptionState.set(key, { text: normalizedText, message_id: messageId, version, at: now });
  handleRtcCaption({
    message_id: messageId,
    message_version: version,
    device_id: `dom:${key}`,
    device_key: `dom:${key}`,
    speaker_name: normalizedSpeaker,
    text: normalizedText,
    source: "MEET_DOM_CAPTIONS",
  });
}

function scanDomCaptions() {
  domCaptionScanTimer = null;
  if (!session || manualPaused) return;
  const nodes = document.querySelectorAll("[aria-live='polite'],[aria-live='assertive'],[role='region'][aria-label],.iTTPOb,.a4cQT,.ygicle,.VbkSUe");
  const seen = new Set();
  for (const node of nodes) {
    const candidate = domCaptionCandidate(node);
    if (!candidate) continue;
    const signature = `${candidate.speaker}|${candidate.text}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    emitDomCaption(candidate.speaker, candidate.text);
  }
}

function scheduleDomCaptionScan() {
  if (domCaptionScanTimer) return;
  domCaptionScanTimer = setTimeout(scanDomCaptions, 80);
}

function startDomCaptionObserver() {
  if (domCaptionObserver || !document.documentElement) return;
  domCaptionObserver = new MutationObserver(scheduleDomCaptionScan);
  domCaptionObserver.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  scheduleDomCaptionScan();
}

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


function findCaptionsToggle() {
  const controls = document.querySelectorAll("button[aria-label], [role='button'][aria-label], button[data-tooltip], [role='button'][data-tooltip]");
  for (const control of controls) {
    const value = `${labelOf(control)} ${norm(control.textContent)}`;
    if (!CAPTION_LABEL_RE.test(value)) continue;
    const pressed = control.getAttribute("aria-pressed");
    if (pressed === "true" || pressed === "false") return control;
    if (CAPTION_ENABLE_RE.test(value) || CAPTION_DISABLE_RE.test(value)) return control;
  }
  return null;
}

function nativeCaptionsActive() {
  const button = findCaptionsToggle();
  if (button) {
    const pressed = button.getAttribute("aria-pressed");
    if (pressed === "true") return true;
    if (pressed === "false") return false;
    const label = `${labelOf(button)} ${norm(button.textContent)}`;
    if (CAPTION_DISABLE_RE.test(label) && CAPTION_LABEL_RE.test(label)) return true;
    if (CAPTION_ENABLE_RE.test(label) && CAPTION_LABEL_RE.test(label)) return false;
  }
  const regions = document.querySelectorAll("[aria-live='polite'], [role='region'][aria-label]");
  for (const el of regions) if (CAPTION_LABEL_RE.test(labelOf(el))) return true;
  return false;
}

function words(value) {
  return norm(value).toLocaleLowerCase("pt-BR").split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2);
}

function textsOverlap(a, b) {
  const aa = norm(a).toLocaleLowerCase("pt-BR");
  const bb = norm(b).toLocaleLowerCase("pt-BR");
  if (!aa || !bb) return false;
  if (aa.includes(bb.slice(0, Math.min(28, bb.length))) || bb.includes(aa.slice(0, Math.min(28, aa.length)))) return true;
  const wa = new Set(words(aa));
  const wb = words(bb);
  const common = wb.filter((w) => wa.has(w)).length;
  return common >= Math.min(3, Math.max(1, Math.floor(wb.length * 0.55)));
}

function hideCaptionElement(el) {
  if (!el || !(el instanceof HTMLElement)) return;
  if (el.closest?.("#relato-live-transcript-panel,#relato-recording-indicator")) return;
  if (el.matches?.("button,[role='button']") || el.querySelector?.("button,[role='button']")) return;
  el.dataset.relatoSilentCaption = "1";
  el.style.setProperty("opacity", "0", "important");
  el.style.setProperty("pointer-events", "none", "important");
  el.style.setProperty("user-select", "none", "important");
}

function captionVisualContainer(leaf) {
  if (!(leaf instanceof HTMLElement)) return null;
  let node = leaf;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
    if (node.matches?.("button,[role='button']") || node.querySelector?.("button,[role='button']")) break;
    const text = norm(node.textContent);
    const rect = node.getBoundingClientRect?.();
    if (text && text.length <= 1800 && rect && rect.height > 0 && rect.height <= 240 && rect.width >= 120) {
      const hasSpeaker = Boolean(node.querySelector?.(".NWpY1d,.zs7s8d,[data-speaker-name]"));
      const hasCaptionLeaf = Boolean(node.querySelector?.(".ygicle,.VbkSUe"));
      if (hasCaptionLeaf && hasSpeaker) return node;
    }
  }
  return leaf;
}

function hideKnownCaptionRegions() {
  const leaves = document.querySelectorAll(".ygicle,.VbkSUe");
  for (const leaf of leaves) hideCaptionElement(captionVisualContainer(leaf));
}

function hideNativeCaptionForFrame(frameText) {
  const leaves = document.querySelectorAll(".ygicle,.VbkSUe");
  for (const leaf of leaves) {
    const body = norm(leaf.textContent);
    if (body && textsOverlap(body, frameText)) hideCaptionElement(captionVisualContainer(leaf));
  }
}

function findLocalCaptionRegion(frameText) {
  const direct = document.querySelectorAll("[aria-live='polite'], [role='region']");
  for (const el of direct) {
    const body = norm(el.textContent);
    if (body.length > 1600 || !textsOverlap(body, frameText)) continue;
    if (/(^|\s)(você|voce|you)(\s|$)/i.test(body)) return el;
  }
  const labels = document.querySelectorAll("div,span");
  for (const label of labels) {
    if (!LOCAL_CAPTION_LABEL_RE.test(norm(label.textContent)) || label.children.length) continue;
    let node = label.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const body = norm(node.textContent);
      if (body.length <= 1600 && textsOverlap(body, frameText)) return node;
    }
  }
  return null;
}

function resolveLocalSpeaker(payload) {
  const key = norm(payload?.device_key || payload?.deviceKey || payload?.device_id || payload?.deviceId);
  if (!key || !ownerPerson) return null;
  if (localDeviceKey && key === localDeviceKey) return ownerPerson;
  const region = findLocalCaptionRegion(payload?.text || "");
  if (!region) return null;
  localDeviceKey = key;
  hideCaptionElement(region);
  const speaker = {
    deviceId: norm(payload?.device_id || payload?.deviceId || key),
    deviceKey: key,
    displayName: ownerPerson,
    source: "meet_local_caption_you",
  };
  handleSpeaker(speaker);
  return ownerPerson;
}

async function reportHealth(extra = {}) {
  const state = {
    active: Boolean(session) && !manualPaused,
    paused: manualPaused,
    meeting_code: getMeetingCode(),
    title: session?.title || getMeetingTitle(),
    mode: "MEET_RTC_CAPTIONS",
    rtc_active: Boolean(lastRtcStatus?.active || transportFresh()),
    rtc_channels: Array.isArray(lastRtcStatus?.channels) ? lastRtcStatus.channels : [],
    captions_state: captionsState,
    first_caption_at: lastCaptionAt || null,
    last_caption_at: lastCaptionAt || null,
    last_diagnostic: lastDiagnostic,
    ...extra,
  };
  await runtime({ type: "CAPTURE_STATE", state });
}

function captionAttemptAllowed() {
  const now = Date.now();
  captionAttemptTimestamps = captionAttemptTimestamps.filter((t) => now - t < CAPTION_ATTEMPT_WINDOW_MS);
  return captionAttemptTimestamps.length < CAPTION_ATTEMPT_MAX;
}

async function ensureNativeCaptions(reason = "watchdog", force = false) {
  if (manualPaused || !getMeetingCode()) return false;
  if (nativeCaptionsActive()) {
    captionsState = "active";
    startDomCaptionObserver();
    scheduleDomCaptionScan();
    hideKnownCaptionRegions();
    await reportHealth();
    return true;
  }
  if (!force && !captionAttemptAllowed()) {
    captionsState = "rate_limited";
    await reportHealth();
    return false;
  }
  captionAttemptTimestamps.push(Date.now());
  captionsState = "enabling";
  await reportHealth({ caption_activation_reason: reason });
  const button = findCaptionsToggle();
  if (button) {
    try { button.click(); } catch {}
  } else {
    try {
      const init = { key: "c", code: "KeyC", keyCode: 67, which: 67, bubbles: true, cancelable: true };
      document.body.dispatchEvent(new KeyboardEvent("keydown", init));
      document.body.dispatchEvent(new KeyboardEvent("keyup", init));
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 900));
  captionsState = nativeCaptionsActive() ? "active" : "not_active";
  if (captionsState === "active") {
    startDomCaptionObserver();
    scheduleDomCaptionScan();
    hideKnownCaptionRegions();
  } else requestRtcCapture(true);
  await reportHealth();
  return captionsState === "active";
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
  const status = await runtime({ type: "GET_STATUS" });
  ownerPerson = norm(status?.device?.owner_person) || ownerPerson;
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
  domCaptionState.clear();
  lastRtcDataCaptionAt = 0;
  liveTranscriptRows.clear();
  for (const frame of prebuffer) pushLiveTranscript(frame);
  renderLiveTranscript();
  showRecordingOverlay("Google Meet");
  startDomCaptionObserver();
  scheduleDomCaptionScan();
  await runtime({ type: "RTC_SESSION_START", session: { ...session, extension_version: VERSION } });
  for (const speaker of speakerPrebuffer.values()) await runtime({ type: "RTC_SPEAKER_MAP", session_id: session.id, speaker });
  speakerPrebuffer.clear();
  for (const frame of prebuffer.splice(0)) await runtime({ type: "RTC_CAPTION", session_id: session.id, frame: { ...frame, offset_ms: Math.max(0, Number(frame.observed_at || Date.now()) - started) } });
  await runtime({ type: "CAPTURE_STATE", state: { active: true, meeting_code: meetingCode, title: session.title, started_at: session.started_at, mode: "MEET_RTC_CAPTIONS" } });
  requestRtcCapture(true);
  ensureNativeCaptions("session_start", true).catch(() => {});
}

async function endSession(reason = "left_call") {
  if (!session) return;
  const closing = session;
  session = null;
  hideRecordingOverlay();
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
  const source = norm(payload?.source) || "MEET_RTC_CAPTIONS";
  if (source === "MEET_RTC_CAPTIONS") lastRtcDataCaptionAt = Date.now();
  const localSpeaker = resolveLocalSpeaker(payload);
  hideNativeCaptionForFrame(payload?.text || "");
  const frame = {
    ...payload,
    speaker_name: localSpeaker || payload?.speaker_name,
    observed_at: Date.now(),
    source,
  };
  lastRtcSignalAt = Date.now();
  lastCaptionAt = Date.now();
  captionsState = "active";
  warningSent = false;
  pushLiveTranscript(frame);
  reportHealth({ first_caption_at: lastCaptionAt, last_caption_at: lastCaptionAt }).catch(() => {});
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
    lastRtcStatus = payload;
    if (payload.active || (Array.isArray(payload.channels) && payload.channels.length)) lastRtcSignalAt = Date.now();
    reportHealth().catch(() => {});
  } else if (type === "CAPTION") {
    handleRtcCaption(payload);
  } else if (type === "SPEAKER_MAP") {
    handleSpeaker(payload);
  } else if (type === "DIAGNOSTIC") {
    lastDiagnostic = payload;
    reportHealth().catch(() => {});
    runtime({ type: "RTC_DIAGNOSTIC", session_id: session?.id || null, diagnostic: payload });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "MEET_RPC_SIGNAL") {
    lastRtcSignalAt = Date.now();
    requestRtcCapture();
  }
  if (message?.type === "REINJECT_RTC") requestRtcCapture(true);
  if (message?.type === "RELATO_FORCE_CAPTIONS") ensureNativeCaptions("manual_retry", true).catch(() => {});
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
      if (!lastCaptionAt || Date.now() - lastCaptionAt > CAPTION_FRESH_MS) ensureNativeCaptions("no_recent_caption").catch(() => {});
      if (!lastCaptionAt && Date.now() - session.started_epoch > NO_FIRST_CAPTION_WARN_MS && !warningSent) {
        warningSent = true;
        await runtime({ type: "RTC_DIAGNOSTIC", session_id: session.id, diagnostic: { code: "no_first_caption", message: "RTC ativo, mas nenhum frame de transcrição chegou nos primeiros 25s." } });
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
  ensureNativeCaptions("watchdog").catch(() => {});
  reportHealth().catch(() => {});
}, CAPTION_WATCHDOG_MS);

window.addEventListener("pageshow", () => requestRtcCapture(true));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") requestRtcCapture(true); });
requestRtcCapture(true);
