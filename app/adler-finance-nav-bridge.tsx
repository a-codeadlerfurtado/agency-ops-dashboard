"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const FINANCE_API = `${SUPABASE_URL}/functions/v1/agency-ops-adler-finance-api`;

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function removeFinanceNav() {
  document.querySelectorAll("[data-adler-finance-nav]").forEach((node) => node.remove());
}

function installFinanceNav() {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container || container.querySelector("[data-adler-finance-nav]")) return;

  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const contracts = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("contratos"));
  const clients = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("clientes"));
  const template = contracts || clients || buttons[0];

  const button = document.createElement("button");
  button.type = "button";
  button.dataset.adlerFinanceNav = "true";
  button.title = "Mensalidades & Impl.";
  button.textContent = "Mensalidades & Impl.";
  if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
  button.addEventListener("click", () => window.location.assign("/finance"));

  if (contracts?.nextSibling) container.insertBefore(button, contracts.nextSibling);
  else if (contracts) container.appendChild(button);
  else if (clients?.nextSibling) container.insertBefore(button, clients.nextSibling);
  else container.appendChild(button);
}

export default function AdlerFinanceNavBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setAllowed(false); removeFinanceNav(); return; }
    let active = true;
    authenticatedFetch(`${FINANCE_API}?probe=1`, { cache: "no-store" })
      .then((response) => { if (active) setAllowed(response.ok); })
      .catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, [session?.access_token]);

  useEffect(() => {
    if (!allowed) { removeFinanceNav(); return; }
    let frame = 0;
    const apply = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (window.location.pathname === "/") installFinanceNav();
        else removeFinanceNav();
      });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = window.setInterval(apply, 1200);
    return () => {
      observer.disconnect();
      window.clearInterval(timer);
      window.cancelAnimationFrame(frame);
      removeFinanceNav();
    };
  }, [allowed]);

  return null;
}
