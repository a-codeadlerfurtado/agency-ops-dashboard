"use client";

import { useEffect, useMemo, useState } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, api, formatDate, supabase, text } from "./shared";

type Row = Record<string, any>;
const NOTIFICATIONS_API = `${SUPABASE_URL}/functions/v1/agency-ops-notifications-home`;

const norm = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const person = (value: unknown) => String(value || "").trim() || "Não identificado";
const array = (value: unknown): Row[] => Array.isArray(value) ? value : [];

function clickupTaskName(item: Row | null) {
  if (!item) return "Tarefa concluída";
  const metadataName = String(item?.metadata?.task_name || "").trim();
  if (metadataName) return metadataName;
  const description = String(item?.description || "").trim();
  return description.split(" · Responsável pela task:")[0]?.trim() || "Tarefa concluída";
}

function notificationMatchesButton(item: Row, visibleText: string) {
  const taskName = norm(clickupTaskName(item));
  const description = norm(item?.description || "");
  const clientName = norm(item?.client_name || "");
  if (taskName && visibleText.includes(taskName)) return true;
  if (description && visibleText.includes(description.slice(0, Math.min(90, description.length)))) return true;
  if (taskName && clientName && visibleText.includes(taskName) && visibleText.includes(clientName)) return true;
  return false;
}

function statusLabel(value: unknown) {
  if (!value || typeof value !== "object") return "—";
  return String((value as Row).status || (value as Row).type || "—");
}

