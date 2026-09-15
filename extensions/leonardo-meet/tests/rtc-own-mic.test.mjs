import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const messages=[]; const listeners=new Map(); const recorders=[];
class Track{constructor(){this.id="own-mic";this.kind="audio";this.readyState="live";this.listeners={};}addEventListener(t,h){this.listeners[t]=h;}stop(){this.readyState="ended";this.listeners.ended?.();}}
class Stream{constructor(tracks){this.tracks=tracks;}getAudioTracks(){return this.tracks;}getTracks(){return this.tracks;}}
class MediaDevices{async getUserMedia(){return new Stream([new Track()]);}}
class PC{constructor(){this.connectionState="connected";this.listeners={};}addEventListener(t,h){(this.listeners[t]??=[]).push(h);}getSenders(){return [];}getReceivers(){return [];}createDataChannel(){throw Error("captions forbidden");}}
class MR{static isTypeSupported(){return true;}constructor(){this.mimeType="audio/webm";this.state="inactive";recorders.push(this);}start(){this.state="recording";}stop(){this.state="inactive";this.onstop?.();}}
class AC{createMediaStreamSource(){return{connect(){}};}createAnalyser(){return{fftSize:1024,getFloatTimeDomainData(a){a.fill(.0012);}};}resume(){return Promise.resolve();}close(){}}
const mediaDevices=new MediaDevices();
const w={RTCPeerConnection:PC,RTCRtpSender:function(){},MediaRecorder:MR,AudioContext:AC,postMessage(m){messages.push(m);},addEventListener(t,h){(listeners.get(t)??listeners.set(t,[]).get(t)).push(h)}};w.window=w;
const ctx=vm.createContext({window:w,navigator:{mediaDevices},MediaRecorder:MR,MediaStream:Stream,Object,Reflect,Set,Map,WeakSet,Float32Array,Uint8Array,ArrayBuffer,Blob,TextDecoder,TextEncoder,DecompressionStream,Response,Date,BigInt,Number,String,RegExp,console,crypto:{randomUUID:()=>"uuid"},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
vm.runInContext(fs.readFileSync(new URL("../page-rtc-capture.js",import.meta.url),"utf8"),ctx);
const dispatch=d=>{for(const h of listeners.get("message")||[])h({source:w,data:d});};
dispatch({source:"leonardo-meet-content",type:"START_AUDIO_CAPTURE"});
await new Promise(resolve=>setTimeout(resolve,10));
assert.equal(recorders.length,1,"Relato must acquire its own microphone when no local WebRTC track is exposed");
assert.ok(messages.some(m=>m.type==="DIAGNOSTIC"&&m.payload.code==="own_microphone_acquired"));
const status=messages.filter(m=>m.type==="RTC_STATUS").at(-1)?.payload;
assert.ok(messages.some(m=>m.type==="LOCAL_TRACK_SEEN"&&m.payload.source==="getUserMedia"));
assert.equal(status?.remote_audio_tracks,0);
assert.equal(status?.own_microphone_active,true);
console.log("rtc-own-microphone fallback test: ok");
