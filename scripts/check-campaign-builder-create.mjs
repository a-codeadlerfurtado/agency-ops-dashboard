// Regression tests for Meta Campaign Builder payloads; no external API calls.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const path = "supabase/functions/agency-ops-campaign-builder-api/index.ts";
const source = fs.readFileSync(path, "utf8");
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const names = new Set(["leadFormQuestions", "resolveMakeFacebookConnection", "clean", "geoQueryPlan", "stateFromSuffix", "foldText", "buildTargeting", "adsetFields", "creativeSpec", "campaignFields", "safeRetryEligible", "externalLeadLink", "successMetadata", "mediaDimensions", "creativeOrientation", "creativeBaseName", "pairCreatives", "placementCreativeSpec", "adUnitsSummary", "unpairedForVision", "parseVisionPairs", "hintsFromStored", "agreedVisionPairs"]);
const declarations = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text)).map(s => s.getText(ast));
assert.equal(declarations.length, names.size, "All payload/guard functions must exist");
const consts = ast.statements.filter(s => ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(ast) === "BR_STATES")).map(s => s.getText(ast));
assert.equal(consts.length, 1, "BR_STATES table must exist");
const js = ts.transpileModule([...consts, ...declarations].join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
let fakeEnv = {};
const ctx = vm.createContext({ URL, String, Uint8Array, Map, Object,
  Deno: { env: { get: (k) => fakeEnv[k] } } });
vm.runInContext(js + "\nthis.builder = { leadFormQuestions, resolveMakeFacebookConnection, geoQueryPlan, buildTargeting, adsetFields, creativeSpec, campaignFields, safeRetryEligible, externalLeadLink, successMetadata, mediaDimensions, creativeOrientation, creativeBaseName, pairCreatives, placementCreativeSpec, adUnitsSummary, unpairedForVision, parseVisionPairs, hintsFromStored, agreedVisionPairs };", ctx);
const { leadFormQuestions, resolveMakeFacebookConnection, geoQueryPlan, buildTargeting, adsetFields, creativeSpec, campaignFields, safeRetryEligible, externalLeadLink, successMetadata, mediaDimensions, creativeOrientation, creativeBaseName, pairCreatives, placementCreativeSpec, adUnitsSummary, unpairedForVision, parseVisionPairs, hintsFromStored, agreedVisionPairs } = ctx.builder;
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
assert.equal(target.targeting_automation.advantage_audience, 1,
  "25–65 should remain eligible for Advantage+ Audience");
const restrictedAge = structuredClone(p);
restrictedAge.adset.age_min = 25;
restrictedAge.adset.age_max = 60;
const ageTarget = buildTargeting(restrictedAge, []);
assert.equal(ageTarget.age_min, 25);
assert.equal(ageTarget.age_max, 60);
assert.equal(ageTarget.targeting_automation.advantage_audience, 0,
  "Age cap under 65 must switch to original audience, not silently broaden");
const higherMinimum = structuredClone(p);
higherMinimum.adset.age_min = 30;
assert.equal(buildTargeting(higherMinimum, []).targeting_automation.advantage_audience, 0);
const explicitGender = structuredClone(p);
explicitGender.adset.genders = "female";
assert.equal(buildTargeting(explicitGender, []).targeting_automation.advantage_audience, 0);
assert.deepEqual(Array.from(buildTargeting(explicitGender, []).genders), [2]);
const defaultAudience = structuredClone(p);
defaultAudience.adset.age_min = 18;
assert.equal(buildTargeting(defaultAudience, []).targeting_automation.advantage_audience, 1);
const adset = adsetFields(p, "120123456789000", target, false, "132141753324688");
assert.equal(adset.status, "PAUSED");
assert.equal(adset.daily_budget, "1000");
assert.equal(adset.destination_type, "ON_AD");
assert.equal(adset.optimization_goal, "LEAD_GENERATION");
assert.deepEqual(JSON.parse(adset.promoted_object), { page_id: "132141753324688" });
const whatsappPlan = structuredClone(p);
whatsappPlan.adset.destination = { type: "WHATSAPP", url: null, lead_form_id: null };
const whatsappPage = "771086922748543";
const whatsappAdset = adsetFields(whatsappPlan, "120123456789000", target, false, whatsappPage);
assert.equal(whatsappAdset.status, "PAUSED");
assert.equal(whatsappAdset.destination_type, "WHATSAPP");
assert.equal(whatsappAdset.optimization_goal, "CONVERSATIONS");
assert.deepEqual(JSON.parse(whatsappAdset.promoted_object), { page_id: whatsappPage },
  "WhatsApp ad sets must reference this client's Meta Page");
const creative = creativeSpec(p, "132141753324688", "1717171717171", "abcd1234", null, "https://www.ncimoveis.com/");
assert.equal(creative.instagram_user_id, "1717171717171");
assert.equal(creative.link_data.link, "https://www.ncimoveis.com/");
assert.equal(externalLeadLink("http://www.ncimoveis.com/"), "http://www.ncimoveis.com/");
assert.equal(externalLeadLink("www.ncimoveis.com"), "https://www.ncimoveis.com/");
assert.equal(externalLeadLink("https://www.facebook.com/132141753324688 https://site.com.br"), "https://site.com.br/");
assert.equal(externalLeadLink("https://instagram.com/x"), null);
assert.equal(externalLeadLink(""), null);
assert.equal(creative.link_data.call_to_action.value.lead_gen_form_id, "1802574407825742");
assert.equal(creative.link_data.call_to_action.type, "SIGN_UP");
assert.equal(creative.link_data.image_hash, "abcd1234");
const site = structuredClone(p);
site.adset.destination = { type: "SITE", url: "https://ncimoveis.com.br/apto" };
const siteCreative = creativeSpec(site, "132141753324688", null, "abcd1234", null);
assert.equal(siteCreative.link_data.link, "https://ncimoveis.com.br/apto");
assert.equal(JSON.parse(adsetFields(site,"120123456789000",target,false,"132141753324688").promoted_object || "null"), null);
const camp = campaignFields({ campaign: { name: "TESTE API - MARTIM PRAIA - NC", objective: "OUTCOME_LEADS" } });
assert.equal(camp.status, "PAUSED");
assert.equal(camp.is_adset_budget_sharing_enabled, "false");
assert.equal(camp.objective, "OUTCOME_LEADS");
const failed = (o) => ({ status: "FAILED", created_campaign_id: null, created_adset_id: null, created_ad_id: null, ...o });
assert.equal(safeRetryEligible(failed({ error: "token: meta_account_access_missing" })), true);
assert.equal(safeRetryEligible(failed({ error: "campaign_create: x", request_metadata: { failed_stage: "campaign_create", meta_code: 100 } })), true);
assert.equal(safeRetryEligible(failed({ error: "campaign_create: timeout", request_metadata: { failed_stage: "campaign_create" } })), false);
assert.equal(safeRetryEligible(failed({ error: "adset_create: x", request_metadata: { failed_stage: "adset_create", meta_code: 100 } })), false);
assert.equal(safeRetryEligible(failed({ error: "creative_1_create: x", request_metadata: { failed_stage: "creative_1_create", meta_code: 100, rollback_incomplete: false, created_ad_ids: [], created_creative_ids: [] } })), true);
assert.equal(safeRetryEligible(failed({ error: "creative_1_create: x", request_metadata: { failed_stage: "creative_1_create", meta_code: 100, rollback_incomplete: true } })), false);
assert.equal(safeRetryEligible(failed({ error: "creative_1_create: x", request_metadata: { failed_stage: "creative_1_create", meta_code: 2, rollback_incomplete: false } })), false);
assert.match(source, /META_CAMPAIGN_BUILDER_TOKEN/);
const cleaned = successMetadata({ failed_stage: "ad_1_create", meta_code: 100, meta_subcode: 1, rollback: {}, rollback_incomplete: false, safe_retry_count: 3, creatives: [1] });
assert.deepEqual(Object.keys(cleaned).sort(), ["creatives", "safe_retry_count"]);
assert.equal(safeRetryEligible(failed({ error: "campaign_create: x", created_campaign_id: "1", request_metadata: { failed_stage: "campaign_create", meta_code: 100 } })), false);
assert.equal(safeRetryEligible(failed({ error: "campaign_create: x", request_metadata: { failed_stage: "campaign_create", meta_code: 100, created_creative_ids: ["9"] } })), false);
assert.equal(safeRetryEligible(failed({ error: "ad_1_create: x", request_metadata: { failed_stage: "ad_1_create", meta_code: 100, rollback_incomplete: false, created_creative_ids: ["9"] } })), true);
assert.equal(safeRetryEligible({ status: "CREATED", error: "token: meta_account_access_missing" }), false);
assert.match(source, /const GRAPH = "v26\.0"/);
assert.match(source, /lead_form_page_mismatch/);
assert.match(source, /\.eq\("status", "DRAFTED"\)\.select\("id"\)\.maybeSingle\(\)/);
assert.match(source, /rollback_incomplete/);
assert.ok(source.indexOf("// Overrides limitados") < source.indexOf("const finalBudget"), "Budget must be checked after overrides");

// Failed attempts must not appear to be fresh drafts on the frontend.
const campaignUi = fs.readFileSync("app/campaigns/create/page.tsx", "utf8");
assert.match(campaignUi, /request_not_draft: "Esta tentativa/);
assert.match(campaignUi, /body\?\.error === "request_not_draft" && body\?\.status === "FAILED"/);
assert.match(campaignUi, /needsDraftRecovery \? "Retome a tentativa antes de criar"/);
assert.match(campaignUi, /onClick=\{\(\) => void resumeFromHistory\(\{ id: draft\.request_id, client_name: clientName \}\)\}/);
assert.match(campaignUi, /setRecoverRequestId\(null\)/);
assert.match(campaignUi, /disabled=\{executing \|\| needsDraftRecovery\}/);

// --- feed x story ---
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w, h) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
assert.deepEqual({ ...mediaDimensions(png(1080, 1350), "IMAGE") }, { width: 1080, height: 1350 });
const jpeg = (w, h, orient) => {
  const exif = orient ? [0xff, 0xe1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orient, 0, 0, 0, 0, 0, 0] : [];
  return new Uint8Array([0xff, 0xd8, ...exif, 0xff, 0xc0, 0, 17, 8, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
};
assert.deepEqual({ ...mediaDimensions(jpeg(1080, 1920), "IMAGE") }, { width: 1080, height: 1920 });
assert.deepEqual({ ...mediaDimensions(jpeg(1920, 1080, 6), "IMAGE") }, { width: 1080, height: 1920 }, "EXIF rotation swaps dims");
const tkhd = (w, h, rotated) => {
  const box = new Uint8Array(92); box.set(be32(92), 0); box.set([0x74, 0x6b, 0x68, 0x64], 4);
  const m = rotated ? [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000] : [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
  m.forEach((v, k) => box.set(be32(v >>> 0), 48 + k * 4));
  box.set(be32(w * 65536), 84); box.set(be32(h * 65536), 88); return box;
};
const mp4 = (w, h, r) => { const b = new Uint8Array(400); b.set(tkhd(0, 0, false), 20); b.set(tkhd(w, h, r), 150); return b; };
assert.deepEqual({ ...mediaDimensions(mp4(1080, 1920, false), "VIDEO") }, { width: 1080, height: 1920 });
assert.deepEqual({ ...mediaDimensions(mp4(1920, 1080, true), "VIDEO") }, { width: 1080, height: 1920 }, "rotated phone video");
assert.equal(mediaDimensions(new Uint8Array([1, 2, 3]), "IMAGE"), null);
assert.equal(creativeOrientation({ width: 1080, height: 1920 }), "STORY");
assert.equal(creativeOrientation({ width: 1080, height: 1350 }), "FEED");
assert.equal(creativeOrientation({ width: 1080, height: 1080 }), "FEED");
assert.equal(creativeOrientation({ file_name: "Criativo 2 - STORIES.png" }), "STORY");
assert.equal(creativeOrientation({ file_name: "criativo2_4x5.jpg" }), "FEED");
assert.equal(creativeOrientation({ file_name: "foto.jpg" }), null);
assert.equal(creativeBaseName("Criativo 1 - Story.MP4"), "criativo 1");
assert.equal(creativeBaseName("criativo_1_feed.mp4"), "criativo 1");
assert.equal(creativeBaseName("Martim 1080x1920.png"), "martim");
const mk = (file_name, type, orientation) => ({ file_name, type, orientation });
// two variations x two formats -> two ads
let units = pairCreatives([mk("v1 feed.png", "IMAGE", "FEED"), mk("v1 story.png", "IMAGE", "STORY"), mk("v2 feed.png", "IMAGE", "FEED"), mk("v2 story.png", "IMAGE", "STORY")]);
assert.deepEqual(JSON.parse(JSON.stringify(units)), [{ feed: 0, story: 1, via: "NAME" }, { feed: 2, story: 3, via: "NAME" }]);
// names match even out of order
units = pairCreatives([mk("B story.png", "IMAGE", "STORY"), mk("A feed.png", "IMAGE", "FEED"), mk("A story.png", "IMAGE", "STORY"), mk("B feed.png", "IMAGE", "FEED")]);
assert.deepEqual(JSON.parse(JSON.stringify(units)), [{ feed: 3, story: 0, via: "NAME" }, { feed: 1, story: 2, via: "NAME" }]);
// no name relation -> never paired by upload order (singles) ...
const loose = [mk("x.png", "IMAGE", "FEED"), mk("y.png", "IMAGE", "FEED"), mk("z.png", "IMAGE", "STORY"), mk("w.png", "IMAGE", "STORY")];
units = pairCreatives(loose);
assert.deepEqual(JSON.parse(JSON.stringify(units)), [{ single: 0 }, { single: 1 }, { single: 2 }, { single: 3 }]);
// ... unless the vision AI suggested the pair (hint), validated against real orientation
units = pairCreatives(loose, [{ feed: 0, story: 3 }, { feed: 1, story: 0 }]);
assert.deepEqual(JSON.parse(JSON.stringify(units)), [{ feed: 0, story: 3, via: "AI" }, { single: 1 }, { single: 2 }]);
// name wins over AI hint
units = pairCreatives([mk("A feed.png", "IMAGE", "FEED"), mk("A story.png", "IMAGE", "STORY")], [{ feed: 0, story: 1 }]);
assert.equal(units[0].via, "NAME");
const pend = unpairedForVision([mk("A feed.png", "IMAGE", "FEED"), mk("A story.png", "IMAGE", "STORY"), ...loose]);
assert.deepEqual(JSON.parse(JSON.stringify(pend)), { feeds: [2, 3], stories: [4, 5] });
assert.equal(unpairedForVision([mk("A feed.png", "IMAGE", "FEED"), mk("A story.png", "IMAGE", "STORY")]), null);
assert.equal(unpairedForVision([mk("x.png", "IMAGE", "FEED"), mk("z.png", "IMAGE", "STORY")]), null, "single candidate is never sent to AI");
const vp = parseVisionPairs({ pairs: [{ feed: "F1", story: "S2", confidence: 0.93 }, { feed: "F2", story: "S2", confidence: 0.99 }, { feed: "F2", story: "S1", confidence: 0.85 }, { feed: "F9", story: "S1", confidence: 0.99 }] }, [2, 3], [4, 5]);
assert.deepEqual(JSON.parse(JSON.stringify(vp)), [{ feed: 2, story: 5, confidence: 0.93 }]);
assert.deepEqual(JSON.parse(JSON.stringify(parseVisionPairs({ nope: 1 }, [1], [2]))), []);
const agreed = agreedVisionPairs([{ feed: 2, story: 5, confidence: 0.95 }, { feed: 3, story: 4, confidence: 0.97 }], [{ feed: 2, story: 5, confidence: 0.91 }, { feed: 3, story: 5, confidence: 0.99 }]);
assert.deepEqual(JSON.parse(JSON.stringify(agreed)), [{ feed: 2, story: 5, confidence: 0.91 }]);
const hs = hintsFromStored([{ path: "a" }, { path: "b" }, { path: "c" }], [{ feed_path: "c", story_path: "a" }, { feed_path: "x", story_path: "b" }]);
assert.deepEqual(JSON.parse(JSON.stringify(hs)), [{ feed: 2, story: 0 }]);
// image never pairs with video; unknown stays single
units = pairCreatives([mk("a feed.png", "IMAGE", "FEED"), mk("a story.mp4", "VIDEO", "STORY"), mk("c.png", "IMAGE", null)]);
assert.deepEqual(JSON.parse(JSON.stringify(units)), [{ single: 0 }, { single: 1 }, { single: 2 }]);
// real NC upload naming: STORY (2), feed (2), STORY (1), feed (1) -> 2 ads
units = pairCreatives([mk("[NC] - Criativos STORY - AP MARTIM PRAIA CLUBE (2).png", "IMAGE", "STORY"), mk("[NC] - Criativos - AP MARTIM PRAIA CLUBE (2).png", "IMAGE", "FEED"), mk("[NC] - Criativos STORY - AP MARTIM PRAIA CLUBE (1).png", "IMAGE", "STORY"), mk("[NC] - Criativos - AP MARTIM PRAIA CLUBE (1).png", "IMAGE", "FEED")]);
assert.deepEqual(JSON.parse(JSON.stringify(units)), [{ feed: 1, story: 0, via: "NAME" }, { feed: 3, story: 2, via: "NAME" }]);
const legacy = adUnitsSummary(["[NC] - Criativos STORY - AP MARTIM PRAIA CLUBE (2).png", "[NC] - Criativos - AP MARTIM PRAIA CLUBE (2).png", "[NC] - Criativos STORY - AP MARTIM PRAIA CLUBE (1).png", "[NC] - Criativos - AP MARTIM PRAIA CLUBE (1).png"].map((f) => ({ file_name: f, type: "IMAGE", orientation: creativeOrientation({ file_name: f }) })));
assert.equal(legacy.length, 2);
assert.ok(legacy.every((u) => u.kind === "FEED_STORY"));
// only feeds -> one ad each (old behaviour)
assert.equal(pairCreatives([mk("a.png", "IMAGE", "FEED"), mk("b.png", "IMAGE", "FEED")]).length, 2);
assert.equal(adUnitsSummary([mk("v1 feed.png", "IMAGE", "FEED"), mk("v1 story.png", "IMAGE", "STORY")])[0].kind, "FEED_STORY");
const pc = placementCreativeSpec(p, "132141753324688", "17841403012425516", { hash: "feedhash" }, { hash: "storyhash" }, "https://www.ncimoveis.com/", "cb_x_1");
const afs = JSON.parse(JSON.stringify(pc.asset_feed_spec));
assert.equal(pc.object_story_spec.instagram_user_id, "17841403012425516");
assert.equal(afs.optimization_type, "PLACEMENT");
assert.deepEqual(afs.ad_formats, ["SINGLE_IMAGE"]);
assert.equal(afs.images.length, 2);
assert.equal(afs.asset_customization_rules.length, 2);
const storyRule = afs.asset_customization_rules.find((r) => r.priority === 1);
assert.equal(storyRule.image_label.name, "cb_x_1_story");
assert.ok(storyRule.customization_spec.instagram_positions.includes("story"));
assert.ok(storyRule.customization_spec.facebook_positions.includes("story"));
assert.equal(afs.images.find((i) => i.adlabels[0].name === "cb_x_1_story").hash, "storyhash");
assert.equal(afs.call_to_actions[0].value.lead_gen_form_id, "1802574407825742");
const feedRule = afs.asset_customization_rules.find((r) => r.priority === 2);
assert.equal(feedRule.image_label.name, "cb_x_1_feed");
assert.equal(feedRule.customization_spec.publisher_platforms, undefined, "feed rule must be catch-all, or Meta skips feed placements");
assert.equal(afs.link_urls[0].website_url, "https://www.ncimoveis.com/");
const pv = placementCreativeSpec(p, "1", "2", { video: { id: "v1", thumb: "t1" } }, { video: { id: "v2", thumb: "t2" } }, "https://x.com/", "l");
assert.deepEqual(JSON.parse(JSON.stringify(pv.asset_feed_spec.ad_formats)), ["SINGLE_VIDEO"]);
assert.equal(pv.asset_feed_spec.asset_customization_rules[0].video_label.name, "l_story");
assert.match(source, /placement\.fallbacks\.push/);

// Cidades com sufixo de estado ou separadas por vírgula não podem virar "Brasil inteiro".
const geo = (raw) => JSON.parse(JSON.stringify(geoQueryPlan(raw)));
assert.deepEqual(geo("Caraguatatuba, SP").attempts[0], { q: "Caraguatatuba", state: "São Paulo" });
assert.deepEqual(geo("Ubatuba - São Paulo").attempts[0], { q: "Ubatuba", state: "São Paulo" });
assert.deepEqual(geo("Santos (SP)").attempts[0], { q: "Santos", state: "São Paulo" });
assert.deepEqual(geo("Caraguatatuba, SP").parts, []);
assert.deepEqual(geo("Santos, Praia Grande").parts, ["Santos", "Praia Grande"]);
assert.deepEqual(geo("Santos, Praia Grande").attempts, [{ q: "Santos, Praia Grande", state: null }]);
assert.deepEqual(geo("Caraguatatuba").attempts, [{ q: "Caraguatatuba", state: null }]);
assert.deepEqual(geo("   ").attempts, []);
assert.match(source, /error: "geo_unresolved"/);

// A conexao Facebook Lead Ads segue o GT responsavel pelo cliente: cada GT
// autoriza a propria conexao no Make. Ordem: GT -> __default__ -> env.
const fbOps = (value) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: value === undefined ? null : { value } }) }) }) }) });
const fbMap = { "Felipe Oliveira": 4851809, __default__: 4769961 };
assert.deepEqual(JSON.parse(JSON.stringify(await resolveMakeFacebookConnection(fbOps(fbMap), "Felipe Oliveira"))),
  { id: 4851809, source: "GT", gt: "Felipe Oliveira" });
