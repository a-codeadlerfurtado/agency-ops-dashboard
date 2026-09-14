"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authenticatedFetch, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;

const API = `${SUPABASE_URL}/functions/v1/agency-ops-briefing-staff-api`;
const JOEL = "Joel Antoniete";
const BUTTON_CLASS = "joel-briefing-vault-shortcut";

export default function JoelBriefingVaultShortcut() {
  const [allowed, setAllowed] = useState(false);
  const armedRef = useRef(false);

  const checkAccess = useCallback(async () => {
    try {
      const url = new URL(API);
      url.searchParams.set("action", "bootstrap");
      const response = await authenticatedFetch(url, { cache: "no-store" });
      const body: Row = await response.json().catch(() => ({}));
      setAllowed(response.ok && String(body.person || "") === JOEL);
    } catch {
      setAllowed(false);
    }
  }, []);

  useEffect(() => {
    void checkAccess();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        setAllowed(false);
        return;
      }
      if (event === "SIGNED_IN" || event === "USER_UPDATED" || event === "TOKEN_REFRESHED") {
        window.setTimeout(() => { void checkAccess(); }, 0);
      }
    });
    return () => subscription.unsubscribe();
  }, [checkAccess]);

  useEffect(() => {
    if (!allowed) return;

    const openVault = () => {
      armedRef.current = true;
      window.dispatchEvent(new CustomEvent("material-triage-open-briefing", { detail: { tab: "accesses" } }));

      const activateAccessTab = () => {
        if (!armedRef.current) return;
        const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".brief-staff-tab"));
        const accessTab = buttons.find((button) => /Acessos Briefing Hub/i.test(button.textContent || ""));
        if (accessTab) {
          accessTab.click();
          armedRef.current = false;
        }
      };

      activateAccessTab();
      const observer = new MutationObserver(() => {
        activateAccessTab();
        if (!armedRef.current) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.setTimeout(() => { armedRef.current = false; observer.disconnect(); }, 120000);
    };

    const attach = () => {
      const menu = document.querySelector<HTMLElement>(".profile-menu");
      if (!menu || menu.querySelector(`.${BUTTON_CLASS}`)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = BUTTON_CLASS;
      button.textContent = "Cofre de acessos";
      button.title = "Acessos dos clientes no Briefing Hub";
      button.addEventListener("click", openVault);
      const logout = Array.from(menu.querySelectorAll("button")).find((node) => /sair/i.test(node.textContent || ""));
      if (logout) menu.insertBefore(button, logout);
      else menu.appendChild(button);
    };

    attach();
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((node) => node.remove());
      armedRef.current = false;
    };
  }, [allowed]);

  if (!allowed) return null;
  return <style>{`.${BUTTON_CLASS}{font-weight:650!important;color:#dbeafe!important}`}</style>;
}
