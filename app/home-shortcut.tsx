"use client";

import { useEffect, useState } from "react";
import { supabase } from "./shared";

const LEONARDO_EMAIL = "lakassessoriadigital@gmail.com";

export default function HomeShortcut() {
  const [authenticated, setAuthenticated] = useState(false);
  const [email, setEmail] = useState("");

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setAuthenticated(Boolean(data.session));
      setEmail(String(data.session?.user?.email || "").toLowerCase());
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      setAuthenticated(Boolean(session));
      setEmail(String(session?.user?.email || "").toLowerCase());
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

      const target = email === LEONARDO_EMAIL ? "/commercial-direction" : "/";
      if (window.location.pathname !== target) window.location.assign(target);
    }

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [authenticated, email]);

  return null;
}
