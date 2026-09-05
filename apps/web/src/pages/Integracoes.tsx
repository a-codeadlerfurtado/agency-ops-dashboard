import { useEffect, useState } from "react";
import { dataHora, relativo } from "../lib/format";
import {
  atualizarFonte, conectarPagina, criarFonte, excluirFonte, filas, fontesDeLead, iniciarConexaoMeta,
  paginasDaMeta, prepararTeste, regerarTokenDaFonte, salvarTokenDeSistema,
  situacaoDoTokenDeSistema,
  type FonteDeLead, type PaginaDaMeta,
} from "../lib/comercial";
import { mensagemDeErro } from "../lib/supabase";
import Dialogo from "../Dialogo";
import {
  Alerta, CabecalhoDaPagina, Card, CardsCarregando, Ico, useAsync, useToast, Vazio,
} from "../ui";
import type { Sessao } from "../lib/types";

const BASE = (import.meta.env.VITE_INGEST_URL ?? "").replace(/\/+$/, "");
const APP_META = import.meta.env.VITE_META_APP_ID ?? "";

/* Permissoes minimas: listar as paginas, inscrever a pagina no webhook e ler
   o conteudo do formulario. `leads_retrieval` e a que exige App Review -- sem
   ela aprovada a Meta so autoriza contas de desenvolvedor do proprio app. */
const ESCOPO = "pages_show_list,pages_manage_metadata,leads_retrieval";

