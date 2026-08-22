"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-ai-head-api`;

export default function AIHeadRouter() {
  useEffect(() => {
    if (window.location.pathname.startsWith("/ai-head")) return;
    let active = true;

    const route = async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session || !active) return;
      try {
        const response = await fetch(API_URL, {
          headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
          cache: "no-store",
        });
        if (!response.ok || !active) return;
        const body = await response.json().catch(() => ({}));
        if (body?.profile?.role === "AI") window.location.replace("/ai-head");
      } catch {
        // Em falha de identificação, preserva a rota atual.
      }
    };

    route();
    return () => { active = false; };
  }, []);

  return null;
}