assert.equal((await resolveMakeFacebookConnection(fbOps(fbMap), "Yuri Melo")).source, "DEFAULT");
assert.equal((await resolveMakeFacebookConnection(fbOps(fbMap), "")).id, 4769961);
assert.equal(await resolveMakeFacebookConnection(fbOps({}), "Yuri Melo"), null);
assert.equal(await resolveMakeFacebookConnection(fbOps(undefined), "Yuri Melo"), null);
assert.equal(await resolveMakeFacebookConnection(fbOps({ "Yuri Melo": 0 }), "Yuri Melo"), null);
assert.equal(await resolveMakeFacebookConnection(fbOps({ "Yuri Melo": "abc" }), "Yuri Melo"), null);
fakeEnv = { MAKE_FB_LEADS_CONNECTION_ID: "4302326" };
assert.equal((await resolveMakeFacebookConnection(fbOps({}), "Yuri Melo")).source, "ENV");
assert.equal((await resolveMakeFacebookConnection(fbOps({ "Yuri Melo": 4869515 }), "Yuri Melo")).id, 4869515);
fakeEnv = {};
// Sem conexao do GT, nada e criado na Meta nem no Make.
assert.match(source, /error: "make_fb_connection_missing"/);
// Em 14/10 a producao (v28) criou campanha com entrega via Make sem conexao
// configurada: a guarda era `Number(Deno.env.get(...)) <= 0` e, com a variavel
// ausente, Number(undefined) e NaN — toda comparacao com NaN e false, entao a
// guarda nunca disparava (fail-open). Comparar o valor de uma variavel de
// ambiente com <= ou < abre esse buraco de novo; use Number.isInteger + > 0.
assert.doesNotMatch(source, /Number\(Deno\.env\.get\([^)]*\)\)\s*<=?\s*\d/);
// Guarda de conexão: pré-execução, configuração após criar e Make-only.
assert.equal(source.split('error: "make_fb_connection_missing"').length - 1, 3);

// A Graph API devolve as perguntas do formulario como lista simples. Ler so
// questions.data travava a entrega em make_form_questions_missing com o
// formulario cheio (producao, 14/10/2026).
const q = [{ key: "full_name" }, { key: "phone_number" }];
assert.equal(leadFormQuestions(q).length, 2);
assert.equal(leadFormQuestions({ data: q }).length, 2);
assert.equal(leadFormQuestions(undefined).length, 0);
assert.equal(leadFormQuestions(null).length, 0);
assert.equal(leadFormQuestions({}).length, 0);
assert.equal(leadFormQuestions({ data: "nao e lista" }).length, 0);
assert.doesNotMatch(source, /questions\?\.data/);
console.log("Campaign Builder create regression guard: OK (feed+story pairing, name first, AI fallback) (lead form, site, targeting, budget, ownership, duplicate guard)");

await import("./check-campaign-builder-make.mjs");
