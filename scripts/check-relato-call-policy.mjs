import fs from "node:fs";

const sdr = fs.readFileSync("supabase/functions/agency-ops-sdr-api/index.ts", "utf8");
const ui = fs.readFileSync("app/sdr-profile-shell.tsx", "utf8");

const invariants = [
  [sdr.includes('const range=req.headers.get("range")||"";'), "audio endpoint must forward browser Range requests"],
  [sdr.includes('"content-range"'), "audio endpoint must preserve Content-Range"],
  [sdr.includes('status:upstream.status'), "audio endpoint must preserve upstream 206 status"],
  [sdr.includes('action==="call_review_set"'), "Leonardo call-review backend action must remain available"],
  [sdr.includes("manager_reviewed"), "Leonardo reviewed state must remain in the SDR API"],
  [ui.includes("toggleReviewed"), "Leonardo reviewed-call toggle must remain in the dashboard"],
  [ui.includes("manager_reviewed"), "reviewed-call state must remain rendered in the dashboard"],
];

const failed = invariants.filter(([ok]) => !ok).map(([,message]) => message);
if (failed.length) {
  console.error("Relato regression guard failed:");
  for (const message of failed) console.error(`- ${message}`);
  process.exit(1);
}
console.log("Relato call audio/review regression guard: OK");
