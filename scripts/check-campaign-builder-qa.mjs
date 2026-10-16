// Regression tests for the Campaign Builder homologation (QA) guards,
// account-conflict handling and the read-only INSPECT_CAMPAIGN action.
// No external API calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const path = "supabase/functions/agency-ops-campaign-builder-api/index.ts";
const source = fs.readFileSync(path, "utf8");
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const names = new Set(["clean", "qaEnvelope", "accountStatusLabel"]);
const declarations = ast.statements
  .filter((s) => ts.isFunctionDeclaration(s) && names.has(s.name?.text))
  .map((s) => s.getText(ast));
assert.equal(declarations.length, names.size, "QA helper functions must exist");
const consts = ast.statements
  .filter((s) => ts.isVariableStatement(s) && s.declarationList.declarations
    .some((d) => ["ACCOUNT_STATUS_LABEL", "QA_PREFIX"].includes(d.name.getText(ast))))
  .map((s) => s.getText(ast));
assert.equal(consts.length, 2, "ACCOUNT_STATUS_LABEL and QA_PREFIX must exist");
const js = ts.transpileModule([...consts, ...declarations].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const ctx = vm.createContext({ String, Number, Object, Array });
vm.runInContext(js + "\nthis.qa = { qaEnvelope, accountStatusLabel, QA_PREFIX };", ctx);
const { qaEnvelope, accountStatusLabel, QA_PREFIX } = ctx.qa;

// --- QA envelope -----------------------------------------------------------
assert.equal(QA_PREFIX, "[QA CAMPAIGN BUILDER]");
const ok = qaEnvelope({ run_id: "qa-20261016-r1", idempotency_key: "qa-20261016-r1:5b1c2d3e-0000-4000-8000-000000000001" });
assert.equal(ok.run_id, "qa-20261016-r1");
assert.equal(qaEnvelope(null), null);
assert.equal(qaEnvelope([]), null);
assert.equal(qaEnvelope({ run_id: "prod", idempotency_key: "prod:abc" }), null, "run id must follow qa-YYYYMMDD-*");
assert.equal(qaEnvelope({ run_id: "qa-20261016-r1", idempotency_key: "other-run:abcdefghij" }), null,
  "idempotency key must be scoped to the run");
assert.equal(qaEnvelope({ run_id: "qa-20261016-r1", idempotency_key: "qa-20261016-r1:a b" }), null);

// --- account status --------------------------------------------------------
assert.equal(accountStatusLabel(1), "ACTIVE");
assert.equal(accountStatusLabel(9), "IN_GRACE_PERIOD", "status 9 must never read as active");
assert.equal(accountStatusLabel(2), "DISABLED");
assert.equal(accountStatusLabel(77), "STATUS_77");

// --- source-level safety policies -----------------------------------------
const section = (start, end) => {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `section ${start} must exist`);
  return source.slice(a, b);
};
const activate = section('if (action === "ACTIVATE_CREATED")', 'if (action === "DISCARD")');
assert.match(activate, /qa_activation_forbidden/, "QA objects must never be activatable");
assert.ok(activate.indexOf("qa_activation_forbidden") < activate.indexOf('status: "ACTIVE"'),
  "QA guard must run before any ACTIVE mutation");

const execute = section('if (action === "EXECUTE")', 'return reply({ error: "invalid_action" }, 400);');
assert.match(execute, /qa_overrides_forbidden/, "QA runs cannot change names, budgets or enable Make");
assert.match(execute, /assets_changed/, "EXECUTE must re-check the client's current ad account");
assert.ok(execute.indexOf("assets_changed") < execute.indexOf("act_${accountId}/campaigns"),
  "asset re-check must happen before the first Meta mutation");
assert.match(execute, /verification_creative/, "verification must confirm creatives, not only ads");
assert.ok(!/status:\s*"ACTIVE"/.test(execute), "EXECUTE must never send ACTIVE");
assert.equal((execute.match(/status:\s*"PAUSED"/g) || []).length >= 1, true);

const draft = section('if (action === "DRAFT")', 'if (action === "RESUME_DRAFT")');
assert.match(draft, /qa_forbidden/);
assert.match(draft, /isAdler/, "QA must be admin-only");
assert.match(draft, /qa_already_exists/, "QA must be idempotent per client and run");
assert.match(draft, /qa_name_required/, "QA campaigns must carry the standard prefix");

const inspect = section('if (action === "INSPECT_CAMPAIGN")', '// --- LIST_LEAD_FORMS ---');
assert.ok(!/metaPost|metaDelete/.test(inspect), "INSPECT_CAMPAIGN must be read-only");
assert.match(inspect, /campaign_client_mismatch/, "INSPECT_CAMPAIGN must refuse campaigns from other accounts");
assert.match(inspect, /loadScopedClient/, "INSPECT_CAMPAIGN must respect GT scope");

const rate = section("const rateLimited = async", "const contentType");
assert.match(rate, /request_metadata->qa/, "QA and normal rate limits must be counted separately");

const load = section("const loadAssets = async", "const rateLimited");
assert.match(load, /account_conflict/, "divergent ad accounts must not be chosen automatically");

const check = section('if (action === "CHECK_META_ACCESS")', '// --- AUDIT_META_PORTFOLIO');
assert.match(check, /account_status/, "access check must read account_status");
assert.match(check, /accountStatus === 1/, "only ACTIVE accounts are reported as ready");

const page = fs.readFileSync("app/campaigns/create/page.tsx", "utf8");
assert.ok(!page.includes("385332010919725"), "frontend must not hardcode the NC ad account for every client");
assert.ok(!page.includes("BM NC Imóveis - Litoral"), "frontend must not hardcode the NC portfolio");
assert.match(page, /account_error/, "frontend must show the exact blocking reason");

console.log("CAMPAIGN BUILDER QA: ADMIN-ONLY, IDEMPOTENT, PAUSED-ONLY, NEVER ACTIVATABLE, READ-ONLY INSPECTION, NO SILENT ACCOUNT CHOICE");
