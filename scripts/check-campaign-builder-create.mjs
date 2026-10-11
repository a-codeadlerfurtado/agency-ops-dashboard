// Regression tests for Meta Campaign Builder payloads; no external API calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const path = "supabase/functions/agency-ops-campaign-builder-api/index.ts";
const source = fs.readFileSync(path, "utf8");
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const names = new Set(["buildTargeting", "adsetFields", "creativeSpec"]);
const declarations = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text)).map(s => s.getText(ast));
assert.equal(declarations.length, names.size, "All three payload functions must exist");
const js = ts.transpileModule(declarations.join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const ctx = vm.createContext({});
vm.runInContext(js + "\nthis.builder = { buildTargeting, adsetFields, creativeSpec };", ctx);
const { buildTargeting, adsetFields, creativeSpec } = ctx.builder;
const p = {
  campaign: { objective: "OUTCOME_LEADS" },
  adset: {
    name: "Martim Praia", daily_budget_brl: 10, age_min: 25, age_max: 65,
    genders: "all", geo: { radius_km: null }, start: "NOW",
    destination: { type: "LEAD_FORM", lead_form_id: "1802574407825742" },
  },
  ad: { primary_text: "Conheca o apartamento", headline: "Martim Praia", description: "", cta: "SIGN_UP" },
};
const target = buildTargeting(p, []);
assert.deepEqual(Array.from(JSON.parse(JSON.stringify(target.geo_locations.countries))), ["BR"]);
const adset = adsetFields(p, "120123456789000", target, false, "132141753324688");
assert.equal(adset.status, "PAUSED");
assert.equal(adset.daily_budget, "1000");
assert.equal(adset.destination_type, "ON_AD");
assert.equal(adset.optimization_goal, "LEAD_GENERATION");
assert.deepEqual(JSON.parse(adset.promoted_object), { page_id: "132141753324688" });
const creative = creativeSpec(p, "132141753324688", "1717171717171", "abcd1234", null);
assert.equal(creative.instagram_user_id, "1717171717171");
assert.equal(creative.link_data.link, "https://www.facebook.com/132141753324688");
assert.equal(creative.link_data.call_to_action.value.lead_gen_form_id, "1802574407825742");
assert.equal(creative.link_data.call_to_action.type, "SIGN_UP");
assert.equal(creative.link_data.image_hash, "abcd1234");
const site = structuredClone(p);
site.adset.destination = { type: "SITE", url: "https://ncimoveis.com.br/apto" };
const siteCreative = creativeSpec(site, "132141753324688", null, "abcd1234", null);
assert.equal(siteCreative.link_data.link, "https://ncimoveis.com.br/apto");
assert.equal(JSON.parse(adsetFields(site,"120123456789000",target,false,"132141753324688").promoted_object || "null"), null);
assert.match(source, /const GRAPH = "v26\.0"/);
assert.match(source, /lead_form_page_mismatch/);
assert.match(source, /\.eq\("status", "DRAFTED"\)\.select\("id"\)\.maybeSingle\(\)/);
assert.match(source, /rollback_incomplete/);
assert.ok(source.indexOf("// Overrides limitados") < source.indexOf("const finalBudget"), "Budget must be checked after overrides");
console.log("Campaign Builder create regression guard: OK (lead form, site, targeting, budget, ownership, duplicate guard)");
