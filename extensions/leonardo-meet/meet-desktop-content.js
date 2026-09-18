const RELATO_VERSION = "0.5.0";
const JOIN_STABLE_MS = 1200;
const LEAVE_STABLE_MS = 9000;
let session = null;
let ownerPerson = "";
let joinSince = 0;
let leaveSince = 0;
let liveCursor = 0;
let panel = null;
let panelBody = null;
let badge = null;
let lastStateSentAt = 0;
let bridgeFailures = 0;
let fallbackEnabled = false;

function norm(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function nowIso() { return new Date().toISOString(); }
async function runtime(message) { try { return await chrome.runtime.sendMessage(message); } catch { return null; } }
async function bridge(path, method = "GET", body = null) {
  return runtime({ type: "DESKTOP_BRIDGE", path, method, body });
}

function getMeetingCode() {
  const match = location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return match?.[1] || "";
}

function hasEndCallControl() {
  const nodes = [...document.querySelectorAll('button,[role="button"]')];
  return nodes.some((node) => /sair da chamada|encerrar chamada|leave call|hang up/i.test(norm(node.getAttribute("aria-label"))));
}
function getMeetingTitle() {
  const text = norm(document.title).replace(/\s*-\s*Google Meet.*$/i, "");
  return text && !/^Meet:/i.test(text) ? text : `Google Meet · ${getMeetingCode()}`;
}

function candidateName(node) {
  if (!node) return "";
  const attrs = ["data-participant-name", "data-self-name", "data-display-name", "aria-label"];
  for (const attr of attrs) {
    const raw = norm(node.getAttribute?.(attr));
    if (!raw) continue;
    const cleaned = raw.replace(/\s*\((voc[eê]|you)\)\s*$/i, "").replace(/\s*(est[aá] falando|speaking)\s*$/i, "").trim();
    if (cleaned.length >= 2 && cleaned.length <= 120 && !/microfone|camera|câmera|mais opções|more options/i.test(cleaned)) return cleaned;
  }
  return "";
}

function collectParticipants() {
  const names = new Set();
  if (ownerPerson) names.add(ownerPerson);
  const selectors = [
    "[data-participant-name]", "[data-self-name]", "[data-display-name]",
    "[data-participant-id]", "[data-requested-participant-id]"
  ];
  for (const node of document.querySelectorAll(selectors.join(","))) {
    let name = candidateName(node);
    if (!name) name = candidateName(node.querySelector?.("[data-participant-name],[data-self-name],[data-display-name],[aria-label]"));
    if (name) names.add(name);
  }
  return [...names].slice(0, 80);
}

function activeSpeakerName() {
  const selectors = [
    '[data-is-speaking="true"]', '[data-speaking="true"]',
    '[aria-label*="está falando" i]', '[aria-label*="esta falando" i]', '[aria-label*="speaking" i]'
  ];
  for (const node of document.querySelectorAll(selectors.join(","))) {
    let current = node;
    for (let depth = 0; depth < 5 && current; depth++, current = current.parentElement) {
      const name = candidateName(current) || candidateName(current.querySelector?.("[data-participant-name],[data-self-name],[data-display-name],[aria-label]"));
      if (name && !/^voc[eê]$|^you$/i.test(name) && (!ownerPerson || name.toLocaleLowerCase("pt-BR") !== ownerPerson.toLocaleLowerCase("pt-BR"))) return name;
    }
  }
  return "";
}

function ensureUi() {
  if (!badge) {
    badge = document.createElement("button");
    badge.type = "button";
    badge.textContent = "🔴  Relato AI · Gravando pelo Desktop Agent";
    Object.assign(badge.style, {
      position: "fixed", right: "18px", top: "18px", zIndex: "2147483646",
      background: "#09172b", color: "#eef4ff", border: "1px solid #315b94",
      borderRadius: "999px", padding: "10px 15px", fontWeight: "700", fontSize: "13px",
      boxShadow: "0 12px 30px rgba(0,0,0,.35)", cursor: "pointer"
    });
    badge.addEventListener("click", () => { ensurePanel(); panel.style.display = panel.style.display === "none" ? "block" : "none"; });
    document.documentElement.appendChild(badge);
  }
  ensurePanel();
}

function ensurePanel() {
  if (panel) return;
  panel = document.createElement("section");
  Object.assign(panel.style, {
    position: "fixed", right: "18px", top: "72px", width: "390px", maxHeight: "72vh",
    zIndex: "2147483645", background: "#081426", color: "#eef4ff",
    border: "1px solid #315b94", borderRadius: "16px", overflow: "hidden",
    boxShadow: "0 20px 45px rgba(0,0,0,.42)", fontFamily: "Arial, sans-serif"
  });
  const head = document.createElement("div");
  Object.assign(head.style, { padding: "15px 16px", borderBottom: "1px solid #203551", display: "flex", justifyContent: "space-between", alignItems: "center" });
  const title = document.createElement("div");
  title.innerHTML = '<div style="font-weight:800;font-size:15px">Transcrição ao vivo</div><div style="font-size:12px;color:#9eb0cb;margin-top:4px">Relato AI · Desktop Agent</div>';
  const close = document.createElement("button");
  close.textContent = "×";
  Object.assign(close.style, { background: "transparent", color: "#dce8fb", border: "0", fontSize: "24px", cursor: "pointer" });
  close.addEventListener("click", () => { panel.style.display = "none"; });
  head.append(title, close);
  panelBody = document.createElement("div");
  Object.assign(panelBody.style, { overflowY: "auto", maxHeight: "calc(72vh - 66px)", padding: "8px 0 14px" });
  const waiting = document.createElement("div");
  waiting.id = "relato-desktop-waiting";
  waiting.textContent = "Aguardando a primeira fala…";
  Object.assign(waiting.style, { padding: "28px 16px", textAlign: "center", color: "#91a4c2", fontSize: "13px" });
  panelBody.appendChild(waiting);
  panel.append(head, panelBody);
  document.documentElement.appendChild(panel);
}

function pushSegment(row) {
  if (!row || !norm(row.Text ?? row.text)) return;
  ensureUi();
  document.getElementById("relato-desktop-waiting")?.remove();
  const item = document.createElement("div");
  Object.assign(item.style, { padding: "10px 16px", borderBottom: "1px solid #172b46" });
  const who = document.createElement("div");
  who.textContent = norm(row.SpeakerName ?? row.speakerName ?? row.speaker_name) || "Participantes";
  Object.assign(who.style, { color: "#8fb4ff", fontWeight: "700", fontSize: "11px", marginBottom: "3px" });
  const text = document.createElement("div");
  text.textContent = norm(row.Text ?? row.text);
  Object.assign(text.style, { color: "#eef4ff", fontSize: "13px", lineHeight: "1.45" });
  item.append(who, text);
  panelBody.appendChild(item);
  panelBody.scrollTop = panelBody.scrollHeight;
}
async function observeBridge(result, reason, localSessionId = session?.id || null) {
  if (result?.ok) { bridgeFailures = 0; return true; }
  bridgeFailures += 1;
  if (!fallbackEnabled && bridgeFailures >= 3) {
    fallbackEnabled = true;
    await runtime({ type: "ENABLE_MEET_RTC_FALLBACK", local_session_id: localSessionId, reason });
    if (badge) badge.textContent = "🔴  Relato AI · Fallback WebRTC";
    console.warn("Relato ativou fallback WebRTC", reason);
  }
  return false;
}
async function startSession() {
  if (session || fallbackEnabled || !getMeetingCode()) return;
  const status = await runtime({ type: "GET_STATUS" });
  ownerPerson = norm(status?.device?.owner_person) || ownerPerson;
  const startedAt = nowIso();
  const localSessionId = `${getMeetingCode()}-${Date.now()}-${crypto.randomUUID()}`;
  const body = {
    local_session_id: localSessionId,
    meeting_code: getMeetingCode(),
    meeting_url: location.href,
    title: getMeetingTitle(),
    started_at: startedAt,
    participants: collectParticipants()
  };
  const result = await bridge("/meet/start", "POST", body);
  if (!result?.ok) {
    console.warn("Relato Desktop Agent indisponível", result?.error || "unknown");
    bridgeFailures = 3;
    await observeBridge(result, "desktop_start_failed", localSessionId);
    return;
  }
  bridgeFailures = 0;
  session = { id: localSessionId, started_at: startedAt, meeting_code: getMeetingCode() };
  liveCursor = 0;
  ensureUi();
  await sendMeetState(true);
}

async function finishSession(reason = "left_call") {
  if (!session) return;
  const closing = session;
  session = null;
  const result = await bridge("/meet/finish", "POST", { reason });
  badge?.remove(); badge = null;
  panel?.remove(); panel = null; panelBody = null;
  liveCursor = 0;
  if (!result?.ok) console.warn("Relato não conseguiu finalizar a reunião", closing.id, result?.error);
}

async function pollLive() {
  if (!session) return;
  const result = await bridge(`/meet/live?after=${liveCursor}`);
  if (!(await observeBridge(result, "desktop_live_failed"))) return;
  for (const row of result.segments || []) {
    const seq = Number(row.Seq ?? row.seq ?? 0);
    if (seq > liveCursor) liveCursor = seq;
    pushSegment(row);
  }
}

async function sendMeetState(force = false) {
  if (!session) return;
  const now = Date.now();
  if (!force && now - lastStateSentAt < 650) return;
  lastStateSentAt = now;
  const participants = collectParticipants();
  const activeSpeaker = activeSpeakerName();
  const result = await bridge("/meet/state", "POST", {
    participants,
    active_speaker: activeSpeaker || null,
    confidence: activeSpeaker ? 0.82 : 0
  });
  await observeBridge(result, "desktop_state_failed");
}

async function tick() {
  const inCall = hasEndCallControl();
  if (inCall) {
    leaveSince = 0;
    if (!joinSince) joinSince = Date.now();
    if (!session && Date.now() - joinSince >= JOIN_STABLE_MS) await startSession();
    if (session) {
      await sendMeetState();
      await pollLive();
    }
  } else {
    joinSince = 0;
    if (session) {
      if (!leaveSince) leaveSince = Date.now();
      if (Date.now() - leaveSince >= LEAVE_STABLE_MS) await finishSession("left_call_confirmed");
    }
  }
}

setInterval(() => { tick().catch(() => {}); }, 800);
window.addEventListener("pagehide", () => {
  if (session) runtime({ type: "CAPTURE_STATE", state: { active: true, mode: "MEET_DESKTOP_AGENT_AUDIO", desktop_session_id: session.id } });
});
tick().catch(() => {});
