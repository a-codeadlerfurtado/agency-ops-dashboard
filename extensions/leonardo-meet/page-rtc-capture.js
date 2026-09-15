(() => {
  "use strict";

  if (window.__leonardoMeetRtcCaptureInstalled) return;
  Object.defineProperty(window, "__leonardoMeetRtcCaptureInstalled", { value: true, configurable: false });

  const SOURCE = "leonardo-meet-rtc";
  const CONTROL_SOURCE = "leonardo-meet-content";
  const NativePC = window.RTCPeerConnection;
  if (!NativePC) return;

  const nativeCreateDataChannel = NativePC.prototype.createDataChannel;
  const seenPeerConnections = new WeakSet();
  const peerConnections = new Set();
  const audioRecorders = new Map();
  const knownLocalTracks = new Set();
  const lastRmsByRole = { local: 0, remote: 0 };
  let lastAudioChunkAt = 0;
  let audioCaptureEnabled = false;
  let audioSeq = 0;
  const boundChannels = new WeakSet();
  const channelLabels = new Set();
  const speakerMap = new Map();
  const latestMessageVersions = new Map();
  let activePc = null;
  let firstCaptionAt = 0;
  let lastCaptionAt = 0;
  let lastCollectionsAt = 0;
  let channelPrimeAt = 0;

  function emit(type, payload = {}) {
    window.postMessage({ source: SOURCE, type, payload, at: Date.now() }, "*");
  }

  function text(bytes) {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(bytes); }
    catch { return ""; }
  }

  function normalizeDeviceKey(value) {
    const raw = String(value || "").trim();
    const canonical = raw.match(/spaces\/[A-Za-z0-9_-]+\/devices\/(\d+)/i);
    if (canonical) return `@${canonical[1]}`;
    const short = raw.match(/^@?(\d+)$/);
    if (short) return `@${short[1]}`;
    const suffix = raw.match(/\/(\d+)\/?$/);
    if (suffix) return `@${suffix[1]}`;
    return raw.slice(0, 180);
  }

  function participantFallback(deviceId) {
    const key = normalizeDeviceKey(deviceId);
    const n = key.match(/@(\d+)/)?.[1];
    return n ? `Participant ${n}` : "Participant";
  }

  function readVarint(bytes, start) {
    let value = 0n;
    let shift = 0n;
    let pos = start;
    while (pos < bytes.length && shift <= 70n) {
      const b = BigInt(bytes[pos++]);
      value |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) return { value, pos };
      shift += 7n;
    }
    throw new Error("invalid_varint");
  }

  function parseFields(bytes) {
    const fields = [];
    let pos = 0;
    while (pos < bytes.length) {
      const tag = readVarint(bytes, pos);
      pos = tag.pos;
      const field = Number(tag.value >> 3n);
      const wire = Number(tag.value & 7n);
      if (!field || field > 2048) break;
      if (wire === 0) {
        const next = readVarint(bytes, pos);
        fields.push({ field, wire, value: next.value });
        pos = next.pos;
      } else if (wire === 1) {
        if (pos + 8 > bytes.length) break;
        fields.push({ field, wire, value: bytes.slice(pos, pos + 8) });
        pos += 8;
      } else if (wire === 2) {
        const len = readVarint(bytes, pos);
        pos = len.pos;
        const size = Number(len.value);
        if (!Number.isSafeInteger(size) || size < 0 || pos + size > bytes.length) break;
        fields.push({ field, wire, value: bytes.slice(pos, pos + size) });
        pos += size;
      } else if (wire === 5) {
        if (pos + 4 > bytes.length) break;
        fields.push({ field, wire, value: bytes.slice(pos, pos + 4) });
        pos += 4;
      } else {
        break;
      }
    }
    return fields;
  }

  function fieldValues(bytes, fieldNo, wire = 2) {
    try { return parseFields(bytes).filter((entry) => entry.field === fieldNo && entry.wire === wire).map((entry) => entry.value); }
    catch { return []; }
  }

  function firstString(bytes, fieldNo) {
    const value = fieldValues(bytes, fieldNo, 2)[0];
    return value ? text(value).trim() : "";
  }

  function firstVarint(bytes, fieldNo) {
    try {
      const value = parseFields(bytes).find((entry) => entry.field === fieldNo && entry.wire === 0)?.value;
      return value == null ? null : value;
    } catch { return null; }
  }

  function decodeTranscriptMessage(bytes) {
    const deviceId = firstString(bytes, 1);
    const messageId = firstVarint(bytes, 2);
    const messageVersion = firstVarint(bytes, 3);
    const transcriptText = firstString(bytes, 6);
    const langId = firstVarint(bytes, 8);
    if (!deviceId || !transcriptText) return null;
    return {
      deviceId,
      messageId: messageId == null ? "0" : messageId.toString(),
      messageVersion: messageVersion == null ? 0 : Number(messageVersion),
      text: transcriptText,
      langId: langId == null ? null : langId.toString(),
    };
  }

  function decodeTranscriptPayload(bytes) {
    const decoded = [];
    const wrappers = fieldValues(bytes, 1, 2);
    for (const candidate of wrappers) {
      const message = decodeTranscriptMessage(candidate);
      if (message) decoded.push(message);
    }
    if (!decoded.length) {
      const direct = decodeTranscriptMessage(bytes);
      if (direct) decoded.push(direct);
    }
    return decoded;
  }

  function descendFieldPath(bytes, path) {
    let nodes = [bytes];
    for (const fieldNo of path) {
      const next = [];
      for (const node of nodes) next.push(...fieldValues(node, fieldNo, 2));
      nodes = next;
      if (!nodes.length) break;
    }
    return nodes;
  }

  function plausibleName(value) {
    const s = String(value || "").replace(/\s+/g, " ").trim();
    if (s.length < 2 || s.length > 120) return false;
    if (/spaces\/.+\/devices\//i.test(s)) return false;
    if (/^(participant|participante|speaker|guest|convidado|unknown|desconhecido)(\b|\s)/i.test(s)) return false;
    if (/^[\x00-\x1f]+$/.test(s)) return false;
    return /[\p{L}]/u.test(s);
  }

  function recordSpeaker(deviceId, displayName, source) {
    const name = String(displayName || "").replace(/\s+/g, " ").trim();
    if (!deviceId || !plausibleName(name)) return false;
    const key = normalizeDeviceKey(deviceId);
    const previous = speakerMap.get(key);
    if (previous?.displayName === name) return false;
    const row = { deviceId: String(deviceId).slice(0, 300), deviceKey: key, displayName: name, source };
    speakerMap.set(key, row);
    speakerMap.set(String(deviceId), row);
    emit("SPEAKER_MAP", row);
    return true;
  }

  function decodeCanonicalDeviceMappings(bytes) {
    let changed = false;
    for (const leaf of descendFieldPath(bytes, [1, 2, 13, 1, 2])) {
      const deviceId = firstString(leaf, 1);
      const deviceName = firstString(leaf, 2);
      if (recordSpeaker(deviceId, deviceName, "collections_schema")) changed = true;
    }
    return changed;
  }

  function collectStrings(bytes, out, depth = 0) {
    if (depth > 6 || out.length > 500) return;
    let fields;
    try { fields = parseFields(bytes); } catch { return; }
    for (const entry of fields) {
      if (entry.wire !== 2 || !(entry.value instanceof Uint8Array)) continue;
      const s = text(entry.value).replace(/\u0000/g, "").trim();
      const printable = s && [...s].filter((ch) => ch >= " " || ch === "\n" || ch === "\t").length / Math.max(1, s.length) > 0.8;
      if (printable && s.length <= 300) out.push(s);
      if (entry.value.length >= 2) collectStrings(entry.value, out, depth + 1);
    }
  }

  function decodeHeuristicDeviceMappings(bytes) {
    const strings = [];
    collectStrings(bytes, strings);
    let changed = false;
    for (let i = 0; i < strings.length; i++) {
      const device = strings[i];
      if (!/spaces\/[A-Za-z0-9_-]+\/devices\/\d+/i.test(device)) continue;
      const start = Math.max(0, i - 4);
      const end = Math.min(strings.length, i + 5);
      const name = strings.slice(start, end).find((candidate, j) => start + j !== i && plausibleName(candidate));
      if (name && recordSpeaker(device, name, "collections_heuristic")) changed = true;
    }
    return changed;
  }

  function decodeRegexDeviceMappings(bytes) {
    const raw = text(bytes);
    const devices = [...raw.matchAll(/spaces\/[A-Za-z0-9_-]+\/devices\/\d+/gi)].map((m) => m[0]);
    let changed = false;
    for (const device of devices) {
      const at = raw.indexOf(device);
      const nearby = raw.slice(Math.max(0, at - 180), Math.min(raw.length, at + device.length + 180));
      const words = nearby.split(/[\u0000-\u001f]+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(plausibleName);
      const name = words.find((s) => !s.includes(device));
      if (name && recordSpeaker(device, name, "collections_regex")) changed = true;
    }
    return changed;
  }

  async function bytesFromData(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    if (typeof data === "string") return new TextEncoder().encode(data);
    return null;
  }

  async function decompress(bytes) {
    if (!bytes?.length) return bytes;
    const formats = [];
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) formats.push("gzip");
    if (bytes[0] === 0x78) formats.push("deflate");
    for (const format of formats) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch {}
    }
    return bytes;
  }

  async function handleChannelMessage(channel, event) {
    const compressed = await bytesFromData(event.data);
    if (!compressed) return;
    const bytes = await decompress(compressed);
    if (channel.label === "collections") {
      lastCollectionsAt = Date.now();
      decodeCanonicalDeviceMappings(bytes) || decodeHeuristicDeviceMappings(bytes) || decodeRegexDeviceMappings(bytes);
      return;
    }
    if (channel.label !== "captions" && channel.label !== "captions_v2") return;
    const messages = decodeTranscriptPayload(bytes);
    for (const message of messages) {
      const deviceKey = normalizeDeviceKey(message.deviceId);
      const messageKey = `${deviceKey}|${message.messageId}`;
      const previousVersion = latestMessageVersions.get(messageKey);
      if (previousVersion != null && previousVersion > message.messageVersion) continue;
      latestMessageVersions.set(messageKey, message.messageVersion);
      const speaker = speakerMap.get(deviceKey)?.displayName || speakerMap.get(message.deviceId)?.displayName || participantFallback(message.deviceId);
      if (!firstCaptionAt) firstCaptionAt = Date.now();
      lastCaptionAt = Date.now();
      emit("CAPTION", {
        message_id: messageKey,
        message_version: message.messageVersion,
        device_id: message.deviceId,
        device_key: deviceKey,
        speaker_name: speaker,
        text: message.text,
        lang_id: message.langId,
        channel: channel.label,
        source: "MEET_RTC_CAPTIONS",
      });
    }
  }

  function bindChannel(pc, channel) {
    if (!channel || boundChannels.has(channel)) return;
    boundChannels.add(channel);
    channelLabels.add(channel.label || "unknown");
    const onOpen = () => {
      channelLabels.add(channel.label || "unknown");
      if (channel.label === "collections") {
        activePc = pc;
        lastCollectionsAt = Date.now();
        ensureTextChannels();
      }
      emit("RTC_STATUS", currentStatus());
    };
    channel.addEventListener("open", onOpen);
    channel.addEventListener("message", (event) => handleChannelMessage(channel, event).catch((error) => emit("DIAGNOSTIC", { code: "channel_decode_failed", label: channel.label, message: String(error?.message || error) })));
    channel.addEventListener("close", () => {
      channelLabels.delete(channel.label || "unknown");
      emit("RTC_STATUS", currentStatus());
    });
    if (channel.readyState === "open") onOpen();
  }

  function attachAudioTrack(track, role) {
    if (!audioCaptureEnabled || !track || track.kind !== "audio") return;
    const key = `${role}:${track.id || crypto.randomUUID()}`;
    if (audioRecorders.has(key)) return;
    let mime = "audio/webm";
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
    const entry = { recorder: null, role, track, mime, timer: null, stopping: false, energyTimer: null, audioContext: null, segmentHasVoice: true, segmentPeakRms: 1, segmentStartedAt: 0 };
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx({ latencyHint: "interactive" });
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const analyser = ctx.createAnalyser(); analyser.fftSize = 1024; source.connect(analyser);
        const samples = new Float32Array(analyser.fftSize); entry.audioContext = ctx; entry.segmentHasVoice = false; entry.segmentPeakRms = 0;
        ctx.resume?.().catch(() => {});
        entry.energyTimer = setInterval(() => {
          try { analyser.getFloatTimeDomainData(samples); let sum = 0; for (const value of samples) sum += value * value; const rms = Math.sqrt(sum / samples.length); lastRmsByRole[role] = rms; entry.segmentPeakRms = Math.max(entry.segmentPeakRms, rms); const voiceThreshold = role === "local" ? 0.00055 : 0.00075; if (rms >= voiceThreshold) entry.segmentHasVoice = true; } catch {}
        }, 80);
      }
    } catch {}
    const cleanup = () => { clearInterval(entry.energyTimer); entry.energyTimer = null; try { entry.audioContext?.close?.(); } catch {} entry.audioContext = null; };
    audioRecorders.set(key, entry); emit("AUDIO_TRACK_START", { role, track_key: key, mime_type: mime });
    const startSegment = () => {
      if (!audioCaptureEnabled || entry.stopping || track.readyState === "ended") { cleanup(); audioRecorders.delete(key); return; }
      let recorder; try { recorder = new MediaRecorder(new MediaStream([track]), { mimeType: mime, audioBitsPerSecond: 64000 }); } catch { recorder = new MediaRecorder(new MediaStream([track])); mime = recorder.mimeType || mime; entry.mime = mime; }
      entry.recorder = recorder; entry.segmentStartedAt = Date.now(); entry.segmentHasVoice = entry.audioContext ? false : true; entry.segmentPeakRms = entry.audioContext ? 0 : 1; let emitted = false;
      recorder.ondataavailable = (event) => { if (!event.data?.size || emitted) return; emitted = true; const duration = Math.max(1, Date.now() - entry.segmentStartedAt); if (!entry.segmentHasVoice) { emit("DIAGNOSTIC", { code: "audio_silence_skipped", role, rms: entry.segmentPeakRms, duration_ms: duration }); return; } lastAudioChunkAt = Date.now(); emit("AUDIO_CHUNK", { role, track_key: key, seq: ++audioSeq, mime_type: event.data.type || mime, duration_ms: duration, rms: entry.segmentPeakRms, blob: event.data }); };
      recorder.onstop = () => { clearTimeout(entry.timer); entry.timer = null; entry.recorder = null; if (audioCaptureEnabled && !entry.stopping && track.readyState !== "ended") setTimeout(startSegment, 0); else { cleanup(); audioRecorders.delete(key); emit("AUDIO_TRACK_END", { role, track_key: key }); } };
      try { recorder.start(); entry.timer = setTimeout(() => { try { if (recorder.state !== "inactive") recorder.stop(); } catch {} }, 2500); } catch (error) { cleanup(); audioRecorders.delete(key); emit("DIAGNOSTIC", { code: "audio_recorder_start_failed", role, message: String(error?.message || error) }); }
    };
    track.addEventListener("ended", () => { entry.stopping = true; clearTimeout(entry.timer); try { if (entry.recorder?.state !== "inactive") entry.recorder.stop(); } catch {} }, { once: true }); startSegment();
  }

  function rememberLocalTrack(track, source = "unknown") {
    if (!track || track.kind !== "audio") return;
    knownLocalTracks.add(track);
    emit("LOCAL_TRACK_SEEN", { track_id: track.id || null, source, ready_state: track.readyState || null });
    track.addEventListener?.("ended", () => knownLocalTracks.delete(track), { once: true });
    if (audioCaptureEnabled) attachAudioTrack(track, "local");
  }

  function scanAudioTracks(pc) {
    if (!audioCaptureEnabled || !pc) return;
    try { for (const sender of pc.getSenders?.() || []) if (sender?.track?.kind === "audio") { rememberLocalTrack(sender.track, "rtp_sender"); attachAudioTrack(sender.track, "local"); } } catch {}
    try { for (const receiver of pc.getReceivers?.() || []) if (receiver?.track?.kind === "audio") attachAudioTrack(receiver.track, "remote"); } catch {}
  }

  function startAudioCapture() {
    if (!audioCaptureEnabled) audioSeq = 0;
    audioCaptureEnabled = true;
    for (const track of knownLocalTracks) attachAudioTrack(track, "local");
    for (const pc of peerConnections) scanAudioTracks(pc);
    emit("RTC_STATUS", currentStatus());
  }

  function stopAudioCapture() {
    audioCaptureEnabled = false;
    for (const entry of [...audioRecorders.values()]) {
      entry.stopping = true; clearTimeout(entry.timer);
      try { if (entry.recorder?.state !== "inactive") entry.recorder.stop(); } catch {}
    }
    emit("RTC_STATUS", currentStatus());
  }

  function observePeerConnection(pc) {
    if (!pc || seenPeerConnections.has(pc)) return pc;
    seenPeerConnections.add(pc);
    peerConnections.add(pc);
    activePc = pc;
    pc.addEventListener("datachannel", (event) => bindChannel(pc, event.channel));
    pc.addEventListener("track", (event) => { activePc = pc; attachAudioTrack(event.track, "remote"); });
    pc.addEventListener("negotiationneeded", () => scanAudioTracks(pc));
    pc.addEventListener("signalingstatechange", () => scanAudioTracks(pc));
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "closed") peerConnections.delete(pc);
      else { activePc = pc; scanAudioTracks(pc); }
      emit("RTC_STATUS", currentStatus());
    });
    scanAudioTracks(pc);
    return pc;
  }

  function createTextChannel(label) {
    if (!activePc || channelLabels.has(label) || activePc.connectionState === "closed") return;
    try {
      const channel = nativeCreateDataChannel.call(activePc, label);
      bindChannel(activePc, channel);
    } catch (error) {
      emit("DIAGNOSTIC", { code: "create_data_channel_failed", label, message: String(error?.message || error) });
    }
  }

  function ensureTextChannels() {
    // Intentionally disabled: Relato Meet 0.4.4 transcribes direct WebRTC audio and never enables/requests captions.
    return;
  }

  function currentStatus() {
    return {
      active: Boolean(activePc && activePc.connectionState !== "closed"),
      channels: [...channelLabels],
      first_caption_at: firstCaptionAt || null,
      last_caption_at: lastCaptionAt || null,
      last_collections_at: lastCollectionsAt || null,
      speakers: new Set([...speakerMap.values()].map((row) => row.deviceKey)).size,
      audio_capture: audioCaptureEnabled,
      audio_tracks: audioRecorders.size,
      local_audio_tracks: [...audioRecorders.values()].filter((row) => row.role === "local").length,
      remote_audio_tracks: [...audioRecorders.values()].filter((row) => row.role === "remote").length,
      known_local_tracks: knownLocalTracks.size,
      local_rms: lastRmsByRole.local,
      remote_rms: lastRmsByRole.remote,
      last_audio_chunk_at: lastAudioChunkAt || null,
    };
  }

  try {
    const WrappedPC = function (...args) {
      return observePeerConnection(Reflect.construct(NativePC, args, NativePC));
    };
    WrappedPC.prototype = NativePC.prototype;
    Object.setPrototypeOf(WrappedPC, NativePC);
    Object.defineProperty(window, "RTCPeerConnection", { value: WrappedPC, configurable: true, writable: false });
  } catch (error) {
    emit("DIAGNOSTIC", { code: "rtc_constructor_patch_failed", message: String(error?.message || error) });
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(NativePC.prototype, "createDataChannel");
    if (!descriptor || descriptor.configurable || descriptor.writable) {
      Object.defineProperty(NativePC.prototype, "createDataChannel", {
        configurable: true,
        writable: false,
        value: function (label, options) {
          const channel = nativeCreateDataChannel.call(this, label, options);
          observePeerConnection(this);
          bindChannel(this, channel);
          return channel;
        },
      });
    }
  } catch (error) {
    emit("DIAGNOSTIC", { code: "create_data_channel_patch_failed", message: String(error?.message || error) });
  }


  try {
    const nativeAddTrack = NativePC.prototype.addTrack;
    if (nativeAddTrack) NativePC.prototype.addTrack = function(track, ...streams) { const sender = nativeAddTrack.call(this, track, ...streams); observePeerConnection(this); rememberLocalTrack(track, "addTrack"); return sender; };
    const nativeAddTransceiver = NativePC.prototype.addTransceiver;
    if (nativeAddTransceiver) NativePC.prototype.addTransceiver = function(trackOrKind, init) { const tx = nativeAddTransceiver.call(this, trackOrKind, init); observePeerConnection(this); if (trackOrKind?.kind === "audio") rememberLocalTrack(trackOrKind, "addTransceiver"); return tx; };
    const nativeReplaceTrack = window.RTCRtpSender?.prototype?.replaceTrack;
    if (nativeReplaceTrack) window.RTCRtpSender.prototype.replaceTrack = function(track) { if (track?.kind === "audio") rememberLocalTrack(track, "replaceTrack"); return nativeReplaceTrack.call(this, track); };
  } catch (error) { emit("DIAGNOSTIC", { code: "audio_track_patch_failed", message: String(error?.message || error) }); }

  try {
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : null;
    const mediaProto = mediaDevices ? Object.getPrototypeOf(mediaDevices) : null;
    const nativeGetUserMedia = mediaProto?.getUserMedia;
    if (nativeGetUserMedia) {
      mediaProto.getUserMedia = async function(constraints) {
        const stream = await nativeGetUserMedia.call(this, constraints);
        try { for (const track of stream?.getAudioTracks?.() || []) rememberLocalTrack(track, "getUserMedia"); } catch {}
        return stream;
      };
    }
  } catch (error) { emit("DIAGNOSTIC", { code: "get_user_media_patch_failed", message: String(error?.message || error) }); }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== CONTROL_SOURCE) return;
    if (event.data.type === "START_AUDIO_CAPTURE") startAudioCapture();
    else if (event.data.type === "STOP_AUDIO_CAPTURE") stopAudioCapture();
    else if (event.data.type === "REQUEST_CAPTIONS") emit("RTC_STATUS", currentStatus());
  });

  setInterval(() => {
    if (activePc) ensureTextChannels();
    emit("RTC_STATUS", currentStatus());
    if (activePc && !firstCaptionAt && Date.now() - lastCollectionsAt > 20_000) {
      emit("DIAGNOSTIC", { code: "caption_language_or_stream_not_active", message: "RTC conectado, mas nenhum frame de transcrição chegou." });
    }
  }, 10_000);

  emit("READY", currentStatus());
})();
