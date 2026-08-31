"use client";

const STYLE_ID = "nav-brand-icons-style";

const ICONS: Record<string, string> = {
  home: `<svg viewBox="0 0 24 24"><path d="M3.5 10.8 12 3.8l8.5 7v9.4a.8.8 0 0 1-.8.8h-5.2v-6.2h-5V21H4.3a.8.8 0 0 1-.8-.8z"/></svg>`,
  target: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`,
  tasks: `<svg viewBox="0 0 24 24"><rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 9 1.6 1.6L13 7.4M8 15h8"/></svg>`,
  users: `<svg viewBox="0 0 24 24"><path d="M16 20v-1.6c0-2.2-1.8-4-4-4H7c-2.2 0-4 1.8-4 4V20"/><circle cx="9.5" cy="7.3" r="3.3"/><path d="M16.5 4.4a3 3 0 0 1 0 5.8M18.5 14.6c1.6.6 2.5 1.8 2.5 3.5V20"/></svg>`,
  heart: `<svg viewBox="0 0 24 24"><path d="M20.5 5.8a5 5 0 0 0-7.1 0L12 7.2l-1.4-1.4a5 5 0 0 0-7.1 7.1L12 21l8.5-8.1a5 5 0 0 0 0-7.1z"/></svg>`,
  route: `<svg viewBox="0 0 24 24"><circle cx="5" cy="18" r="2"/><circle cx="19" cy="6" r="2"/><path d="M7 18h3c5 0 1-12 6-12h1"/></svg>`,
  userplus: `<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20v-1.4c0-2.6 2.1-4.6 4.6-4.6h1.8c2.6 0 4.6 2.1 4.6 4.6V20M18 8v6M15 11h6"/></svg>`,
  chat: `<svg viewBox="0 0 24 24"><path d="M5 18.5 3.8 21l4.1-1.2c1.2.5 2.6.8 4.1.8 5 0 9-3.7 9-8.3S17 4 12 4s-9 3.7-9 8.3c0 2.4.8 4.5 2 6.2z"/></svg>`,
  note: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3M8 11h7M8 15h7"/></svg>`,
  check: `<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="m7.5 12.5 3 3 6-7"/></svg>`,
  filecheck: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3m-9 7 2 2 4-4"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>`,
  bell: `<svg viewBox="0 0 24 24"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9zM10 21h4"/></svg>`,
  chart: `<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20v-11M2 20h21"/></svg>`,
  palette: `<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18h1.2a2.2 2.2 0 0 0 0-4.4h-.9a1.8 1.8 0 0 1 0-3.6H15a6 6 0 0 0 6-6c0-2.2-4-4-9-4z"/><circle cx="7.5" cy="9" r="1"/><circle cx="10" cy="6.5" r="1"/><circle cx="15" cy="7" r="1"/></svg>`,
  funnel: `<svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8v5l-4 2v-7z"/></svg>`,
  wallet: `<svg viewBox="0 0 24 24"><path d="M4 6.5h14a2 2 0 0 1 2 2v10H4a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2h11"/><path d="M16 11h6v4h-6a2 2 0 0 1 0-4z"/></svg>`,
  gear: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5v-3l-2.1-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7-.7-2.1h-3l-.7 2.1-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2.1.7v3l2.1.7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2.1h3l.7-2.1 1.7-.7 1.9.9 2.1-2.1-.9-1.9z" transform="translate(1.3 .2) scale(.9)"/></svg>`,
  plug: `<svg viewBox="0 0 24 24"><path d="M8 3v5M16 3v5M6 8h12v2a6 6 0 0 1-6 6v5M9 21h6"/></svg>`,
  sparkle: `<svg viewBox="0 0 24 24"><path d="m12 2 1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>`,
  shield: `<svg viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5.2-3.4 8.3-8 10-4.6-1.7-8-4.8-8-10V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 8.2A7 7 0 0 1 18.8 10M17.8 15.8A7 7 0 0 1 5.2 14"/></svg>`,
  file: `<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M15 3.5V7h3"/></svg>`,
};

