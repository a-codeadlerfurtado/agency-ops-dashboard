"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";
import { ContractsCenter } from "./views/contracts";

const CONTRACTS_API = `${SUPABASE_URL}/functions/v1/agency-ops-contracts-api`;

export default function ContractsPrivateBridge() {
  const [token, setToken] = useState<string | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [open, setOpen] = useState(false);
  const [navHost, setNavHost] = useState<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    supabase.auth.getSession().then(({ data }) => setToken(data.session?.access_token || null));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setToken(session?.access_token || null);
      if (!session) { setAuthorized(false); setOpen(false); }
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!token) return;
    let active = true;
    fetch(CONTRACTS_API, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    }).then((response) => {
      if (!active) return;
      setAuthorized(response.ok);
      if (!response.ok) setOpen(false);
    }).catch(() => { if (active) { setAuthorized(false); setOpen(false); } });
    return () => { active = false; };
  }, [token]);

  useEffect(() => {
    if (!mounted || !authorized) { setNavHost(null); return; }
    const locate = () => setNavHost(document.querySelector<HTMLElement>(".side-nav-items"));
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [mounted, authorized]);

  useEffect(() => {
    if (!navHost) return;
    const closeWhenOtherTabOpens = (event: Event) => {
      const target = event.target as HTMLElement | null;
      const button = target?.closest("button");
      if (button && !button.hasAttribute("data-contracts-private")) setOpen(false);
    };
    navHost.addEventListener("click", closeWhenOtherTabOpens);
    return () => navHost.removeEventListener("click", closeWhenOtherTabOpens);
  }, [navHost]);

  if (!mounted || !authorized || !token || !navHost) return null;

  return <>
    {createPortal(
      <button
        type="button"
        data-contracts-private="true"
        className={open ? "active" : ""}
        onClick={() => setOpen((value) => !value)}
        title="Contratos · privado Adler"
      >Contratos</button>,
      navHost
    )}
    {open && createPortal(
      <div style={{
        position: "fixed",
        top: 112,
        left: "var(--sidenav-width, 224px)",
        right: 0,
        bottom: 0,
        zIndex: 9000,
        overflow: "auto",
        padding: "18px 22px 40px",
        background: "var(--bg, #080c13)",
        borderTop: "1px solid rgba(148,163,184,.12)",
      }}>
        <ContractsCenter token={token} />
      </div>,
      document.body
    )}
  </>;
}
