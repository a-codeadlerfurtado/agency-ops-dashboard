"use client";

import { useEffect, useState } from "react";
import { loadProfileLite } from "./shared";

export default function BriefingHubDemoLink() {
  const [allowed, setAllowed] = useState(false);

  useEffect(() => {
    let active = true;
    loadProfileLite().then((profile: any) => {
      if (!active) return;
      const role = String(profile?.role || "").toUpperCase();
      const person = String(profile?.person || "");
      setAllowed(role === "CS" || role === "COMMERCIAL" || role === "MGMT" || person === "Adler Furtado");
    }).catch(() => setAllowed(false));
    return () => { active = false; };
  }, []);

  if (!allowed) return null;

  return <a
    href="/briefing-hub-demo"
    target="_blank"
    rel="noopener noreferrer"
    style={{
      display:"inline-flex",alignItems:"center",gap:8,padding:"9px 12px",borderRadius:10,
      border:"1px solid rgba(96,165,250,.22)",background:"rgba(59,130,246,.08)",
      color:"#dbeafe",textDecoration:"none",fontSize:12,fontWeight:700
    }}
  >
    <span aria-hidden>▣</span>
    Apresentar Briefing Hub
  </a>;
}