const CANAIS = {
  META_ADS: {
    nome: "Meta Lead Ads",
    caminho: "meta",
    resumo: "Facebook e Instagram. O lead cai no CRM no segundo em que a pessoa envia o formulario.",
  },
  GOOGLE_ADS: {
    nome: "Google Ads",
    caminho: "google",
    resumo: "Formulario de lead do Google Ads. Nao precisa de app nem de conta de desenvolvedor: cola a URL e a chave dentro do proprio Ads.",
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

/** Le e limpa o ?meta=ok|erro|vazio com que o worker devolve o navegador. */
function retornoDaMeta(): { estado: string; motivo?: string } | null {
  const bruto = location.hash.split("?")[1];
  if (!bruto) return null;
  const q = new URLSearchParams(bruto);
  const estado = q.get("meta");
  if (!estado) return null;
  const motivo = q.get("motivo") ?? undefined;
  history.replaceState(null, "", location.pathname + "#/integracoes");
  return { estado, motivo };
}

export default function Integracoes({ sessao }: { sessao: Sessao }) {
  const avisar = useToast();
  const [novo, setNovo] = useState<Canal | null>(null);
  const [aberta, setAberta] = useState<string | null>(null);
  const [tokenNovo, setTokenNovo] = useState<{ id: string; token: string } | null>(null);
  const [escolhendo, setEscolhendo] = useState(false);

  const dados = useAsync(
    async () => ({
      fontes: await fontesDeLead(),
      listaDeFilas: await filas(sessao.tenant.id),
      paginas: await paginasDaMeta(),
      sistema: await situacaoDoTokenDeSistema(),
    }),
    [sessao.tenant.id]
  );

  // volta do dialogo da Meta: avisa e ja abre a escolha de pagina
  useEffect(() => {
    const r = retornoDaMeta();
    if (!r) return;
    if (r.estado === "ok") {
      avisar("ok", "Conta do Facebook conectada. Escolha a pagina.");
      setEscolhendo(true);
    } else if (r.estado === "vazio") {
      avisar("err", r.motivo ?? "Nenhuma pagina encontrada nessa conta.");
    } else {
      avisar("err", r.motivo ?? "Nao foi possivel conectar com a Meta.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (dados.erro) return <Alerta>{dados.erro}</Alerta>;
  if (!dados.dado) return <CardsCarregando n={3} />;

  const { fontes, listaDeFilas, paginas, sistema } = dados.dado;

  /**
   * Manda a pessoa para o dialogo da Meta.
   *
   * O `state` sai do banco e vale uma vez: e ele que amarra o retorno da Meta
   * a esta imobiliaria. Sem isso qualquer um que descobrisse a URL de callback
   * poderia pendurar as proprias paginas em outro tenant.
   */
  async function entrarComFacebook() {
    try {
      const state = await iniciarConexaoMeta();
      const redirect = `${BASE}/v1/meta/oauth`;
      location.href =
        "https://www.facebook.com/v21.0/dialog/oauth" +
        `?client_id=${encodeURIComponent(APP_META)}` +
        `&redirect_uri=${encodeURIComponent(redirect)}` +
        `&state=${encodeURIComponent(state)}` +
        `&scope=${encodeURIComponent(ESCOPO)}` +
        "&response_type=code";
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    }
  }

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

      {!APP_META && (
        <Alerta tipo="warn">
          <b>Conectar com login do Facebook ainda nao esta ligado.</b> Falta o
          aplicativo Meta desta instalacao: id no <code>VITE_META_APP_ID</code> e
          segredo no worker. O login para o cliente final ainda depende de App
          Review; o token de sistema abaixo <b>nao depende</b>.
        </Alerta>
      )}

      <TokenDeSistema
        situacao={sistema}
        aoImportar={() => { dados.recarregar(); setEscolhendo(true); }}
      />

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
                        : ativas === 1 ? "1 conexao"
                        : ativas + " conexoes"}
                    </div>
                  </div>
                </div>
                <p style={{ color: "var(--muted)", fontSize: 13, margin: "0 0 12px" }}>
                  {CANAIS[c].resumo}
                </p>
                {c === "META_ADS" ? (
                  <div className="row" style={{ gap: 7, flexWrap: "wrap" }}>
                    <button
                      className="btn sm primary" disabled={!APP_META || !BASE}
                      onClick={entrarComFacebook}
                      title={!APP_META ? "Falta o id do aplicativo Meta nesta instalacao." : undefined}
                      style={!APP_META ? undefined : { background: "#1877f2", borderColor: "#1877f2" }}
                    >
                      Conectar conta do Facebook
                    </button>
                    {paginas.length > 0 && (
                      <button className="btn sm ghost" onClick={() => setEscolhendo(true)}>
                        Escolher pagina
                      </button>
                    )}
                    <button className="btn sm ghost" onClick={() => setNovo(c)}>
                      Manual
                    </button>
                  </div>
                ) : (
                  <button className="btn sm primary" onClick={() => setNovo(c)}>
                    {Ico.plus({ size: 14 })} Conectar
                  </button>
                )}
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

      <EscolherPagina
        aberto={escolhendo}
        paginas={paginas}
        filas={listaDeFilas}
        aoFechar={() => setEscolhendo(false)}
        aoConectar={async (pageId, nome, queueId) => {
          const r = await conectarPagina(pageId, nome, queueId);
          // o worker inscreve a pagina no webhook usando o nonce de uso unico
          const resp = await fetch(`${BASE}/v1/meta/assinar?n=${encodeURIComponent(r.nonce)}`, {
            method: "POST",
          });
          const corpo = await resp.json().catch(() => ({})) as {
            erro?: string; aviso?: string; link?: string;
          };
          setEscolhendo(false);
          dados.recarregar();
          if (!resp.ok) {
            avisar("err", corpo.erro ?? "Pagina salva, mas a inscricao no webhook falhou.");
          } else if (corpo.aviso) {
            // assinou, mas a leitura do lead ainda nao esta liberada. O aviso
            // fica gravado na conexao, entao a tela continua mostrando depois
            // que o toast some.
            avisar("err", corpo.aviso);
          } else {
            avisar("ok", `${r.page_name} conectada e testada. Lead novo ja cai aqui.`);
          }
        }}
      />

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
  const [confirmando, setConfirmando] = useState(false);
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
              {fonte.integration === "GOOGLE_ADS" && (
                <Copiavel
                  rotulo="Chave"
                  valor={tokenNovo}
                  dica="No Google Ads, campo 'Chave'. E o mesmo valor do fim da URL: o Google manda essa chave no corpo e nos conferimos se bate."
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
          {fonte.integration === "GOOGLE_ADS" && <PassoAPassoGoogle />}

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
            {/* Testar percorre o mesmo caminho de um lead real: acessa a
                pagina, lista os formularios e tenta LER um lead. E o terceiro
                passo que exige o acesso a leads liberado, e e o que a
                Ferramenta de Teste da Meta nao prova. */}
            {fonte.integration === "META_ADS" && fonte.page_id && (
              <button
                className="btn sm" disabled={salvando}
                onClick={() => mexer(async () => {
                  const nonce = await prepararTeste(fonte.id);
                  const r = await fetch(
                    `${BASE}/v1/meta/testar?n=${encodeURIComponent(nonce)}`,
                    { method: "POST" }
                  );
                  const c = await r.json().catch(() => ({})) as {
                    erro?: string; aviso?: string;
                  };
                  if (!r.ok) throw new Error(c.erro ?? "Falha ao testar.");
                  if (c.aviso) throw new Error(c.aviso);
                  avisar("ok", "Conexao pronta: leitura de lead autorizada.");
                })}
              >
                Testar conexao
              </button>
            )}
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
            <button
              className="btn danger sm" disabled={salvando}
              onClick={() => setConfirmando(true)}
            >
              Excluir
            </button>
            <span className="spacer" />
            <span className="hint">Criada em {dataHora(fonte.created_at)}</span>
          </div>
        </div>
      )}

      {/* Excluir integracao nao e o mesmo que desativar, e a tela precisa dizer
          isso: desativar para de aceitar lead e guarda a configuracao; excluir
          descarta o token, e no caso da Meta a pagina continua assinada la --
          ela vai seguir mandando lead para um destino que deixou de existir. */}
      <Dialogo
        aberto={confirmando}
        titulo="Excluir integracao"
        aoFechar={() => setConfirmando(false)}
        rodape={
          <>
            <button className="btn" onClick={() => setConfirmando(false)} disabled={salvando}>
              Cancelar
            </button>
            <button
              className="btn danger" disabled={salvando}
              onClick={() => mexer(async () => {
                await excluirFonte(fonte.id);
                setConfirmando(false);
                avisar("ok", `Integracao "${fonte.label}" excluida.`);
              })}
            >
              {salvando ? "Excluindo..." : "Excluir definitivamente"}
            </button>
          </>
        }
      >
        <p style={{ margin: 0 }}>
          Excluir <b>{fonte.label}</b>?
        </p>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 10 }}>
          Os {fonte.leads} lead{fonte.leads === 1 ? "" : "s"} que ja entraram
          por aqui <b>permanecem</b> no funil. O que se perde e a configuracao:
          token, fila de destino e o vinculo com a pagina.
        </p>
        {fonte.integration === "META_ADS" && fonte.page_id && (
          <p style={{ color: "var(--warning, #f0b429)", fontSize: 13, marginTop: 8 }}>
            Esta pagina continua inscrita no webhook da Meta. Ela vai seguir
            enviando lead para um destino que deixou de existir, e esse lead se
            perde. Para parar de vez, remova o app tambem nas configuracoes da
            pagina no Facebook.
          </p>
        )}
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 8 }}>
          Se a intencao e so parar de receber por enquanto, use{" "}
          <b>Desativar</b> &mdash; a configuracao fica guardada.
        </p>
      </Dialogo>
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

/**
 * Google Ads. Deliberadamente sem nenhum passo de "criar app": o formulario de
 * lead do Google entrega por webhook direto, sem OAuth e sem conta de
 * desenvolvedor. Quem procura por isso perde horas achando que precisa.
 */
function PassoAPassoGoogle() {
  return (
    <div className="col" style={{ gap: 12 }}>
      <Passo n={1} titulo="No Google Ads, abra Recursos > Formulario de lead (ou crie um no anuncio).">
        <span className="hint">
          Nao e preciso criar app, projeto no Google Cloud nem conta de
          desenvolvedor. Isso so seria necessario para a API do Google Ads, que
          e outro caminho.
        </span>
      </Passo>
      <Passo n={2} titulo="Va ate a etapa de entrega e escolha 'Webhook'." />
      <Passo n={3} titulo="Cole a URL de callback no campo 'URL do webhook' e a Chave no campo 'Chave'." >
        <span className="hint">
          Sao os dois valores acima. O Google devolve a chave dentro do corpo de
          cada lead, e o CRM confere se bate.
        </span>
      </Passo>
      <Passo n={4} titulo="Clique em 'Enviar dados de teste'.">
        <span className="hint">
          O Google so aceita a URL se ela responder. Esse lead de teste NAO entra
          no funil de proposito -- ele existe so para validar a configuracao.
        </span>
      </Passo>
      <Passo n={5} titulo="Salve o formulario e publique o anuncio.">
        <span className="hint">
          A partir daí o lead cai aqui no momento do envio, ja distribuido para
          um corretor da fila.
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

/* ------------------------------------------------- escolher pagina --- */

/**
 * Lista as paginas que a Meta devolveu depois do login.
 *
 * Nao ha token nenhum nesta tela: `paginas_da_meta()` devolve so id e nome. O
 * token de pagina ficou no servidor desde o retorno do OAuth, e e de la que
 * `conectar_pagina` o copia para a conexao.
 */
function EscolherPagina({
  aberto, paginas, filas: listaDeFilas, aoFechar, aoConectar,
}: {
  aberto: boolean;
  paginas: PaginaDaMeta[];
  filas: { id: string; name: string }[];
  aoFechar: () => void;
  aoConectar: (pageId: string, nome: string, queueId: string | null) => Promise<void>;
}) {
  const avisar = useToast();
  const [pageId, setPageId] = useState("");
  const [nome, setNome] = useState("");
  const [queueId, setQueueId] = useState("");
  const [salvando, setSalvando] = useState(false);

  const escolhida = paginas.find((p) => p.page_id === pageId);

  return (
    <Dialogo
      aberto={aberto}
      titulo="Escolher a pagina do Facebook"
      aoFechar={aoFechar}
      largura={560}
    >
      {paginas.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 13.5 }}>
          Nenhuma pagina foi trazida ainda. Clique em "Conectar conta do Facebook"
          e autorize o acesso.
        </div>
      ) : (
        <form
          className="col" style={{ gap: 13 }}
          onSubmit={async (e) => {
            e.preventDefault();
            setSalvando(true);
            try {
              await aoConectar(pageId, nome.trim() || escolhida?.page_name || "", queueId || null);
              setPageId(""); setNome(""); setQueueId("");
            } catch (err) {
              avisar("err", mensagemDeErro(err));
            } finally {
              setSalvando(false);
            }
          }}
        >
          <div className="field">
            <label className="label">Pagina</label>
            <div className="col" style={{ gap: 6 }}>
              {paginas.map((p) => (
                <label
                  key={p.page_id}
                  className="row"
                  style={{
                    gap: 10, padding: "9px 11px", cursor: "pointer",
                    borderRadius: "var(--r-sm)",
                    border: "1px solid " + (pageId === p.page_id ? "var(--blue)" : "var(--line-soft)"),
                    background: pageId === p.page_id ? "var(--blue-soft)" : "transparent",
                  }}
                >
                  <input
                    type="radio" name="pagina" value={p.page_id}
                    checked={pageId === p.page_id}
                    onChange={() => { setPageId(p.page_id); setNome(p.page_name); }}
                  />
                  <span style={{ fontWeight: 550, flex: 1 }}>{p.page_name}</span>
                  {p.conectada && <span className="badge won">ja conectada</span>}
                </label>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="label" htmlFor="pg-nome">Nome da conexao</label>
            <input
              id="pg-nome" className="input" value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder={escolhida?.page_name ?? "Nome que aparece na origem do lead"}
            />
          </div>

          <div className="field">
            <label className="label" htmlFor="pg-fila">Fila que recebe</label>
            <select id="pg-fila" className="select" value={queueId}
                    onChange={(e) => setQueueId(e.target.value)}>
              <option value="">Sem fila (lead fica sem dono)</option>
              {listaDeFilas.map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </select>
            <span className="hint">
              Com fila o lead ja entra com corretor e prazo. Sem fila ele fica parado.
            </span>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" type="submit" disabled={salvando || !pageId}>
              {salvando ? "Conectando..." : "Conectar pagina"}
            </button>
            <button className="btn ghost" type="button" onClick={aoFechar}>Cancelar</button>
          </div>
        </form>
      )}
    </Dialogo>
  );
}

/* ------------------------------------------- token de usuario de sistema --- */

/**
 * Caminho da agencia: um token de usuario de sistema da Business Manager, que
 * ja enxerga as paginas dos clientes.
 *
 * E o unico caminho que funciona ANTES do App Review, porque a Meta so exige
 * revisao para usar permissao em nome de quem nao tem papel no aplicativo -- e
 * um usuario de sistema da mesma BM do app pode ter papel nele.
 *
 * O token e digitado aqui e vai direto para o banco pela RPC. Ele nunca volta:
 * a tela so sabe que existe e de quando e.
 */
function TokenDeSistema({
  situacao, aoImportar,
}: {
  situacao: { tem: boolean; atualizado_em?: string };
  aoImportar: () => void;
}) {
  const avisar = useToast();
  const [aberto, setAberto] = useState(false);
  const [token, setToken] = useState("");
  const [pageId, setPageId] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function importar() {
    setOcupado(true);
    try {
      const state = await salvarTokenDeSistema(token.trim());
      const r = await fetch(
        `${BASE}/v1/meta/paginas?n=${encodeURIComponent(state)}` +
        `&page_id=${encodeURIComponent(pageId.trim())}`,
        { method: "POST" }
      );
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        const c = corpo as { erro?: string; detalhe?: string };
        // o detalhe e o texto cru da Meta: some da frase principal mas fica
        // visivel, senao o caso raro vira adivinhacao
        throw new Error(
          (c.erro ?? "Falha ao buscar a pagina.") +
          (c.detalhe ? ` (Meta: ${c.detalhe})` : "")
        );
      }
      setToken("");
      setPageId("");
      setAberto(false);
      avisar("ok", "Pagina " + ((corpo as { nome?: string }).nome ?? "") + " importada.");
      aoImportar();
    } catch (e) {
      avisar("err", mensagemDeErro(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Card>
      <div className="card-head">
        <h2>Conectar pela Business Manager</h2>
        {situacao.tem
          ? <span className="badge won"><span className="dot" />token salvo</span>
          : <span className="badge">sem token</span>}
        <span className="spacer" />
        {situacao.atualizado_em && (
          <span className="hint some-no-mobile">
            atualizado em {dataHora(situacao.atualizado_em)}
          </span>
        )}
        <button className="btn ghost sm" onClick={() => setAberto(!aberto)}>
          {aberto ? "Fechar" : situacao.tem ? "Trocar token" : "Usar token de sistema"}
        </button>
      </div>

      {aberto && (
        <div className="card-body col" style={{ gap: 14 }}>
          <div style={{ color: "var(--muted)", fontSize: 13.5 }}>
            Se as paginas dos clientes ja estao na sua Business Manager, este e o
            caminho mais curto: um token so, e todas as paginas aparecem para
            escolher. <b>Nao depende de App Review.</b>
          </div>

          <div className="col" style={{ gap: 11 }}>
            <Passo n={1} titulo="Na Business Manager, crie um usuario de sistema (Administrador)." />
            <Passo n={2} titulo="Atribua a ele a PAGINA do cliente, nao so a conta de anuncios.">
              <span className="hint">
                E o erro mais comum: com so a conta de anuncios o token lista zero
                paginas.
              </span>
            </Passo>
            <Passo n={3} titulo="Gere o token escolhendo o seu aplicativo e marque leads_retrieval, pages_show_list, pages_read_engagement, pages_manage_metadata e ads_management." />
            <Passo n={4} titulo="Se o cliente restringiu o acesso a leads, peca para liberar sua BM no Gerenciador de Acesso a Leads da pagina dele." />
          </div>

          <div className="field">
            <label className="label" htmlFor="tk-sistema">Token de usuario de sistema</label>
            <input
              id="tk-sistema" className="input" type="password" value={token}
              onChange={(e) => setToken(e.target.value)} placeholder="EAAG..."
              style={{ fontFamily: "ui-monospace, monospace" }}
            />
            <span className="hint">
              Vai direto para o servidor e nunca volta para esta tela. Token de
              usuario de sistema nao expira.
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="tk-pagina">ID da pagina</label>
            <input
              id="tk-pagina" className="input" value={pageId} inputMode="numeric"
              onChange={(e) => setPageId(e.target.value)} placeholder="102938475601234"
              style={{ fontFamily: "ui-monospace, monospace" }}
            />
            <span className="hint">
              So numeros. Voce acha em Configuracoes da Pagina &gt; Sobre, no
              campo Identificacao da Pagina. Pedimos o ID em vez de listar tudo
              porque um token de agencia enxerga as paginas de todos os
              clientes -- e a lista apareceria para o admin de um so.
            </span>
          </div>

          <div className="row" style={{ gap: 8 }}>
            <button
              className="btn primary"
              disabled={ocupado || !token.trim() || !pageId.trim()}
              onClick={importar}
            >
              {ocupado ? "Importando..." : "Salvar e importar pagina"}
            </button>
            <button className="btn ghost" onClick={() => { setToken(""); setPageId(""); setAberto(false); }}>
              Cancelar
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
