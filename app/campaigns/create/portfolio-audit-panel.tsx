"use client";

import { useState } from "react";
type Row = Record<string, any>;
type Api = (payload: Row) => Promise<{ ok: boolean; status: number; body: Row | null }>;
type PortfolioResult = {
  client_id: string; client_name: string; lifecycle: string; gt: string | null;
  status: "META_ACCESS_CONFIRMED" | "NEEDS_ATTENTION";
  page_access: boolean; account_access: boolean; issues: string[];
};
const meanings: Record<string,string> = {
  MISSING_PAGE: "Sem Página Meta cadastrada",
  MISSING_AD_ACCOUNT: "Sem conta de anúncios cadastrada",
  AMBIGUOUS_AD_ACCOUNT: "Conta de anúncios ambígua",
  MISSING_GT: "Sem gestor de tráfego definido",
  ADS_MANAGEMENT_MISSING: "Credencial sem ads_management",
  PAGE_ACCESS_NOT_CONFIRMED: "Leads da Página não acessíveis",
  ACCOUNT_ACCESS_NOT_CONFIRMED: "Conta de anúncios não acessível",
  ACCOUNT_INACTIVE: "Conta de anúncios não está ativa",
  META_CREDENTIAL_MISSING: "Sem credencial Meta configurada",
};
export default function PortfolioAuditPanel({api}: {api: Api}) {
  const [running,setRunning] = useState(false);
  const [checked,setChecked] = useState<PortfolioResult[]>([]);
  const [total,setTotal] = useState<number|null>(null);
  const [lastRun,setLastRun] = useState("");
  const [error,setError] = useState("");

  const run = async () => {
    if (running) return;
    setRunning(true); setError(""); setChecked([]); setTotal(null);
    const all: PortfolioResult[] = [];
    try {
      let offset: number|null = 0;
      while (offset !== null) {
        const response = await api({action:"AUDIT_META_PORTFOLIO",offset});
        if (!response.ok || !response.body?.ok || !response.body.read_only ||
            !Array.isArray(response.body.results)) {
          throw new Error("Auditoria interrompida (HTTP " + response.status + "). Os clientes restantes não foram verificados.");
        }
        const page = response.body.results as PortfolioResult[];
        const count = Number(response.body.total);
        const next = response.body.next_offset;
        if (!Number.isSafeInteger(count) || count < 0 ||
            page.length > 5 || (next != null && (!Number.isSafeInteger(next) || next <= offset))) {
          throw new Error("Resposta inesperada da auditoria. Nenhum resultado incompleto será considerado aprovado.");
        }
        all.push(...page);
        setChecked([...all]); setTotal(count);
        offset = next === null ? null : Number(next);
        if (page.length === 0 && offset !== null) throw new Error("A auditoria parou antes de concluir a lista.");
      }
      setLastRun(new Date().toLocaleString("pt-BR"));
    } catch (e) {
      setError((e as Error).message || "Falha ao verificar as permissões Meta.");
    } finally {
      setRunning(false);
    }
  };

  const metaReady = checked.filter(r => r.status === "META_ACCESS_CONFIRMED");
  const needsAttention = checked.filter(r => r.status !== "META_ACCESS_CONFIRMED");
  const complete = total !== null && checked.length === total && !running && !error;
  return <section className="cb-card">
    <h3 style={{margin:"0 0 8px",fontSize:14}}>Auditoria Meta da carteira · Administrador</h3>
    <p className="cb-hint">Verifica os clientes ativos e em onboarding com chamadas de leitura na Meta: Página, formulário, conta de anúncios ativa e permissão ads_management. Não cria campanhas, não ativa anúncios e não expõe tokens.</p>
    <button type="button" className="cb-btn ghost" disabled={running} onClick={() => void run()}>
      {running ? "Verificando permissões…" : "Auditar todos os clientes na Meta"}
    </button>
    {total !== null && <div style={{marginTop:12}}>
      <p className="cb-hint" role="status">Verificados: <b>{checked.length} de {total}</b> · Acesso Meta confirmado: <b>{metaReady.length}</b> · Com pendências: <b>{needsAttention.length}</b>{complete ? " · auditoria concluída" : " · auditoria parcial"}</p>
      {complete && <p className="cb-hint">Última verificação: {lastRun}. Esta checagem é de acesso, não certifica aprovação futura de anúncios ou disponibilidade permanente da conta.</p>}
    </div>}
    {error && <div className="cb-error" role="alert" style={{marginTop:10}}>{error}</div>}
    {needsAttention.length>0 && <div style={{maxHeight:300,overflowY:"auto",marginTop:14}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,textAlign:"left"}}>
        <thead><tr><th style={{padding:8}}>Cliente</th><th style={{padding:8}}>GT</th><th style={{padding:8}}>Pendências</th></tr></thead>
        <tbody>{needsAttention.map(r=><tr key={r.client_id}>
          <td style={{padding:8,borderTop:"1px solid #29425b"}}>{r.client_name} <small>({r.lifecycle})</small></td>
          <td style={{padding:8,borderTop:"1px solid #29425b"}}>{r.gt || "Sem GT"}</td>
          <td style={{padding:8,borderTop:"1px solid #29425b"}}>{r.issues.map(x=>meanings[x]||x).join("; ") || "Permissões não confirmadas"}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {complete && needsAttention.length===0 && <p className="cb-hint" style={{marginTop:10}}>Todos os clientes consultados tiveram os acessos Meta de leitura e ads_management confirmados nesta verificação.</p>}
  </section>;
}
