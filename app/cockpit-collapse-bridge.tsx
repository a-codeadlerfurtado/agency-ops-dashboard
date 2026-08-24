"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const STORAGE_KEY = "agency-ops-cockpit-collapsed";

export default function CockpitCollapseBridge() {
  const [cockpit, setCockpit] = useState<HTMLElement | null>(null);
  const [head, setHead] = useState<HTMLElement | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {}
  }, []);

  useEffect(() => {
    let last: HTMLElement | null = null;
    const sync = () => {
      const next = document.querySelector<HTMLElement>(".ops-cockpit");
      if (next === last) return;
      last = next;
      setCockpit(next);
      setHead(next?.querySelector<HTMLElement>(".ops-cockpit-head") || null);
    };

    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!cockpit) return;
    cockpit.dataset.collapsed = collapsed ? "true" : "false";
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {}
    return () => {
      delete cockpit.dataset.collapsed;
    };
  }, [cockpit, collapsed]);

  if (!head) return <style>{styles}</style>;

  return <>
    <style>{styles}</style>
    {createPortal(
      <button
        type="button"
        className="ops-cockpit-collapse-toggle"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? "Expandir cockpit operacional" : "Recolher cockpit operacional"}
        title={collapsed ? "Expandir cockpit" : "Recolher cockpit"}
      >
        <span>{collapsed ? "Expandir" : "Recolher"}</span>
        <i aria-hidden="true">{collapsed ? "⌄" : "⌃"}</i>
      </button>,
      head,
    )}
  </>;
}

const styles = `
.ops-cockpit-collapse-toggle{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;border:1px solid var(--line,#294b61);background:color-mix(in srgb,var(--panel2,#091a27) 92%,transparent);color:var(--text,#dcecf7);border-radius:10px;padding:7px 10px;font:800 9px/1 Inter,system-ui,sans-serif;letter-spacing:.02em;cursor:pointer;transition:background .18s ease,border-color .18s ease,transform .18s ease}
.ops-cockpit-collapse-toggle:hover{background:color-mix(in srgb,var(--blue,#2777b8) 14%,var(--panel2,#091a27));border-color:color-mix(in srgb,var(--blue,#2777b8) 48%,var(--line,#294b61));transform:translateY(-1px)}
.ops-cockpit-collapse-toggle i{font-style:normal;font-size:14px;line-height:1;color:var(--muted,#8aa2b4)}
.ops-cockpit[data-collapsed="true"] .ops-cockpit-grid{display:none!important}
.ops-cockpit[data-collapsed="true"] .ops-cockpit-head{margin-bottom:0!important}
.ops-cockpit[data-collapsed="true"] .ops-cockpit-head p{display:none!important}
.ops-cockpit[data-collapsed="true"]{padding-top:12px!important;padding-bottom:12px!important}
@media(max-width:760px){.ops-cockpit-collapse-toggle span{display:none}.ops-cockpit-collapse-toggle{width:34px;padding:6px}.ops-cockpit-collapse-toggle i{font-size:16px}}
`;
