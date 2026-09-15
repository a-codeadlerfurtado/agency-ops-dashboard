import { useState } from "react";
import { corretores } from "../lib/queries";
import { definirMembros, filas, membrosDaFila, salvarFila } from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import Dialogo from "../Dialogo";
import {
  Alerta, Avatar, CabecalhoDaPagina, Card, Ico, Skeleton, useAsync, useToast,
  Vazio,
} from "../ui";
import type { Fila, HorarioFila, Sessao } from "../lib/types";

export default function Distribuicao({ sessao }: { sessao: Sessao }) {
  const [editando, setEditando] = useState<Partial<Fila> | null>(null);
  const lista = useAsync(() => filas(sessao.tenant.id), [sessao.tenant.id]);

  if (lista.erro) return <Alerta>{lista.erro}</Alerta>;

  return (
    <>
      <CabecalhoDaPagina
        contexto="Motor de distribuicao"
        titulo="Distribuicao"
        descricao={"Fila distribui em rodizio. Quem nao aceitar dentro do prazo perde o " +
                   "lead, e ele passa para o proximo — sem cron: um relogio por lead, " +
                   "que so acorda na hora."}
        acoes={
          <button className="btn primary" onClick={() => setEditando({ acceptance_timeout_seconds: 300 })}>
            {Ico.plus({ size: 15 })} Nova fila
          </button>
        }
      />

      {editando && (
        <FormFila
          sessao={sessao}
          inicial={editando}
          aoFechar={() => setEditando(null)}
          aoSalvar={() => { setEditando(null); lista.recarregar(); }}
        />
      )}

      {lista.carregando ? (
        <Card><div className="card-body"><Skeleton h={90} /></div></Card>
      ) : (lista.dado?.length ?? 0) === 0 ? (
        <Card>
          <Vazio
            icone={Ico.users({ size: 20 })}
            titulo="Nenhuma fila"
            texto="Sem fila, o lead que chega por anuncio fica sem dono ate alguem distribuir na mao."
          />
        </Card>
      ) : (
        lista.dado?.map((f) => (
          <CardFila key={f.id} fila={f} sessao={sessao} aoEditar={() => setEditando(f)} />
        ))
      )}
    </>
  );
}

