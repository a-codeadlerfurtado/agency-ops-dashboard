"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

type Row = Record<string, any>;
const ENDPOINT = `${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`;

function isCompletionTitle(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase("pt-BR").startsWith("onboarding finalizado");
}

export default function OnboardingHistoryNotificationBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const cache = useRef<{ at: number; rows: Row[] }>({ at: 0, rows: [] });

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) cache.current = { at: 0, rows: [] };
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadRows = useCallback(async () => {
    if (!session?.access_token) return [] as Row[];
    if (Date.now() - cache.current.at < 5000 && cache.current.rows.length) return cache.current.rows;
    const response = await fetch(ENDPOINT, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    const rows: Row[] = response.ok && body?.ok && Array.isArray(body.items) ? body.items : [];
    cache.current = { at: Date.now(), rows };
    return rows;
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;

    const click = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const card = target?.closest?.(
        ".notification-panel .notification-list > button, button.toast, .nh-item, .client-notifications-bridge-host .cn-item"
      ) as HTMLElement | null;
      if (!card) return;
      const title = card.querySelector<HTMLElement>("b,strong,h2,h4")?.textContent || "";
      if (!isCompletionTitle(title)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      void (async () => {
        const notificationId = String(card.dataset.notificationId || "").trim();
        const rows = await loadRows();
        let item = notificationId ? rows.find((row) => String(row.id) === notificationId) : null;
        if (!item) {
          const sameTitle = rows.filter((row) => isCompletionTitle(row.title) && String(row.title) === String(title));
          item = sameTitle.length === 1 ? sameTitle[0] : sameTitle.sort((a,b) => +new Date(b.occurred_at || 0) - +new Date(a.occurred_at || 0))[0];
        }
        const caseId = Number(item?.metadata?.onboarding_history_case_id || 0);
        window.location.assign(caseId > 0 ? `/onboarding-overview/history?case=${caseId}` : "/onboarding-overview/history");
      })();
    };

    window.addEventListener("click", click, true);
    return () => window.removeEventListener("click", click, true);
  }, [loadRows, session?.access_token]);

  return null;
}
