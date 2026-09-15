"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, apiPost, formatDate, supabase, text } from "./shared";

type Row = Record<string, any>;

function isLeadQuality(item: Row | null | undefined) {
  if (!item) return false;
  return String(item.type || "").toUpperCase() === "LEAD_DISPATCH_INCOMPLETE"
    || Boolean(item.metadata?.incident_id)
    || /lead incompleto/i.test(String(item.title || ""));
}

export default function NotificationLeadClickOverride() {
  const [session, setSession] = useState<Session | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) setSelected(null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const openDetail = useCallback(async (title: string, visibleText: string) => {
    if (!session?.access_token) return;
    setLoading(true);
    setCopied(false);
    setSelected({ title, description: visibleText, metadata: {} });
    try {
      const home = await api("home", session.access_token);
      const rows: Row[] = Array.isArray(home?.notifications) ? home.notifications : [];
      const exact = rows.find((row) => isLeadQuality(row) && String(row.title || "").trim() === title.trim());
      const fallback = rows.find((row) => isLeadQuality(row));
      const item = exact || fallback;
      if (item) {
        setSelected(item);
        if (!item.read_at) {
          try { await apiPost("notifications-read", session.access_token, { id: item.id }); } catch {}
        }
      } else {
        setSelected({ title, description: "Não foi possível carregar os detalhes desta ocorrência agora.", metadata: {} });
      }
    } catch {
      setSelected({ title, description: "Não foi possível carregar os detalhes desta ocorrência agora.", metadata: {} });
    } finally {
      setLoading(false);
    }
  }, [session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;

    const handler = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const card = target?.closest?.(".notification-panel .notification-list > button, button.toast") as HTMLButtonElement | null;
      if (!card) return;

      const title = card.querySelector("b")?.textContent?.trim() || "";
      if (!/lead incompleto/i.test(title)) return;

      // Captura no WINDOW, antes do listener React do dashboard. Assim o clique
      // nunca chega ao openClient() original dessas notificacoes.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const visibleText = card.textContent?.trim() || "";
      void openDetail(title, visibleText);
    };

    window.addEventListener("click", handler, true);
    return () => window.removeEventListener("click", handler, true);
  }, [openDetail, session?.access_token]);

  if (!selected) return null;

  const metadata = selected.metadata || {};
  const required = Array.isArray(metadata.missing_required) ? metadata.missing_required : [];
  const extras = Array.isArray(metadata.missing_extra_questions) ? metadata.missing_extra_questions : [];
  const rawText = String(metadata.raw_text || "").trim();
  const occurrence = Number(metadata.occurrence_no || 0);
  const severity = String(selected.level || (occurrence >= 2 ? "CRITICAL" : "ATTENTION")).toUpperCase();
  const client = text(selected.client_name || String(selected.description || "").split(" · ")[0] || "Não identificado");
  const product = text(metadata.product_label || "Não identificado");
  const routing = text(metadata.routing_status || "Não informado");

  async function copyRaw() {
    if (!rawText) return;
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  }

  return (
    <div className="nlco-backdrop" role="dialog" aria-modal="true" aria-label="Detalhes do erro do lead" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <style>{styles}</style>
      <section className="nlco-card">
        <header className="nlco-head">
          <div>
            <span className={`nlco-severity ${severity === "CRITICAL" ? "critical" : "attention"}`}>{severity === "CRITICAL" ? "CRÍTICO" : "ATENÇÃO"}{occurrence ? ` · ${occurrence}ª ocorrência` : ""}</span>
            <h2>{text(selected.title || "Lead incompleto")}</h2>
            <p>{text(selected.description || "Veja exatamente como a mensagem chegou e qual dado falhou.")}</p>
          </div>
          <button onClick={() => setSelected(null)} aria-label="Fechar">×</button>
        </header>

        {loading ? <div className="nlco-loading">Carregando ocorrência original…</div> : <>
          <div className="nlco-meta">
            <div><small>Cliente</small><b>{client}</b></div>
            <div><small>Produto</small><b>{product}</b></div>
            <div><small>Detectado</small><b>{selected.occurred_at ? formatDate(selected.occurred_at) : "—"}</b></div>
            <div><small>Roteamento</small><b>{routing}</b></div>
          </div>

          <section className="nlco-error">
            <span>DIAGNÓSTICO</span><h3>O que chegou errado</h3>
            <div className="nlco-chips">
              {required.map((field: string) => <i key={field}>{field}: ausente ou inválido</i>)}
              {extras.map((extra: Row, index: number) => <i key={`${extra.question || "pergunta"}-${index}`}>Sem resposta: {text(extra.question || `pergunta adicional ${index + 1}`)}</i>)}
              {!required.length && !extras.length && <i className="neutral">Detalhamento não disponível.</i>}
            </div>
          </section>

          <section className="nlco-message">
            <div className="nlco-message-head"><div><span>MENSAGEM ORIGINAL</span><h3>Exatamente como chegou pela Z-API</h3></div><button onClick={copyRaw} disabled={!rawText}>{copied ? "✓ Copiado" : "Copiar mensagem"}</button></div>
            <pre>{rawText || "[Conteúdo bruto não disponível nesta ocorrência.]"}</pre>
          </section>

          <details className="nlco-tech"><summary>Ver dados técnicos</summary><div>
            <span><small>Message ID</small><code>{text(metadata.message_id || "—")}</code></span>
            <span><small>Incident ID</small><code>{text(metadata.incident_id || "—")}</code></span>
            <span><small>Origem</small><code>{text(selected.source || "zapi_direct_official")}</code></span>
            <span><small>Tipo</small><code>{text(selected.type || "LEAD_DISPATCH_INCOMPLETE")}</code></span>
          </div></details>
        </>}
      </section>
    </div>
  );
}

