import { useEffect, useState } from "react";
import { irPara } from "../App";
import Dialogo from "../Dialogo";
import { classeEtapa, relativo, rotuloOrigem } from "../lib/format";
import {
  atualizarEtapaPipeline, colunaDoQuadro, corretores, criarEtapaPipeline, etapas,
  excluirEtapaPipeline, moverEtapa, moverEtapaPipeline, oportunidadesDoQuadro,
} from "../lib/queries";
import { mensagemDeErro } from "../lib/supabase";
import { useFlip } from "../lib/flip";
import {
  Alerta, Avatar, CabecalhoDaPagina, Ico, Skeleton, useAsync, useToast, Vazio,
} from "../ui";
import type { Opportunity, Sessao, Stage, StageKind } from "../lib/types";

export default function Pipeline({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [editorAberto, setEditorAberto] = useState(false);
  const [corretorId, setCorretorId] = useState("");
  const [arrastando, setArrastando] = useState<string | null>(null);
  const [colunaAtiva, setColunaAtiva] = useState<string | null>(null);
  // otimista: o card pula de coluna antes da resposta do servidor
  const [ajuste, setAjuste] = useState<Record<string, string>>({});
  // FLIP: sem isto o card desaparece de uma coluna e reaparece na outra
  const { container: quadro, capturar } = useFlip<HTMLDivElement>();

  // paginas extras carregadas sob demanda, por coluna
  const [extras, setExtras] = useState<Record<string, Opportunity[]>>({});
  const [buscandoMais, setBuscandoMais] = useState<string | null>(null);

  const dados = useAsync(async () => {
    const colunas = await etapas(sessao.tenant.id);
    const filtro = sessao.isAdmin ? (corretorId || undefined) : sessao.userId;
    return {
      etapas: colunas,
      colunasDoQuadro: await oportunidadesDoQuadro(
        sessao.tenant.id,
        colunas.map((e) => e.id),
        filtro
      ),
      pessoas: sessao.isAdmin ? await corretores(sessao.tenant.id) : [],
    };
  }, [sessao.tenant.id, corretorId]);

  // trocar de corretor recomeca a paginacao; senao sobram cards do filtro velho
  useEffect(() => { setExtras({}); }, [corretorId, sessao.tenant.id]);

  if (dados.erro) return <Alerta>{dados.erro}</Alerta>;

  if (!dados.dado) {
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

  const { etapas: colunas, colunasDoQuadro, pessoas } = dados.dado;
  const nomePorId = new Map(pessoas.map((p) => [p.id, p.full_name ?? "--"]));

  const carregados = (etapaId: string) => [
    ...(colunasDoQuadro.find((c) => c.etapaId === etapaId)?.itens ?? []),
    ...(extras[etapaId] ?? []),
  ];
  const opps = colunas.flatMap((e) => carregados(e.id));
  const totalDoBanco = (etapaId: string) =>
    colunasDoQuadro.find((c) => c.etapaId === etapaId)?.total ?? 0;

  const etapaDe = (o: Opportunity) => ajuste[o.id] ?? o.stage_id;

  /* O card movido ainda nao existe na contagem do servidor, e o da origem
     ainda existe. Sem corrigir, arrastar um card faz os dois numeros mentirem
     ate o proximo carregamento. */
  const deslocamento = (etapaId: string) => {
    let d = 0;
    for (const o of opps) {
      const destino = ajuste[o.id];
      if (!destino || destino === o.stage_id) continue;
      if (destino === etapaId) d += 1;
      if (o.stage_id === etapaId) d -= 1;
    }
    return d;
  };

  async function carregarMais(etapaId: string) {
    setBuscandoMais(etapaId);
    try {
      const novos = await colunaDoQuadro(
        sessao.tenant.id,
        etapaId,
        sessao.isAdmin ? (corretorId || undefined) : sessao.userId,
        carregados(etapaId).length,
        50
      );
      setExtras((x) => ({ ...x, [etapaId]: [...(x[etapaId] ?? []), ...novos.itens] }));
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    } finally {
      setBuscandoMais(null);
    }
  }

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
    capturar();                       // mede onde o card esta AGORA
    setAjuste((a) => ({ ...a, [id]: etapaId }));
    try {
      await moverEtapa(id, etapaId, nota);
      avisar("ok", `Movido para ${alvo?.name}.`);
    } catch (e) {
      capturar();                                   // o card volta animando tambem
      setAjuste((a) => ({ ...a, [id]: anterior }));  // desfaz o otimismo
      avisar("err", mensagemDeErro(e));
    }
  }

  // o cabecalho diz quantas existem, nao quantas couberam na tela
  const total = colunasDoQuadro.reduce((s, c) => s + c.total, 0);

  return (
    <>
      <CabecalhoDaPagina
        contexto={total + " oportunidade" + (total === 1 ? "" : "s") + " em aberto"}
        titulo="Pipeline"
        descricao="Arraste o card para mover a etapa. A ordem conta a historia do lead."
        acoes={sessao.isAdmin ? (
          <>
            <button className="btn ghost sm" onClick={() => setEditorAberto(true)}>
              {Ico.gear({ size: 14 })} Editar etapas
            </button>
            <select
              className="select" style={{ width: "auto", minWidth: 150 }}
              value={corretorId} onChange={(e) => setCorretorId(e.target.value)}
              aria-label="Filtrar quadro por corretor"
            >
              <option value="">Todos os corretores</option>
              {pessoas.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </>
        ) : undefined}
      />

      <Dialogo aberto={editorAberto} titulo="Editar pipeline" aoFechar={() => setEditorAberto(false)} largura={720}>
        <EditorPipeline
          tenantId={sessao.tenant.id}
          colunas={colunas}
          aoMudar={() => dados.recarregar()}
        />
      </Dialogo>

      {total === 0 ? (
        <Vazio
          icone={Ico.board({ size: 20 })}
          titulo="Quadro vazio"
          texto="Nenhuma oportunidade aberta com esse filtro."
        />
      ) : (
        <div className="kanban" ref={quadro}>
          {colunas.map((etapa) => {
            const daColuna = opps.filter((o) => etapaDe(o) === etapa.id);
            const quantos = totalDoBanco(etapa.id) + deslocamento(etapa.id);
            const faltam = quantos - daColuna.length;
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
                  <span className="kcol-count">{quantos}</span>
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

                  {/* Sem isto a coluna diz "1586" e mostra 50, sem explicar a
                      diferenca -- que foi exatamente como o problema apareceu. */}
                  {faltam > 0 && (
                    <button
                      type="button"
                      className="btn ghost"
                      style={{ width: "100%", marginTop: 6, fontSize: 12 }}
                      disabled={buscandoMais === etapa.id}
                      onClick={() => void carregarMais(etapa.id)}
                    >
                      {buscandoMais === etapa.id
                        ? "Carregando..."
                        : `Mostrando ${daColuna.length} de ${quantos} — carregar mais`}
                    </button>
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

const TIPOS_ETAPA: { value: StageKind; label: string }[] = [
  { value: "NEW", label: "Novo" },
  { value: "CONTACTED", label: "Contatado" },
  { value: "QUALIFIED", label: "Qualificado" },
  { value: "VISIT", label: "Visita" },
  { value: "PROPOSAL", label: "Proposta" },
  { value: "WON", label: "Ganho" },
  { value: "LOST", label: "Perdido" },
];

function EditorPipeline({
  tenantId, colunas, aoMudar,
}: {
  tenantId: string;
  colunas: Stage[];
  aoMudar: () => void;
}) {
  const avisar = useToast();
  const [novoNome, setNovoNome] = useState("");
  const [novoTipo, setNovoTipo] = useState<StageKind>("CONTACTED");
  const [ocupado, setOcupado] = useState<string | null>(null);

  async function executar(chave: string, fn: () => Promise<unknown>, ok: string) {
    setOcupado(chave);
    try {
      await fn();
      avisar("ok", ok);
      aoMudar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    } finally {
      setOcupado(null);
    }
  }

  async function adicionar() {
    const nome = novoNome.trim();
    if (!nome) return;
    await executar("novo", () => criarEtapaPipeline(tenantId, nome, novoTipo), "Etapa criada.");
    setNovoNome("");
    setNovoTipo("CONTACTED");
  }

  async function editar(etapa: Stage) {
    const nome = prompt("Nome da etapa:", etapa.name)?.trim();
    if (!nome) return;
    const tipo = prompt(
      "Tipo da etapa: NEW, CONTACTED, QUALIFIED, VISIT, PROPOSAL, WON ou LOST",
      etapa.kind
    )?.trim().toUpperCase() as StageKind | undefined;
    if (!tipo || !TIPOS_ETAPA.some((t) => t.value === tipo)) {
      avisar("err", "Tipo de etapa invalido.");
      return;
    }
    await executar(etapa.id, () => atualizarEtapaPipeline(etapa.id, nome, tipo), "Etapa atualizada.");
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="hint">
        Renomeie, reorganize, crie ou exclua etapas. Etapas com leads nao podem ser excluidas.
      </div>

      <div className="col" style={{ gap: 8 }}>
        {colunas.map((etapa, indice) => (
          <div
            key={etapa.id}
            className="row"
            style={{
              gap: 8, flexWrap: "wrap", padding: "9px 10px",
              border: "1px solid var(--line-soft)", borderRadius: "var(--r-sm)",
            }}
          >
            <span className={"badge " + classeEtapa(etapa.kind)}><span className="dot" /></span>
            <strong style={{ minWidth: 120 }}>{etapa.name}</strong>
            <span className="badge">{TIPOS_ETAPA.find((t) => t.value === etapa.kind)?.label ?? etapa.kind}</span>
            <span className="spacer" />
            <button
              className="btn ghost sm"
              disabled={ocupado !== null || indice === 0}
              onClick={() => void executar(etapa.id, () => moverEtapaPipeline(etapa.id, -1), "Etapa movida.")}
              aria-label={"Mover " + etapa.name + " para a esquerda"}
            >←</button>
            <button
              className="btn ghost sm"
              disabled={ocupado !== null || indice === colunas.length - 1}
              onClick={() => void executar(etapa.id, () => moverEtapaPipeline(etapa.id, 1), "Etapa movida.")}
              aria-label={"Mover " + etapa.name + " para a direita"}
            >→</button>
            <button className="btn ghost sm" disabled={ocupado !== null} onClick={() => void editar(etapa)}>
              Editar
            </button>
            <button
              className="btn ghost sm"
              disabled={ocupado !== null}
              onClick={() => {
                if (!confirm('Excluir a etapa "' + etapa.name + '"?')) return;
                void executar(etapa.id, () => excluirEtapaPipeline(etapa.id), "Etapa excluida.");
              }}
              aria-label={"Excluir " + etapa.name}
            >
              {Ico.lixeira({ size: 14 })}
            </button>
          </div>
        ))}
      </div>

      <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 14 }}>
        <div className="label" style={{ marginBottom: 7 }}>Nova etapa</div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 220px" }}
            value={novoNome}
            onChange={(e) => setNovoNome(e.target.value)}
            placeholder="Ex.: Em negociacao"
            onKeyDown={(e) => { if (e.key === "Enter") void adicionar(); }}
          />
          <select className="select" value={novoTipo} onChange={(e) => setNovoTipo(e.target.value as StageKind)}>
            {TIPOS_ETAPA.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <button className="btn primary" disabled={ocupado !== null || !novoNome.trim()} onClick={() => void adicionar()}>
            {Ico.plus({ size: 14 })} Adicionar
          </button>
        </div>
      </div>
    </div>
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
      data-flip-id={o.id}
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
