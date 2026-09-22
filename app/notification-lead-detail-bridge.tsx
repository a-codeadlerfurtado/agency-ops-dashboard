"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, apiPost, formatDate, supabase, text } from "./shared";

type Row = Record<string, any>;

type SelectedDetail = {
  item: Row;
  loading?: boolean;
};

function isLeadQualityNotification(item: Row | null | undefined) {
  if (!item) return false;
  return String(item.type || "").toUpperCase() === "LEAD_DISPATCH_INCOMPLETE"
    || Boolean(item.metadata?.incident_id)
    || /lead incompleto/i.test(String(item.title || ""));
}

function normTxt(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("pt-BR");
}

function isBriefingNotification(item: Row | null | undefined) {
  if (!item) return false;
  return String(item.source || "").toLocaleLowerCase("pt-BR") === "briefing_hub"
    || String(item.type || "").toUpperCase().startsWith("BRIEFING_");
}

function findBrief(rows: Row[], button: HTMLButtonElement) {
  const title = normTxt(button.querySelector("b")?.textContent || "");
  const visible = normTxt(button.textContent || "");
  const exact = rows.filter((item) => {
    if (!isBriefingNotification(item) || normTxt(item.title) !== title) return false;
    const description = normTxt(item.description);
    return !description || visible.includes(description);
  });

  if (exact.length === 1) return exact[0];

  const byTitle = rows.filter((item) => isBriefingNotification(item) && normTxt(item.title) === title);
  return byTitle.length === 1 ? byTitle[0] : null;
}

function exactNotificationForButton(rows: Row[], button: HTMLButtonElement) {
  const title = normTxt(button.querySelector("b")?.textContent || "");
  const visible = normTxt(button.textContent || "");
  const candidates = rows.filter((item) => {
    if (!isLeadQualityNotification(item)) return false;
    if (normTxt(item.title) !== title) return false;
    const description = normTxt(item.description);
    return Boolean(description) && visible.includes(description);
  });

  if (candidates.length === 1) return candidates[0];

  // Em recorrências o título traz o número da ocorrência. Se, por alguma razão,
  // a descrição renderizada mudou apenas na parte do ator/data, usamos também
  // cliente + produto + ocorrência para chegar a uma única notificação.
  const byIdentity = rows.filter((item) => {
    if (!isLeadQualityNotification(item) || normTxt(item.title) !== title) return false;
    const description = normTxt(item.description);
    const product = normTxt(item.metadata?.product_label);
    const occurrence = Number(item.metadata?.occurrence_no || 0);
    const occurrenceText = occurrence ? `${occurrence}` : "";
    const descriptionMatches = description ? visible.includes(description) : false;
    const productMatches = product ? visible.includes(product) : false;
    const occurrenceMatches = occurrenceText ? visible.includes(occurrenceText) : true;
    return descriptionMatches || (productMatches && occurrenceMatches);
  });

  return byIdentity.length === 1 ? byIdentity[0] : null;
}

