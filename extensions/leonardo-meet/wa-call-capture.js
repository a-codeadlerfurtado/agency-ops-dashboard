(() => {
  "use strict";
  if (window.__relatoWaCallCaptureInstalled) return;
  Object.defineProperty(window, "__relatoWaCallCaptureInstalled", { value: true });
  const SOURCE = "relato-wa-call-page";
  const NativePC = window.RTCPeerConnection;
  if (!NativePC || !window.MediaRecorder) return;
  const tracked = new WeakSet();
  const recorders = new Map();
  let sessionId = null;
  let startedAt = 0;
  let endTimer = null;
  let seq = 0;

  function emit(type, payload = {}) {
    window.postMessage({ source: SOURCE, type, payload, at: Date.now() }, "*");
  }
  function ensureSession() {
    if (sessionId) return;
    startedAt = Date.now();
    sessionId = `wa-${startedAt}-${crypto.randomUUID()}`;
    emit("CALL_START", { session_id: sessionId, started_at: new Date(startedAt).toISOString() });
  }
  function scheduleEnd(reason = "tracks_ended") {
    clearTimeout(endTimer);
    if (!sessionId || recorders.size) return;
    endTimer = setTimeout(() => {
      if (!sessionId || recorders.size) return;
      emit("CALL_END", {
        session_id: sessionId,
        ended_at: new Date().toISOString(),
        reason,
      });
      sessionId = null;
      startedAt = 0;
      seq = 0;
    }, 3500);
  }

  function stopAll(reason = "peer_closed") {
    for (const entry of recorders.values()) {
      try { if (entry.recorder.state !== "inactive") entry.recorder.stop(); } catch {}
    }
    setTimeout(() => scheduleEnd(reason), 50);
  }

  function attachTrack(track, role) {
    if (!track || track.kind !== "audio" || tracked.has(track)) return;
    tracked.add(track);
    ensureSession();
    clearTimeout(endTimer);
    const key = `${role}:${track.id || crypto.randomUUID()}`;
    let mime = "audio/webm";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    let recorder;
    try { recorder = new MediaRecorder(new MediaStream([track]), { mimeType: mime, audioBitsPerSecond: 64000 }); }
    catch { recorder = new MediaRecorder(new MediaStream([track])); mime = recorder.mimeType || mime; }
    const entry = { recorder, role, key };
    recorders.set(key, entry);
    emit("TRACK_START", { session_id: sessionId, role, track_key: key, mime_type: mime });
    recorder.ondataavailable = (event) => {
      if (!event.data || !event.data.size || !sessionId) return;
      emit("AUDIO_CHUNK", {
        session_id: sessionId,
        role,
        track_key: key,
        seq: ++seq,
        offset_ms: Math.max(0, Date.now() - startedAt),
        mime_type: event.data.type || mime,
        blob: event.data,
      });
    };
    recorder.onstop = () => {
      recorders.delete(key);
      emit("TRACK_END", { session_id: sessionId, role, track_key: key });
      scheduleEnd("audio_tracks_ended");
    };
    track.addEventListener("ended", () => {
      try { if (recorder.state !== "inactive") recorder.stop(); } catch {}
    }, { once: true });
    try { recorder.start(5000); } catch {}
  }

  const nativeAddTrack = NativePC.prototype.addTrack;
  NativePC.prototype.addTrack = function(track, ...streams) {
    const sender = nativeAddTrack.call(this, track, ...streams);
    attachTrack(track, "local");
    return sender;
  };

  const nativeAddTransceiver = NativePC.prototype.addTransceiver;
  if (nativeAddTransceiver) {
    NativePC.prototype.addTransceiver = function(trackOrKind, init) {
      const tx = nativeAddTransceiver.call(this, trackOrKind, init);
      if (trackOrKind && typeof trackOrKind === "object" && trackOrKind.kind === "audio") attachTrack(trackOrKind, "local");
      return tx;
    };
  }

  function bindPc(pc) {
    pc.addEventListener("track", (event) => attachTrack(event.track, "remote"));
    pc.addEventListener("connectionstatechange", () => {
      if (["closed", "failed"].includes(pc.connectionState)) stopAll(`peer_${pc.connectionState}`);
    });
  }
  window.RTCPeerConnection = new Proxy(NativePC, {
    construct(Target, args, NewTarget) {
      const pc = Reflect.construct(Target, args, NewTarget === window.RTCPeerConnection ? Target : NewTarget);
      bindPc(pc);
      return pc;
    },
  });
  emit("READY", { media_recorder: true });
})();
