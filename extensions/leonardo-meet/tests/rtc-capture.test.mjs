import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

class FakeTrack {
  constructor(id) { this.id=id; this.kind="audio"; this.listeners=new Map(); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  end() { this.listeners.get("ended")?.(); }
}
class FakeChannel {
  constructor(label) { this.label=label; this.readyState="open"; this.listeners=new Map(); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
}
class FakePC {
  constructor() { this.listeners=new Map(); this.connectionState="connected"; this.created=[]; this.senders=[]; this.receivers=[]; }
  addEventListener(type, handler) { if(!this.listeners.has(type)) this.listeners.set(type,[]); this.listeners.get(type).push(handler); }
  dispatch(type, event={}) { for(const h of this.listeners.get(type)||[]) h(event); }
  createDataChannel(label) { const ch=new FakeChannel(label); this.created.push(ch); return ch; }
  getSenders() { return this.senders; }
  getReceivers() { return this.receivers; }
}

const recorders=[];
class FakeMediaRecorder {
  static isTypeSupported() { return true; }
  constructor(stream, options={}) { this.stream=stream; this.mimeType=options.mimeType||"audio/webm"; this.state="inactive"; recorders.push(this); }
  start() { this.state="recording"; }
  requestData() { this.ondataavailable?.({data:new Blob(["final"],{type:this.mimeType})}); }
  stop() { if(this.state==="inactive") return; this.ondataavailable?.({data:new Blob(["final"],{type:this.mimeType})}); this.state="inactive"; this.onstop?.(); }
  emit(body="chunk") { this.ondataavailable?.({data:new Blob([body],{type:this.mimeType})}); }
}
const messages=[];
const listeners=new Map();
const windowObject={
  RTCPeerConnection:FakePC,
  MediaRecorder:FakeMediaRecorder,
  postMessage(message){ messages.push(message); },
  addEventListener(type,handler){ if(!listeners.has(type)) listeners.set(type,[]); listeners.get(type).push(handler); },
};
windowObject.window=windowObject;

const context=vm.createContext({
  window:windowObject,
  MediaRecorder:FakeMediaRecorder,
  MediaStream:class { constructor(tracks){ this.tracks=tracks; } },
  Object,Reflect,Set,Map,WeakSet,Uint8Array,ArrayBuffer,Blob,
  TextDecoder,TextEncoder,DecompressionStream,Response,Date,BigInt,Number,String,RegExp,console,
  crypto:{randomUUID:()=>"uuid"},
  setInterval:()=>0, clearInterval:()=>{}, setTimeout:(fn,ms)=>{ if(ms===0) fn(); return 0; }, clearTimeout:()=>{}, Float32Array,
});

const source=fs.readFileSync(new URL("../page-rtc-capture.js",import.meta.url),"utf8");
vm.runInContext(source,context);

const pc=new windowObject.RTCPeerConnection();
pc.senders.push({track:new FakeTrack("local-1")},{track:new FakeTrack("local-2")});
pc.receivers.push({track:new FakeTrack("remote-1")});
const dispatchWindow=(data)=>{ for(const h of listeners.get("message")||[]) h({source:windowObject,data}); };
dispatchWindow({source:"leonardo-meet-content",type:"START_AUDIO_CAPTURE"});
assert.equal(recorders.length,2,"only one preferred local track plus remote should be recorded");
assert.equal(messages.filter(m=>m.type==="AUDIO_TRACK_START").length,2);
assert.equal(pc.created.length,0,"audio architecture must not create caption data channels");

recorders[0].emit("local-audio");
recorders[1].emit("remote-audio");
const chunks=messages.filter(m=>m.type==="AUDIO_CHUNK");
assert.equal(chunks.length,2);
assert.deepEqual(new Set(chunks.map(m=>m.payload.role)),new Set(["local","remote"]));
assert.ok(chunks.every(m=>m.payload.blob instanceof Blob));

dispatchWindow({source:"leonardo-meet-content",type:"START_AUDIO_CAPTURE"});
recorders[0].stop();
recorders[2].emit("local-b");
const seqs=messages.filter(m=>m.type==="AUDIO_CHUNK").map(m=>m.payload.seq);
assert.deepEqual(seqs,[1,2,3],"repeated START_AUDIO_CAPTURE must not reset chunk sequence");
recorders[2].stop();
recorders[1].stop();

const beforeStop=messages.filter(m=>m.type==="AUDIO_CHUNK").length;
dispatchWindow({source:"leonardo-meet-content",type:"STOP_AUDIO_CAPTURE"});
assert.equal(recorders.filter(r=>r.state!=="inactive").length,0);
assert.equal(messages.filter(m=>m.type==="AUDIO_CHUNK").length,beforeStop+2,"stop must flush final chunk for both tracks");

dispatchWindow({source:"leonardo-meet-content",type:"REQUEST_CAPTIONS"});
assert.equal(pc.created.length,0,"REQUEST_CAPTIONS must not re-enable captions");
console.log("rtc-audio synthetic test: ok");