export default function NotificationLeadDetailBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [notifications, setNotifications] = useState<Row[]>([]);
  const [selected, setSelected] = useState<SelectedDetail | null>(null);
  const [copied, setCopied] = useState(false);
  const loadingRef = useRef(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setNotifications([]);
        setSelected(null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadNotifications = useCallback(async () => {
    if (!session?.access_token || loadingRef.current) return notifications;
    loadingRef.current = true;
    try {
      const home = await api("home", session.access_token);
      const next = Array.isArray(home?.notifications) ? home.notifications : [];
      setNotifications(next);
      return next;
    } catch {
      return notifications;
    } finally {
      loadingRef.current = false;
    }
  }, [notifications, session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    let panelWasOpen = false;
    let timer = 0;
    const inspect = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const open = Boolean(document.querySelector(".notification-panel .notification-list"));
        if (open && !panelWasOpen) loadNotifications();
        panelWasOpen = open;
      }, 30);
    };
    inspect();
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [loadNotifications, session?.access_token]);

  useEffect(() => {
    if (!session?.access_token) return;
    const accessToken = session.access_token;

    async function handleClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      const notificationButton = target?.closest?.(".notification-panel .notification-list > button") as HTMLButtonElement | null;
      if (!notificationButton) return;

      const title = notificationButton.querySelector("b")?.textContent?.trim() || "";

      let briefing = findBrief(notifications, notificationButton);
      if (!briefing) {
        const fresh = await loadNotifications();
        briefing = findBrief(fresh, notificationButton);
      }

      if (briefing) {
        const deepLink = String(briefing.metadata?.dashboard_path || briefing.metadata?.deep_link || "").trim();
        if (deepLink) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          try {
            if (!briefing.read_at) await apiPost("notifications-read", accessToken, { id: briefing.id });
          } catch {
            // A navegação não depende da marcação como lida.
          }
          const destination = /^https?:\/\//i.test(deepLink)
            ? deepLink
            : `https://agency-briefing-hub.lakassessoriadigital.workers.dev${deepLink.startsWith("/") ? "" : "/"}${deepLink}`;
          const separator = destination.includes("#") ? "&" : "#";
          window.location.assign(`${destination}${separator}access_token=${encodeURIComponent(accessToken)}`);
          return;
        }
      }

      if (!/lead incompleto/i.test(title)) return;

      // Impede SEMPRE o clique original do NotificationCenter para este tipo de alerta.
      // Assim ele nunca cai no fallback genérico que abre a ficha de algum cliente.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      setSelected({ item: { title, metadata: {} }, loading: true });
      setCopied(false);

      let item = exactNotificationForButton(notifications, notificationButton);
      if (!item) {
        const fresh = await loadNotifications();
        item = exactNotificationForButton(fresh, notificationButton);
      }

      if (!item) {
        setSelected({
          item: {
            title: title || "Lead incompleto",
            description: "Não consegui vincular esta linha a uma ocorrência única com segurança. Nenhum cliente foi aberto para evitar mostrar o registro errado. Atualize a Central de Notificações e tente novamente.",
            metadata: {},
          },
        });
        return;
      }

      setSelected({ item });
      try {
        if (!item.read_at) await apiPost("notifications-read", accessToken, { id: item.id });
      } catch {
        // A visualização do detalhe não depende da marcação como lida.
      }
    }

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [loadNotifications, notifications, session?.access_token]);

  if (!selected) return null;

  const item = selected.item || {};
  const metadata = item.metadata || {};
  const required = Array.isArray(metadata.missing_required) ? metadata.missing_required : [];
  const extras = Array.isArray(metadata.missing_extra_questions) ? metadata.missing_extra_questions : [];
  const rawText = String(metadata.raw_text || "").trim();
  const occurrence = Number(metadata.occurrence_no || 0);
  const severity = String(item.level || (occurrence >= 2 ? "CRITICAL" : "ATTENTION")).toUpperCase();
  const incidentId = text(metadata.incident_id || "—");
  const messageId = text(metadata.message_id || "—");
  const product = text(metadata.product_label || "Não identificado");
  const routing = text(metadata.routing_status || "Não informado");

  async function copyRaw() {
    if (!rawText) return;
    try {
      await navigator.clipboard.writeText(rawText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {}
  }

  return (
    <div className="nld-backdrop" role="dialog" aria-modal="true" aria-label="Detalhes do erro do lead" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}>
      <style>{styles}</style>
      <section className="nld-card">
        <header className="nld-head">
          <div>
            <span className={`nld-severity ${severity === "CRITICAL" ? "critical" : "attention"}`}>{severity === "CRITICAL" ? "CRÍTICO" : "ATENÇÃO"}{occurrence ? ` · ${occurrence}ª ocorrência` : ""}</span>
            <h2>{text(item.title || "Lead incompleto")}</h2>
            <p>{text(item.description || "Veja abaixo exatamente como a mensagem chegou e o que o sistema identificou como incompleto.")}</p>
          </div>
          <button className="nld-close" onClick={() => setSelected(null)} aria-label="Fechar">×</button>
        </header>

        {selected.loading ? <div className="nld-loading">Carregando conteúdo exato da ocorrência…</div> : <>
          <div className="nld-meta">
            <div><small>Cliente</small><b>{text(item.client_name || item.description?.split(" · ")?.[0] || "Não identificado")}</b></div>
            <div><small>Produto</small><b>{product}</b></div>
            <div><small>Detectado</small><b>{item.occurred_at ? formatDate(item.occurred_at) : "—"}</b></div>
            <div><small>Roteamento</small><b>{routing}</b></div>
          </div>

          <section className="nld-error">
            <div className="nld-section-head"><div><span>DIAGNÓSTICO</span><h3>O que o sistema encontrou de errado</h3></div></div>
            <div className="nld-chips">
              {required.map((field: string) => <span key={field}>{field}: ausente ou inválido</span>)}
              {extras.map((extra: Row, index: number) => <span key={`${extra.question || "pergunta"}-${index}`}>Sem resposta: {text(extra.question || `pergunta adicional ${index + 1}`)}</span>)}
              {!required.length && !extras.length && <span className="neutral">Detalhamento dos campos não disponível nesta notificação.</span>}
            </div>
          </section>

          <section className="nld-message">
            <div className="nld-section-head">
              <div><span>MENSAGEM ORIGINAL</span><h3>Exatamente como chegou pela Z-API</h3></div>
              <button onClick={copyRaw} disabled={!rawText}>{copied ? "✓ Copiado" : "Copiar mensagem"}</button>
            </div>
            <pre>{rawText || "[O conteúdo bruto desta mensagem não está disponível nesta ocorrência.]"}</pre>
          </section>

          <details className="nld-tech">
            <summary>Ver dados técnicos da ocorrência</summary>
            <div>
              <span><small>Message ID</small><code>{messageId}</code></span>
              <span><small>Incident ID</small><code>{incidentId}</code></span>
              <span><small>Origem</small><code>{text(item.source || "zapi_direct_official")}</code></span>
              <span><small>Tipo</small><code>{text(item.type || "LEAD_DISPATCH_INCOMPLETE")}</code></span>
            </div>
          </details>
        </>}
      </section>
    </div>
  );
}

