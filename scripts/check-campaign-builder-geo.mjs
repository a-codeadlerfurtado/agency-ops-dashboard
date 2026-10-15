// Geo Meta Campaign Builder regression: fixtures only; no real requests/tokens.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const path = "supabase/functions/agency-ops-campaign-builder-api/index.ts";
const source = fs.readFileSync(path, "utf8");
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const names = new Set(["foldText", "stateFromSuffix", "geoQueryPlan", "searchGeo",
  "geoState", "geoConflicts", "resolveGeo", "buildTargeting"]);
const funcs = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text));
assert.equal(funcs.length, names.size, "All geo functions must be found");
const defs = ast.statements.filter(s => ts.isVariableStatement(s) &&
  s.declarationList.declarations.some(d => d.name.getText(ast) === "BR_STATES"));
assert.equal(defs.length, 1);
const js = ts.transpileModule([...defs, ...funcs].map(s => s.getText(ast)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const citiesSP = ["São Paulo","Santo André","São Bernardo do Campo",
  "São Caetano do Sul","Praia Grande","Santos","Cubatão"];
const hit = (name, key, type="city", region="São Paulo (state)") =>
  ({name,key,type,region,country_code:"BR"});
let onlyWrongPraiaGrande=false;
let requestLog=[];
const records={
  "São Paulo":[hit("São Paulo","460","region",null),hit("São Paulo","2420608")],
  "Santo André":[hit("Santo André","268652")],
  "São Bernardo do Campo":[hit("São Bernardo do Campo","268965")],
  "São Caetano do Sul":[hit("São Caetano do Sul","269009")],
  "Praia Grande":[hit("Praia Grande","2695717","city","Santa Catarina"),
    hit("Praia Grande","2680123")],
  "Santos":[hit("Santos","268866")],
  "Cubatão":[hit("Cubatão","250322")],
};
const ctx=vm.createContext({
  Map,Set,JSON,String,Math,
  graphUrl:(path,params)=>JSON.stringify({path,params}),
  metaJson:async value=>{
    const {path,params}=JSON.parse(value);
    assert.equal(path,"search");
    assert.equal(params.type,"adgeolocation");
    assert.equal(params.limit,"50");
    requestLog.push(params.q);
    const data=records[params.q]||[];
    return {data:onlyWrongPraiaGrande&&params.q==="Praia Grande"?data.slice(0,1):data};
  },
});
vm.runInContext(js+"\nthis.geo = { geoQueryPlan,geoConflicts,resolveGeo,buildTargeting };",ctx);
const {geoQueryPlan,geoConflicts,resolveGeo,buildTargeting}=ctx.geo;
assert.equal(geoQueryPlan("Praia Grande, SP").attempts.length,1,
  "State-qualified queries never fall back to a different state");
const fixed=await resolveGeo("DUMMY_TOKEN",citiesSP);
assert.deepEqual(JSON.parse(JSON.stringify(fixed.unresolved)),[]);
assert.equal(fixed.resolved.length,7);
assert.equal(fixed.resolved[0].type,"city","São Paulo must not resolve to its state");
assert.equal(fixed.resolved[0].name,"São Paulo");
assert.equal(fixed.resolved.find(h=>h.name==="Praia Grande").region,"São Paulo (state)");
assert.equal(geoConflicts(fixed.resolved),false);
const targeting=buildTargeting({adset:{age_min:18,age_max:65,genders:"all",geo:{radius_km:null}}},fixed.resolved);
assert.equal(targeting.geo_locations.cities.length,7);
assert.equal(targeting.geo_locations.regions,undefined);
assert.equal(targeting.geo_locations.countries,undefined);
onlyWrongPraiaGrande=true;
const blocked=await resolveGeo("DUMMY_TOKEN",citiesSP);
assert.ok(blocked.unresolved.includes("Praia Grande"),"Never choose Praia Grande, SC by accident");
assert.equal(blocked.resolved.some(h=>h.name==="Praia Grande"),false);
const explicit=await resolveGeo("DUMMY_TOKEN",["Praia Grande, SP"]);
assert.ok(explicit.unresolved.includes("Praia Grande, SP"),"If Meta only returns SC, fail closed");
onlyWrongPraiaGrande=false;
const specified=await resolveGeo("DUMMY_TOKEN",["Praia Grande, SP"]);
assert.equal(specified.resolved[0].region,"São Paulo (state)");
assert.equal(geoConflicts([hit("São Paulo","460","region",null),hit("Santos","268866")]),true);
assert.equal(geoConflicts([hit("São Paulo","460","region",null),hit("Praia Grande","2695717","city","Santa Catarina")]),false);
assert.match(source,/geo_repaired_at/,"Retaking the failed campaign must revalidate geo");
assert.match(source,/if \(geoConflicts\(geoRows\)\)/,"Execution must fail closed before creating anything");
assert.match(source,/!geo\.unresolved\.length && !geoConflicts\(geo\.resolved\)/,
  "Unsafe new draft should not enable execution");
console.log("PASS: São Paulo city, Praia Grande SP, ambiguous UF rejection, preflight and safe resume");
