import { useState } from "react";
import { dinheiro, dinheiroCurto, numero } from "../lib/format";
import {
  empreendimentos, imoveis, mudarStatusImovel, salvarImovel,
  type FiltrosImovel,
} from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import {
  Alerta, CabecalhoDaPagina, Card, Ico, TabelaCarregando, useAsync, useToast,
  Vazio,
} from "../ui";
import FotosImovel from "../FotosImovel";
import Dialogo from "../Dialogo";
import type { Property, PropertyStatus, PropertyType, Sessao } from "../lib/types";

const TIPOS: PropertyType[] = [
  "APARTAMENTO", "CASA", "SOBRADO", "COBERTURA", "TERRENO", "SALA", "GALPAO", "CHACARA",
];

const ROTULO_TIPO: Record<PropertyType, string> = {
  APARTAMENTO: "Apartamento", CASA: "Casa", SOBRADO: "Sobrado",
  COBERTURA: "Cobertura", TERRENO: "Terreno", SALA: "Sala",
  GALPAO: "Galpao", CHACARA: "Chacara",
};

const ROTULO_STATUS: Record<PropertyStatus, string> = {
  AVAILABLE: "Disponivel", RESERVED: "Reservado", SOLD: "Vendido", INACTIVE: "Inativo",
};

const CLASSE_STATUS: Record<PropertyStatus, string> = {
  AVAILABLE: "won", RESERVED: "qualified", SOLD: "proposal", INACTIVE: "",
};