export default function CompletedWorkItemDetailBridge() {
  const [item, setItem] = useState<Row | null>(null);
  const [clickupNotification, setClickupNotification] = useState<Row | null>(null);
  const [loadingTitle, setLoadingTitle] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const onClick = async (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.("[data-notification-resolve]")) return;
      const button = target?.closest?.(".notification-panel .notification-list > button") as HTMLButtonElement | null;
      if (!button) return;

      const title = button.querySelector("b")?.textContent?.trim() || "";
      const isWorkCompletion = /^demanda conclu[ií]da\s*:/i.test(title);
      const isClickupCompletion = /^tarefa conclu[ií]da\s*$/i.test(title);
      if (!isWorkCompletion && !isClickupCompletion) return;

      event.preventDefault();
      event.stopPropagation();
      (event as any).stopImmediatePropagation?.();
      setItem(null); setClickupNotification(null); setError("");

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error("Sessão indisponível");

        if (isClickupCompletion) {
          const visibleText = norm(button.textContent || "");
          setLoadingTitle("tarefa do ClickUp");
          const response = await fetch(NOTIFICATIONS_API, {
            headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
            cache: "no-store",
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload?.ok) throw new Error(payload?.error || "Não consegui carregar os detalhes da tarefa.");
          if (disposed) return;
          const candidates: Row[] = (Array.isArray(payload?.items) ? payload.items : [])
            .filter((row: Row) => row.kind === "NOTIFICATION" && String(row.type || "").toUpperCase() === "TASK_COMPLETED")
            .sort((a: Row, b: Row) => new Date(String(b.occurred_at || 0)).getTime() - new Date(String(a.occurred_at || 0)).getTime());
          const found = candidates.find((row) => notificationMatchesButton(row, visibleText));
          if (!found) throw new Error("Não encontrei esta tarefa concluída na Central de Notificações.");
          setClickupNotification(found);
          return;
        }

        const taskName = title.replace(/^demanda conclu[ií]da\s*:\s*/i, "").trim();
        if (!taskName) throw new Error("Não consegui identificar a demanda concluída.");
        const visibleText = norm(button.textContent || "");
        setLoadingTitle(taskName);
        const payload = await api("work", session.access_token);
        if (disposed) return;
        const rows: Row[] = Array.isArray(payload?.items) ? payload.items : [];
        const candidates = rows.filter((row) => norm(row.title) === norm(taskName) && String(row.status || "").toUpperCase() === "COMPLETED")
          .sort((a, b) => {
            const ar = norm(a.resolution), br = norm(b.resolution);
            const av = ar && visibleText.includes(ar.slice(0, Math.min(48, ar.length))) ? 1 : 0;
            const bv = br && visibleText.includes(br.slice(0, Math.min(48, br.length))) ? 1 : 0;
            if (av !== bv) return bv - av;
            return new Date(String(b.completed_at || b.updated_at || 0)).getTime() - new Date(String(a.completed_at || a.updated_at || 0)).getTime();
          });
        if (!candidates[0]) throw new Error("Não encontrei os detalhes desta demanda na Central de Trabalho.");
        setItem(candidates[0]);
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : "Não consegui carregar os detalhes desta tarefa.");
      } finally { if (!disposed) setLoadingTitle(""); }
    };
    document.addEventListener("click", onClick, true);
    return () => { disposed = true; document.removeEventListener("click", onClick, true); };
  }, []);

  useEffect(() => {
    if (!item && !clickupNotification && !error && !loadingTitle) return;
    const previous = document.body.style.overflow;
    if (item || clickupNotification || error) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [item, clickupNotification, error, loadingTitle]);

  const client = item?.clients || {};
  const routedTo = useMemo(() => person(item?.target_person || item?.target_role), [item]);
  const meta = clickupNotification?.metadata || {};
  const completedBy = person(meta.completed_by || clickupNotification?.actor);
  const assignees = person(meta.assignee_names);
  const attachments = array(meta.attachments);
  const watchers = array(meta.watchers);
  const statusBefore = statusLabel(meta.status_before);
  const statusAfter = statusLabel(meta.status_after);

  const close = () => { setItem(null); setClickupNotification(null); setError(""); setLoadingTitle(""); };
  if (loadingTitle && !item && !clickupNotification && !error) return <div className="cw-detail-loading" role="status"><style>{styles}</style><span /> Carregando detalhes de <b>{loadingTitle}</b>…</div>;
  if (!item && !clickupNotification && !error) return null;

  const isClickup = Boolean(clickupNotification);
  const modalTitle = isClickup ? clickupTaskName(clickupNotification) : item ? text(item.title) : "Não foi possível abrir a tarefa";

  return <div className="cw-detail-shield" role="dialog" aria-modal="true" aria-labelledby="cw-detail-title">
    <style>{styles}</style>
    <section className="cw-detail-card">
      <header><div><span className="eyebrow">{isClickup ? "Tarefa concluída · ClickUp" : "Demanda concluída · detalhes"}</span><h2 id="cw-detail-title">{modalTitle}</h2></div><button type="button" className="cw-close" onClick={close}>×</button></header>

      {error ? <div className="cw-error">{error}</div> : isClickup ? <>
        <div className="cw-people">
          <div><small>CRIADA POR</small><b>{person(meta.creator_name)}</b></div>
          <div><small>RESPONSÁVEL</small><b>{assignees}</b></div>
          <div className="done"><small>FINALIZADA POR</small><b>{completedBy}</b></div>
          <div><small>STATUS</small><b>{text(meta.status || "Concluída")}</b></div>
        </div>

        <section className="cw-block original"><small>PEDIDO ORIGINAL DA TAREFA</small><p>{text(meta.task_description || "Sem descrição registrada no ClickUp.")}</p></section>

        <section className="cw-block resolution">
          <small>AÇÃO QUE FECHOU A ETAPA</small>
          <p><b>{completedBy}</b> alterou o status de <b>{statusBefore}</b> para <b>{statusAfter}</b>{clickupNotification?.occurred_at ? ` em ${formatDate(clickupNotification.occurred_at)}` : ""}.</p>
          <div className="cw-author">Fonte: evento de histórico do próprio ClickUp · {text(meta.completion_actor_source || "sem fonte identificada")}</div>
        </section>

        <section className="cw-block history"><small>O QUE QUEM FINALIZOU ESCREVEU</small><p>{text(meta.completion_note || "Não existe texto/comentário de conclusão anexado a esse evento no ClickUp. O dado comprovável é a mudança de status acima.")}</p></section>

        {attachments.length > 0 && <section className="cw-block"><small>ANEXOS DA TAREFA ({attachments.length})</small><div className="cw-links">{attachments.map((a, i) => <a key={String(a.id || i)} href={String(a.url_w_query || a.url || "#")} target="_blank" rel="noreferrer">{text(a.title || a.name || `Anexo ${i + 1}`)} ↗</a>)}</div></section>}

        <div className="cw-meta">
          <span><small>CLIENTE</small><b>{text(clickupNotification?.client_name || "Não vinculado")}</b></span>
          <span><small>ID DA TAREFA</small><b>{text(clickupNotification?.task_id || "—")}</b></span>
          <span><small>LISTA</small><b>{text(meta.list || "—")}</b></span>
          <span><small>PASTA</small><b>{text(meta.folder || "—")}</b></span>
          <span><small>CRIADA EM</small><b>{meta.date_created ? formatDate(meta.date_created) : "—"}</b></span>
          <span><small>PRAZO</small><b>{meta.due_date ? formatDate(meta.due_date) : "Sem prazo"}</b></span>
          <span><small>CONCLUÍDA EM</small><b>{clickupNotification?.occurred_at ? formatDate(clickupNotification.occurred_at) : "—"}</b></span>
          <span><small>ACOMPANHANDO</small><b>{watchers.length ? `${watchers.length} pessoa${watchers.length === 1 ? "" : "s"}` : "—"}</b></span>
        </div>

        {meta.url && <a className="cw-clickup" href={String(meta.url)} target="_blank" rel="noreferrer">Abrir tarefa no ClickUp ↗</a>}
      </> : <>
        <div className="cw-people"><div><small>CRIADA POR</small><b>{person(item?.created_by_person)}</b></div><div><small>ENCAMINHADA PARA</small><b>{routedTo}</b></div><div className="done"><small>FINALIZADA POR</small><b>{person(item?.completed_by)}</b></div><div><small>PRIORIDADE</small><b>{text(item?.priority || "—")}</b></div></div>
        <section className="cw-block original"><small>PEDIDO ORIGINAL</small><p>{text(item?.description || "Sem descrição original registrada.")}</p></section>
        <section className="cw-block resolution"><small>O QUE QUEM FINALIZOU ESCREVEU</small><p>{text(item?.resolution || "A conclusão não possui texto registrado.")}</p><div className="cw-author">Registrado por <b>{person(item?.completed_by)}</b>{item?.completed_at ? ` em ${formatDate(item.completed_at)}` : ""}</div></section>
        {item?.metadata?.last_action_detail && <section className="cw-block history"><small>ÚLTIMO REGISTRO ANTES DA CONCLUSÃO</small><p>{text(item.metadata.last_action_detail)}</p>{item.metadata.last_action_at && <div className="cw-author">{formatDate(item.metadata.last_action_at)}</div>}</section>}
        <div className="cw-meta"><span><small>CLIENTE</small><b>{text(client.display_name || "Solicitação geral")}</b></span><span><small>CRIADA EM</small><b>{formatDate(item?.created_at)}</b></span><span><small>PRAZO</small><b>{item?.due_at ? formatDate(item.due_at) : "Sem prazo"}</b></span><span><small>CONCLUÍDA EM</small><b>{item?.completed_at ? formatDate(item.completed_at) : "—"}</b></span></div>
        {item?.metadata?.clickup_url && <a className="cw-clickup" href={item.metadata.clickup_url} target="_blank" rel="noreferrer">Abrir tarefa no ClickUp ↗</a>}
      </>}
      <button type="button" className="cw-ok" onClick={close}>Fechar detalhes</button>
    </section>
  </div>;
}

