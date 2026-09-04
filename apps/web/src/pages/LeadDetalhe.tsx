import { useState } from "react";
import { irPara } from "../App";
import { dataHora, linkWhatsapp, relativo, rotuloOrigem } from "../lib/format";
import {
  atividades, corretores, criarTarefa, etapas, moverEtapa, oportunidade, registrarAtividade,
} from "../lib/queries";
import { mensagemDeErro } from "../lib/supabase";
import {
  Alerta, Avatar, BotaoAcao, Card, EtapaBadge, Ico, Skeleton, useAsync, useToast,
} from "../ui";
import {
  AcoesComerciais, AvisoDeAceite, PainelInteresse, PainelMatching,
} from "./LeadComercial";
import type { Activity, ActivityType, Match, Sessao } from "../lib/types";

const ICONE_ATIVIDADE: Record<ActivityType, () => React.ReactNode> = {
  NOTE: () => Ico.note({ size: 13 }),
  CALL: () => Ico.phone({ size: 13 }),
  WHATSAPP: () => Ico.whats({ size: 13 }),
  EMAIL: () => Ico.mail({ size: 13 }),
  MEETING: () => Ico.users({ size: 13 }),
  STATUS_CHANGE: () => Ico.arrow({ size: 13 }),
  VISIT: () => Ico.building({ size: 13 }),
  PROPOSAL: () => Ico.note({ size: 13 }),
  SYSTEM: () => Ico.gear({ size: 13 }),
};

const ROTULO_ATIVIDADE: Record<ActivityType, string> = {
  NOTE: "Nota", CALL: "Ligacao", WHATSAPP: "WhatsApp", EMAIL: "E-mail",
  MEETING: "Reuniao", STATUS_CHANGE: "Mudou de etapa", VISIT: "Visita",
  PROPOSAL: "Proposta", SYSTEM: "Sistema",
};

