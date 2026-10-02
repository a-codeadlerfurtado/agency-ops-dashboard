import fs from "node:fs";

const sdr = fs.readFileSync("supabase/functions/agency-ops-sdr-api/index.ts", "utf8");
const ui = fs.readFileSync("app/sdr-profile-shell.tsx", "utf8");
const pairing = fs.readFileSync("app/relato-pairing-card.tsx", "utf8");
const meetings = fs.readFileSync("app/meetings-bridge.tsx", "utf8");
const heavy = fs.readFileSync("supabase/functions/agency-ops-heavy-worker-api/index.ts", "utf8");
const jarvis = fs.readFileSync("worker/jarvis/index.ts", "utf8");
const processor = fs.readFileSync("vps/agency-processor/worker-v6.mjs", "utf8");

const invariants = [
  [sdr.includes('const range=req.headers.get("range")||"";'), "audio endpoint must forward browser Range requests"],
  [sdr.includes('"content-range"'), "audio endpoint must preserve Content-Range"],
  [sdr.includes('status:upstream.status'), "audio endpoint must preserve upstream 206 status"],
  [sdr.includes('action==="call_review_set"'), "Leonardo call-review backend action must remain available"],
  [sdr.includes("manager_reviewed"), "Leonardo reviewed state must remain in the SDR API"],
  [ui.includes("toggleReviewed"), "Leonardo reviewed-call toggle must remain in the dashboard"],
  [ui.includes("manager_reviewed"), "reviewed-call state must remain rendered in the dashboard"],
  [pairing.includes('action:"desktop_release_info"'), "SDR pairing card must load the canonical desktop release dynamically"],
  [!pairing.includes("relato-package-v2026.10.02.1"), "SDR pairing card must not regress to the 0.5.10 hardcoded release"],
  [meetings.includes('action: "desktop_release_info"'), "Relato workspace must expose the role-specific desktop release"],
  [sdr.includes("relato-package-v2026.10.02.2/RelatoAI-Desktop-SDR.exe"), "SDR API must expose the current 0.5.11 release"],
  [heavy.includes("tryWorkersAiCallFallback"), "terminal empty transcripts must use Workers AI fallback before NEEDS_REVIEW"],
  [heavy.includes('recovered_by: "CLOUDFLARE_WORKERS_AI"'), "fallback-recovered calls must close their heavy job as SUCCEEDED"],
  [heavy.includes('"NO_SPEECH_OR_UNINTELLIGIBLE"'), "true no-speech audio must not pollute NEEDS_REVIEW"],
  [heavy.includes('action === "worker_probe"'), "Workers AI fallback authentication probe must remain available"],
  [heavy.includes('"LOW_CONFIDENCE_PENDING"'), "low-confidence SDR transcripts must stay usable instead of being rejected"],
  [jarvis.includes('x-agency-worker-token'), "Jarvis STT must accept authenticated Relato worker fallback requests"],
  [fs.readFileSync("worker/jarvis/stt.ts", "utf8").includes('pass = "relaxed"'), "Workers AI STT must retry empty audio with relaxed decoding"],
  [processor.includes('body.text || body.transcription'), "local Whisper worker must preserve text-only verbose responses"],
  [heavy.includes("SEPARATE_WAV_CHANNELS"), "Workers AI fallback must transcribe local/remote channels separately"],
  [heavy.includes("fallback_no_remote_speech"), "fallback must not treat ringback audio as an answered call"],
  [heavy.includes("canonicalSegments"), "legacy mixed fallback must never become canonical transcript evidence"],
  [fs.readFileSync("supabase/functions/agency-ops-meeting-capture-api/index.ts","utf8").includes('state: noAnswer ? "READY" : "PROCESSING"'), "known no-answer attempts must skip transcription queue"],
  [ui.includes("Não atendidas") && ui.includes("answeredRows"), "SDR dashboard metrics must separate answered calls from attempts"],
];

const failed = invariants.filter(([ok]) => !ok).map(([,message]) => message);
if (failed.length) {
  console.error("Relato regression guard failed:");
  for (const message of failed) console.error(`- ${message}`);
  process.exit(1);
}
console.log("Relato call audio/review regression guard: OK");
