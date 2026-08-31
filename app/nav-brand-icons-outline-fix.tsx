"use client";

import { useEffect } from "react";

const STYLE_ID = "nav-brand-icons-outline-fix-style";
const META_OUTLINE = `<svg viewBox="0 0 32 20" fill="none" aria-hidden="true"><path d="M2.6 15.7C4.8 9.1 7.1 4.3 10.2 4.3c4.4 0 6.4 8.7 8.7 11.3 1.2 1.4 2.4 2 3.8 2 3.3 0 5.6-2.9 5.6-6.3 0-4.2-3.3-8.5-7.5-8.5-4.9 0-7.8 7.6-10.2 12.2-1 2-1.9 3-3.5 3-1.9 0-3.2-1.3-3.2-3.4 0-2.2 1.5-5.6 3.6-8.4C9.5 3.6 12 2 14.8 2c4 0 6.7 3.4 9.1 7.5"/></svg>`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .nav-brand-icon[data-kind="meta"] {
      width:18px!important;
      height:16px!important;
      flex:0 0 18px!important;
      background:none!important;
      background-image:none!important;
      color:#0866ff!important;
      opacity:.96!important;
      filter:drop-shadow(0 0 0 rgba(8,102,255,0))!important;
      transition:color .16s ease,opacity .16s ease,filter .16s ease,transform .16s ease!important;
    }
    .nav-brand-icon[data-kind="meta"] svg {
      width:18px!important;
      height:14px!important;
      display:block!important;
      fill:none!important;
      stroke:currentColor!important;
      stroke-width:1.8!important;
      stroke-linecap:round!important;
      stroke-linejoin:round!important;
      vector-effect:non-scaling-stroke;
      overflow:visible;
    }
    .side-nav-items > button:hover .nav-brand-icon[data-kind="meta"],
    .side-nav-items > a:hover .nav-brand-icon[data-kind="meta"] {
      color:#1683ff!important;
      opacity:1!important;
      filter:drop-shadow(0 0 5px rgba(8,102,255,.28))!important;
      transform:translateY(-.25px)!important;
    }
    .side-nav-items > .active .nav-brand-icon[data-kind="meta"] {
      color:#1683ff!important;
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
    .side-nav:not(.open) .side-nav-items > button:not(.sidebar-ia-group-title) > :not(.nav-brand-icon),
    .side-nav:not(.open) .side-nav-items > a > :not(.nav-brand-icon) {
      display:none!important;
    }
    .side-nav:not(.open) .side-nav-items .nav-brand-icon {
      display:inline-flex!important;
      width:18px!important;
      min-width:18px!important;
      height:18px!important;
      flex:0 0 18px!important;
      margin:0 auto!important;
      font-size:initial!important;
      line-height:normal!important;
      opacity:.96!important;
    }
    .side-nav:not(.open) .side-nav-items .nav-brand-icon[data-kind="meta"] svg {
      width:18px!important;
      height:14px!important;
    }
  `;
  document.head.appendChild(style);
}

function patchMetaIcons() {
  document.querySelectorAll<HTMLElement>('.nav-brand-icon[data-kind="meta"]').forEach((icon) => {
    if (icon.dataset.outlineMeta === "true") return;
    icon.style.removeProperty("background-image");
    icon.innerHTML = META_OUTLINE;
    icon.dataset.outlineMeta = "true";
  });
}

export default function NavBrandIconsOutlineFix() {
  useEffect(() => {
    ensureStyles();
    let frame = 0;
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(patchMetaIcons);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-kind"],
    });
    const timer = window.setInterval(schedule, 1200);

    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      document.getElementById(STYLE_ID)?.remove();
    };
  }, []);

  return null;
}
