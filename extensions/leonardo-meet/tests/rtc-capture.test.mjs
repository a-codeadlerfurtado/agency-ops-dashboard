import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { gzipSync } from "node:zlib";

function varint(value) {
  let n = BigInt(value);
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Uint8Array.from(out);
}

function concat(...parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function lenField(field, bytes) {
  return concat(varint((field << 3) | 2), varint(bytes.length), bytes);
}
function strField(field, value) { return lenField(field, new TextEncoder().encode(value)); }
function intField(field, value) { return concat(varint(field << 3), varint(value)); }
function exactArrayBuffer(view) { return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength); }

function nested(path, leaf) {
  let current = leaf;
  for (const field of [...path].reverse()) current = lenField(field, current);
  return current;
}


async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("wait_for_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeChannel {
  constructor(label) { this.label = label; this.readyState = "open"; this.listeners = new Map(); }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
  emit(type, value = {}) { for (const handler of this.listeners.get(type) || []) handler(value); }
}

class FakePC {
  constructor() { this.listeners = new Map(); this.connectionState = "connected"; this.created = []; }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
  dispatch(type, event) { for (const handler of this.listeners.get(type) || []) handler(event); }
  createDataChannel(label) { const channel = new FakeChannel(label); this.created.push(channel); return channel; }
}

const messages = [];
const windowObject = {
  RTCPeerConnection: FakePC,
  postMessage(message) { messages.push(message); },
  addEventListener() {},
};
windowObject.window = windowObject;

const context = vm.createContext({
  window: windowObject,
  Object,
  Reflect,
  Set,
  Map,
  WeakSet,
  Uint8Array,
  ArrayBuffer,
  Blob,
  TextDecoder,
  TextEncoder,
  DecompressionStream,
  Response,
  Date,
  BigInt,
  Number,
  String,
  RegExp,
  console,
  setInterval: () => 0,
});

const source = fs.readFileSync(new URL("../page-rtc-capture.js", import.meta.url), "utf8");
vm.runInContext(source, context);

const pc = new windowObject.RTCPeerConnection();
const collections = new FakeChannel("collections");
pc.dispatch("datachannel", { channel: collections });

const leaf = concat(strField(1, "spaces/abc/devices/145"), strField(2, "Adler Furtado"));
collections.emit("message", { data: exactArrayBuffer(nested([1, 2, 13, 1, 2], leaf)) });
await waitFor(() => messages.some((message) => message.type === "SPEAKER_MAP"));

const innerV1 = concat(strField(1, "@145"), intField(2, 7), intField(3, 1), strField(6, "Olá"), intField(8, 1));
const innerV2 = concat(strField(1, "@145"), intField(2, 7), intField(3, 2), strField(6, "Olá mundo"), intField(8, 1));
const captions = pc.created.find((channel) => channel.label === "captions");
assert.ok(captions, "captions channel should be created after collections opens");

captions.emit("message", { data: exactArrayBuffer(gzipSync(lenField(1, innerV1))) });
captions.emit("message", { data: exactArrayBuffer(gzipSync(lenField(1, innerV2))) });
await waitFor(() => messages.some((message) => message.type === "CAPTION" && message.payload?.message_version === 2));

const speaker = messages.find((message) => message.type === "SPEAKER_MAP")?.payload;
assert.equal(speaker?.deviceKey, "@145");
assert.equal(speaker?.displayName, "Adler Furtado");

const captionEvents = messages.filter((message) => message.type === "CAPTION");
assert.equal(captionEvents.at(-1)?.payload?.speaker_name, "Adler Furtado");
assert.equal(captionEvents.at(-1)?.payload?.text, "Olá mundo");
assert.equal(captionEvents.at(-1)?.payload?.message_version, 2);
assert.equal(captionEvents.at(-1)?.payload?.device_key, "@145");

console.log("rtc-capture synthetic test: ok");
