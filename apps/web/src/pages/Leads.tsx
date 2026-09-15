import { useEffect, useState } from "react";
import { irPara } from "../App";
import { data, relativo, rotuloOrigem } from "../lib/format";
import { corretores, criarOportunidade, etapas, oportunidades, type FiltrosLead } from "../lib/queries";
import { empreendimentos } from "../lib/comercial";
import { mensagemDeErro, supabase } from "../lib/supabase";
import Dialogo from "../Dialogo";
import {
  Alerta, Avatar, CabecalhoDaPagina, Card, EtapaBadge, Ico, TabelaCarregando, useAsync,
  useToast, Vazio,
} from "../ui";
import type { Opportunity, Profile, Sessao, Stage } from "../lib/types";

const ORIGENS = ["META_ADS", "GOOGLE", "INDICACAO", "MANUAL", "SITE"];

export default function Leads({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [filtros, setFiltros] = useState<FiltrosLead>({});
  const [busca, setBusca] = useState("");
  const [itens, setItens] = useState<Opportunity[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [novo, setNovo] = useState(false);
  const [paraExcluir, setParaExcluir] = useState<Opportunity | null>(null);
  const [excluindo, setExcluindo] = useState(false);

  const meta = useAsync(
    async () => ({
      etapas: await etapas(sessao.tenant.id),
      pessoas: await corretores(sessao.tenant.id),
      produtos: await empreendimentos(sessao.tenant.id),
    }),
    [sessao.tenant.id]
  );

  // debounce da busca: nao dispara request a cada tecla
  const [buscaAplicada, setBuscaAplicada] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setBuscaAplicada(busca), 280);
    return () => clearTimeout(t);
  }, [busca]);

  async function excluir() {
    if (!paraExcluir) return;
    setExcluindo(true);
    try {
      const { data, error } = await supabase.rpc("excluir_lead", { p_id: paraExcluir.id });
      if (error) throw error;
      const r = data as { contato_removido?: boolean } | null;
      // some da lista sem recarregar tudo: a pagina esta paginada por cursor e
      // recarregar do zero jogaria o usuario de volta ao topo
      setItens((lista) => lista.filter((o) => o.id !== paraExcluir.id));
      avisar("ok", r?.contato_removido
        ? "Lead e contato excluidos."
        : "Lead excluido. O contato foi mantido porque tem outros registros.");
      setParaExcluir(null);
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    } finally {
      setExcluindo(false);
    }
  }

  const filtrosCompletos = { ...filtros, busca: buscaAplicada };
  const lista = useAsync(
    () => oportunidades(sessao.tenant.id, filtrosCompletos),
    [sessao.tenant.id, buscaAplicada, filtros.etapaId, filtros.corretorId, filtros.origem,
     filtros.status, filtros.empreendimentoId]
  );

  useEffect(() => {
    if (lista.dado) {
      setItens(lista.dado.itens);
      setCursor(lista.dado.proximoCursor);
    }
  }, [lista.dado]);

  async function carregarMais() {
    if (!cursor) return;
    setCarregandoMais(true);
    try {
      const r = await oportunidades(sessao.tenant.id, filtrosCompletos, cursor);
      setItens((a) => [...a, ...r.itens]);
      setCursor(r.proximoCursor);
    } finally {
      setCarregandoMais(false);
    }
  }

  const nomePorId = new Map((meta.dado?.pessoas ?? []).map((p) => [p.id, p.full_name]));
  const etapaPorId = new Map((meta.dado?.etapas ?? []).map((e) => [e.id, e]));
  const temFiltro = Boolean(
    buscaAplicada || filtros.etapaId || filtros.corretorId || filtros.origem ||
    filtros.empreendimentoId
  );

  return (
    <>
      <CabecalhoDaPagina
        contexto={sessao.isAdmin ? "Carteira da operacao" : "Sua carteira"}
        titulo={sessao.isAdmin ? "Leads" : "Meus leads"}
        descricao={
          sessao.isAdmin
            ? "Todo lead da imobiliaria, de onde veio e com quem esta."
            : "Os leads sob sua responsabilidade."
        }
        acoes={
          <button className="btn primary" onClick={() => setNovo(true)}>
            {Ico.plus({ size: 15 })} Novo lead
          </button>
        }
      />

      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <div style={{ position: "relative", flex: "1 1 240px", maxWidth: 340 }}>
          <span style={{
            position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
            color: "var(--text-subtle)", display: "flex", pointerEvents: "none",
          }}>{Ico.search({ size: 15 })}</span>
          <input
            className="input" style={{ paddingLeft: 32 }}
            placeholder="Nome, telefone ou e-mail"
            value={busca} onChange={(e) => setBusca(e.target.value)}
            aria-label="Buscar leads"
          />
        </div>

        <select
          className="select" style={{ width: "auto", minWidth: 130 }}
          value={filtros.etapaId ?? ""}
          onChange={(e) => setFiltros((f) => ({ ...f, etapaId: e.target.value || undefined }))}
          aria-label="Filtrar por etapa"
        >
          <option value="">Todas as etapas</option>
          {meta.dado?.etapas.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>

        {sessao.isAdmin && (
          <select
            className="select" style={{ width: "auto", minWidth: 130 }}
            value={filtros.corretorId ?? ""}
            onChange={(e) => setFiltros((f) => ({ ...f, corretorId: e.target.value || undefined }))}
            aria-label="Filtrar por corretor"
          >
            <option value="">Todos os corretores</option>
            {meta.dado?.pessoas.map((p) => (
              <option key={p.id} value={p.id}>{p.full_name}</option>
            ))}
          </select>
        )}

        <select
          className="select" style={{ width: "auto", minWidth: 120 }}
          value={filtros.origem ?? ""}
          onChange={(e) => setFiltros((f) => ({ ...f, origem: e.target.value || undefined }))}
          aria-label="Filtrar por origem"
        >
          <option value="">Todas as origens</option>
          {ORIGENS.map((o) => <option key={o} value={o}>{rotuloOrigem(o)}</option>)}
        </select>

        {/* Produto (spec 71). O vinculo lead->empreendimento nasce da visita,
            da proposta ou da venda; "Sem produto" e o filtro que interessa na
            pratica: e a fila de quem ainda nao foi ancorado em nada. */}
        {(meta.dado?.produtos.length ?? 0) > 0 && (
          <select
            className="select" style={{ width: "auto", minWidth: 150 }}
            value={filtros.empreendimentoId ?? ""}
            onChange={(e) => setFiltros((f) => ({ ...f, empreendimentoId: e.target.value || undefined }))}
            aria-label="Filtrar por empreendimento"
          >
            <option value="">Todos os produtos</option>
            {meta.dado?.produtos.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            <option value="__sem">Sem produto</option>
          </select>
        )}

        {temFiltro && (
          <button className="btn ghost sm" onClick={() => { setFiltros({}); setBusca(""); }}>
            Limpar
          </button>
        )}
      </div>

      <NovoLead
        aberto={novo}
        sessao={sessao}
        pessoas={meta.dado?.pessoas ?? []}
        aoFechar={() => setNovo(false)}
        aoCriar={() => { setNovo(false); lista.recarregar(); }}
      />

      {/* Confirmacao obrigatoria: exclusao de lead apaga tambem visitas,
          propostas e todo o historico de atendimento em cascata. Dizer o que
          vai junto e mais util que perguntar "tem certeza?". */}
      <Dialogo
        aberto={paraExcluir !== null}
        titulo="Excluir lead"
        aoFechar={() => setParaExcluir(null)}
        rodape={
          <>
            <button className="btn" onClick={() => setParaExcluir(null)} disabled={excluindo}>
              Cancelar
            </button>
            <button className="btn danger" onClick={() => void excluir()} disabled={excluindo}>
              {excluindo ? "Excluindo..." : "Excluir definitivamente"}
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Excluir <b>{paraExcluir?.contact?.full_name ?? "este lead"}</b>
          {paraExcluir?.contact?.phone ? ` (${paraExcluir.contact.phone})` : ""}?
        </p>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 10 }}>
          Vao junto o historico de atendimento, as visitas, as propostas e as
          tarefas deste lead. O contato so e removido se nao tiver mais nenhum
          outro registro.
        </p>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 8 }}>
          Lead com venda registrada nao pode ser excluido &mdash; nesse caso,
          cancele a venda antes.
        </p>
      </Dialogo>

      {lista.erro && <Alerta>{lista.erro}</Alerta>}

      <Card>
        <div className="card-body flush">
          {lista.carregando ? (
            <TabelaCarregando linhas={6} colunas={6} />
          ) : itens.length === 0 ? (
            <Vazio
              titulo={temFiltro ? "Nenhum lead encontrado" : "Nenhum lead ainda"}
              texto={temFiltro
                ? "Tente outro termo ou limpe os filtros."
                : "Cadastre o primeiro lead ou conecte uma origem de anuncios."}
              acao={!temFiltro && (
                <button className="btn primary" onClick={() => setNovo(true)}>
                  {Ico.plus({ size: 15 })} Novo lead
                </button>
              )}
            />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Nome</th>
                    <th>Origem</th>
                    {sessao.isAdmin && <th>Corretor</th>}
                    <th>Produto</th>
                    <th>Etapa</th>
                    <th>Entrada</th>
                    <th>Ultima interacao</th>
                    {sessao.isAdmin && <th style={{ width: 44 }} aria-label="Acoes" />}
                  </tr>
                </thead>
                <tbody>
                  {itens.map((o) => {
                    const etapa = etapaPorId.get(o.stage_id);
                    return (
                      <tr key={o.id} className="clickable" onClick={() => irPara(`/leads/${o.id}`)}>
                        <td>
                          <div style={{ fontWeight: 550 }}>{o.contact?.full_name ?? "Sem nome"}</div>
                          <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                            {o.contact?.phone ?? "sem telefone"}
                          </div>
                        </td>
                        <td className="nowrap">
                          <span className="badge">{rotuloOrigem(o.source)}</span>
                        </td>
                        {sessao.isAdmin && (
                          <td>
                            <div className="row" style={{ gap: 7 }}>
                              <Avatar nome={o.assigned_user_id ? nomePorId.get(o.assigned_user_id) : null} />
                              <span className="truncate" style={{ maxWidth: 120 }}>
                                {o.assigned_user_id
                                  ? nomePorId.get(o.assigned_user_id) ?? "--"
                                  : <span style={{ color: "var(--text-subtle)" }}>Na fila</span>}
                              </span>
                            </div>
                          </td>
                        )}
                        <td>
                          {o.development?.name ? (
                            <span className="truncate" style={{ maxWidth: 150, display: "block" }}>
                              {o.development.name}
                            </span>
                          ) : o.property?.title ? (
                            <span className="truncate" style={{ maxWidth: 150, display: "block" }}>
                              {o.property.title}
                            </span>
                          ) : (
                            <span style={{ color: "var(--text-subtle)" }}>--</span>
                          )}
                        </td>
                        <td className="nowrap">
                          {etapa
                            ? <EtapaBadge kind={etapa.kind} nome={etapa.name} />
                            : <span className="badge">--</span>}
                        </td>
                        <td className="nowrap num" style={{ color: "var(--muted)" }}>
                          {data(o.created_at)}
                        </td>
                        <td className="nowrap" style={{
                          color: Date.now() - new Date(o.last_interaction_at).getTime() > 30 * 86400000
                            ? "var(--danger)" : "var(--muted)",
                        }}>
                          {relativo(o.last_interaction_at)}
                        </td>
                        {sessao.isAdmin && (
                          /* stopPropagation: a linha inteira abre o lead, e um
                             clique em excluir nao pode navegar junto */
                          <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn ghost sm"
                              title={`Excluir ${o.contact?.full_name ?? "lead"}`}
                              aria-label={`Excluir ${o.contact?.full_name ?? "lead"}`}
                              onClick={() => setParaExcluir(o)}
                            >
                              {Ico.lixeira({ size: 15 })}
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {cursor && (
        <div style={{ textAlign: "center" }}>
          <button className="btn" onClick={carregarMais} disabled={carregandoMais}>
            {carregandoMais ? "Carregando..." : "Carregar mais"}
          </button>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- novo lead --- */

function NovoLead({
  aberto, sessao, pessoas, aoFechar, aoCriar,
}: {
  aberto: boolean; sessao: Sessao; pessoas: Profile[];
  aoFechar: () => void; aoCriar: () => void;
}) {
  const avisar = useToast();
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [email, setEmail] = useState("");
  const [origem, setOrigem] = useState("MANUAL");
  const [corretorId, setCorretorId] = useState(sessao.isAdmin ? "" : sessao.userId);
  const [salvando, setSalvando] = useState(false);

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    try {
      const id = await criarOportunidade({
        tenantId: sessao.tenant.id,
        nome: nome.trim(),
        telefone, email,
        corretorId: corretorId || null,
        origem,
      });
      avisar("ok", "Lead criado.");
      aoCriar();
      irPara(`/leads/${id}`);
    } catch (err) {
      avisar("err", mensagemDeErro(err));
      setSalvando(false);
    }
  }

  return (
    <Dialogo aberto={aberto} titulo="Novo lead" aoFechar={aoFechar}>
      <form onSubmit={salvar} className="col" style={{ gap: 13 }}>
          <div className="grid cols-2">
            <div className="field">
              <label className="label" htmlFor="n">Nome completo</label>
              <input id="n" className="input" value={nome} required autoFocus
                     onChange={(e) => setNome(e.target.value)} placeholder="Maria Oliveira" />
            </div>
            <div className="field">
              <label className="label" htmlFor="t">Telefone</label>
              <input id="t" className="input" value={telefone} inputMode="tel"
                     onChange={(e) => setTelefone(e.target.value)} placeholder="(11) 99663-4567" />
              <span className="hint">Usado para nao duplicar o contato.</span>
            </div>
          </div>

          <div className="grid cols-3">
            <div className="field">
              <label className="label" htmlFor="e">E-mail</label>
              <input id="e" className="input" type="email" value={email}
                     onChange={(e) => setEmail(e.target.value)} placeholder="opcional" />
            </div>
            <div className="field">
              <label className="label" htmlFor="o">Origem</label>
              <select id="o" className="select" value={origem} onChange={(e) => setOrigem(e.target.value)}>
                {ORIGENS.map((o) => <option key={o} value={o}>{rotuloOrigem(o)}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="c">Corretor</label>
              <select id="c" className="select" value={corretorId} disabled={!sessao.isAdmin}
                      onChange={(e) => setCorretorId(e.target.value)}>
                {sessao.isAdmin && <option value="">Deixar na fila</option>}
                {pessoas.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select>
              {!sessao.isAdmin && <span className="hint">Leads que voce cria ficam com voce.</span>}
            </div>
          </div>

        <div className="row">
          <button className="btn ghost" type="button" onClick={aoFechar}>Cancelar</button>
          <span className="spacer" />
          <button className="btn primary" type="submit" disabled={salvando || !nome.trim()}>
            {salvando ? "Salvando..." : "Criar lead"}
          </button>
        </div>
      </form>
    </Dialogo>
  );
}
