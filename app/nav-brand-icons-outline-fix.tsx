"use client";

import { useEffect } from "react";

const STYLE_ID = "nav-brand-icons-outline-fix-style";

/*
 * Meta icons are intentionally CSS-driven instead of DOM-injected.
 * The sidebar is rebuilt by several bridges during navigation; an injected
 * <span> can disappear between renders. A pseudo-element bound to the nav
 * item's stable attributes survives every React/sidebar re-render.
 */
const META_SELECTORS = `
  .side-nav-items > [data-ads-intelligence-nav],
  .side-nav-items > [data-meta-consultant-nav],
  .side-nav-items > [data-meta-analysis-nav],
  .side-nav-items > [data-meta-performance-nav],
  .side-nav-items > [data-client-balances-nav],
  .side-nav-items > a[href="/campaigns"],
  .side-nav-items > button[href="/campaigns"]
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* The legacy icon injector may still create a Meta span for a frame.
       Hide it permanently so there is never a duplicate or a race. */
    .side-nav-items .nav-brand-icon[data-kind="meta"] {
      display:none!important;
    }

    ${META_SELECTORS} {
      display:flex!important;
      align-items:center!important;
      gap:9px!important;
    }

    ${META_SELECTORS.replaceAll(",", "::before,")}::before {
      content:""!important;
      display:inline-block!important;
      width:19px!important;
      min-width:19px!important;
      height:15px!important;
      flex:0 0 19px!important;
      background-color:#0866ff!important;
      -webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 20' fill='none'%3E%3Cpath d='M2.6 15.7C4.8 9.1 7.1 4.3 10.2 4.3c4.4 0 6.4 8.7 8.7 11.3 1.2 1.4 2.4 2 3.8 2 3.3 0 5.6-2.9 5.6-6.3 0-4.2-3.3-8.5-7.5-8.5-4.9 0-7.8 7.6-10.2 12.2-1 2-1.9 3-3.5 3-1.9 0-3.2-1.3-3.2-3.4 0-2.2 1.5-5.6 3.6-8.4C9.5 3.6 12 2 14.8 2c4 0 6.7 3.4 9.1 7.5' stroke='black' stroke-width='2.05' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat!important;
      mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 20' fill='none'%3E%3Cpath d='M2.6 15.7C4.8 9.1 7.1 4.3 10.2 4.3c4.4 0 6.4 8.7 8.7 11.3 1.2 1.4 2.4 2 3.8 2 3.3 0 5.6-2.9 5.6-6.3 0-4.2-3.3-8.5-7.5-8.5-4.9 0-7.8 7.6-10.2 12.2-1 2-1.9 3-3.5 3-1.9 0-3.2-1.3-3.2-3.4 0-2.2 1.5-5.6 3.6-8.4C9.5 3.6 12 2 14.8 2c4 0 6.7 3.4 9.1 7.5' stroke='black' stroke-width='2.05' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center/contain no-repeat!important;
      opacity:.96!important;
      filter:drop-shadow(0 0 0 rgba(8,102,255,0))!important;
      transform:translateY(0)!important;
      transition:opacity .16s ease,filter .16s ease,transform .16s ease,background-color .16s ease!important;
      pointer-events:none!important;
    }

    ${META_SELECTORS.replaceAll(",", ":hover::before,")}:hover::before {
      background-color:#1683ff!important;
      opacity:1!important;
      filter:drop-shadow(0 0 5px rgba(8,102,255,.28))!important;
      transform:translateY(-.25px)!important;
    }

    ${META_SELECTORS.replaceAll(",", ".active::before,")}.active::before {
      background-color:#1683ff!important;
      opacity:1!important;
      filter:drop-shadow(0 0 6px rgba(8,102,255,.34))!important;
    }

    .side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title),
    .side-nav:not(.open) .side-nav-items > a {
      justify-content:center!important;
      gap:0!important;
      overflow:hidden!important;
      white-space:nowrap!important;
      font-size:0!important;
      line-height:0!important;
      padding-left:0!important;
      padding-right:0!important;
      text-indent:0!important;
    }

    .side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title) > *,
    .side-nav:not(.open) .side-nav-items > a > * {
      display:none!important;
    }

    .side-nav:not(.open) ${META_SELECTORS.replaceAll(",", ", .side-nav:not(.open) ")} {
      overflow:visible!important;
    }

    .side-nav:not(.open) ${META_SELECTORS.replaceAll(",", "::before, .side-nav:not(.open) ")}::before {
      display:inline-block!important;
      width:20px!important;
      min-width:20px!important;
      height:16px!important;
      flex:0 0 20px!important;
      margin:0 auto!important;
    }
  `;

  document.head.appendChild(style);
}

export default function NavBrandIconsOutlineFix() {
  useEffect(() => {
    ensureStyles();
    return () => document.getElementById(STYLE_ID)?.remove();
  }, []);

  return null;
}
