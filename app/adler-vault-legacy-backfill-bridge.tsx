"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-vault-legacy-backfill`;
const SESSION_KEY = "agency-ops:adler-vault-backfill-v1";

export default function AdlerVaultLegacyBackfillBridge() {
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        if (window.sessionStorage.getItem(SESSION_KEY) === "done") return;
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token || cancelled) return;
        const response = await fetch(API, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            apikey: SUPABASE_ANON_KEY,
            "content-type": "application/json",
          },
          cache: "no-store",
          body: "{}",
        });
        if (response.status === 404) {
          // Perfil diferente do Adler: o endpoint se comporta como inexistente.
          window.sessionStorage.setItem(SESSION_KEY, "done");
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok || cancelled) return;
        window.sessionStorage.setItem(SESSION_KEY, "done");
        window.dispatchEvent(new CustomEvent("agency-ops:adler-vault-updated", { detail: payload }));
      } catch {
        // Backfill é complementar e nunca deve bloquear o dashboard.
      }
    };

    void run();
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      window.sessionStorage.removeItem(SESSION_KEY);
      void run();
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return null;
}
