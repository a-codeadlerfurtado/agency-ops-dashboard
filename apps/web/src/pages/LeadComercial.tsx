import { useState } from "react";
import { dinheiro, dinheiroCurto, numero, relativo } from "../lib/format";
import {
  aceitarLead, agendarVisita, atribuicaoPendente, criarProposta, imoveis,
  interesse, matches, registrarVenda, salvarInteresse,
} from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import { Alerta, Card, Ico, Skeleton, useAsync, useToast } from "../ui";
import { ROTULO_TIPO, TIPOS } from "./Imoveis";
import type {
  LeadInterest, Match, MotivoMatch, Property, PropertyType, Sessao,
} from "../lib/types";

/* ================================================= aceite do lead (30) === */

export function AvisoDeAceite({ oppId, aoAceitar }: { oppId: string; aoAceitar: () => void }) {
  const avisar = useToast();
  const [aceitando, setAceitando] = useState(false);
  const p = useAsync(() => atribuicaoPendente(oppId), [oppId]);

  if (!p.dado) return null;

  const restam = Math.max(0, Math.round((new Date(p.dado.expires_at).getTime() - Date.now()) / 1000));

  async function assumir() {
    setAceitando(true);
    try {
      await aceitarLead(p.dado!.id);
      avisar("ok", "Lead assumido.");
      aoAceitar();
      p.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
      setAceitando(false);
    }
  }

  return (
    <div className="alert warn" style={{ alignItems: "center" }}>
      <span style={{ flexShrink: 0 }}>{Ico.fire({ size: 16 })}</span>
      <div style={{ flex: 1 }}>
        <b>Lead aguardando seu aceite.</b>{" "}
        {restam > 0
          ? `Voce tem ${restam < 60 ? `${restam} segundos` : `${Math.round(restam / 60)} minutos`} antes de ele ser repassado.`
          : "O prazo estourou; ele pode ser repassado a qualquer momento."}
      </div>
      <button className="btn primary sm" onClick={assumir} disabled={aceitando}>
        {aceitando ? "..." : "Assumir lead"}
      </button>
    </div>
  );
}

/* ==================================================== perfil de interesse === */

const VAZIO = (oppId: string): LeadInterest => ({
  opportunity_id: oppId,
  purchase_purpose: "INDEFINIDO",
  property_type: null,
  cities: [], neighborhoods: [],
  min_price: null, max_price: null, min_area: null, max_area: null,
  min_bedrooms: null, min_suites: null, min_parking_spaces: null,
  financing_needed: null, down_payment: null,
  purchase_timeframe: null, notes: null,
});

