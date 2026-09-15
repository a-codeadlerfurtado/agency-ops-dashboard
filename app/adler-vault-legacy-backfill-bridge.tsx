"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API = `${SUPABASE_URL}/functions/v1/agency-ops-vault-legacy-backfill`;
const SESSION_KEY = "agency-ops:adler-vault-backfill-v1";

export default function AdlerVaultLegacyBackfillBridge() {
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const run = async () => {
      if (cancelled || inFlight) return;
      try {
        const state = window.sessionStorage.getItem(SESSION_KEY);
        if (state === "done" || state === "running") return;
        inFlight = true;
        window.sessionStorage.setItem(SESSION_KEY, "running");

        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token || cancelled) {
          window.sessionStorage.removeItem(SESSION_KEY);
          return;
        }

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
          window.sessionStorage.setItem(SESSION_KEY, "done");
          return;
        }

        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok || cancelled) {
          window.sessionStorage.removeItem(SESSION_KEY);
          return;
        }

        window.sessionStorage.setItem(SESSION_KEY, "done");
        window.dispatchEvent(new CustomEvent("agency-ops:adler-vault-updated", { detail: payload }));
      } catch {
        window.sessionStorage.removeItem(SESSION_KEY);
      } finally {
        inFlight = false;
      }
    };

    void run();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        window.sessionStorage.removeItem(SESSION_KEY);
        return;
      }
      if (event === "SIGNED_IN") void run();
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  return null;
}
