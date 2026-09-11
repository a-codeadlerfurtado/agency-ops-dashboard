(() => {
  "use strict";
  if (window.__relatoWaContentInstalled) return;
  window.__relatoWaContentInstalled = true;
  const SOURCE = "relato-wa-call-page";
  let current = null;
  let overlay = null;

  function norm(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
  function contactName() {
    const candidates = [
      document.querySelector("header span[title]")?.getAttribute("title"),
      document.querySelector("[data-testid='conversation-info-header-chat-title']")?.textContent,
      document.querySelector("[data-testid='call-info'] span[title]")?.getAttribute("title"),
    ].map(norm).filter(Boolean);
    if (candidates[0]) return candidates[0].slice(0, 160);
    return norm(document.title).replace(/^\(\d+\)\s*/, "").replace(/\s*[-–]\s*WhatsApp.*$/i, "").slice(0, 160) || "Contato WhatsApp";
  }

  async function runtime(message) {
    try { return await chrome.runtime.sendMessage(message); } catch { return null; }
  }
  function showOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "relato-wa-call-indicator";
    overlay.textContent = "Relato AI · REC chamada";
    Object.assign(overlay.style, {
      position: "fixed", top: "14px", right: "14px", zIndex: "2147483647",
      padding: "8px 11px", borderRadius: "999px", background: "#0b162b",
      color: "#f3f7ff", border: "1px solid #4f6ca6", font: "700 12px system-ui",
      boxShadow: "0 8px 24px rgba(0,0,0,.28)", pointerEvents: "none",
    });
    document.documentElement.appendChild(overlay);
  }
  function hideOverlay() { overlay?.remove(); overlay = null; }

  async function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = () => reject(reader.error || new Error("blob_read_failed"));
      reader.readAsDataURL(blob);
    });
  }

  async function start(payload) {
    if (current?.id === payload.session_id) return;
    current = {
      id: payload.session_id,
      started_at: payload.started_at || new Date().toISOString(),
      contact_name: contactName(),
    };
    showOverlay();
    await runtime({ type: "CALL_SESSION_START", session: { ...current, source: "WHATSAPP_WEB" } });
  }
  async function chunk(payload) {
    if (!current || current.id !== payload.session_id || !(payload.blob instanceof Blob)) return;
    const base64 = await blobToBase64(payload.blob);
    if (!base64) return;
    await runtime({
      type: "CALL_AUDIO_CHUNK",
      session_id: current.id,
      role: payload.role === "local" ? "local" : "remote",
      chunk: {
        seq: Number(payload.seq || 0),
        offset_ms: Number(payload.offset_ms || 0),
        mime_type: norm(payload.mime_type) || payload.blob.type || "audio/webm",
        track_key: norm(payload.track_key),
        base64,
      },
    });
  }

  async function finish(payload) {
    if (!current || current.id !== payload.session_id) return;
    const closing = current;
    current = null;
    hideOverlay();
    await runtime({
      type: "CALL_SESSION_FINISH",
      session_id: closing.id,
      ended_at: payload.ended_at || new Date().toISOString(),
      reason: payload.reason || "call_ended",
      contact_name: closing.contact_name,
    });
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== SOURCE) return;
    const { type, payload = {} } = event.data;
    if (type === "CALL_START") start(payload).catch(() => {});
    else if (type === "AUDIO_CHUNK") chunk(payload).catch(() => {});
    else if (type === "CALL_END") finish(payload).catch(() => {});
  });

  window.addEventListener("beforeunload", () => {
    if (current) runtime({ type: "CALL_SESSION_FINISH", session_id: current.id, ended_at: new Date().toISOString(), reason: "page_unload", contact_name: current.contact_name });
  });
})();
