import fs from "node:fs";

const enhancements = fs.readFileSync("app/dashboard-enhancements.tsx", "utf8");
const home = fs.readFileSync("app/dashboard-native.tsx", "utf8");
const layout = fs.readFileSync("app/layout.tsx", "utf8");

const failures = [];
if (enhancements.includes("ops-cockpit-slot") || enhancements.includes("overviewSlot")) failures.push("overview voltou a criar slot do cockpit");
if (enhancements.includes("<OperationalCockpit")) failures.push("overview voltou a renderizar OperationalCockpit");
if (enhancements.includes("<IntegrityCenter")) failures.push("overview voltou a renderizar IntegrityCenter");

const reflection = home.indexOf('<DailyReflection token={session.access_token} />');
const banner = home.indexOf('<div className="source-banner">');
if (reflection < 0) failures.push("reflexao do dia ausente da Home");
if (banner < 0 || reflection > banner) failures.push("reflexao do dia precisa ficar antes do restante da Home");
if ((home.match(/<DailyReflection token=\{session\.access_token\} \/>/g) || []).length !== 1) failures.push("reflexao do dia deve aparecer exatamente uma vez");
if (!layout.includes("<IntegrationHealthBar />")) failures.push("indicador flutuante de integracoes nao pode ser removido");

if (failures.length) {
  console.error("HOME UI POLICY FAILED:\n- " + failures.join("\n- "));
  process.exit(1);
}
console.log("HOME UI POLICY OK: reflexao no topo; cockpit/integridade fora da Home; indicador flutuante preservado.");
