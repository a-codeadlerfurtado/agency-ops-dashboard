// Guarda de regressão do CPL Guard (regras puras em supabase/functions/agency-ops-cpl-guard/logic.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const src = fs.readFileSync(new URL("../supabase/functions/agency-ops-cpl-guard/logic.ts", import.meta.url), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cpl-guard-")), "logic.mjs");
fs.writeFileSync(tmp, js);
const L = await import(pathToFileURL(tmp).href);

// Limite: 2x CPL, em centavos, com piso.
assert.equal(L.thresholdCents(25, 2, 20), 5000);
assert.equal(L.thresholdCents(25, 3, 20), 7500);
assert.equal(L.thresholdCents(6, 2, 20), 2000, "piso de R$ 20");
assert.equal(L.thresholdCents(17.335, 2, 20), 3467);

// Spec da regra validada na Meta.
const spec = L.ruleSpec("AD", 2, 5000);
const f = Object.fromEntries(spec.evaluation_spec.filters.map((x) => [x.field, x]));
assert.equal(f.entity_type.value, "AD");
assert.equal(f.time_preset.value, "TODAY");
assert.equal(f.spent.value, 5000);
assert.equal(f.spent.operator, "GREATER_THAN");
assert.deepEqual([f.results.value, f.results.operator], [1, "LESS_THAN"]);
assert.ok(f["campaign.objective"].value.includes("OUTCOME_LEADS"));
assert.ok(f["adset.optimization_goal"].value.includes("CONVERSATIONS"));
assert.equal(spec.execution_spec.execution_type, "PAUSE");
assert.equal(spec.schedule_spec.schedule_type, "SEMI_HOURLY");
assert.ok(spec.name.startsWith("[Imobi Guard] Pausa anuncio"));
assert.ok(L.ruleSpec("ADSET", 3, 7500).name.startsWith("[Imobi Guard] Pausa conjunto"));
assert.ok(!/[—–]/.test(spec.name));

// Limite atual e quando atualizar.
assert.equal(L.currentThreshold({ evaluation_spec: { filters: [{ field: "spent", value: "5000" }] } }), 5000);
assert.equal(L.currentThreshold(null), null);
assert.equal(L.thresholdChanged(5000, 5200), false);
assert.equal(L.thresholdChanged(5000, 5400), true);
assert.equal(L.thresholdChanged(null, 5000), true);

// Resultado: lead ou conversa.
assert.equal(L.resultCount([{ action_type: "lead", value: "2" }, { action_type: "link_click", value: "9" }]), 2);
assert.equal(L.resultCount([{ action_type: "onsite_conversion.messaging_conversation_started_7d", value: "3" }]), 3);
assert.equal(L.resultCount([{ action_type: "link_click", value: "9" }]), 0);
assert.equal(L.resultCount(null), 0);

// Diagnóstico.
const base = {
  level: "AD", cpl_alvo: 25, threshold_brl: 50, hours_since_created: 200, learning_status: "SUCCESS",
  today: { spend: "52", impressions: "3000", cpm: "17", inline_link_click_ctr: "0.3", inline_link_clicks: "9", frequency: "1.1" },
  last7: { spend: "300", impressions: "20000", frequency: "1.8", actions: [{ action_type: "lead", value: "12" }] },
  account7: { spend: "1000", cpm: "16", inline_link_click_ctr: "1.0", actions: [{ action_type: "lead", value: "40" }] },
  rankings: {},
};
let codes = L.diagnose(base).map((s) => s.code);
assert.ok(codes.includes("LOW_CTR"), "CTR 0,3% contra 1% da conta");
assert.ok(codes.includes("CLICKS_NO_LEAD"), "9 cliques e nenhum lead");
assert.ok(codes.includes("WAS_GOOD"), "vinha bem em 7 dias");
assert.ok(!codes.includes("HIGH_CPM"));

codes = L.diagnose({ ...base, hours_since_created: 10, learning_status: "LEARNING", today: { spend: "52", impressions: "200", cpm: "60" }, last7: { spend: "52", actions: [] } }).map((s) => s.code);
assert.ok(codes.includes("NEW"));
assert.ok(!codes.includes("LEARNING"), "novo já cobre aprendizado");
assert.ok(codes.includes("LOW_DELIVERY"));
assert.ok(codes.includes("HIGH_CPM"));
assert.ok(codes.includes("NEVER_CONVERTED"));

codes = L.diagnose({ ...base, today: { spend: "52", impressions: "2000", cpm: "16", inline_link_click_ctr: "1.0", inline_link_clicks: "2" }, last7: { spend: "100", frequency: "3.4", actions: [{ action_type: "lead", value: "2" }] }, account7: { spend: "1000", cpm: "16", inline_link_click_ctr: "1.0", actions: [{ action_type: "lead", value: "20" }] }, rankings: { quality: "BELOW_AVERAGE_20" }, learning_status: "FAIL" }).map((s) => s.code);
assert.ok(codes.includes("FATIGUE"));
assert.ok(codes.includes("LOW_RANKING"));
assert.ok(codes.includes("LEARNING_LIMITED"));
assert.ok(codes.includes("ACCOUNT_BAD"), "conta com CPL 50 contra ideal 25");

codes = L.diagnose({ ...base, today: { spend: "52", impressions: "2000", cpm: "16", inline_link_click_ctr: "1.0", inline_link_clicks: "2" }, last7: null, account7: null }).map((s) => s.code);
assert.deepEqual(codes, ["NO_CLEAR_SIGNAL"]);

assert.match(L.nextStep([{ code: "CLICKS_NO_LEAD" }, { code: "LOW_CTR" }]), /formulário|WhatsApp/);
assert.match(L.nextStep([{ code: "LOW_CTR" }]), /criativo/);

// Texto sem travessão e com link.
assert.equal(L.tidy("A — B – C"), "A, B, C");
const url = L.adsManagerUrl("123", "AD", "999");
assert.equal(url, "https://adsmanager.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=999");
assert.ok(L.adsManagerUrl("123", "ADSET", "9").includes("adsets?act=123&selected_adset_ids=9"));
const view = {
  client_name: "NC Imóveis", gt_owner: "Felipe Oliveira", level: "AD", entity_name: "AD01 — Vídeo",
  campaign_name: "[LEAD] Martim", adset_name: "Aberto", spend_today: 52.3, threshold_brl: 50, multiplier: 2,
  cpl_alvo: 25, cpl_origem: "HISTORICO_30D", reading: ["CTR baixo — criativo fraco."], next_step: "Trocar o criativo.", url,
};
const gtMsg = L.whatsappText([view], false);
const mgrMsg = L.whatsappText([view], true);
assert.ok(!/[—–]/.test(gtMsg) && !/[—–]/.test(mgrMsg));
assert.ok(gtMsg.includes("R$ 52,30") && gtMsg.includes("R$ 25,00") && gtMsg.includes("média dos últimos 30 dias"));
assert.ok(!gtMsg.includes("GT:") && mgrMsg.includes("GT: Felipe Oliveira"));
assert.ok(gtMsg.includes(url));
assert.equal(L.brl(1234.5), "R$ 1.234,50");

// Janela de envio (BRT).
assert.equal(L.inSendWindow(new Date("2026-10-11T13:00:00Z")), true, "10h BRT");
assert.equal(L.inSendWindow(new Date("2026-10-12T05:00:00Z")), false, "2h BRT");
assert.equal(L.inSendWindow(new Date("2026-10-12T01:30:00Z")), false, "22h30 BRT");

console.log("CPL Guard regression guard: OK (regra Meta, limite, diagnóstico, mensagem, janela)");
