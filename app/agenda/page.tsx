"use client";

import { useEffect } from "react";

export default function AgendaRetiredPage() {
  useEffect(() => {
    const embedded = new URLSearchParams(window.location.search).get("embedded") === "1";
    window.location.replace(embedded ? "/commercial-direction?embedded=1" : "/");
  }, []);

  return null;
}
