"use client";

const STYLE_ID = "nav-brand-icons-v2-style";

const ICONS: Record<string, string> = {
  grid: `<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/></svg>`,
  home: `<svg viewBox="0 0 24 24"><path d="M3.5 10.8 12 3.8l8.5 7v9.4a.8.8 0 0 1-.8.8h-5.2v-6.2h-5V21H4.3a.8.8 0 0 1-.8-.8z"/></svg>`,
  target: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 9 1.6 1.6L13 7.4M8 15h8"/></svg>`,
  clients: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 20v-1.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.5 4.5V20M17 8h4M19 6v4"/></svg>`,
  heart: `<svg viewBox="0 0 24 24"><path d="M20.5 5.8a5 5 0 0 0-7.1 0L12 7.2l-1.4-1.4a5 5 0 0 0-7.1 7.1L12 21l8.5-8.1a5 5 0 0 0 0-7.1z"/><path d="M7 12h3l1-2 2 4 1-2h3"/></svg>`,
  chat: `<svg viewBox="0 0 24 24"><path d="M5 18.5 3.8 21l4.1-1.2c1.2.5 2.6.8 4.1.8 5 0 9-3.7 9-8.3S17 4 12 4s-9 3.7-9 8.3c0 2.4.8 4.5 2 6.2z"/><path d="M8 12h8M8 9h5"/></svg>`,
  route: `<svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h3c5 0 1-12 6-12h1"/></svg>`,
  briefing: `<svg viewBox="0 0 24 24"><rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3h6v1.5M8.5 9h7M8.5 13h7M8.5 17h4"/></svg>`,
  ads: `<svg viewBox="0 0 24 24"><path d="M4 13v-2l11-5v12zM15 9l4-2v10l-4-2M6 13l1.5 6h3L9 13"/></svg>`,
  compass: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg>`,
  campaign: `<svg viewBox="0 0 24 24"><path d="M4 14V9l12-4v13zM16 8l4-1v9l-4-1M6 14l1.5 5h3L9 14"/></svg>`,
  analysis: `<svg viewBox="0 0 24 24"><path d="M4 19V9M9 19V5M14 19v-7"/><circle cx="17.5" cy="15.5" r="3.5"/><path d="m20 18 2 2"/></svg>`,
  trend: `<svg viewBox="0 0 24 24"><path d="M4 18 10 12l4 4 6-8M15 8h5v5"/></svg>`,
  coins: `<svg viewBox="0 0 24 24"><ellipse cx="9" cy="6" rx="5" ry="2.5"/><path d="M4 6v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V6M4 10v4c0 1.4 2.2 2.5 5 2.5 1 0 2-.2 2.8-.5"/><path d="M14 14h6v6h-6zM17 14v6"/></svg>`,
  team: `<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="2.7"/><circle cx="16.5" cy="9" r="2.3"/><path d="M2.8 20v-1.3A4.2 4.2 0 0 1 7 14.5h2a4.2 4.2 0 0 1 4.2 4.2V20M13.5 15.5c.7-.7 1.7-1 2.8-1h.8a3.9 3.9 0 0 1 3.9 3.9V20"/></svg>`,
  chart: `<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20v-11M2 20h21"/></svg>`,
  gauge: `<svg viewBox="0 0 24 24"><path d="M4 18a8 8 0 1 1 16 0M7 18h10M12 14l4-4"/><circle cx="12" cy="18" r="1"/></svg>`,
  diagnostic: `<svg viewBox="0 0 24 24"><path d="M6 3v6a6 6 0 0 0 12 0V3M4 3h4M16 3h4M12 15v2a4 4 0 0 0 4 4h1"/><circle cx="19" cy="18" r="2"/></svg>`,
  audit: `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5M8 10.5l1.5 1.5 3-3"/></svg>`,
  evidence: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3m-9 7 2 2 4-4"/></svg>`,
  contract: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3M8 11h7M8 15h5M15 17l3-3"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24"><path d="M4 6.5h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2h11"/><path d="M16 11h6v4h-6a2 2 0 0 1 0-4z"/></svg>`,
  wrapped: `<svg viewBox="0 0 24 24"><rect x="3.5" y="8" width="17" height="12" rx="2"/><path d="M12 8v12M3.5 12h17M7.5 8C5 8 5 4.5 7.2 4.5 9.2 4.5 12 8 12 8M16.5 8C19 8 19 4.5 16.8 4.5 14.8 4.5 12 8 12 8"/></svg>`,
  userplus: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20v-1.4c0-2.6 2.1-4.6 4.6-4.6h1.8c2.6 0 4.6 2.1 4.6 4.6V20M18 8v6M15 11h6"/></svg>`,
  funnel: `<svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg>`,
  handshake: `<svg viewBox="0 0 24 24"><path d="m8 12 3-3a2 2 0 0 1 3 0l2 2 4-4M4 8l4 4-3 3-3-3zM20 8l-4 4 3 3 3-3z"/><path d="m9 14 2 2m0-4 3 3m0-4 3 3"/></svg>`,
  palette: `<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18h1.2a2.2 2.2 0 0 0 0-4.4h-.9a1.8 1.8 0 0 1 0-3.6H15a6 6 0 0 0 6-6c0-2.2-4-4-9-4z"/><circle cx="7.5" cy="9" r="1"/><circle cx="10" cy="6.5" r="1"/><circle cx="15" cy="7" r="1"/></svg>`,
  pen: `<svg viewBox="0 0 24 24"><path d="M4 20h4l11-11-4-4L4 16zM13.5 6.5l4 4M4 20l3-1"/></svg>`,
  video: `<svg viewBox="0 0 24 24"><rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3zM8 9l4 3-4 3z"/></svg>`,
  radar: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/><path d="M12 12 19 5"/></svg>`,
  note: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3M8 11h7M8 15h7"/></svg>`,
  bell: `<svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9zM10 21h4"/></svg>`,
  clickup: `<svg viewBox="0 0 24 24"><path d="m5 13 7 5 7-5M7 9l5-4 5 4M8 12l4 3 4-3"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24"><path d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>`,
  mic: `<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>`,
  workflow: `<svg viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="5" rx="1"/><rect x="15" y="15" width="6" height="5" rx="1"/><path d="M9 6.5h4a3 3 0 0 1 3 3v5.5M15 17.5h-4a3 3 0 0 1-3-3V9"/></svg>`,
  plug: `<svg viewBox="0 0 24 24"><path d="M8 3v5M16 3v5M6 8h12v2a6 6 0 0 1-6 6v5M9 21h6"/></svg>`,
  shield: `<svg viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5.2-3.4 8.3-8 10-4.6-1.7-8-4.8-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 8.2A7 7 0 0 1 18.8 10M17.8 15.8A7 7 0 0 1 5.2 14"/></svg>`,
};

