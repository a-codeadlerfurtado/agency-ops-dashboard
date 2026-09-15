"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-client-balances-api`;
const attr = "data-client-balances-nav";

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
function removeNav() { document.querySelectorAll(`[${attr}]`).forEach((node) => node.remove()); }
function installNav() {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container || container.querySelector(`[${attr}]`)) return;
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
  const campaigns = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("campanhas"));
  const clients = buttons.find((button) => normalize(button.title || button.textContent || "").startsWith("clientes"));
  const template = campaigns || clients || buttons[0];
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute(attr, "true");
  button.title = "Saldo Clientes";
  button.textContent = "Saldo Clientes";
  if (template?.className) button.className = template.className.replace(/\bactive\b/g, "").trim();
  button.addEventListener("click", () => window.location.assign("/client-balances"));
  if (campaigns?.nextSibling) container.insertBefore(button, campaigns.nextSibling);
  else if (campaigns) container.appendChild(button);
  else if (clients?.nextSibling) container.insertBefore(button, clients.nextSibling);
  else container.appendChild(button);
}

export default function ClientBalancesNavBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowed, setAllowed] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session?.access_token) { setAllowed(false); removeNav(); return; }
    let active = true;
    authenticatedFetch(`${API}?probe=1`, { cache: "no-store" })
      .then((response) => { if (active) setAllowed(response.ok); })
      .catch(() => { if (active) setAllowed(false); });
    return () => { active = false; };
  }, [session?.access_token]);
  useEffect(() => {
    if (!allowed) { removeNav(); return; }
    const apply = () => window.location.pathname === "/" ? installNav() : removeNav();
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); removeNav(); };
  }, [allowed]);
  return null;
}