const styles = `
.nlco-backdrop{position:fixed;inset:0;z-index:2147483647;background:rgba(2,7,13,.82);backdrop-filter:blur(10px);display:grid;place-items:center;padding:18px;font-family:Inter,system-ui,sans-serif;color:#eaf2fb}.nlco-card{width:min(980px,100%);max-height:calc(100dvh - 36px);overflow:auto;background:#07111c;border:1px solid #254056;border-radius:18px;box-shadow:0 35px 110px rgba(0,0,0,.65);padding:20px}.nlco-head{display:flex;justify-content:space-between;gap:18px;border-bottom:1px solid #1a3042;padding-bottom:15px}.nlco-head h2{font:800 clamp(24px,4vw,38px)/1.04 'Inter Tight',Inter,sans-serif;margin:7px 0 8px}.nlco-head p{margin:0;color:#9aafc1;line-height:1.45}.nlco-head>button{border:1px solid #2a4356;background:#0b1b28;color:#bcd0df;width:36px;height:36px;border-radius:10px;font-size:23px;cursor:pointer}.nlco-severity{display:inline-flex;border-radius:999px;padding:5px 9px;font-size:9px;font-weight:900;letter-spacing:.1em}.nlco-severity.critical{background:#35151e;color:#ff8e9b;border:1px solid #71303d}.nlco-severity.attention{background:#342916;color:#f2ca75;border:1px solid #66512b}.nlco-meta{display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin:14px 0}.nlco-meta div{background:#0a1926;border:1px solid #18364a;border-radius:11px;padding:10px}.nlco-meta small,.nlco-meta b{display:block}.nlco-meta small{font-size:8px;color:#718ca2;text-transform:uppercase}.nlco-meta b{font-size:11px;margin-top:4px;overflow:hidden;text-overflow:ellipsis}.nlco-error,.nlco-message{border:1px solid #1c384c;background:#081621;border-radius:13px;padding:12px;margin-top:10px}.nlco-error{border-color:#63313c;background:linear-gradient(135deg,rgba(80,22,35,.28),#081621 58%)}.nlco-error>span,.nlco-message-head span{font-size:8px;font-weight:900;letter-spacing:.12em;color:#7895ad}.nlco-error h3,.nlco-message h3{font-size:13px;margin:3px 0 0}.nlco-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.nlco-chips i{font-style:normal;border:1px solid #864250;background:#38141c;color:#ffd6dc;border-radius:999px;padding:6px 9px;font-size:10px;font-weight:800}.nlco-chips i.neutral{border-color:#385064;background:#101e2a;color:#9eb4c6}.nlco-message-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.nlco-message-head button{border:1px solid #31536d;background:#0b2131;color:#bfe6ff;border-radius:8px;padding:7px 10px;font-size:10px;font-weight:800;cursor:pointer}.nlco-message pre{margin:11px 0 0;max-height:42vh;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#03080d;border:1px solid #172b3b;border-radius:10px;padding:13px;color:#d7e3ec;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.nlco-tech{margin-top:10px;border:1px solid #1a3447;border-radius:11px;background:#081520;overflow:hidden}.nlco-tech summary{padding:10px 12px;cursor:pointer;color:#8fa9bd;font-size:10px;font-weight:800}.nlco-tech>div{border-top:1px solid #1a3447;padding:10px 12px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.nlco-tech small,.nlco-tech code{display:block}.nlco-tech small{font-size:8px;color:#66849b;text-transform:uppercase}.nlco-tech code{margin-top:3px;color:#c7d8e5;font-size:9px;overflow-wrap:anywhere}.nlco-loading{padding:48px;text-align:center;color:#8fa8ba}@media(max-width:760px){.nlco-backdrop{padding:7px;place-items:start center;overflow:auto}.nlco-card{max-height:none;min-height:calc(100dvh - 14px);padding:14px}.nlco-meta{grid-template-columns:1fr 1fr}.nlco-tech>div{grid-template-columns:1fr}.nlco-message pre{max-height:none}}
`;
