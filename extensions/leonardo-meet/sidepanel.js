import { getFrames, getSpeakers, listSessions } from "./rtc-store.js";

const $ = (id) => document.getElementById(id);
const tabs = [...document.querySelectorAll("[data-tab]")];
let currentSession = null;
let paused = false;
let lastSignature = "";

function fmt(ms) {
  const sec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60]
    .map((n) => String(n).padStart(2, "0")).join(":");
}
function norm(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function keyOf(value) {
  const raw = norm(value);
  const canonical = raw.match(/spaces\/[A-Za-z0-9_-]+\/devices\/(\d+)/i);
  if (canonical) return `@${canonical[1]}`;
  const short = raw.match(/^@?(\d+)$/);
  return short ? `@${short[1]}` : raw;
}
function activate(name) {
  for (const button of tabs) button.classList.toggle("active", button.dataset.tab === name);
  for (const id of ["info", "ask", "transcript"]) $("tab-" + id).classList.toggle("hidden", id !== name);
}
tabs.forEach((button) => button.addEventListener("click", () => activate(button.dataset.tab)));


function setHealth(id, label, tone = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = label;
  el.className = `health-pill${tone ? ` ${tone}` : ""}`;
}

function renderHealth(state, rowsLength = 0) {
  const rtcOk = Boolean(state?.rtc_active || (Array.isArray(state?.rtc_channels) && state.rtc_channels.length));
  setHealth("healthRtc", rtcOk ? "RTC Â· conectado" : "RTC Â· aguardando", rtcOk ? "ok" : "warn");
  const captionState = String(state?.captions_state || "unknown");
  if (captionState === "active") setHealth("healthCaptions", "Legendas Â· ativas", "ok");
  else if (captionState === "enabling") setHealth("healthCaptions", "Legendas Â· ativando", "warn");
  else if (captionState === "rate_limited") setHealth("healthCaptions", "Legendas Â· retry limitado", "warn");
  else setHealth("healthCaptions", "Legendas Â· inativas", "bad");
  const hasFrames = rowsLength > 0 || Boolean(state?.first_caption_at);
  setHealth("healthFrames", hasFrames ? "Frames Â· recebendo" : "Frames Â· aguardando", hasFrames ? "ok" : "warn");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[ch]));
}
async function activeSession() {
  const sessions = await listSessions();
  const active = sessions.filter((row) => ["CAPTURING", "FINISHING"].includes(String(row.state || "")));
  active.sort((a, b) => Date.parse(b.updated_at || b.started_at || 0) - Date.parse(a.updated_at || a.started_at || 0));
  return active[0] || null;
}
async function loadLive() {
  const [status, session] = await Promise.all([
    chrome.runtime.sendMessage({ type: "GET_STATUS" }).catch(() => null),
    activeSession(),
  ]);
  currentSession = session;
  paused = Boolean(status?.state?.paused);
  renderHealth(status?.state || {}, 0);
  $("ownerName").textContent = status?.device?.owner_person || "—";
  $("ownerState").textContent = status?.paired ? "Conectado" : "Não conectado";
  $("toggleCapture").textContent = paused ? "Retomar transcrição" : "Parar transcrição";
  $("liveDot").classList.toggle("on", Boolean(session && !paused));
  if (!session) {
    $("meetingTitle").textContent = "Aguardando reunião";
    $("infoStatus").textContent = paused ? "Pausado" : "Aguardando";
    $("infoStarted").textContent = "—";
    $("infoParticipants").textContent = "—";
    if (!lastSignature) $("transcript").innerHTML = '<div class="empty">A transcrição ao vivo aparecerá aqui.</div>';
    return;
  }
  $("meetingTitle").textContent = session.title || session.meeting_code || "Google Meet";
  $("infoStatus").textContent = paused ? "Pausado" : "Transcrevendo";
  $("infoStarted").textContent = session.started_at
    ? new Date(session.started_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—";
  const [frames, speakers] = await Promise.all([getFrames(session.id), getSpeakers(session.id)]);
  const speakerMap = new Map(speakers.map((s) => [
    keyOf(s.device_key || s.device_id || s.deviceId),
    norm(s.display_name || s.displayName),
  ]));
  $("infoParticipants").textContent = [...new Set([...speakerMap.values()].filter(Boolean))].join(", ") || "Identificando…";
  const rows = [...frames].sort((a, b) => Number(a.offset_ms || 0) - Number(b.offset_ms || 0));
  renderHealth(status?.state || {}, rows.length);
  const last = rows.at(-1);
  const signature = `${session.id}:${rows.length}:${last?.message_version || 0}:${last?.text || ""}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  if (!rows.length) {
    $("transcript").innerHTML = '<div class="empty">Conectado. Aguardando a primeira fala…</div>';
    return;
  }
  $("transcript").innerHTML = rows.map((frame) => {
    const key = keyOf(frame.device_key || frame.device_id || frame.deviceId);
    const who = speakerMap.get(key) || norm(frame.speaker_name) || "Participante";
    return `<article class="utterance"><div class="utterance-head"><span class="speaker">${escapeHtml(who)}</span><span class="timestamp">${fmt(frame.offset_ms)}</span></div><p>${escapeHtml(frame.text)}</p></article>`;
  }).join("");
  const box = $("transcript");
  box.scrollTop = box.scrollHeight;
}


$("retryCaptions")?.addEventListener("click", async () => {
  const tabId = currentSession?.tab_id;
  if (tabId == null) return;
  await chrome.tabs.sendMessage(tabId, { type: "RELATO_FORCE_CAPTIONS" }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1200));
  lastSignature = "";
  await loadLive().catch(() => {});
});

$("refresh").addEventListener("click", () => {
  lastSignature = "";
  loadLive().catch(() => {});
});
$("toggleCapture").addEventListener("click", async () => {
  const tabId = currentSession?.tab_id;
  if (tabId == null) return;
  paused = !paused;
  await chrome.tabs.sendMessage(tabId, { type: "RELATO_CAPTURE_CONTROL", paused }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 300));
  lastSignature = "";
  await loadLive().catch(() => {});
});

$("askForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = norm($("askInput").value);
  if (!question || !currentSession) return;
  const frames = await getFrames(currentSession.id);
  const words = question.toLocaleLowerCase("pt-BR").split(/\W+/).filter((x) => x.length > 3);
  const ranked = frames.map((frame) => ({
    frame,
    score: words.reduce((n, word) => n + (String(frame.text || "").toLocaleLowerCase("pt-BR").includes(word) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score || Number(b.frame.offset_ms || 0) - Number(a.frame.offset_ms || 0));
  const picks = ranked.filter((x) => x.score > 0).slice(0, 5);
  $("askAnswer").textContent = picks.length
    ? picks.map((x) => `[${fmt(x.frame.offset_ms)}] ${x.frame.text}`).join("\n\n")
    : "Não encontrei um trecho claramente relacionado ainda. A análise completa fica disponível após o processamento da reunião.";
});

activate("transcript");
loadLive().catch(() => {});
setInterval(() => loadLive().catch(() => {}), 900);
