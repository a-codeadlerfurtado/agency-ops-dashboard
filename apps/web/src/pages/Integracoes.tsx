import { useState } from "react";
import { dataHora, relativo } from "../lib/format";
import {
  atualizarFonte, criarFonte, filas, fontesDeLead, regerarTokenDaFonte,
  type FonteDeLead,
} from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import Dialogo from "../Dialogo";
import {
  Alerta, CabecalhoDaPagina, Card, CardsCarregando, Ico, useAsync, useToast, Vazio,
} from "../ui";
import type { Sessao } from "../lib/types";

const BASE = (import.meta.env.VITE_INGEST_URL ?? "").replace(/\/+$/, "");

const CANAIS = {
  META_ADS: {
    nome: "Meta Lead Ads",
    caminho: "meta",
    resumo: "Facebook e Instagram. O lead cai no CRM no segundo em que a pessoa envia o formulario.",
  },
  SITE: {
    nome: "Site / Landing page",
    caminho: "site",
    resumo: "Formulario do seu site manda um POST e o lead entra distribuido.",
  },
  WEBHOOK: {
    nome: "Webhook generico",
    caminho: "webhook",
    resumo: "Zapier, Make, n8n, RD Station: qualquer coisa que saiba mandar JSON.",
  },
} as const;

type Canal = keyof typeof CANAIS;

const urlDeCallback = (canal: Canal, token: string) =>
  `${BASE}/v1/ingest/leads/${CANAIS[canal].caminho}?k=${token}`;

/* ------------------------------------------------------- utilidades --- */

function Copiavel({ rotulo, valor, dica }: { rotulo: string; valor: string; dica?: string }) {
  const avisar = useToast();
  return (
    <div className="field">
      <label className="label">{rotulo}</label>
      <div className="row" style={{ gap: 6, alignItems: "stretch" }}>
        <input
          className="input" readOnly value={valor}
          onFocus={(e) => e.currentTarget.select()}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 12.5 }}
        />
        <button
          type="button" className="btn"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(valor);
              avisar("ok", rotulo + " copiado.");
            } catch {
              avisar("err", "O navegador bloqueou a copia. Selecione e copie na mao.");
            }
          }}
        >
          Copiar
        </button>
      </div>
      {dica && <span className="hint">{dica}</span>}
    </div>
  );
}

function Passo({ n, titulo, children }: { n: number; titulo: string; children?: React.ReactNode }) {
  return (
    <div className="row" style={{ alignItems: "flex-start", gap: 11 }}>
      <span
        className="num"
        style={{
          flexShrink: 0, width: 22, height: 22, borderRadius: 99,
          display: "grid", placeItems: "center", fontSize: 11.5, fontWeight: 600,
          background: "var(--blue-soft)", color: "var(--blue)",
          border: "1px solid #3e92dc3d",
        }}
      >
        {n}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 550, marginBottom: children ? 6 : 0 }}>{titulo}</div>
        {children}
      </div>
    </div>
  );
}

/* --------------------------------------------------- estado da fonte --- */

function situacao(f: FonteDeLead) {
  if (!f.active) return { texto: "Desativada", classe: "lost" as const };
  if (f.integration === "META_ADS" && !f.tem_token_da_pagina) {
    return { texto: "Falta o token da pagina", classe: "warn" as const };
  }
  if (f.last_error_at && (!f.last_used_at || f.last_error_at > f.last_used_at)) {
    return { texto: "Com erro", classe: "lost" as const };
  }
  if (f.last_used_at) return { texto: "Recebendo", classe: "won" as const };
  return { texto: "Aguardando o primeiro lead", classe: "" as const };
}

/* ------------------------------------------------------------ tela --- */

