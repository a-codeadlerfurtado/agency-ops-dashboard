import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
let signal=0; const timers=[]; const recorders=[]; const messages=[]; const listeners=new Map();
class Track{constructor(){this.id="vad-track";this.kind="audio";this.readyState="live";this.listeners={};}addEventListener(t,h){this.listeners[t]=h;}}
class PC{constructor(){this.connectionState="connected";this.senders=[{track:new Track()}];this.receivers=[];this.listeners={};}addEventListener(t,h){(this.listeners[t]??=[]).push(h);}getSenders(){return this.senders;}getReceivers(){return this.receivers;}createDataChannel(){throw Error("captions forbidden");}}
class MR{static isTypeSupported(){return true;}constructor(_s,o={}){this.mimeType=o.mimeType||"audio/webm";this.state="inactive";recorders.push(this);}start(){this.state="recording";}stop(){if(this.state==="inactive")return;this.ondataavailable?.({data:new Blob(["segment"],{type:this.mimeType})});this.state="inactive";this.onstop?.();}emit(){this.ondataavailable?.({data:new Blob(["segment"],{type:this.mimeType})});}}
class AC{constructor(){this.state="running";}createMediaStreamSource(){return{connect(){}};}createAnalyser(){return{fftSize:1024,getFloatTimeDomainData(a){a.fill(signal);}};}resume(){return Promise.resolve();}close(){}}
const w={RTCPeerConnection:PC,MediaRecorder:MR,AudioContext:AC,postMessage(m){messages.push(m);},addEventListener(t,h){(listeners.get(t)??listeners.set(t,[]).get(t)).push(h)}};w.window=w;
const ctx=vm.createContext({window:w,MediaRecorder:MR,MediaStream:class{constructor(t){this.tracks=t;}},Object,Reflect,Set,Map,WeakSet,Uint8Array,Float32Array,ArrayBuffer,Blob,TextDecoder,TextEncoder,DecompressionStream,Response,Date,BigInt,Number,String,RegExp,console,crypto:{randomUUID:()=>"uuid"},setInterval(fn){timers.push(fn);return timers.length;},clearInterval(){},setTimeout(fn,ms){if(ms===0)fn();return 0;},clearTimeout(){}});
vm.runInContext(fs.readFileSync(new URL("../page-rtc-capture.js",import.meta.url),"utf8"),ctx);
const pc=new w.RTCPeerConnection(); const dispatch=d=>{for(const h of listeners.get("message")||[])h({source:w,data:d});}; dispatch({source:"leonardo-meet-content",type:"START_AUDIO_CAPTURE"});
for(const fn of timers)fn(); recorders[0].emit();
assert.equal(messages.filter(m=>m.type==="AUDIO_CHUNK").length,0,"silence must not emit audio chunk");
assert.ok(messages.some(m=>m.type==="DIAGNOSTIC"&&m.payload.code==="audio_silence_skipped"));
recorders[0].stop(); signal=.02; for(const fn of timers)fn(); recorders[1].emit();
assert.equal(messages.filter(m=>m.type==="AUDIO_CHUNK").length,1,"speech-level energy must emit audio chunk");
console.log("rtc-vad synthetic test: ok");