const styles = `
.nld-backdrop{position:fixed;inset:0;z-index:2147483646;background:rgba(2,7,13,.78);backdrop-filter:blur(9px);display:grid;place-items:center;padding:18px;font-family:Inter,system-ui,sans-serif;color:#eaf2fb}.nld-card{width:min(980px,100%);max-height:calc(100dvh - 36px);overflow:auto;background:#07111c;border:1px solid #254056;border-radius:18px;box-shadow:0 35px 110px rgba(0,0,0,.62);padding:20px}.nld-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;border-bottom:1px solid #1a3042;padding-bottom:15px}.nld-head h2{font:800 clamp(24px,4vw,38px)/1.04 'Inter Tight',Inter,sans-serif;letter-spacing:-.03em;margin:7px 0 8px}.nld-head p{margin:0;color:#9aafc1;line-height:1.45;max-width:780px}.nld-severity{display:inline-flex;border-radius:999px;padding:5px 9px;font-size:9px;font-weight:900;letter-spacing:.1em}.nld-severity.critical{background:#35151e;color:#ff8e9b;border:1px solid #71303d}.nld-severity.attention{background:#342916;color:#f2ca75;border:1px solid #66512b}.nld-close{border:1px solid #2a4356;background:#0b1b28;color:#bcd0df;width:36px;height:36px;border-radius:10px;font-size:23px;cursor:pointer}.nld-meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:14px 0}.nld-meta div{background:#0a1926;border:1px solid #18364a;border-radius:11px;padding:10px;min-width:0}.nld-meta small,.nld-meta b{display:block}.nld-meta small{font-size:8px;text-transform:uppercase;letter-spacing:.09em;color:#718ca2}.nld-meta b{margin-top:4px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nld-error,.nld-message{border:1px solid #1c384c;background:#081621;border-radius:13px;padding:12px;margin-top:10px}.nld-error{border-color:#63313c;background:linear-gradient(135deg,rgba(80,22,35,.28),#081621 58%)}.nld-section-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.nld-section-head span{font-size:8px;font-weight:900;letter-spacing:.12em;color:#7895ad}.nld-section-head h3{font-size:13px;margin:3px 0 0}.nld-section-head button{border:1px solid #31536d;background:#0b2131;color:#bfe6ff;border-radius:8px;padding:7px 10px;font-size:10px;font-weight:800;cursor:pointer}.nld-section-head button:disabled{opacity:.45;cursor:not-allowed}.nld-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px}.nld-chips span{border:1px solid #864250;background:#38141c;color:#ffd6dc;border-radius:999px;padding:6px 9px;font-size:10px;font-weight:800}.nld-chips span.neutral{border-color:#385064;background:#101e2a;color:#9eb4c6}.nld-message pre{margin:11px 0 0;max-height:42vh;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#03080d;border:1px solid #172b3b;border-radius:10px;padding:13px;color:#d7e3ec;font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.nld-tech{margin-top:10px;border:1px solid #1a3447;border-radius:11px;background:#081520;overflow:hidden}.nld-tech summary{padding:10px 12px;cursor:pointer;color:#8fa9bd;font-size:10px;font-weight:800}.nld-tech>div{border-top:1px solid #1a3447;padding:10px 12px;display:grid;grid-template-columns:1fr 1fr;gap:8px}.nld-tech span{min-width:0}.nld-tech small,.nld-tech code{display:block}.nld-tech small{font-size:8px;color:#66849b;text-transform:uppercase}.nld-tech code{margin-top:3px;color:#c7d8e5;font-size:9px;overflow-wrap:anywhere}.nld-loading{padding:46px 12px;text-align:center;color:#8fa8ba}@media(max-width:760px){.nld-backdrop{padding:7px;place-items:start center;overflow:auto}.nld-card{max-height:none;min-height:calc(100dvh - 14px);padding:14px;border-radius:14px}.nld-meta{grid-template-columns:1fr 1fr}.nld-head h2{font-size:27px}.nld-tech>div{grid-template-columns:1fr}.nld-message pre{max-height:none}}
`;