export function PainelInteresse({
  sessao, oppId, aoSalvar,
}: { sessao: Sessao; oppId: string; aoSalvar: () => void }) {
  const avisar = useToast();
  const atual = useAsync(() => interesse(oppId), [oppId]);
  const [editando, setEditando] = useState(false);
  const [i, setI] = useState<LeadInterest | null>(null);
  const [salvando, setSalvando] = useState(false);

  const dados = i ?? atual.dado ?? null;
  const campo = (k: keyof LeadInterest, v: unknown) =>
    setI({ ...(dados ?? VAZIO(oppId)), [k]: v } as LeadInterest);
  const num = (v: string) => (v === "" ? null : Number(v));
  const lista = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    try {
      await salvarInteresse(sessao.tenant.id, { ...(dados ?? VAZIO(oppId)), opportunity_id: oppId });
      avisar("ok", "Interesse salvo. O matching ja reflete.");
      setEditando(false);
      setI(null);
      atual.recarregar();
      aoSalvar();
    } catch (err) {
      avisar("err", mensagemDeErro(err));
    } finally {
      setSalvando(false);
    }
  }

  if (atual.carregando && !atual.dado) {
    return <Card><div className="card-body"><Skeleton h={80} /></div></Card>;
  }

  if (!editando) {
    const d = atual.dado;
    return (
      <Card>
        <div className="card-head">
          <h2>Interesse</h2>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={() => { setI(d ?? VAZIO(oppId)); setEditando(true); }}>
            {d ? "Editar" : "Preencher"}
          </button>
        </div>
        <div className="card-body">
          {!d ? (
            <div className="hint">
              Sem perfil de interesse. O matching precisa dele para sugerir imovel.
            </div>
          ) : (
            <dl className="kv">
              <dt>Objetivo</dt><dd>{d.purchase_purpose === "MORAR" ? "Morar" : d.purchase_purpose === "INVESTIR" ? "Investir" : "Indefinido"}</dd>
              <dt>Tipo</dt><dd>{d.property_type ? ROTULO_TIPO[d.property_type] : "--"}</dd>
              <dt>Bairros</dt><dd>{d.neighborhoods.length ? d.neighborhoods.join(", ") : "--"}</dd>
              <dt>Faixa</dt>
              <dd>{d.max_price ? `ate ${dinheiroCurto(d.max_price)}` : "--"}</dd>
              <dt>Minimos</dt>
              <dd>
                {[d.min_bedrooms && `${d.min_bedrooms} quartos`,
                  d.min_parking_spaces && `${d.min_parking_spaces} vagas`,
                  d.min_area && `${numero(d.min_area)} m²`]
                  .filter(Boolean).join(" · ") || "--"}
              </dd>
              <dt>Financia</dt>
              <dd>{d.financing_needed == null ? "--" : d.financing_needed ? "Sim" : "Nao"}</dd>
            </dl>
          )}
        </div>
      </Card>
    );
  }

  const d = dados ?? VAZIO(oppId);
  return (
    <Card>
      <div className="card-head">
        <h2>Interesse</h2>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={() => { setEditando(false); setI(null); }}>
          Cancelar
        </button>
      </div>
      <div className="card-body">
        <form onSubmit={enviar} className="col" style={{ gap: 11 }}>
          <div className="grid cols-2">
            <div className="field">
              <label className="label">Objetivo</label>
              <select className="select" value={d.purchase_purpose}
                      onChange={(e) => campo("purchase_purpose", e.target.value)}>
                <option value="INDEFINIDO">Indefinido</option>
                <option value="MORAR">Morar</option>
                <option value="INVESTIR">Investir</option>
              </select>
            </div>
            <div className="field">
              <label className="label">Tipo de imovel</label>
              <select className="select" value={d.property_type ?? ""}
                      onChange={(e) => campo("property_type", (e.target.value || null) as PropertyType)}>
                <option value="">Qualquer</option>
                {TIPOS.map((t) => <option key={t} value={t}>{ROTULO_TIPO[t]}</option>)}
              </select>
            </div>
          </div>

          <div className="field">
            <label className="label">Bairros de interesse</label>
            <input className="input" value={d.neighborhoods.join(", ")}
                   onChange={(e) => campo("neighborhoods", lista(e.target.value))}
                   placeholder="Aquarius, Jardins" />
            <span className="hint">Separe por virgula. Maior peso do matching.</span>
          </div>

          <div className="grid cols-2">
            <div className="field">
              <label className="label">Ate quanto (R$)</label>
              <input className="input" type="number" value={d.max_price ?? ""}
                     onChange={(e) => campo("max_price", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Area minima (m²)</label>
              <input className="input" type="number" value={d.min_area ?? ""}
                     onChange={(e) => campo("min_area", num(e.target.value))} />
            </div>
          </div>

          <div className="grid cols-3">
            <div className="field">
              <label className="label">Quartos min.</label>
              <input className="input" type="number" value={d.min_bedrooms ?? ""}
                     onChange={(e) => campo("min_bedrooms", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Vagas min.</label>
              <input className="input" type="number" value={d.min_parking_spaces ?? ""}
                     onChange={(e) => campo("min_parking_spaces", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Entrada (R$)</label>
              <input className="input" type="number" value={d.down_payment ?? ""}
                     onChange={(e) => campo("down_payment", num(e.target.value))} />
            </div>
          </div>

          <label className="row" style={{ gap: 8, fontSize: 13, cursor: "pointer" }}>
            <input type="checkbox" checked={d.financing_needed ?? false}
                   onChange={(e) => campo("financing_needed", e.target.checked)} />
            Precisa de financiamento
          </label>

          <button className="btn primary wide" type="submit" disabled={salvando}>
            {salvando ? "Salvando..." : "Salvar interesse"}
          </button>
        </form>
      </div>
    </Card>
  );
}

/* ============================================================ matching === */

const ROTULO_CRITERIO: Record<MotivoMatch["criterio"], string> = {
  bairro: "bairro", preco: "preco", tipo: "tipo",
  quartos: "quartos", area: "metragem", vagas: "vagas",
};

export function PainelMatching({
  oppId, chave, aoEscolher,
}: { oppId: string; chave: number; aoEscolher: (p: Match) => void }) {
  const lista = useAsync(() => matches(oppId, 6), [oppId, chave]);

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  return (
    <Card>
      <div className="card-head">
        <h2>Imoveis compativeis</h2>
        <span className="spacer" />
        <span className="badge">score deterministico</span>
      </div>
      <div className="card-body">
        {lista.carregando ? (
          <div className="col" style={{ gap: 10 }}>
            <Skeleton h={52} /><Skeleton h={52} />
          </div>
        ) : (lista.dado?.length ?? 0) === 0 ? (
          <div className="hint">
            Nenhum imovel compativel. Preencha o interesse ao lado, ou cadastre imoveis.
          </div>
        ) : (
          <div className="col" style={{ gap: 9 }}>
            {lista.dado?.map((m) => (
              <div key={m.property_id} style={{
                border: "1px solid var(--line-soft)", borderRadius: "var(--r)",
                padding: "10px 12px", background: "var(--panel-2)",
              }}>
                <div className="row" style={{ gap: 10 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 550, fontSize: 13.5 }}>{m.titulo}</div>
                    <div style={{ fontSize: 12, color: "var(--text-subtle)", marginTop: 1 }}>
                      {[m.bairro, m.preco && dinheiroCurto(m.preco),
                        m.area_m2 && `${numero(m.area_m2)} m²`,
                        m.quartos && `${m.quartos}q`, m.vagas && `${m.vagas}v`]
                        .filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <Score valor={m.score} />
                </div>

                {/* Sem os motivos o corretor nao consegue defender a sugestao
                    na frente do cliente. Score sozinho ninguem usa. */}
                <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                  {m.motivos?.map((mo) => (
                    <span key={mo.criterio} style={{
                      fontSize: 11.5,
                      color: mo.situacao === "atende" ? "var(--success)"
                           : mo.situacao === "parcial" ? "var(--warning)" : "var(--text-subtle)",
                    }}>
                      {mo.situacao === "atende" ? "✓" : mo.situacao === "parcial" ? "~" : "✕"}{" "}
                      {ROTULO_CRITERIO[mo.criterio]}
                    </span>
                  ))}
                  <span className="spacer" />
                  <button className="btn ghost sm" onClick={() => aoEscolher(m)}>
                    Usar este {Ico.arrow({ size: 13 })}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function Score({ valor }: { valor: number }) {
  const cor = valor >= 85 ? "var(--success)" : valor >= 60 ? "var(--warning)" : "var(--muted)";
  return (
    <div style={{ textAlign: "right", flexShrink: 0 }}>
      <div className="num" style={{ fontSize: 19, fontWeight: 650, color: cor, lineHeight: 1 }}>
        {valor}%
      </div>
      <div style={{ fontSize: 10.5, color: "var(--text-subtle)" }}>compativel</div>
    </div>
  );
}

/* =================================================== acoes comerciais === */

type Acao = "visita" | "proposta" | "venda" | null;

export function AcoesComerciais({
  sessao, oppId, imovelSugerido, aoConcluir,
}: {
  sessao: Sessao; oppId: string;
  imovelSugerido: Match | null;
  aoConcluir: () => void;
}) {
  const avisar = useToast();
  const [acao, setAcao] = useState<Acao>(null);
  const [salvando, setSalvando] = useState(false);

  const [quando, setQuando] = useState("");
  const [valor, setValor] = useState("");
  const [entrada, setEntrada] = useState("");
  const [notas, setNotas] = useState("");
  const [imovelId, setImovelId] = useState<string>("");

  const opcoes = useAsync(
    () => imoveis(sessao.tenant.id, { status: "AVAILABLE" }, 100),
    [sessao.tenant.id]
  );

  const escolhido = imovelId || imovelSugerido?.property_id || "";

  function limpar() {
    setAcao(null); setQuando(""); setValor(""); setEntrada(""); setNotas(""); setImovelId("");
  }

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    try {
      if (acao === "visita") {
        await agendarVisita({
          oppId, quando: new Date(quando).toISOString(),
          propertyId: escolhido || null, notas,
        });
        avisar("ok", "Visita agendada.");
      } else if (acao === "proposta") {
        await criarProposta({
          oppId, valor: Number(valor), propertyId: escolhido || null,
          entrada: entrada ? Number(entrada) : null, notas,
        });
        avisar("ok", "Proposta criada.");
      } else if (acao === "venda") {
        await registrarVenda({ oppId, valor: Number(valor), propertyId: escolhido || null });
        avisar("ok", "Venda registrada. VGV atualizado.");
      }
      limpar();
      aoConcluir();
    } catch (err) {
      avisar("err", mensagemDeErro(err));
    } finally {
      setSalvando(false);
    }
  }

  const seletorImovel = (
    <div className="field">
      <label className="label">Imovel</label>
      <select className="select" value={escolhido} onChange={(e) => setImovelId(e.target.value)}>
        <option value="">Sem imovel definido</option>
        {opcoes.dado?.map((p: Property) => (
          <option key={p.id} value={p.id}>
            {p.title}{p.price ? ` — ${dinheiroCurto(p.price)}` : ""}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Card>
      <div className="card-head">
        <h2>Avancar o negocio</h2>
      </div>
      <div className="card-body">
        {acao === null ? (
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => setAcao("visita")}>
              {Ico.building({ size: 15 })} Agendar visita
            </button>
            <button className="btn" onClick={() => setAcao("proposta")}>
              {Ico.note({ size: 15 })} Criar proposta
            </button>
            <button className="btn primary" onClick={() => setAcao("venda")}>
              {Ico.trophy({ size: 15 })} Registrar venda
            </button>
          </div>
        ) : (
          <form onSubmit={enviar} className="col" style={{ gap: 11 }}>
            {acao === "visita" && (
              <>
                <div className="grid cols-2">
                  <div className="field">
                    <label className="label">Data e hora</label>
                    <input className="input" type="datetime-local" required autoFocus
                           value={quando} onChange={(e) => setQuando(e.target.value)} />
                  </div>
                  {seletorImovel}
                </div>
                <div className="field">
                  <label className="label">Observacao</label>
                  <input className="input" value={notas} onChange={(e) => setNotas(e.target.value)}
                         placeholder="Encontrar na portaria" />
                </div>
              </>
            )}

            {acao === "proposta" && (
              <>
                <div className="grid cols-3">
                  <div className="field">
                    <label className="label">Valor ofertado (R$)</label>
                    <input className="input" type="number" required autoFocus value={valor}
                           onChange={(e) => setValor(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="label">Entrada (R$)</label>
                    <input className="input" type="number" value={entrada}
                           onChange={(e) => setEntrada(e.target.value)} />
                  </div>
                  {seletorImovel}
                </div>
                <div className="field">
                  <label className="label">Condicoes</label>
                  <input className="input" value={notas} onChange={(e) => setNotas(e.target.value)}
                         placeholder="Financiamento Caixa, 30 anos" />
                </div>
              </>
            )}

            {acao === "venda" && (
              <>
                <div className="alert warn">
                  Registrar venda fecha a oportunidade, marca o imovel como vendido
                  e soma no VGV. Cancelar depois so o administrador.
                </div>
                <div className="grid cols-2">
                  <div className="field">
                    <label className="label">Valor final (R$)</label>
                    <input className="input" type="number" required autoFocus value={valor}
                           onChange={(e) => setValor(e.target.value)} />
                    {valor && <span className="hint">{dinheiro(Number(valor))}</span>}
                  </div>
                  {seletorImovel}
                </div>
              </>
            )}

            <div className="row">
              <button className="btn ghost sm" type="button" onClick={limpar}>Cancelar</button>
              <span className="spacer" />
              <button className={`btn ${acao === "venda" ? "primary" : ""}`.trim()}
                      type="submit" disabled={salvando}>
                {salvando ? "Salvando..."
                  : acao === "visita" ? "Agendar"
                  : acao === "proposta" ? "Criar proposta" : "Confirmar venda"}
              </button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
