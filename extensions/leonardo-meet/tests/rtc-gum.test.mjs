import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const messages=[]; const listeners=new Map(); const recorders=[];
class Track{constructor(){this.id="mic-local";this.kind="audio";this.readyState="live";this.listeners={};}addEventListener(t,h){this.listeners[t]=h;}}
class Stream{constructor(tracks){this.tracks=tracks;}getAudioTracks(){return this.tracks.filter(t=>t.kind==="audio");}}
class MediaDevices{async getUserMedia(){return new Stream([new Track()]);}}
class PC{constructor(){this.connectionState="connected";this.listeners={};}addEventListener(t,h){(this.listeners[t]??=[]).push(h);}getSenders(){return [];}getReceivers(){return [];}createDataChannel(){throw Error("captions forbidden");}}
class MR{static isTypeSupported(){return true;}constructor(_s,o={}){this.mimeType=o.mimeType||"audio/webm";this.state="inactive";recorders.push(this);}start(){this.state="recording";}stop(){this.state="inactive";this.onstop?.();}}
class AC{createMediaStreamSource(){return{connect(){}};}createAnalyser(){return{fftSize:1024,getFloatTimeDomainData(a){a.fill(.0012);}};}resume(){return Promise.resolve();}close(){}}
const mediaDevices=new MediaDevices();
const w={RTCPeerConnection:PC,RTCRtpSender:function(){},MediaRecorder:MR,AudioContext:AC,postMessage(m){messages.push(m);},addEventListener(t,h){(listeners.get(t)??listeners.set(t,[]).get(t)).push(h)}};w.window=w;
const ctx=vm.createContext({window:w,navigator:{mediaDevices},MediaRecorder:MR,MediaStream:Stream,Object,Reflect,Set,Map,WeakSet,Float32Array,Uint8Array,ArrayBuffer,Blob,TextDecoder,TextEncoder,DecompressionStream,Response,Date,BigInt,Number,String,RegExp,console,crypto:{randomUUID:()=>"uuid"},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}});
vm.runInContext(fs.readFileSync(new URL("../page-rtc-capture.js",import.meta.url),"utf8"),ctx);
const stream=await mediaDevices.getUserMedia({audio:true});
assert.equal(stream.getAudioTracks().length,1);
assert.ok(messages.some(m=>m.type==="LOCAL_TRACK_SEEN"),"getUserMedia track must be remembered before capture starts");
const dispatch=d=>{for(const h of listeners.get("message")||[])h({source:w,data:d});};
dispatch({source:"leonardo-meet-content",type:"START_AUDIO_CAPTURE"});
assert.equal(recorders.length,1,"remembered microphone track must be recorded when capture starts");
const status=messages.filter(m=>m.type==="RTC_STATUS").at(-1)?.payload;
assert.equal(status?.known_local_tracks,1);
assert.equal(status?.local_audio_tracks,1);
console.log("rtc-getUserMedia capture test: ok");
