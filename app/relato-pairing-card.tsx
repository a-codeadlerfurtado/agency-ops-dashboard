"use client";

import { useState } from "react";
import { authenticatedFetch, SUPABASE_URL } from "./shared";

type PairingResult = { code?: string; expires_at?: string; owner_person?: string; error?: string };

export function RelatoPairingCard() {
  const [pairing,setPairing]=useState<PairingResult|null>(null);
  const [busy,setBusy]=useState(false);
  const [copied,setCopied]=useState(false);
  const [error,setError]=useState("");

  async function createPairing(){
    setBusy(true); setError(""); setCopied(false);
    try{
      const response=await authenticatedFetch(SUPABASE_URL+"/functions/v1/agency-ops-meeting-capture-api",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({action:"pair_create"})
      });
      const json=await response.json().catch(()=>({})) as PairingResult;
      if(!response.ok||!json.code) throw new Error(json.error||"Não foi possível gerar o código.");
      setPairing(json);
    }catch(err){setError(err instanceof Error?err.message:"Não foi possível gerar o código.");}
    finally{setBusy(false);}
  }

  async function copyCode(){
    if(!pairing?.code)return;
    await navigator.clipboard.writeText(pairing.code);
    setCopied(true); window.setTimeout(()=>setCopied(false),1600);
  }

  const minutes=pairing?.expires_at?Math.max(0,Math.ceil((new Date(pairing.expires_at).getTime()-Date.now())/60000)):0;
  return <section className="relato-pair-card">
    <style>{`
      .relato-pair-card{margin:0 0 18px;padding:18px 20px;border:1px solid rgba(127,148,255,.2);border-radius:18px;background:linear-gradient(145deg,rgba(20,28,48,.92),rgba(9,15,27,.94));box-shadow:0 14px 36px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap}
      .relato-pair-copy{min-width:220px;flex:1}.relato-pair-copy span{display:block;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#8fa5ff;font-weight:800;margin-bottom:6px}.relato-pair-copy h3{margin:0;color:#f4f7ff;font-size:17px}.relato-pair-copy p{margin:6px 0 0;color:#94a2b8;font-size:12px;line-height:1.5}
      .relato-pair-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.relato-pair-code{min-width:150px;padding:10px 14px;border-radius:12px;border:1px solid rgba(131,151,255,.28);background:rgba(5,10,18,.72);text-align:center}.relato-pair-code b{display:block;font:800 24px/1.1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;color:#fff}.relato-pair-code small{display:block;margin-top:5px;color:#7f8da3;font-size:10px}
      .relato-pair-card button{border:0;border-radius:11px;padding:10px 14px;font-weight:800;cursor:pointer;background:#eef2ff;color:#11182a}.relato-pair-card button.secondary{background:rgba(255,255,255,.07);color:#dfe6f7;border:1px solid rgba(255,255,255,.1)}.relato-pair-card button:disabled{opacity:.55;cursor:wait}.relato-pair-error{color:#ff9a9a;font-size:11px;margin-top:7px}
    `}</style>
    <div className="relato-pair-copy"><span>RELATO AI · DISPOSITIVO</span><h3>Vincular o Relato Desktop</h3><p>Gere um código e informe no programa do Relato neste computador. Ele expira em 15 minutos.</p>{error&&<div className="relato-pair-error">{error}</div>}</div>
    <div className="relato-pair-actions">{pairing?.code&&<div className="relato-pair-code"><b>{pairing.code}</b><small>{pairing.owner_person||"Perfil"} · {minutes>0?minutes+" min restantes":"expirado"}</small></div>}{pairing?.code&&<button className="secondary" type="button" onClick={copyCode}>{copied?"Copiado":"Copiar código"}</button>}<button type="button" onClick={createPairing} disabled={busy}>{busy?"Gerando...":pairing?.code?"Gerar novo código":"Gerar código"}</button></div>
  </section>;
}
