"use client";

import { useEffect, useState } from "react";
import { supabase } from "./shared";

export default function HomeShortcut() {
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (mounted) setAuthenticated(Boolean(data.session));
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (mounted) setAuthenticated(Boolean(session));
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!authenticated) return;

    function handleKeyDown(event: KeyboardEvent) {
      const isHomeShortcut =
        event.ctrlKey &&
        event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "h";

      if (!isHomeShortcut || event.repeat) return;

      event.preventDefault();
      event.stopPropagation();

      if (window.location.pathname !== "/") {
        window.location.assign("/");
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [authenticated]);

  return null;
}
