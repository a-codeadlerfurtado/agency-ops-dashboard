"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL, authenticatedFetch, supabase } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-diagnostics-api`;
const ATTR = "data-diagnostics-nav";
const norm = (value: unknown) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

function removeNav() {
  document.querySelectorAll(`[${ATTR}]`).forEach((node) => node.remove());
}

function installNav() {
  const container = document.querySelector<HTMLElement>(".side-nav-items");
  if (!container || container.querySelector(`[${ATTR}]`)) return;
  const nodes = Array.from(container.querySelectorAll<HTMLElement>("button,a"));
  const audit = nodes.find((node) => norm(node.getAttribute("title") || node.textContent) === "auditoria");
  const template = audit || nodes.find((node) => norm(node.textContent) === "desempenho op") || nodes[0];
  const link = document.createElement("a");
  link.setAttribute(ATTR, "true");
  link.href = "/diagnostics";
  link.title = "Central de Diagnóstico";
  link.textContent = "Central de Diagnóstico";
  if (template?.className) link.className = String(template.className).replace(/\bactive\b/g, "").trim();
  if (audit) container.insertBefore(link, audit);
  else container.appendChild(link);
}

export default function DiagnosticsNavBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.access_token) { setAllowed(false); removeNav(); return; }
    let alive = true;
    authenticatedFetch(`${API}?probe=1`, { cache: "no-store" })
      .then((response) => { if (alive) setAllowed(response.ok); })
      .catch(() => { if (alive) setAllowed(false); });
    return () => { alive = false; };
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
