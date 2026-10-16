// Portfolio audit is a read-only admin verification workflow.
// This test does NOT invoke the Meta API or use credentials.
import assert from "node:assert/strict";
import fs from "node:fs";

const backend = fs.readFileSync("supabase/functions/agency-ops-campaign-builder-api/index.ts","utf8");
const ui = fs.readFileSync("app/campaigns/create/page.tsx","utf8");
const panel = fs.readFileSync("app/campaigns/create/portfolio-audit-panel.tsx","utf8");
const section = backend.split('if (action === "AUDIT_META_PORTFOLIO") {')[1]
  ?.split('// --- LIST_MAKE_CAMPAIGNS ---')[0];
assert.ok(section,"missing bulk audit route");
assert.match(section,/if \(!isAdler\) return reply\(\{ error: "forbidden" \}, 403\)/);
assert.match(section,/const limit = 5;/);
assert.match(section,/.in\("lifecycle", \["ACTIVE", "ONBOARDING"\]\)/);
assert.match(section,/Promise\.allSettled/);
assert.match(section,/adsManagementGranted/);
assert.match(section,/resolveNcPageToken/);
assert.match(section,/leadgen_forms/);
assert.match(section,/account_status/);
assert.match(section,/validPage && activeAccount/);
assert.match(section,/read_only: true/);
for (const dangerous of [".insert(", ".upsert(", ".update(", "metaPost(", "metaDelete(", "console.", "Deno.env.set("])
  assert.equal(section.includes(dangerous),false,"Auditor must be non-mutating and not log values: "+dangerous);
assert.ok(!section.includes("return reply({ ok: true, token:"));
assert.match(ui,/boot\?\.profile\?\.is_adler && <PortfolioAuditPanel api=\{api\}/);
assert.match(panel,/while \(offset !== null\)/);
assert.match(panel,/checked\.length === total && !running && !error/);
assert.match(panel,/Nenhum resultado incompleto será considerado aprovado/);
assert.match(panel,/não certifica aprovação futura de anúncios/);
console.log("PORTFOLIO AUDIT: ADMIN-ONLY, READ-ONLY, BATCHED, NO FALSE GREEN ON PARTIAL RESULT");