export default function Integracoes({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [novo, setNovo] = useState<Canal | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);
  const [tokenNovo, setTokenNovo] = useState<{ id: string; token: string } | null>(null);

  const dados = useAsync(
    async () => ({
      fontes: await fontesDeLead(),
      listaDeFilas: await filas(sessao.tenant.id),
    }),
    [sessao.tenant.id]
  );

  if (dados.erro) return <Alerta>{dados.erro}</Alerta>;
  if (!dados.dado) return <CardsCarregando n={3} />;

  const { fontes, listaDeFilas } = dados.dado;

  async function conectar(canal: Canal, nome: string, queueId: string | null) {
    try {
      const r = await criarFonte(canal, nome, queueId);
      setNovo(null);
      setTokenNovo({ id: r.id, token: r.token });
      setAberta(r.id);
      dados.recarregar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

  return (
    <>
      <CabecalhoDaPagina
        contexto="Entrada de leads"
        titulo="Integracoes"
        descricao="Conecte o anuncio ao CRM. O lead entra, cai na fila e o relogio do SLA comeca sozinho."
      />

      {!BASE && (
        <Alerta>
          O endereco do servico de ingestao nao esta configurado nesta instalacao
          (VITE_INGEST_URL). As URLs abaixo vao sair incompletas.
        </Alerta>
      )}

      {/* canais disponiveis */}
      <div className="grid cols-3">
        {(Object.keys(CANAIS) as Canal[]).map((c) => {
          const ativas = fontes.filter((f) => f.integration === c && f.active).length;
          return (
            <Card key={c}>
              <div className="card-body">
                <div className="row" style={{ gap: 9, marginBottom: 8 }}>
                  <span className="empty-icon" style={{ width: 30, height: 30, margin: 0, borderRadius: 9 }}>
                    {c === "META_ADS" ? Ico.fire({ size: 15 })
                      : c === "SITE" ? Ico.building({ size: 15 })
                      : Ico.arrow({ size: 15 })}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{CANAIS[c].nome}</div>
                    <div style={{ fontSize: 11.5, color: "var(--text-subtle)" }}>
                      {ativas === 0 ? "nao conectado"
                        : ativas + " conexao" + (ativas === 1 ? "" : "es")}
                    </div>
                  </div>
                </div>
                <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 12px" }}>
                  {CANAIS[c].resumo}
                </p>
                <button className="btn sm primary" onClick={() => setNovo(c)}>
                  {Ico.plus({ size: 14 })} Conectar
                </button>
              </div>
            </Card>
          );
        })}
      </div>

      {/* conexoes existentes */}
      {fontes.length === 0 ? (
        <Card>
          <Vazio
            icone={Ico.arrow({ size: 20 })}
            titulo="Nenhuma conexao ainda"
            texto="Conecte a Meta para o lead do anuncio entrar direto na fila, sem planilha no meio."
          />
        </Card>
      ) : (
        fontes.map((f) => (
          <Conexao
            key={f.id}
            fonte={f}
            filas={listaDeFilas}
            aberta={aberta === f.id}
            tokenNovo={tokenNovo?.id === f.id ? tokenNovo.token : null}
            aoAbrir={() => setAberta(aberta === f.id ? null : f.id)}
            aoMudar={() => dados.recarregar()}
            aoNovoToken={(t) => setTokenNovo({ id: f.id, token: t })}
          />
        ))
      )}

      <FormularioDeConexao
        canal={novo}
        filas={listaDeFilas}
        aoFechar={() => setNovo(null)}
        aoCriar={conectar}
      />
    </>
  );
}

/* ------------------------------------------------------- conexao --- */

function Conexao({
  fonte, filas: listaDeFilas, aberta, tokenNovo, aoAbrir, aoMudar, aoNovoToken,
}: {
  fonte: FonteDeLead;
  filas: { id: string; name: string }[];
  aberta: boolean;
  tokenNovo: string | null;
  aoAbrir: () => void;
  aoMudar: () => void;
  aoNovoToken: (t: string) => void;
}) {
  const avisar = useToast();
  const [tokenPagina, setTokenPagina] = useState("");
  const [salvando, setSalvando] = useState(false);
  const st = situacao(fonte);
  const canal = CANAIS[fonte.integration];

  async function mexer(fn: () => Promise<void>) {
    setSalvando(true);
    try { await fn(); aoMudar(); }
    catch (e) { avisar("err", mensagemDeErro(e)); }
    finally { setSalvando(false); }
  }

  return (
    <Card>
      <div className="card-head">
        <h2>{fonte.label}</h2>
        <span className={`badge ${st.classe}`.trim()}>
          <span className="dot" />{st.texto}
        </span>
        <span className="badge">{canal.nome}</span>
        <span className="spacer" />
        <span style={{ fontSize: 12.5, color: "var(--text-subtle)" }} className="some-no-mobile">
          {fonte.leads} lead{fonte.leads === 1 ? "" : "s"}
          {fonte.last_used_at ? ` · ultimo ${relativo(fonte.last_used_at)}` : ""}
        </span>
        <button className="btn ghost sm" onClick={aoAbrir}>
          {aberta ? "Fechar" : "Configurar"}
        </button>
      </div>

      {fonte.last_error && st.classe === "lost" && (
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <Alerta>
            {fonte.last_error}
            {fonte.last_error_at && ` (${dataHora(fonte.last_error_at)})`}
          </Alerta>
        </div>
      )}

      {aberta && (
        <div className="card-body col" style={{ gap: 16 }}>
          {tokenNovo ? (
            <>
              <Alerta tipo="warn">
                Este token aparece uma unica vez. Termine a configuracao agora --
                depois de fechar, so gerando outro.
              </Alerta>
              <Copiavel
                rotulo="URL de callback"
                valor={urlDeCallback(fonte.integration, tokenNovo)}
                dica="Cole no campo URL de retorno de chamada."
              />
              {fonte.integration === "META_ADS" && (
                <Copiavel
                  rotulo="Token de verificacao"
                  valor={tokenNovo}
                  dica="O mesmo valor que ja esta no fim da URL. A Meta pede nos dois campos."
                />
              )}
            </>
          ) : (
            <Alerta tipo="warn">
              A URL de callback contem o token e por isso nao pode ser exibida de
              novo. Se voce precisa dela agora, gere um token novo -- a conexao
              antiga para de funcionar na hora em que o novo for gerado.
            </Alerta>
          )}

          {fonte.integration === "META_ADS" && <PassoAPasso />}

          {fonte.integration !== "META_ADS" && (
            <div style={{ fontSize: 13, color: "var(--muted)" }}>
              Mande <code>POST</code> com JSON contendo <code>nome</code> e{" "}
              <code>telefone</code> (ou <code>email</code>). Campos{" "}
              <code>utm_source</code>, <code>utm_campaign</code> e afins entram como
              atribuicao. Reenviar o mesmo <code>event_id</code> nao duplica o lead.
            </div>
          )}

          <div className="grid cols-2">
            <div className="field">
              <label className="label">Fila que recebe</label>
              <select
                className="select" value={fonte.queue_id ?? ""} disabled={salvando}
                onChange={(e) => mexer(() => atualizarFonte(fonte.id, {
                  queueId: e.target.value || null,
                }))}
              >
                <option value="">Sem fila (lead fica sem dono)</option>
                {listaDeFilas.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
              </select>
              <span className="hint">
                Sem fila o lead entra e fica parado. Com fila ele ja cai com corretor
                e prazo.
              </span>
            </div>

            {fonte.integration === "META_ADS" && (
              <div className="field">
                <label className="label">
                  Token de pagina {fonte.tem_token_da_pagina && "(ja configurado)"}
                </label>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input" type="password" value={tokenPagina}
                    placeholder={fonte.tem_token_da_pagina ? "••••••••••" : "EAAG..."}
                    onChange={(e) => setTokenPagina(e.target.value)}
                  />
                  <button
                    className="btn" disabled={salvando || !tokenPagina.trim()}
                    onClick={() => mexer(async () => {
                      await atualizarFonte(fonte.id, { tokenDaPagina: tokenPagina.trim() });
                      setTokenPagina("");
                      avisar("ok", "Token de pagina salvo.");
                    })}
                  >
                    Salvar
                  </button>
                </div>
                <span className="hint">
                  Sem ele a Meta avisa que chegou lead e o CRM nao consegue ler nome
                  nem telefone. Ele fica so no servidor.
                </span>
              </div>
            )}
          </div>

          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
              className="btn ghost sm" disabled={salvando}
              onClick={() => mexer(async () => {
                const r = await regerarTokenDaFonte(fonte.id);
                aoNovoToken(r.token);
                avisar("ok", "Token novo gerado. Atualize a URL na Meta.");
              })}
            >
              Gerar token novo
            </button>
            <button
              className={fonte.active ? "btn ghost sm" : "btn sm"} disabled={salvando}
              onClick={() => mexer(async () => {
                await atualizarFonte(fonte.id, { ativa: !fonte.active });
                avisar("ok", fonte.active
                  ? "Conexao desativada: para de aceitar lead."
                  : "Conexao reativada.");
              })}
            >
              {fonte.active ? "Desativar" : "Reativar"}
            </button>
            <span className="spacer" />
            <span className="hint">Criada em {dataHora(fonte.created_at)}</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function PassoAPasso() {
  return (
    <div className="col" style={{ gap: 12 }}>
      <Passo n={1} titulo="Abra o Gerenciador de Anuncios e va em Ferramentas > Formularios instantaneos." />
      <Passo n={2} titulo="No painel de desenvolvedor da Meta, adicione o produto Webhooks e escolha o objeto Pagina." />
      <Passo n={3} titulo="Cole a URL de callback e o token de verificacao acima, e assine o campo leadgen." />
      <Passo n={4} titulo="Gere um token de pagina de longa duracao e cole no campo abaixo.">
        <span className="hint">
          E o que autoriza o CRM a ler o conteudo do formulario. O webhook sozinho
          so avisa que existe um lead.
        </span>
      </Passo>
      <Passo n={5} titulo="Envie um lead de teste pela ferramenta de teste da Meta." >
        <span className="hint">
          Ele aparece em Leads em segundos. Se nao aparecer, o erro fica escrito
          aqui nesta tela.
        </span>
      </Passo>
    </div>
  );
}

/* ------------------------------------------------- nova conexao --- */

function FormularioDeConexao({
  canal, filas: listaDeFilas, aoFechar, aoCriar,
}: {
  canal: Canal | null;
  filas: { id: string; name: string }[];
  aoFechar: () => void;
  aoCriar: (canal: Canal, nome: string, queueId: string | null) => Promise<void>;
}) {
  const [nome, setNome] = useState("");
  const [queueId, setQueueId] = useState("");
  const [salvando, setSalvando] = useState(false);

  function fechar() { setNome(""); setQueueId(""); aoFechar(); }

  return (
    <Dialogo
      aberto={canal !== null}
      titulo={canal ? "Conectar " + CANAIS[canal].nome : "Conectar"}
      aoFechar={fechar}
      largura={560}
    >
      {canal && (
        <form
          className="col" style={{ gap: 13 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setSalvando(true);
            await aoCriar(canal, nome.trim(), queueId || null);
            setSalvando(false);
            setNome(""); setQueueId("");
          }}
        >
          <div className="field">
            <label className="label" htmlFor="cx-nome">Nome da conexao</label>
            <input
              id="cx-nome" className="input" required autoFocus value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={canal === "META_ADS" ? "Meta - Vista Residence" : "Site institucional"}
            />
            <span className="hint">
              Aparece na origem do lead. Uma conexao por campanha ou produto
              facilita saber de onde veio a venda.
            </span>
          </div>
          <div className="field">
            <label className="label" htmlFor="cx-fila">Fila que recebe</label>
            <select id="cx-fila" className="select" value={queueId}
                    onChange={(e) => setQueueId(e.target.value)}>
              <option value="">Sem fila (lead fica sem dono)</option>
              {listaDeFilas.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" type="submit" disabled={salvando || !nome.trim()}>
              {salvando ? "Criando..." : "Criar conexao"}
            </button>
            <button className="btn ghost" type="button" onClick={fechar}>Cancelar</button>
          </div>
        </form>
      )}
    </Dialogo>
  );
}
