import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const manager = read("app/manager-attention-radar-warning.tsx");
const churned = read("app/churned-client-message-warning.tsx");
const required = read("app/onboarding-required-alerts.tsx");
const assignment = read("app/onboarding-assignment-bridge.tsx");
const detail = read("app/notification-detail-bridge.tsx");
const weekendApi = read("supabase/functions/agency-ops-weekend-balance-api/index.ts");
const leadApi = read("supabase/functions/agency-ops-lead-quality-api/index.ts");
const identitySync = read("supabase/functions/agency-ops-whatsapp-identity-sync/index.ts");

const checks = [
  [manager.includes("ADLER_USER_ID") && manager.includes("open-manager-attention-alert") && manager.includes("nunca carregar aviso bloqueante automaticamente"), "Radar gerencial deve ser notification-first para Adler."],
  [churned.includes("ADLER_USER_ID") && churned.includes("open-churned-client-message-warning") && churned.includes("session.user.id === ADLER_USER_ID"), "Aviso de mensagem em churned deve ser notification-first para Adler."],
  [required.includes("ADLER_USER_ID") && required.includes("explicitAlertId") && required.includes("open-onboarding-required-alert"), "Aviso obrigatório de onboarding deve exigir abertura explícita no perfil Adler."],
  [assignment.includes("ADLER_USER_ID") && assignment.includes("open-onboarding-gt-assignment") && assignment.includes("panelTarget && !isAdler"), "Atribuição de GT não pode abrir automaticamente no perfil Adler."],
  [detail.includes("ONBOARDING_GT_ASSIGNMENT_REQUIRED") && detail.includes("open-onboarding-gt-assignment"), "Clique da notificação de atribuição de GT deve abrir o aviso completo."],
  [weekendApi.includes('roster.role!=="GT"') || weekendApi.includes('roster.role !== "GT"'), "Alerta de saldo deve continuar restrito a GT."],
  [leadApi.includes('roster.role!=="GT"') || leadApi.includes('roster.role !== "GT"'), "Alerta de qualidade de lead deve continuar restrito a GT."],
  [identitySync.includes('if (reg?.scope === "COMMERCIAL") return null;'), "Grupos COMMERCIAL não podem ser convertidos em cliente pelo snapshot do WhatsApp."],
];

const failed = checks.filter(([ok]) => !ok);
if (failed.length) {
  for (const [, message] of failed) console.error(`[adler-warning-policy] ${message}`);
  process.exit(1);
}
console.log(`[adler-warning-policy] ${checks.length} invariantes OK`);