export default function Imoveis({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [f, setF] = useState<FiltrosImovel>({ status: "AVAILABLE" });
  const [editando, setEditando] = useState<Partial<Property> | null>(null);

  const lista = useAsync(() => imoveis(sessao.tenant.id, f), [
    sessao.tenant.id, f.status, f.tipo, f.cidade, f.bairro, f.precoMax, f.quartosMin, f.busca,
  ]);
  const emps = useAsync(() => empreendimentos(sessao.tenant.id), [sessao.tenant.id]);

  const bairros = [...new Set((lista.dado ?? []).map((p) => p.neighborhood).filter(Boolean))];

  async function alternarStatus(p: Property) {
    const novo: PropertyStatus = p.status === "AVAILABLE" ? "INACTIVE" : "AVAILABLE";
    try {
      await mudarStatusImovel(p.id, novo);
      avisar("ok", `Imovel marcado como ${ROTULO_STATUS[novo].toLowerCase()}.`);
      lista.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

  return (
    <>
      <CabecalhoDaPagina
        contexto="Portfolio"
        titulo="Imoveis"
        descricao="O que a imobiliaria tem para vender. E daqui que sai o match do lead."
      />
      <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
        <input
          className="input" style={{ width: "auto", flex: "1 1 200px", maxWidth: 280 }}
          placeholder="Titulo ou codigo"
          value={f.busca ?? ""}
          onChange={(e) => setF((x) => ({ ...x, busca: e.target.value || undefined }))}
          aria-label="Buscar imovel"
        />
        <select className="select" style={{ width: "auto" }} value={f.status ?? ""}
                onChange={(e) => setF((x) => ({ ...x, status: (e.target.value || undefined) as PropertyStatus }))}
                aria-label="Status">
          <option value="">Todos os status</option>
          {(Object.keys(ROTULO_STATUS) as PropertyStatus[]).map((s) => (
            <option key={s} value={s}>{ROTULO_STATUS[s]}</option>
          ))}
        </select>
        <select className="select" style={{ width: "auto" }} value={f.tipo ?? ""}
                onChange={(e) => setF((x) => ({ ...x, tipo: (e.target.value || undefined) as PropertyType }))}
                aria-label="Tipo">
          <option value="">Todos os tipos</option>
          {TIPOS.map((t) => <option key={t} value={t}>{ROTULO_TIPO[t]}</option>)}
        </select>
        <select className="select" style={{ width: "auto" }} value={f.bairro ?? ""}
                onChange={(e) => setF((x) => ({ ...x, bairro: e.target.value || undefined }))}
                aria-label="Bairro">
          <option value="">Todos os bairros</option>
          {bairros.map((b) => <option key={b} value={b!}>{b}</option>)}
        </select>
        <select className="select" style={{ width: "auto" }} value={f.quartosMin ?? ""}
                onChange={(e) => setF((x) => ({ ...x, quartosMin: Number(e.target.value) || undefined }))}
                aria-label="Quartos">
          <option value="">Quartos</option>
          {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}+ quartos</option>)}
        </select>

        <span className="spacer" />
        {sessao.isAdmin && (
          <button className="btn primary" onClick={() => setEditando({ type: "APARTAMENTO", status: "AVAILABLE", features: [] })}>
            {Ico.plus({ size: 15 })} Novo imovel
          </button>
        )}
      </div>

      {editando && sessao.isAdmin && (
        <FormImovel
          sessao={sessao}
          inicial={editando}
          empreendimentos={emps.dado ?? []}
          aoFechar={() => setEditando(null)}
          aoSalvar={() => { setEditando(null); lista.recarregar(); }}
        />
      )}

      {lista.erro && <Alerta>{lista.erro}</Alerta>}

      <Card>
        <div className="card-body flush">
          {lista.carregando ? (
            <TabelaCarregando linhas={6} colunas={6} />
          ) : (lista.dado?.length ?? 0) === 0 ? (
            <Vazio
              icone={Ico.building({ size: 20 })}
              titulo="Nenhum imovel"
              texto={sessao.isAdmin
                ? "Cadastre o primeiro imovel para o matching comecar a sugerir."
                : "A administracao ainda nao cadastrou imoveis."}
            />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Imovel</th><th>Bairro</th><th className="num">Preco</th>
                    <th className="num">Area</th><th className="num">Q / V</th>
                    <th>Status</th>{sessao.isAdmin && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {lista.dado?.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{p.title}</div>
                        <div style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                          {p.code ? `${p.code} · ` : ""}{ROTULO_TIPO[p.type]}
                          {p.development ? ` · ${p.development.name}` : ""}
                        </div>
                      </td>
                      <td className="nowrap">{p.neighborhood ?? "--"}</td>
                      <td className="num nowrap" style={{ fontWeight: 550 }}>
                        {p.price ? dinheiroCurto(p.price) : "--"}
                      </td>
                      <td className="num nowrap">{p.area_m2 ? `${numero(p.area_m2)} m²` : "--"}</td>
                      <td className="num nowrap">
                        {p.bedrooms ?? "--"} / {p.parking_spaces ?? "--"}
                      </td>
                      <td className="nowrap">
                        <span className={`badge ${CLASSE_STATUS[p.status]}`.trim()}>
                          <span className="dot" />{ROTULO_STATUS[p.status]}
                        </span>
                      </td>
                      {sessao.isAdmin && (
                        <td className="nowrap" style={{ width: 1 }}>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn ghost sm" onClick={() => setEditando(p)}>Editar</button>
                            {p.status !== "SOLD" && (
                              <button className="btn ghost sm" onClick={() => alternarStatus(p)}>
                                {p.status === "AVAILABLE" ? "Desativar" : "Ativar"}
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

function FormImovel({
  sessao, inicial, empreendimentos: emps, aoFechar, aoSalvar,
}: {
  sessao: Sessao; inicial: Partial<Property>;
  empreendimentos: { id: string; name: string }[];
  aoFechar: () => void; aoSalvar: () => void;
}) {
  const avisar = useToast();
  const [p, setP] = useState<Partial<Property>>(inicial);
  const [salvando, setSalvando] = useState(false);

  const campo = (k: keyof Property, v: unknown) => setP((x) => ({ ...x, [k]: v }));
  const num = (v: string) => (v === "" ? null : Number(v));

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    try {
      await salvarImovel(sessao.tenant.id, p);
      avisar("ok", p.id ? "Imovel atualizado." : "Imovel cadastrado.");
      aoSalvar();
    } catch (err) {
      avisar("err", mensagemDeErro(err));
      setSalvando(false);
    }
  }

  return (
    <Dialogo
      aberto
      variante="lateral"
      largura={720}
      titulo={p.id ? "Editar imovel" : "Novo imovel"}
      aoFechar={aoFechar}
    >
      <form onSubmit={enviar} className="col" style={{ gap: 13 }}>
          <div className="grid cols-3">
            <div className="field" style={{ gridColumn: "span 2" }}>
              <label className="label">Titulo</label>
              <input className="input" required value={p.title ?? ""}
                     onChange={(e) => campo("title", e.target.value)}
                     placeholder="Vista Residence - Unidade 101" />
            </div>
            <div className="field">
              <label className="label">Codigo interno</label>
              <input className="input" value={p.code ?? ""}
                     onChange={(e) => campo("code", e.target.value)} placeholder="VR-101" />
            </div>
          </div>

          <div className="grid cols-3">
            <div className="field">
              <label className="label">Tipo</label>
              <select className="select" value={p.type ?? "APARTAMENTO"}
                      onChange={(e) => campo("type", e.target.value)}>
                {TIPOS.map((t) => <option key={t} value={t}>{ROTULO_TIPO[t]}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Empreendimento</label>
              <select className="select" value={p.development_id ?? ""}
                      onChange={(e) => campo("development_id", e.target.value || null)}>
                <option value="">Avulso / usado</option>
                {emps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label className="label">Status</label>
              <select className="select" value={p.status ?? "AVAILABLE"}
                      onChange={(e) => campo("status", e.target.value)}>
                {(Object.keys(ROTULO_STATUS) as PropertyStatus[]).map((s) => (
                  <option key={s} value={s}>{ROTULO_STATUS[s]}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid cols-3">
            <div className="field">
              <label className="label">Cidade</label>
              <input className="input" value={p.city ?? ""} onChange={(e) => campo("city", e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Bairro</label>
              <input className="input" value={p.neighborhood ?? ""}
                     onChange={(e) => campo("neighborhood", e.target.value)} />
              <span className="hint">Vale 25 pontos no matching.</span>
            </div>
            <div className="field">
              <label className="label">UF</label>
              <input className="input" maxLength={2} value={p.state ?? ""}
                     onChange={(e) => campo("state", e.target.value.toUpperCase())} />
            </div>
          </div>

          <div className="grid cols-4">
            <div className="field">
              <label className="label">Preco (R$)</label>
              <input className="input" type="number" inputMode="numeric" value={p.price ?? ""}
                     onChange={(e) => campo("price", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Area (m²)</label>
              <input className="input" type="number" value={p.area_m2 ?? ""}
                     onChange={(e) => campo("area_m2", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Condominio</label>
              <input className="input" type="number" value={p.condo_fee ?? ""}
                     onChange={(e) => campo("condo_fee", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Quartos</label>
              <input className="input" type="number" value={p.bedrooms ?? ""}
                     onChange={(e) => campo("bedrooms", num(e.target.value))} />
            </div>
          </div>

          <div className="grid cols-4">
            <div className="field">
              <label className="label">Suites</label>
              <input className="input" type="number" value={p.suites ?? ""}
                     onChange={(e) => campo("suites", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Banheiros</label>
              <input className="input" type="number" value={p.bathrooms ?? ""}
                     onChange={(e) => campo("bathrooms", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Vagas</label>
              <input className="input" type="number" value={p.parking_spaces ?? ""}
                     onChange={(e) => campo("parking_spaces", num(e.target.value))} />
            </div>
            <div className="field">
              <label className="label">Diferenciais</label>
              <input className="input" value={(p.features ?? []).join(", ")}
                     onChange={(e) => campo("features",
                       e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
                     placeholder="piscina, academia" />
            </div>
          </div>

          {p.id ? (
            <div className="field">
              <label className="label">Fotos</label>
              <FotosImovel tenantId={sessao.tenant.id} propertyId={p.id} podeEditar />
            </div>
          ) : (
            <span className="hint">Salve o imovel para poder anexar fotos.</span>
          )}

          <div className="field">
            <label className="label">Descricao</label>
            <textarea className="textarea" value={p.description ?? ""}
                      onChange={(e) => campo("description", e.target.value)} />
          </div>

          <div className="row">
            {p.price != null && <span className="hint">Preco: {dinheiro(p.price)}</span>}
            <span className="spacer" />
            <button className="btn ghost" type="button" onClick={aoFechar}>Cancelar</button>
            <button className="btn primary" type="submit" disabled={salvando || !p.title}>
              {salvando ? "Salvando..." : "Salvar imovel"}
            </button>
          </div>
      </form>
    </Dialogo>
  );
}

export { ROTULO_TIPO, ROTULO_STATUS, CLASSE_STATUS, TIPOS };
