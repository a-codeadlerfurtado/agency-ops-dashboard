"use client";

import { useEffect, useMemo, useState } from "react";
import { api, formatDate, supabase, text } from "./shared";

type Row = Record<string, any>;

const norm = (value: unknown) => String(value ?? "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

function person(value: unknown) {
  const raw = String(value || "").trim();
  return raw || "Não identificado";
}

export default function CompletedWorkItemDetailBridge() {
  const [item, setItem] = useState<Row | null>(null);
  const [loadingTitle, setLoadingTitle] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;

    const onClick = async (event: MouseEvent) => {
      const target = event.target as Element | null;
      const button = target?.closest?.(".notification-panel .notification-list > button") as HTMLButtonElement | null;
      if (!button) return;
      const title = button.querySelector("b")?.textContent?.trim() || "";
      if (!/^demanda conclu[ií]da\s*:/i.test(title)) return;

      const taskName = title.replace(/^demanda conclu[ií]da\s*:\s*/i, "").trim();
      if (!taskName) return;
      const visibleText = norm(button.textContent || "");
      setLoadingTitle(taskName);
      setError("");

      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) throw new Error("Sessão indisponível");
        const payload = await api("work", session.access_token);
        if (disposed) return;
        const rows: Row[] = Array.isArray(payload?.items) ? payload.items : [];
        const candidates = rows
          .filter((row) => norm(row.title) === norm(taskName) && String(row.status || "").toUpperCase() === "COMPLETED")
          .sort((a, b) => {
            const aResolution = norm(a.resolution);
            const bResolution = norm(b.resolution);
            const aVisible = aResolution && visibleText.includes(aResolution.slice(0, Math.min(48, aResolution.length))) ? 1 : 0;
            const bVisible = bResolution && visibleText.includes(bResolution.slice(0, Math.min(48, bResolution.length))) ? 1 : 0;
            if (aVisible !== bVisible) return bVisible - aVisible;
            return new Date(String(b.completed_at || b.updated_at || 0)).getTime() - new Date(String(a.completed_at || a.updated_at || 0)).getTime();
          });
        const found = candidates[0];
        if (!found) throw new Error("Não encontrei os detalhes desta demanda na Central de Trabalho.");
        setItem(found);
      } catch (caught) {
        if (!disposed) setError(caught instanceof Error ? caught.message : "Não consegui carregar os detalhes desta demanda.");
      } finally {
        if (!disposed) setLoadingTitle("");
      }
    };

    document.addEventListener("click", onClick, true);
    return () => { disposed = true; document.removeEventListener("click", onClick, true); };
  }, []);

  useEffect(() => {
    if (!item && !error && !loadingTitle) return;
    const previous = document.body.style.overflow;
    if (item || error) document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [item, error, loadingTitle]);

  const client = item?.clients || {};
  const routedTo = useMemo(() => person(item?.target_person || item?.target_role), [item]);

  if (loadingTitle && !item && !error) {
    return <div className="cw-detail-loading" role="status"><style>{styles}</style><span /> Carregando detalhes de <b>{loadingTitle}</b>…</div>;
  }
  if (!item && !error) return null;

  return (
    <div className="cw-detail-shield" role="dialog" aria-modal="true" aria-labelledby="cw-detail-title">
      <style>{styles}</style>
      <section className="cw-detail-card">
        <header>
          <div><span className="eyebrow">Demanda concluída · detalhes</span><h2 id="cw-detail-title">{item ? text(item.title) : "Não foi possível abrir a demanda"}</h2></div>
          <button type="button" className="cw-close" onClick={() => { setItem(null); setError(""); }}>×</button>
        </header>

        {error ? <div className="cw-error">{error}</div> : <>
          <div className="cw-people">
            <div><small>CRIADA POR</small><b>{person(item?.created_by_person)}</b></div>
            <div><small>ENCAMINHADA PARA</small><b>{routedTo}</b></div>
            <div className="done"><small>FINALIZADA POR</small><b>{person(item?.completed_by)}</b></div>
            <div><small>PRIORIDADE</small><b>{text(item?.priority || "—")}</b></div>
          </div>

          <section className="cw-block original">
            <small>PEDIDO ORIGINAL</small>
            <p>{text(item?.description || "Sem descrição original registrada.")}</p>
          </section>

          <section className="cw-block resolution">
            <small>O QUE QUEM FINALIZOU ESCREVEU</small>
            <p>{text(item?.resolution || "A conclusão não possui texto registrado.")}</p>
            <div className="cw-author">Registrado por <b>{person(item?.completed_by)}</b>{item?.completed_at ? ` em ${formatDate(item.completed_at)}` : ""}</div>
          </section>

          {item?.metadata?.last_action_detail && <section className="cw-block history"><small>ÚLTIMO REGISTRO ANTES DA CONCLUSÃO</small><p>{text(item.metadata.last_action_detail)}</p>{item.metadata.last_action_at && <div className="cw-author">{formatDate(item.metadata.last_action_at)}</div>}</section>}

          <div className="cw-meta">
            <span><small>CLIENTE</small><b>{text(client.display_name || "Solicitação geral")}</b></span>
            <span><small>CRIADA EM</small><b>{formatDate(item?.created_at)}</b></span>
            <span><small>PRAZO</small><b>{item?.due_at ? formatDate(item.due_at) : "Sem prazo"}</b></span>
            <span><small>CONCLUÍDA EM</small><b>{item?.completed_at ? formatDate(item.completed_at) : "—"}</b></span>
          </div>

          {item?.metadata?.clickup_url && <a className="cw-clickup" href={item.metadata.clickup_url} target="_blank" rel="noreferrer">Abrir tarefa no ClickUp ↗</a>}
        </>}

        <button type="button" className="cw-ok" onClick={() => { setItem(null); setError(""); }}>Fechar detalhes</button>
      </section>
    </div>
  );
}