function iconData(kind: string) {
  const source = ICONS[kind] || ICONS.grid;
  const svg = source.replace("<svg ", `<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#a9bac6" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" `);
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const RULES: Array<[string, string]> = [
  ['[title="Visão geral"], [title="Visao geral"], [title="Home Comercial"]', "home"],
  ['[title="Foco do dia"], [title="Meu dia"]', "target"],
  ['[title^="Central de Trabalho"]', "tasks"],
  ['[title="Clientes"], [title="Carteira"]', "clients"],
  ['[title="Saúde"], [title="Saude"], [title^="Saúde da carteira"], [title^="Saude da carteira"]', "heart"],
  ['[title="Conversas"]', "chat"],
  ['[title="Onboarding"], [title^="Jornada do cliente"]', "route"],
  ['[data-briefing-staff-nav], [title="Briefing Hub"]', "briefing"],
  ['[data-ads-intelligence-nav], [title="Ads Intelligence"]', "ads"],
  ['[data-meta-consultant-nav], [title="Consultor de Performance"]', "compass"],
  ['[title="Campanhas"]', "campaign"],
  ['[data-meta-analysis-nav], [href="/meta-analysis"]', "analysis"],
  ['[data-meta-performance-nav], [href="/meta-performance"], [title="Performance Meta"]', "trend"],
  ['[data-client-balances-nav], [title^="Saldo Clientes"], [title^="Saldo clientes"]', "coins"],
  ['[title="Equipe"]', "team"],
  ['[title^="Desempenho OP"], [title^="Desempenho da operação"], [title^="Desempenho da operacao"]', "chart"],
  ['[title="Capacidade"], [title^="Capacidade operacional"]', "gauge"],
  ['[data-diagnostics-nav], [href="/diagnostics"], [title^="Central de Diagnóstico"], [title^="Central de Diagnostico"]', "diagnostic"],
  ['[title="Auditoria"]', "audit"],
  ['[title="Evidências"], [title="Evidencias"]', "evidence"],
  ['[title="Contratos"]', "contract"],
  ['[data-adler-finance-nav], [href="/finance"], [title^="Mensalidades"], [title="Financeiro"]', "wallet"],
  ['[href="/wrapped"], [title^="Wrapped"]', "wrapped"],
  ['[title^="Pré-clientes"], [title^="Pre-clientes"]', "userplus"],
  ['[data-commercial-funnel-nav], [href="/sales-funnel"], [title^="Funil comercial"], [title^="Funil Comercial"]', "funnel"],
  ['[title^="Acompanhamento Comercial"]', "handshake"],
  ['[title^="Central Criativa"]', "palette"],
  ['[title^="Produção de Roteiros"], [title^="Producao de Roteiros"], [data-video-scripts-nav]', "pen"],
  ['[title^="Vídeos Automáticos"], [title^="Videos Automaticos"]', "video"],
  ['[data-meta-radar-nav], [href="/creative-intelligence"], [title="Inteligência Criativa"], [title="Inteligencia Criativa"]', "radar"],
  ['[title="Diário"], [title="Diario"]', "note"],
  ['[title="Alertas"], [title^="Alertas operacionais"]', "bell"],
  ['[title="ClickUp"]', "clickup"],
  ['[href="/ia"], [title^="IA da agência"], [title^="IA em desenvolvimento"], [title="IA"]', "sparkle"],
  ['[data-meetings-nav], [title="Relato AI"], [title="Reuniões"]', "mic"],
  ['[data-automation-health-nav], [href="/automations"], [title^="Central de Saúde das Automações"], [title^="Central de Saude das Automacoes"]', "workflow"],
  ['[data-donnah-nav], [href*="/integrations/donnah"], [title^="Donnah"]', "plug"],
  ['[data-security-center-nav], [title^="Segurança"], [title^="Seguranca"]', "shield"],
  ['[data-system-updates-nav], [title^="Atualizações"], [title^="Atualizacoes"]', "refresh"],
];

const selectorsFor = (raw: string) => raw
  .split(", ")
  .map((selector) => `.side-nav-items > ${selector}`)
  .join(",\n");

const iconRules = RULES.map(([rawSelectors, kind]) => {
  const selectors = selectorsFor(rawSelectors);
  return `${selectors}{--ops-nav-icon:url("${iconData(kind)}")}`;
}).join("\n");

const defaultIcon = iconData("grid");
const CSS = `
.side-nav-items > button:not(.sidebar-ia-group-title),
.side-nav-items > a{
  --ops-nav-icon:url("${defaultIcon}");
  display:flex!important;
  align-items:center!important;
  justify-content:flex-start!important;
  gap:12px!important;
  position:relative!important;
  box-sizing:border-box!important;
  text-indent:0!important;
}
${iconRules}
.side-nav-items > button:not(.sidebar-ia-group-title)::after,
.side-nav-items > a::after{
  content:""!important;
  display:inline-block!important;
  order:-1!important;
  width:18px!important;
  min-width:18px!important;
  height:18px!important;
  flex:0 0 18px!important;
  margin:0!important;
  padding:0!important;
  position:static!important;
  transform:none!important;
  background-image:var(--ops-nav-icon)!important;
  background-position:center!important;
  background-repeat:no-repeat!important;
  background-size:17px 17px!important;
  opacity:1!important;
  visibility:visible!important;
  pointer-events:none!important;
  transition:filter .15s ease!important;
}
.side-nav-items > button:not(.sidebar-ia-group-title):hover::after,
.side-nav-items > a:hover::after,
.side-nav-items > button:not(.sidebar-ia-group-title).active::after,
.side-nav-items > a.active::after{
  opacity:1!important;
  visibility:visible!important;
  filter:brightness(1.2)!important;
}
.side-nav-items > button:not(.sidebar-ia-group-title)::before,
.side-nav-items > a::before{
  content:""!important;
  position:absolute!important;
  left:0!important;
  top:50%!important;
  width:3px!important;
  min-width:0!important;
  height:0!important;
  flex:none!important;
  margin:0!important;
  padding:0!important;
  border-radius:99px!important;
  background:linear-gradient(var(--accent),color-mix(in srgb,var(--accent) 55%,var(--blue)))!important;
  background-image:none!important;
  transform:translateY(-50%)!important;
  opacity:0!important;
  pointer-events:none!important;
  transition:height var(--motion-base) var(--motion-ease-out),opacity var(--motion-base) ease!important;
}
.side-nav-items > button:not(.sidebar-ia-group-title):hover::before,
.side-nav-items > a:hover::before{height:42%!important;opacity:.55!important}
.side-nav-items > button:not(.sidebar-ia-group-title).active::before,
.side-nav-items > a.active::before{height:64%!important;opacity:1!important}
.side-nav-items > button > .nav-brand-icon,
.side-nav-items > a > .nav-brand-icon,
.side-nav-items > button > [aria-hidden="true"]:first-child,
.side-nav-items > a > [aria-hidden="true"]:first-child,
.side-nav-items > button > svg:first-child,
.side-nav-items > a > svg:first-child,
.side-nav-items > button > img:first-child,
.side-nav-items > a > img:first-child{display:none!important}
.side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title),
.side-nav:not(.open) .side-nav-items > a{
  justify-content:center!important;
  gap:0!important;
  padding-left:0!important;
  padding-right:0!important;
  font-size:0!important;
}
.side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title)::after,
.side-nav:not(.open) .side-nav-items > a::after{
  width:19px!important;
  min-width:19px!important;
  height:19px!important;
  flex-basis:19px!important;
  margin:0 auto!important;
  background-size:18px 18px!important;
}
`;

export default function NavBrandIconsV2() {
  return <style id={STYLE_ID} dangerouslySetInnerHTML={{ __html: CSS }} />;
}
