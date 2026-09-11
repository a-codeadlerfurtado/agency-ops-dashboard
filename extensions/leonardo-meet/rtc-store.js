const DB_NAME = "leonardo_meeting_capture_v2";
const DB_VERSION = 2;

let dbPromise = null;

function reqResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_request_failed"));
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("indexeddb_transaction_failed"));
    tx.onabort = () => reject(tx.error || new Error("indexeddb_transaction_aborted"));
  });
}

export function openCaptureDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const store = db.createObjectStore("sessions", { keyPath: "id" });
        store.createIndex("state", "state", { unique: false });
        store.createIndex("tab_id", "tab_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("frames")) {
        const store = db.createObjectStore("frames", { keyPath: "id" });
        store.createIndex("session_id", "session_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("speakers")) {
        const store = db.createObjectStore("speakers", { keyPath: "id" });
        store.createIndex("session_id", "session_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("audio_chunks")) {
        const store = db.createObjectStore("audio_chunks", { keyPath: "id" });
        store.createIndex("session_id", "session_id", { unique: false });
        store.createIndex("session_role", ["session_id", "role"], { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("indexeddb_open_failed"));
  });
  return dbPromise;
}

export async function putSession(session) {
  const db = await openCaptureDb();
  const tx = db.transaction("sessions", "readwrite");
  tx.objectStore("sessions").put({ ...session, updated_at: new Date().toISOString() });
  await txDone(tx);
}

export async function getSession(id) {
  const db = await openCaptureDb();
  const tx = db.transaction("sessions", "readonly");
  return reqResult(tx.objectStore("sessions").get(id));
}

export async function listSessions() {
  const db = await openCaptureDb();
  const tx = db.transaction("sessions", "readonly");
  return reqResult(tx.objectStore("sessions").getAll());
}

export async function putFrame(sessionId, frame) {
  const messageId = String(frame.message_id || frame.messageId || frame.id || crypto.randomUUID());
  const id = `${sessionId}|${messageId}`;
  const db = await openCaptureDb();
  const tx = db.transaction("frames", "readwrite");
  const store = tx.objectStore("frames");
  const previous = await reqResult(store.get(id));
  const nextVersion = Number(frame.message_version ?? frame.messageVersion ?? 0);
  const prevVersion = Number(previous?.message_version ?? -1);
  if (!previous || nextVersion >= prevVersion) {
    store.put({
      ...(previous || {}),
      ...frame,
      id,
      session_id: sessionId,
      message_id: messageId,
      message_version: nextVersion,
      received_at: frame.received_at || new Date().toISOString(),
    });
  }
  await txDone(tx);
}

export async function putSpeaker(sessionId, speaker) {
  const deviceKey = String(speaker.device_key || speaker.deviceId || speaker.device_id || "").trim();
  if (!deviceKey) return;
  const id = `${sessionId}|${deviceKey}`;
  const db = await openCaptureDb();
  const tx = db.transaction("speakers", "readwrite");
  const store = tx.objectStore("speakers");
  const previous = await reqResult(store.get(id));
  store.put({
    ...(previous || {}),
    ...speaker,
    id,
    session_id: sessionId,
    device_key: deviceKey,
    updated_at: new Date().toISOString(),
  });
  await txDone(tx);
}

async function allByIndex(storeName, sessionId) {
  const db = await openCaptureDb();
  const tx = db.transaction(storeName, "readonly");
  const index = tx.objectStore(storeName).index("session_id");
  return reqResult(index.getAll(IDBKeyRange.only(sessionId)));
}

export const getFrames = (sessionId) => allByIndex("frames", sessionId);
export const getSpeakers = (sessionId) => allByIndex("speakers", sessionId);

export async function putAudioChunk(sessionId, role, chunk) {
  const db = await openCaptureDb();
  const seq = Number(chunk.seq || 0);
  const id = `${sessionId}|${role}|${String(seq).padStart(8, "0")}`;
  const tx = db.transaction("audio_chunks", "readwrite");
  tx.objectStore("audio_chunks").put({ ...chunk, id, session_id: sessionId, role, seq, stored_at: new Date().toISOString() });
  await txDone(tx);
}

export async function getAudioChunks(sessionId, role = null) {
  const db = await openCaptureDb();
  const tx = db.transaction("audio_chunks", "readonly");
  const store = tx.objectStore("audio_chunks");
  const rows = role
    ? await reqResult(store.index("session_role").getAll(IDBKeyRange.only([sessionId, role])))
    : await reqResult(store.index("session_id").getAll(IDBKeyRange.only(sessionId)));
  return rows.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
}

export async function clearSession(sessionId) {
  const db = await openCaptureDb();
  const tx = db.transaction(["sessions", "frames", "speakers", "audio_chunks"], "readwrite");
  tx.objectStore("sessions").delete(sessionId);
  for (const storeName of ["frames", "speakers", "audio_chunks"]) {
    const store = tx.objectStore(storeName);
    const index = store.index("session_id");
    const request = index.openKeyCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
  }
  await txDone(tx);
}