export default function LeadDetalhe({ sessao, oppId }: { sessao: Sessao; oppId: string }) {
  const avisar = useToast();
  const [salvando, setSalvando] = useState(false);
  const [sugerido, setSugerido] = useState<Match | null>(null);
  // muda a cada salvamento de interesse para o matching recalcular
  const [chaveMatch, setChaveMatch] = useState(0);

  const dados = useAsync(
    async () => ({
      opp: await oportunidade(oppId),
      hist: await atividades(oppId),
      etapas: await etapas(sessao.tenant.id),
      pessoas: await corretores(sessao.tenant.id),
    }),
    [oppId, sessao.tenant.id]
  );

  if (dados.erro) return <Alerta>{dados.erro}</Alerta>;

  if (!dados.dado) {
    return (
      <div className="detail">
        <Card><div className="card-body"><Skeleton h={220} /></div></Card>
        <Card><div className="card-body"><Skeleton h={180} /></div></Card>
      </div>
    );
  }

  const { opp, hist, etapas: listaEtapas, pessoas } = dados.dado;
  const etapaAtual = listaEtapas.find((e) => e.id === opp.stage_id);
  const nomePorId = new Map(pessoas.map((p) => [p.id, p.full_name ?? "--"]));
  const wa = linkWhatsapp(opp.contact?.phone_normalized ?? opp.contact?.phone);

  async function mover(etapaId: string) {
    const alvo = listaEtapas.find((e) => e.id === etapaId);
    let nota: string | undefined;
    if (alvo?.kind === "LOST") {
      const r = prompt("Motivo da perda:");
      if (!r?.trim()) return;
      nota = r.trim();
    }
    setSalvando(true);
    try {
      await moverEtapa(oppId, etapaId, nota);
      avisar("ok", `Movido para ${alvo?.name}.`);
      dados.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <>
      <AvisoDeAceite oppId={oppId} aoAceitar={() => dados.recarregar()} />

      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <button className="btn ghost sm" onClick={() => irPara("/leads")}>
          {Ico.back({ size: 15 })} Leads
        </button>
        <span className="spacer" />
        {wa && (
          <a className="btn" href={wa} target="_blank" rel="noopener noreferrer">
            {Ico.whats({ size: 15 })} Abrir no WhatsApp
          </a>
        )}
      </div>

      <Card>
        <div className="card-body">
          <div className="row" style={{ gap: 13, flexWrap: "wrap" }}>
            <Avatar nome={opp.contact?.full_name} tamanho="lg" />
            <div style={{ minWidth: 0 }}>
              <h1 style={{ fontSize: 19 }}>{opp.contact?.full_name ?? "Sem nome"}</h1>
              <div className="row" style={{ gap: 12, marginTop: 3, color: "var(--text-subtle)", fontSize: 13, flexWrap: "wrap" }}>
                {opp.contact?.phone && <span>{opp.contact.phone}</span>}
                {opp.contact?.email && <span>{opp.contact.email}</span>}
              </div>
            </div>
            <span className="spacer" />
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {/* Produto do lead (spec 72). So aparece depois que o lead foi
                  ancorado em um imovel por visita, proposta ou venda -- e o
                  que responde "esse lead e de qual produto?" sem obrigar
                  ninguem a preencher um campo a mais. */}
              {(opp.development?.name || opp.property?.title) && (
                <span
                  className="badge visit"
                  title={opp.property?.title ?? undefined}
                  style={{ maxWidth: 220 }}
                >
                  {Ico.building({ size: 12 })}
                  <span className="truncate">
                    {opp.development?.name ?? opp.property?.title}
                  </span>
                </span>
              )}
              {etapaAtual && <EtapaBadge kind={etapaAtual.kind} nome={etapaAtual.name} />}
              <div className="row" style={{ gap: 6 }}>
                <Avatar nome={opp.assigned_user_id ? nomePorId.get(opp.assigned_user_id) : null} />
                <span style={{ fontSize: 13 }}>
                  {opp.assigned_user_id
                    ? nomePorId.get(opp.assigned_user_id)
                    : <span style={{ color: "var(--text-subtle)" }}>Na fila</span>}
                </span>
              </div>
            </div>
          </div>

          <div className="row" style={{ gap: 6, marginTop: 15, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--text-subtle)", marginRight: 4 }}>
              Mover para:
            </span>
            {listaEtapas.filter((e) => e.id !== opp.stage_id).map((e) => (
              <button key={e.id} className="btn sm" disabled={salvando} onClick={() => mover(e.id)}>
                {e.name}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <div className="detail">
        <div className="col" style={{ gap: 16 }}>
          <AcoesComerciais
            sessao={sessao} oppId={oppId} imovelSugerido={sugerido}
            aoConcluir={() => { setSugerido(null); dados.recarregar(); }}
          />

          <PainelMatching
            oppId={oppId} chave={chaveMatch}
            aoEscolher={(m) => {
              setSugerido(m);
              avisar("info", m.titulo + " selecionado para a proxima acao.");
            }}
          />

          <NovaAtividade
            sessao={sessao} oppId={oppId} tenantId={opp.tenant_id}
            aoRegistrar={() => dados.recarregar()}
          />

          <Card>
            <div className="card-head"><h2>Historico</h2></div>
            <div className="card-body">
              {hist.length === 0 ? (
                <div style={{ color: "var(--text-subtle)", fontSize: 13 }}>Nada registrado ainda.</div>
              ) : (
                <div className="timeline">
                  {hist.map((a) => (
                    <LinhaHistorico
                      key={a.id} a={a}
                      autor={a.created_by ? nomePorId.get(a.created_by) ?? "Sistema" : "Sistema"}
                      nomeEtapa={(id) => listaEtapas.find((e) => e.id === id)?.name ?? "--"}
                    />
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <PainelInteresse
            sessao={sessao} oppId={oppId}
            aoSalvar={() => setChaveMatch((k) => k + 1)}
          />

          <Card>
            <div className="card-head"><h2>Origem</h2></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Canal</dt><dd>{rotuloOrigem(opp.source)}</dd>
                {opp.source_detail && <><dt>Detalhe</dt><dd>{opp.source_detail}</dd></>}
                {opp.campaign_name && <><dt>Campanha</dt><dd>{opp.campaign_name}</dd></>}
                {opp.adset_name && <><dt>Conjunto</dt><dd>{opp.adset_name}</dd></>}
                {opp.ad_name && <><dt>Anuncio</dt><dd>{opp.ad_name}</dd></>}
              </dl>
              {!opp.campaign_name && (
                <div className="hint" style={{ marginTop: 10 }}>
                  Sem atribuicao de campanha. Leads vindos de Meta Ads trazem esses
                  campos automaticamente.
                </div>
              )}
            </div>
          </Card>

          <Card>
            <div className="card-head"><h2>Linha do tempo</h2></div>
            <div className="card-body">
              <dl className="kv">
                <dt>Entrada</dt><dd>{dataHora(opp.created_at)}</dd>
                <dt>Aceite</dt><dd>{dataHora(opp.accepted_at)}</dd>
                <dt>1o contato</dt><dd>{dataHora(opp.first_contact_at)}</dd>
                <dt>Qualificado</dt><dd>{dataHora(opp.qualified_at)}</dd>
                <dt>Fechado</dt><dd>{dataHora(opp.closed_at)}</dd>
                <dt>Ultima int.</dt><dd>{relativo(opp.last_interaction_at)}</dd>
              </dl>
              {opp.lost_reason && (
                <div style={{ marginTop: 12 }}>
                  <Alerta tipo="warn">Perdido: {opp.lost_reason}</Alerta>
                </div>
              )}
            </div>
          </Card>

          <NovoFollowUp sessao={sessao} oppId={oppId} tenantId={opp.tenant_id} />
        </div>
      </div>
    </>
  );
}

function LinhaHistorico({ a, autor, nomeEtapa }: {
  a: Activity; autor: string; nomeEtapa: (id: string | null) => string;
}) {
  const texto = a.type === "STATUS_CHANGE"
    ? `${a.from_stage_id ? nomeEtapa(a.from_stage_id) : "--"} -> ${nomeEtapa(a.to_stage_id)}${a.body ? `. ${a.body}` : ""}`
    : a.body;

  return (
    <div className="tl-item entra">
      <div className="tl-dot">{ICONE_ATIVIDADE[a.type]()}</div>
      <div className="tl-body">
        <div className="tl-head">
          <span className="tl-who">{autor}</span>
          <span className="badge" style={{ height: 18, fontSize: 11 }}>
            {ROTULO_ATIVIDADE[a.type]}
          </span>
          <span className="tl-when">{dataHora(a.created_at)}</span>
        </div>
        {texto && <div className="tl-text">{texto}</div>}
      </div>
    </div>
  );
}

const TIPOS_MANUAIS: ActivityType[] = ["NOTE", "WHATSAPP", "CALL", "EMAIL", "MEETING"];

function NovaAtividade({ sessao, oppId, tenantId, aoRegistrar }: {
  sessao: Sessao; oppId: string; tenantId: string; aoRegistrar: () => void;
}) {
  const avisar = useToast();
  const [tipo, setTipo] = useState<ActivityType>("NOTE");
  const [texto, setTexto] = useState("");

  async function enviar() {
    try {
      await registrarAtividade(tenantId, oppId, tipo, texto.trim(), sessao.userId);
      setTexto("");
      aoRegistrar();
    } catch (err) {
      avisar("err", mensagemDeErro(err));
      throw err;   // o botao volta ao estado parado
    }
  }

  return (
    <Card>
      <div className="card-body">
        <div className="col" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 5, flexWrap: "wrap" }}>
            {TIPOS_MANUAIS.map((t) => (
              <button
                key={t} type="button"
                className={`btn sm ${tipo === t ? "" : "ghost"}`.trim()}
                onClick={() => setTipo(t)}
              >
                {ICONE_ATIVIDADE[t]()} {ROTULO_ATIVIDADE[t]}
              </button>
            ))}
          </div>
          <textarea
            className="textarea" value={texto} onChange={(e) => setTexto(e.target.value)}
            placeholder="O que aconteceu no atendimento?"
            aria-label="Descricao da atividade"
          />
          <div className="row">
            <span className="hint">O registro entra no historico e nao pode ser apagado.</span>
            <span className="spacer" />
            <BotaoAcao aoClicar={enviar} disabled={!texto.trim()}>Registrar</BotaoAcao>
          </div>
        </div>
      </div>
    </Card>
  );
}

function NovoFollowUp({ sessao, oppId, tenantId }: {
  sessao: Sessao; oppId: string; tenantId: string;
}) {
  const avisar = useToast();
  const [titulo, setTitulo] = useState("");
  const [quando, setQuando] = useState("");
  const [salvando, setSalvando] = useState(false);

  async function criar(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    try {
      await criarTarefa({
        tenantId, oppId, usuarioId: sessao.userId,
        titulo: titulo.trim(),
        vencimento: new Date(quando).toISOString(),
      });
      setTitulo(""); setQuando("");
      avisar("ok", "Follow-up agendado.");
    } catch (err) {
      avisar("err", mensagemDeErro(err));
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Card>
      <div className="card-head"><h2>Novo follow-up</h2></div>
      <div className="card-body">
        <form onSubmit={criar} className="col" style={{ gap: 10 }}>
          <div className="field">
            <label className="label" htmlFor="ft">O que fazer</label>
            <input id="ft" className="input" value={titulo} required
                   onChange={(e) => setTitulo(e.target.value)}
                   placeholder="Enviar opcoes no Aquarius" />
          </div>
          <div className="field">
            <label className="label" htmlFor="fq">Quando</label>
            <input id="fq" className="input" type="datetime-local" value={quando} required
                   onChange={(e) => setQuando(e.target.value)} />
          </div>
          <button className="btn wide" type="submit" disabled={salvando || !titulo.trim() || !quando}>
            {salvando ? "Agendando..." : "Agendar"}
          </button>
        </form>
      </div>
    </Card>
  );
}
