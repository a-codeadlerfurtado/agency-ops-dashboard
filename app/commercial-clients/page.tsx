"use client";

import { useEffect } from "react";

export default function CommercialClientsPage() {
  useEffect(() => { window.location.replace("/commercial-home?tab=portfolio"); }, []);
  return <main className="auth-loading">Abrindo carteira comercial…</main>;
}
