"use client";

import { useEffect, useState } from "react";
import { supabase } from "./shared";

export default function LogoutShortcut() {
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

    let signingOut = false;

    async function handleKeyDown(event: KeyboardEvent) {
      const isLogoutShortcut =
        event.ctrlKey &&
        event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "s";

      if (!isLogoutShortcut || event.repeat || signingOut) return;

      event.preventDefault();
      event.stopPropagation();
      signingOut = true;

      try {
        await supabase.auth.signOut({ scope: "local" });
      } finally {
        signingOut = false;
      }
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [authenticated]);

  return null;
}