const styles = `
.cw-detail-loading{position:fixed;right:24px;bottom:24px;z-index:61000;display:flex;align-items:center;gap:9px;padding:13px 16px;border:1px solid rgba(101,185,244,.28);border-radius:12px;background:#101a25;color:#dcecff;box-shadow:0 18px 60px rgba(0,0,0,.45);font:500 12px/1.4 Inter,system-ui,sans-serif}.cw-detail-loading span{width:11px;height:11px;border:2px solid #55b8f2;border-top-color:transparent;border-radius:50%;animation:cwspin .7s linear infinite}@keyframes cwspin{to{transform:rotate(360deg)}}
.cw-detail-shield{position:fixed;inset:0;z-index:62000;display:grid;place-items:center;padding:22px;background:rgba(4,10,17,.88);backdrop-filter:blur(13px);overflow:auto;color:#edf6ff;font-family:Inter,ui-sans-serif,system-ui,sans-serif}.cw-detail-card{width:min(1040px,100%);max-height:calc(100vh - 44px);overflow:auto;border:1px solid rgba(104,173,224,.28);border-radius:22px;padding:27px;background:linear-gradient(180deg,#111d29,#0b121b);box-shadow:0 38px 120px rgba(0,0,0,.68)}.cw-detail-card header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.cw-detail-card .eyebrow{color:#ff955f;font-size:10px;font-weight:900;letter-spacing:.13em;text-transform:uppercase}.cw-detail-card h2{margin:8px 0 0;font:800 clamp(28px,4vw,44px)/1.03 "Inter Tight",Inter,sans-serif;letter-spacing:-.035em}.cw-close{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#c9d8e6;border-radius:10px;width:38px;height:38px;font-size:24px;cursor:pointer}.cw-people{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:22px}.cw-people>div{padding:13px;border:1px solid rgba(255,255,255,.08);border-radius:11px;background:rgba(255,255,255,.025)}.cw-people>div.done{border-color:rgba(74,203,143,.25);background:rgba(44,170,111,.07)}.cw-people small,.cw-block small,.cw-meta small{display:block;color:#7992a9;font-size:9px;font-weight:900;letter-spacing:.11em}.cw-people b{display:block;margin-top:5px;font-size:12px;color:#edf5fc}.cw-block{margin-top:12px;padding:16px 18px;border:1px solid rgba(255,255,255,.08);border-radius:13px;background:rgba(0,0,0,.15)}.cw-block p{margin:8px 0 0;white-space:pre-wrap;font-size:14px;line-height:1.58;color:#d9e6f2}.cw-block.resolution{border-color:rgba(63,207,140,.27);background:rgba(28,114,76,.08)}.cw-block.history{border-color:rgba(232,169,72,.24)}.cw-author{margin-top:9px;color:#7891a8;font-size:10px}.cw-meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}.cw-meta span{padding:11px 13px;border:1px solid rgba(255,255,255,.07);border-radius:10px;background:rgba(255,255,255,.025)}.cw-meta b{display:block;margin-top:5px;font-size:11px;color:#dfeaf4}.cw-links{display:grid;gap:7px;margin-top:9px}.cw-links a,.cw-clickup{color:#72c8ff;font-size:12px;font-weight:800;text-decoration:none}.cw-clickup{display:inline-flex;margin-top:13px}.cw-ok{width:100%;margin-top:19px;border:0;border-radius:11px;padding:14px 18px;background:#67c7ff;color:#07121b;font-weight:900;cursor:pointer}.cw-error{margin:22px 0;padding:15px;border-radius:12px;background:rgba(230,80,75,.12);border:1px solid rgba(230,80,75,.25);color:#ffb9b3;font-size:13px}@media(max-width:760px){.cw-detail-shield{padding:10px}.cw-detail-card{padding:20px}.cw-people,.cw-meta{grid-template-columns:1fr 1fr}.cw-detail-card h2{font-size:30px}}
`;