const styles = `
.cw-detail-loading{position:fixed;right:24px;bottom:24px;z-index:61000;display:flex;align-items:center;gap:9px;max-width:min(520px,calc(100vw - 32px));padding:13px 16px;border:1px solid rgba(101,185,244,.28);border-radius:12px;background:#101a25;color:#dcecff;box-shadow:0 18px 60px rgba(0,0,0,.45);font:500 12px/1.4 Inter,system-ui,sans-serif}.cw-detail-loading span{width:11px;height:11px;border:2px solid #55b8f2;border-top-color:transparent;border-radius:50%;animation:cwspin .7s linear infinite}@keyframes cwspin{to{transform:rotate(360deg)}}
.cw-detail-shield{position:fixed;inset:0;z-index:62000;display:grid;place-items:center;padding:22px;background:rgba(4,10,17,.88);backdrop-filter:blur(13px);overflow:auto;color:#edf6ff;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
.cw-detail-card{width:min(920px,100%);border:1px solid rgba(104,173,224,.28);border-radius:22px;padding:27px;background:linear-gradient(180deg,#111d29,#0b121b);box-shadow:0 38px 120px rgba(0,0,0,.68)}
.cw-detail-card header{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.cw-detail-card .eyebrow{color:#72c8ff;font-size:10px;font-weight:900;letter-spacing:.13em;text-transform:uppercase}.cw-detail-card h2{margin:8px 0 0;font:800 clamp(28px,4vw,44px)/1.03 "Inter Tight",Inter,sans-serif;letter-spacing:-.035em}.cw-close{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:#c9d8e6;border-radius:10px;width:38px;height:38px;font-size:24px;cursor:pointer}
.cw-people{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:22px}.cw-people>div{padding:13px;border:1px solid rgba(255,255,255,.08);border-radius:11px;background:rgba(255,255,255,.025)}.cw-people>div.done{border-color:rgba(74,203,143,.25);background:rgba(44,170,111,.07)}.cw-people small,.cw-block small,.cw-meta small{display:block;color:#7992a9;font-size:9px;font-weight:900;letter-spacing:.11em}.cw-people b{display:block;margin-top:5px;font-size:12px;color:#edf5fc}
.cw-block{margin-top:12px;padding:16px 18px;border:1px solid rgba(255,255,255,.08);border-radius:13px;background:rgba(0,0,0,.15)}.cw-block p{margin:8px 0 0;white-space:pre-wrap;font-size:14px;line-height:1.58;color:#d9e6f2}.cw-block.resolution{border-color:rgba(63,207,140,.27);background:linear-gradient(180deg,rgba(35,148,96,.1),rgba(17,70,53,.08))}.cw-block.resolution small{color:#6ddca8}.cw-block.history{border-color:rgba(242,179,67,.2)}.cw-author{margin-top:10px;color:#8ca4b8;font-size:11px}.cw-author b{color:#d5e8f5}
.cw-meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px}.cw-meta span{padding:12px 13px;border-radius:10px;background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.06)}.cw-meta b{display:block;margin-top:5px;font-size:11px;color:#d8e8f5}
.cw-clickup{display:inline-flex;margin-top:13px;color:#72c8ff;font-size:12px;font-weight:800;text-decoration:none}.cw-ok{width:100%;margin-top:19px;border:0;border-radius:11px;padding:14px 18px;background:#67c7ff;color:#07121b;font-weight:900;cursor:pointer}.cw-error{margin:22px 0;padding:15px;border-radius:12px;background:rgba(230,80,75,.12);border:1px solid rgba(230,80,75,.25);color:#ffb9b3;font-size:13px}
@media(max-width:760px){.cw-detail-shield{padding:10px}.cw-detail-card{padding:20px}.cw-people,.cw-meta{grid-template-columns:1fr 1fr}.cw-detail-card h2{font-size:30px}}
`;
