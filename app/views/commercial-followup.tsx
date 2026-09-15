"use client";

import { useState } from "react";
import { ViewOncallCenter } from "./view-oncall";
import "./commercial-followup.css";

const CLIENTS = ["View Imóveis", "Murano", "Wall Street", "Lopes", "Nexus"] as const;
type ClientName = typeof CLIENTS[number];

export function CommercialFollowupCenter({ token }: { token: string }) {
  const [client, setClient] = useState<ClientName>("View Imóveis");
  return <section className="cfc-shell">
    <header className="cfc-head">
      <div><span>OPERAÇÃO COMERCIAL</span><h1>Acompanhamento Comercial</h1><p>Acompanhamento por cliente, com cada operação isolada em sua própria subaba.</p></div>
    </header>
    <nav className="cfc-tabs" aria-label="Clientes do acompanhamento comercial">
      {CLIENTS.map(name => <button key={name} className={client===name?"active":""} onClick={()=>setClient(name)}>{name}</button>)}
    </nav>
    {client === "View Imóveis" ? <ViewOncallCenter token={token} /> : <CommercialClientPlaceholder name={client} />}
  </section>;
}

function CommercialClientPlaceholder({ name }: { name: Exclude<ClientName,"View Imóveis"> }) {
  return <section className="cfc-placeholder"><div><span>{name.toUpperCase()}</span><h2>Acompanhamento comercial</h2><p>Esta subaba fica reservada para o fluxo geral de acompanhamento dos corretores deste cliente. Ela é separada da rotina específica de plantões da View.</p></div></section>;
}