function iconData(kind: string) {
  const source = ICONS[kind];
  const svg = source.replace(
    "<svg ",
    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#a9bac6" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" `,
  );
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const RULES: Array<[string, string]> = [
  ['[title="Visão geral"], [title="Visao geral"]', "home"],
  ['[title="Foco do dia"], [title="Meu dia"]', "target"],
  ['[title^="Central de Trabalho"]', "tasks"],
  ['[title="Clientes"], [title="Carteira"]', "users"],
  ['[title="Saúde"], [title="Saude"], [title^="Saúde da carteira"], [title^="Saude da carteira"]', "heart"],
  ['[title="Conversas"]', "chat"],
  ['[title="Onboarding"], [title^="Jornada do cliente"]', "route"],
  ['[title^="Pré-clientes"], [title^="Pre-clientes"]', "userplus"],
  ['[title="Diário"], [title="Diario"]', "note"],
  ['[title="Equipe"]', "users"],
  ['[title="ClickUp"]', "check"],
  ['[title="Evidências"], [title="Evidencias"]', "filecheck"],
  ['[title="Auditoria"]', "search"],
  ['[title="Alertas"], [title^="Alertas operacionais"]', "bell"],
  ['[title^="Desempenho OP"], [title^="Desempenho da operação"], [title^="Desempenho da operacao"]', "chart"],
  ['[title^="Central Criativa"], [title="Inteligência Criativa"], [title="Inteligencia Criativa"]', "palette"],
  ['[title^="Funil Comercial"]', "funnel"],
  ['[title="Financeiro"], [title^="Mensalidades"]', "wallet"],
  ['[title^="Automações"], [title^="Automacoes"]', "gear"],
  ['[title="Donnah"], [href*="/integrations/donnah"]', "plug"],
  ['[title="IA"], [title^="IA em desenvolvimento"], [href="/ia"]', "sparkle"],
  ['[title^="Atualizações"], [title^="Atualizacoes"]', "refresh"],
  ['[title^="Segurança"], [title^="Seguranca"]', "shield"],
  ['[title="Contratos"]', "file"],
];

const selectorsFor = (raw: string) => raw.split(", ").map((selector) => `.side-nav-items > ${selector}`).join(",\n");

const iconRules = RULES.map(([rawSelectors, kind]) => {
  const selectors = selectorsFor(rawSelectors);
  return `${selectors}{display:flex!important;align-items:center!important;gap:12px!important}\n${selectors.replaceAll(",\n", "::before,\n")}::before{content:""!important;display:inline-block!important;width:18px!important;min-width:18px!important;height:18px!important;flex:0 0 18px!important;margin:0!important;position:static!important;transform:none!important;background-image:url("${iconData(kind)}")!important;background-position:center!important;background-repeat:no-repeat!important;background-size:17px 17px!important;opacity:.96!important;pointer-events:none!important}`;
}).join("\n");

const CSS = `
/* Icons are rendered by CSS in the same frame as the nav item. The old
   MutationObserver-injected spans are disabled to prevent delayed pop-in. */
.side-nav-items .nav-brand-icon{display:none!important}
${iconRules}
.side-nav-items > button:hover::before,
.side-nav-items > a:hover::before{opacity:1!important;filter:brightness(1.18)!important}
.side-nav-items > button.active::before,
.side-nav-items > a.active::before{opacity:1!important;filter:brightness(1.28)!important}
.side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title),
.side-nav:not(.open) .side-nav-items > a{justify-content:center!important;gap:0!important}
.side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title)::before,
.side-nav:not(.open) .side-nav-items > a::before{width:18px!important;min-width:18px!important;height:18px!important;flex:0 0 18px!important;margin:0 auto!important}
`;

export default function NavBrandIcons() {
  return <style id={STYLE_ID} dangerouslySetInnerHTML={{ __html: CSS }} />;
}