function CardFila({
  fila, sessao, aoEditar,
}: { fila: Fila; sessao: Sessao; aoEditar: () => void }) {
  const avisar = useToast();
  const [salvando, setSalvando] = useState(false);

  const dados = useAsync(
    async () => ({
      membros: await membrosDaFila(fila.id),
      pessoas: await corretores(sessao.tenant.id),
    }),
    [fila.id, sessao.tenant.id]
  );

  const membros = dados.dado?.membros ?? [];
  const naFila = new Set(membros.map((m) => m.user_id));
  const foraDaFila = (dados.dado?.pessoas ?? []).filter((p) => !naFila.has(p.id));

  // proximo do rodizio: o primeiro com sort_order maior que o cursor
  const proximo =
    membros.find((m) => m.active && m.sort_order > fila.cursor_sort_order) ??
    membros.find((m) => m.active);
  const ultimo = membros.find((m) => m.sort_order === fila.cursor_sort_order);

  async function reordenar(ids: string[]) {
    setSalvando(true);
    try {
      await definirMembros(sessao.tenant.id, fila.id, ids);
      avisar("ok", "Fila atualizada.");
      dados.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    } finally {
      setSalvando(false);
    }
  }

  const ordem = membros.map((m) => m.user_id);

  return (
    <Card>
      <div className="card-head">
        <h2>{fila.name}</h2>
        <span className={`badge ${fila.status === "ACTIVE" ? "won" : ""}`.trim()}>
          <span className="dot" />{fila.status === "ACTIVE" ? "Ativa" : "Inativa"}
        </span>
        <span className="badge">
          {Ico.clock({ size: 12 })} aceite em {Math.round(fila.acceptance_timeout_seconds / 60)} min
        </span>
        <span className="badge">{descreveHorario(fila.working_hours)}</span>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={aoEditar}>Configurar</button>
      </div>

      <div className="card-body">
        {dados.carregando ? (
          <Skeleton h={70} />
        ) : (
          <>
            <div className="grid cols-2" style={{ marginBottom: 14 }}>
              <div className="col" style={{ gap: 2 }}>
                <span className="stat-label">Ultimo a receber</span>
                <div className="row" style={{ gap: 7 }}>
                  <Avatar nome={ultimo?.profile?.full_name} />
                  <span style={{ fontSize: 13.5 }}>
                    {ultimo?.profile?.full_name ?? "ninguem ainda"}
                  </span>
                </div>
              </div>
              <div className="col" style={{ gap: 2 }}>
                <span className="stat-label">Proximo da vez</span>
                <div className="row" style={{ gap: 7 }}>
                  <Avatar nome={proximo?.profile?.full_name} />
                  <span style={{ fontSize: 13.5, color: "var(--accent-light)", fontWeight: 550 }}>
                    {proximo?.profile?.full_name ?? "fila vazia"}
                  </span>
                </div>
              </div>
            </div>

            {membros.length === 0 ? (
              <div className="alert warn">
                Fila sem corretor. Lead que cair aqui fica sem dono.
              </div>
            ) : (
              <div className="col" style={{ gap: 7 }}>
                {membros.map((m, i) => (
                  <div key={m.id} className="row" style={{
                    gap: 9, padding: "8px 11px", borderRadius: "var(--r)",
                    background: "var(--panel-2)", border: "1px solid var(--line-soft)",
                  }}>
                    <span className="num" style={{
                      width: 18, fontSize: 12, color: "var(--text-subtle)", fontWeight: 600,
                    }}>{i + 1}</span>
                    <Avatar nome={m.profile?.full_name} />
                    <span style={{ fontSize: 13.5 }}>{m.profile?.full_name ?? "--"}</span>
                    <span className="spacer" />
                    <button className="btn ghost sm" disabled={i === 0 || salvando}
                            onClick={() => {
                              const n = [...ordem];
                              [n[i - 1], n[i]] = [n[i]!, n[i - 1]!];
                              reordenar(n);
                            }}>
                      subir
                    </button>
                    <button className="btn ghost sm" disabled={i === membros.length - 1 || salvando}
                            onClick={() => {
                              const n = [...ordem];
                              [n[i], n[i + 1]] = [n[i + 1]!, n[i]!];
                              reordenar(n);
                            }}>
                      descer
                    </button>
                    <button className="btn ghost sm" disabled={salvando}
                            onClick={() => reordenar(ordem.filter((x) => x !== m.user_id))}>
                      remover
                    </button>
                  </div>
                ))}
              </div>
            )}

            {foraDaFila.length > 0 && (
              <div className="row" style={{ gap: 7, marginTop: 12, flexWrap: "wrap" }}>
                <span className="hint">Adicionar:</span>
                {foraDaFila.map((p) => (
                  <button key={p.id} className="btn sm" disabled={salvando}
                          onClick={() => reordenar([...ordem, p.id])}>
                    {Ico.plus({ size: 13 })} {p.full_name}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

const DIAS = [
  { n: 1, r: "Seg" }, { n: 2, r: "Ter" }, { n: 3, r: "Qua" },
  { n: 4, r: "Qui" }, { n: 5, r: "Sex" }, { n: 6, r: "Sab" }, { n: 7, r: "Dom" },
];

/** Resume o expediente numa frase curta para o cabecalho da fila. */
function descreveHorario(h: Fila["working_hours"]): string {
  const w = h as HorarioFila | undefined;
  if (!w || !w.inicio || !w.dias?.length) return "atende 24h";
  const nomes = DIAS.filter((d) => w.dias.includes(d.n)).map((d) => d.r);
  const primeiro = nomes[0] ?? "";
  const ultimo = nomes[nomes.length - 1] ?? "";
  const ordenados = [...w.dias].sort((a, b) => a - b);
  const contiguo =
    ordenados.length > 2 &&
    ordenados.every((d, i) => i === 0 || d === (ordenados[i - 1] ?? d) + 1);
  const seq = contiguo ? primeiro + " a " + ultimo : nomes.join(", ");
  return seq + " " + w.inicio + "-" + w.fim;
}

function FormFila({
  sessao, inicial, aoFechar, aoSalvar,
}: {
  sessao: Sessao; inicial: Partial<Fila>;
  aoFechar: () => void; aoSalvar: () => void;
}) {
  const avisar = useToast();
  const [nome, setNome] = useState(inicial.name ?? "");
  const [minutos, setMinutos] = useState(
    String(Math.round((inicial.acceptance_timeout_seconds ?? 300) / 60))
  );
  const [ativa, setAtiva] = useState((inicial.status ?? "ACTIVE") === "ACTIVE");
  const h0 = inicial.working_hours as HorarioFila | undefined;
  const [limitaHorario, setLimitaHorario] = useState(Boolean(h0?.inicio));
  const [dias, setDias] = useState<number[]>(h0?.dias ?? [1, 2, 3, 4, 5]);
  const [horaIni, setHoraIni] = useState(h0?.inicio ?? "09:00");
  const [horaFim, setHoraFim] = useState(h0?.fim ?? "19:00");
  const [salvando, setSalvando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setSalvando(true);
    try {
      await salvarFila(sessao.tenant.id, {
        id: inicial.id,
        name: nome.trim(),
        acceptance_timeout_seconds: Math.max(Number(minutos) * 60, 30),
        status: ativa ? "ACTIVE" : "INACTIVE",
        working_hours: limitaHorario && dias.length
          ? { dias: [...dias].sort((a, b) => a - b), inicio: horaIni, fim: horaFim }
          : {},
      });
      avisar("ok", "Fila salva.");
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
      largura={620}
      titulo={inicial.id ? "Configurar fila" : "Nova fila"}
      aoFechar={aoFechar}
    >
      <form onSubmit={enviar} className="col" style={{ gap: 13 }}>
          <div className="grid cols-3">
            <div className="field" style={{ gridColumn: "span 2" }}>
              <label className="label">Nome da fila</label>
              <input className="input" required autoFocus value={nome}
                     onChange={(e) => setNome(e.target.value)}
                     placeholder="Plantao Vista Residence" />
            </div>
            <div className="field">
              <label className="label">Tempo para aceitar</label>
              <select className="select" value={minutos} onChange={(e) => setMinutos(e.target.value)}>
                {[1, 3, 5, 10, 15, 30, 60].map((m) => (
                  <option key={m} value={m}>{m} minuto{m > 1 ? "s" : ""}</option>
                ))}
              </select>
              <span className="hint">Passou disso, o lead vai para o proximo.</span>
            </div>
          </div>
          <label className="row" style={{ gap: 8, fontSize: 13.5, cursor: "pointer" }}>
            <input type="checkbox" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} />
            Fila ativa
          </label>

          <div style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 13 }}>
            <span className="eyebrow">Horario de atendimento</span>
            <label className="row" style={{ gap: 8, fontSize: 13.5, cursor: "pointer", marginBottom: 10 }}>
              <input type="checkbox" checked={limitaHorario}
                     onChange={(e) => setLimitaHorario(e.target.checked)} />
              Contar o prazo so dentro do expediente
            </label>

            {limitaHorario && (
              <>
                <div className="row" style={{ gap: 5, flexWrap: "wrap", marginBottom: 11 }}>
                  {DIAS.map((d) => (
                    <button key={d.n} type="button"
                            className={dias.includes(d.n) ? "btn sm" : "btn ghost sm"}
                            onClick={() => setDias((v) =>
                              v.includes(d.n) ? v.filter((x) => x !== d.n) : [...v, d.n])}>
                      {d.r}
                    </button>
                  ))}
                </div>
                <div className="grid cols-2">
                  <div className="field">
                    <label className="label">Abre</label>
                    <input className="input" type="time" value={horaIni}
                           onChange={(e) => setHoraIni(e.target.value)} />
                  </div>
                  <div className="field">
                    <label className="label">Fecha</label>
                    <input className="input" type="time" value={horaFim}
                           onChange={(e) => setHoraFim(e.target.value)} />
                  </div>
                </div>
                <span className="hint" style={{ display: "block", marginTop: 8 }}>
                  Lead que chega fora do expediente e atribuido na hora, mas o
                  relogio so comeca quando abre. Sexta as 20h vira segunda as {horaIni}.
                </span>
              </>
            )}
          </div>
          <div className="row">
            <span className="spacer" />
            <button className="btn ghost" type="button" onClick={aoFechar}>Cancelar</button>
            <button className="btn primary" type="submit" disabled={salvando || !nome.trim()}>
              {salvando ? "Salvando..." : "Salvar fila"}
            </button>
          </div>
      </form>
    </Dialogo>
  );
}
