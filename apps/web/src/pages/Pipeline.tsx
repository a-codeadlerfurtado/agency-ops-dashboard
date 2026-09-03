import { useState } from "react";
import { irPara } from "../App";
import { classeEtapa, relativo, rotuloOrigem } from "../lib/format";
import { corretores, etapas, moverEtapa, oportunidadesDoQuadro } from "../lib/queries";
import { mensagemDeErro } from "../lib/supabase";
import { Alerta, Avatar, Ico, Skeleton, useAsync, useToast, Vazio } from "../ui";
import type { Opportunity, Sessao, Stage } from "../lib/types";

export default function Pipeline({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [corretorId, setCorretorId] = useState("");
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [colunaAtiva, setColunaAtiva] = useState<string | null>(null);
  // otimista: o card pula de coluna antes da resposta do servidor
  const [ajuste, setAjuste] = useState<Record<string, string>>({});

  const dados = useAsync(
    async () => ({
      etapas: await etapas(sessao.tenant.id),
      opps: await oportunidadesDoQuadro(
        sessao.tenant.id,
        sessao.isAdmin ? (corretorId || undefined) : sessao.userId
      ),
      pessoas: sessao.isAdmin ? await corretores(sessao.tenant.id) : [],
    }),
    [sessao.tenant.id, corretorId]
  );

  if (dados.erro) return <Alerta>{dados.erro}</Alerta>;

  if (dados.carregando || !dados.dado) {
    return (
      <div className="kanban">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="kcol" style={{ minHeight: 260 }}>
            <div className="kcol-head"><Skeleton h={13} w={90} /></div>
            <div className="kcol-body">
              <Skeleton h={62} /><Skeleton h={62} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const { etapas: colunas, opps, pessoas } = dados.dado;
  const nomePorId = new Map(pessoas.map((p) => [p.id, p.full_name ?? "--"]));

  const etapaDe = (o: Opportunity) => ajuste[o.id] ?? o.stage_id;

  async function soltar(etapaId: string) {
    const id = arrastando;
    setArrastando(null);
    setColunaAtiva(null);
    if (!id) return;

    const opp = opps.find((o) => o.id === id);
    if (!opp || etapaDe(opp) === etapaId) return;

    const alvo = colunas.find((e) => e.id === etapaId);
    let nota: string | undefined;
    if (alvo?.kind === "LOST") {
      const r = prompt("Motivo da perda:");
      if (!r?.trim()) return;
      nota = r.trim();
    }

    const anterior = etapaDe(opp);
    setAjuste((a) => ({ ...a, [id]: etapaId }));
    try {
      await moverEtapa(id, etapaId, nota);
      avisar("ok", `Movido para ${alvo?.name}.`);
    } catch (e) {
      setAjuste((a) => ({ ...a, [id]: anterior }));  // desfaz o otimismo
      avisar("err", mensagemDeErro(e));
    }
  }

  const total = opps.length;

  return (
    <>
      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          {total} oportunidade{total === 1 ? "" : "s"} aberta{total === 1 ? "" : "s"}
        </div>
        <span className="spacer" />
        {sessao.isAdmin && (
          <select
            className="select" style={{ width: "auto", minWidth: 150 }}
            value={corretorId} onChange={(e) => setCorretorId(e.target.value)}
            aria-label="Filtrar quadro por corretor"
          >
            <option value="">Todos os corretores</option>
            {pessoas.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        )}
      </div>

      {total === 0 ? (
        <Vazio
          icone={Ico.board({ size: 20 })}
          titulo="Quadro vazio"
          texto="Nenhuma oportunidade aberta com esse filtro."
        />
      ) : (
        <div className="kanban">
          {colunas.map((etapa) => {
            const daColuna = opps.filter((o) => etapaDe(o) === etapa.id);
            return (
              <section
                key={etapa.id}
                className={`kcol ${colunaAtiva === etapa.id ? "over" : ""}`.trim()}
                onDragOver={(e) => { e.preventDefault(); setColunaAtiva(etapa.id); }}
                onDragLeave={() => setColunaAtiva((c) => (c === etapa.id ? null : c))}
                onDrop={(e) => { e.preventDefault(); void soltar(etapa.id); }}
                aria-label={etapa.name}
              >
                <div className="kcol-head">
                  <span className={`badge ${classeEtapa(etapa.kind)}`} style={{ height: 16, padding: "0 6px" }}>
                    <span className="dot" />
                  </span>
                  <span className="kcol-name">{etapa.name}</span>
                  <span className="kcol-count">{daColuna.length}</span>
                </div>
                <div className="kcol-body">
                  {daColuna.map((o) => (
                    <CardLead
                      key={o.id} o={o}
                      corretor={o.assigned_user_id ? nomePorId.get(o.assigned_user_id) : null}
                      mostrarCorretor={sessao.isAdmin}
                      arrastando={arrastando === o.id}
                      aoArrastar={() => setArrastando(o.id)}
                      aoSoltar={() => setArrastando(null)}
                    />
                  ))}
                  {daColuna.length === 0 && (
                    <div style={{
                      padding: "18px 8px", textAlign: "center",
                      fontSize: 12, color: "var(--text-subtle)",
                    }}>
                      Arraste um card para ca
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function CardLead({
  o, corretor, mostrarCorretor, arrastando, aoArrastar, aoSoltar,
}: {
  o: Opportunity; corretor: string | null | undefined; mostrarCorretor: boolean;
  arrastando: boolean; aoArrastar: () => void; aoSoltar: () => void;
}) {
  const frio = Date.now() - new Date(o.last_interaction_at).getTime() > 30 * 86_400_000;

  return (
    <article
      className={`kcard ${arrastando ? "dragging" : ""}`.trim()}
      draggable
      onDragStart={aoArrastar}
      onDragEnd={aoSoltar}
      onClick={() => irPara(`/leads/${o.id}`)}
      role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") irPara(`/leads/${o.id}`); }}
    >
      <div className="kcard-title">{o.contact?.full_name ?? "Sem nome"}</div>
      <div className="kcard-meta">
        <span className="badge" style={{ height: 18, fontSize: 11 }}>
          {rotuloOrigem(o.source)}
        </span>
        <span style={{ color: frio ? "var(--danger)" : undefined }}>
          {relativo(o.last_interaction_at)}
        </span>
        <span className="spacer" />
        {mostrarCorretor && <Avatar nome={corretor} />}
      </div>
    </article>
  );
}
