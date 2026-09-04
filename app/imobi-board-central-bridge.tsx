"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { SUPABASE_URL, supabase } from "./shared";

/**
 * Central de controle do Imobi-Board, dentro do dashboard da agência.
 *
 * O dashboard é a central da operação; o CRM é um dos sistemas que ela opera.
 * Aqui o Adler vê todas as imobiliárias, quem tem acesso a cada uma, convida
 * gente nova e define senha — e é a definição da senha que faz o acesso do
 * CRM finalmente existir no cofre.
 *
 * Por que o cofre estava vazio para o CRM: o convite do Imobi-Board faz cada
 * pessoa criar a própria senha, e o banco guarda só o hash. Não havia valor a
 * guardar. Quando a senha é definida aqui, ela passa a ser conhecida, vai
 * cifrada para o cofre e aparece no "Cofre de acessos" do perfil.
 *
 * E se a pessoa trocar a senha depois, pela tela do CRM? O item fica marcado
 * como DESATUALIZADO em vez de continuar mostrando algo que não abre mais.
 */

const CENTRAL_API = `${SUPABASE_URL}/functions/v1/imobi-board-central-api`;
const BOTAO = "imobi-board-central-trigger";

type Usuario = {
  user_id: string;
  email: string;
  nome: string;
  papel: string;
  situacao: string;
  ultimo_acesso: string | null;
  entrou_em: string | null;
  no_cofre: boolean;
  senha_definida_em: string | null;
  senha_desatualizada: boolean;
};

type Convite = { email: string; papel: string; expira_em: string };

type Imobiliaria = {
  tenant_id: string;
  nome: string;
  slug: string;
  situacao: string;
  agency_client_id: string | null;
  cliente: string | null;
  leads: number;
  usuarios: Usuario[];
  convites_pendentes: Convite[];
};

type Cliente = { client_id: string; display_name: string };

const rotulos: Record<string, string> = {
  unauthorized: "Sua sessão do Dashboard expirou. Entre novamente.",
  invalid_reauthentication: "A senha do seu perfil está incorreta.",
  reauth_locked: "Muitas tentativas incorretas. Bloqueado por 15 minutos.",
  senha_curta: "A senha precisa ter pelo menos 10 caracteres.",
  senha_longa: "Senha longa demais.",
  imobiliaria_sem_cliente:
    "Ligue esta imobiliária a um cliente do Agency Ops primeiro — sem isso não há cofre onde guardar o acesso.",
  papel_invalido: "Papel inválido.",
  falha_ao_definir_senha: "Não foi possível alterar a senha desse usuário.",
  vault_key_missing: "A chave criptográfica do cofre não está disponível.",
  sem_item_no_cofre:
    "Esse usuário ainda não tem senha no cofre — defina uma primeiro para poder vê-la.",
  cofre_decifra_falhou: "Não foi possível abrir essa credencial.",
  falha_ao_ler_imobiliaria:
    "Não consegui ler a ligação desta imobiliária com o cliente. Isso é falha de leitura, não ausência de ligação — me mostre o detalhe.",
  origin_not_allowed: "Origem não autorizada.",
};
const rotulo = (codigo: unknown) =>
  rotulos[String(codigo || "")] || String(codigo || "Não foi possível concluir agora.");

function quando(valor?: string | null) {
  if (!valor) return "—";
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(d);
}

/** Linha de credencial revelada: valor em fonte mono, com copiar ao lado. */
function Campo({ rotulo: nome, valor, aoCopiar }: {
  rotulo: string; valor: string; aoCopiar: () => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: "var(--muted)", minWidth: 52, fontSize: 12 }}>{nome}</span>
      <code style={{
        flex: 1, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        wordBreak: "break-all", userSelect: "all",
      }}>{valor || "—"}</code>
      {valor && (
        <button type="button"
          onClick={() => { void navigator.clipboard.writeText(valor); aoCopiar(); }}
          style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 7, padding: "3px 9px", cursor: "pointer", fontSize: 11 }}>
          Copiar
        </button>
      )}
    </div>
  );
}

export default function ImobiBoardCentralBridge() {
  const [permitido, setPermitido] = useState(false);
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [imobiliarias, setImobiliarias] = useState<Imobiliaria[]>([]);
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [crmUrl, setCrmUrl] = useState("");
  const [erro, setErro] = useState("");
  const [aviso, setAviso] = useState("");
  const [expandida, setExpandida] = useState<string | null>(null);

  // formulário de senha, aberto para um usuário por vez
  const [alvo, setAlvo] = useState<{ t: Imobiliaria; u: Usuario } | null>(null);
  const [novaSenha, setNovaSenha] = useState("");
  const [senhaDoPainel, setSenhaDoPainel] = useState("");
  const [salvando, setSalvando] = useState(false);

  // convite
  const [convidando, setConvidando] = useState<Imobiliaria | null>(null);
  const [emailConvite, setEmailConvite] = useState("");
  const [papelConvite, setPapelConvite] = useState("BROKER");
  const [linkGerado, setLinkGerado] = useState("");

  // revelação: pede a senha do dashboard, mostra por tempo limitado
  const [revelando, setRevelando] = useState<{ t: Imobiliaria; u: Usuario } | null>(null);
  const [reveladas, setReveladas] = useState<Record<string, { login: string; senha: string }>>({});
  const [expiraEm, setExpiraEm] = useState<Record<string, number>>({});
  const [agora, setAgora] = useState(() => Date.now());

  const chamar = useCallback(async (corpo: Record<string, unknown>) => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) throw new Error("unauthorized");
    const r = await fetch(CENTRAL_API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(corpo),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j?.ok) throw new Error(j?.detalhe || j?.error || "falha");
    return j;
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    try {
      const j = await chamar({ action: "LISTAR" });
      setImobiliarias((j.imobiliarias || []) as Imobiliaria[]);
      setCrmUrl(String(j.crm_url || ""));
      setPermitido(true);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "unauthorized") setPermitido(false);
      else setErro(rotulo(msg));
    } finally {
      setCarregando(false);
    }
  }, [chamar]);

  /* Só descobre se pode ao tentar: a trava mora na Edge Function, e duplicar a
     regra aqui criaria dois lugares para ela divergir. */
  useEffect(() => {
    void carregar();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((evento) => {
      if (evento === "SIGNED_OUT") { setPermitido(false); setAberto(false); return; }
      if (evento === "SIGNED_IN" || evento === "USER_UPDATED") void carregar();
    });
    return () => subscription.unsubscribe();
  }, [carregar]);

  // lista de clientes só é necessária para ligar uma imobiliária ainda solta
  useEffect(() => {
    if (!aberto || clientes.length) return;
    void (async () => {
      const { data } = await supabase.schema("agency_ops")
        .from("dashboard_client_overview").select("client_id,display_name")
        .order("display_name");
      setClientes((data || []) as Cliente[]);
    })();
  }, [aberto, clientes.length]);

  useEffect(() => {
    if (!permitido) return;
    const prender = () => {
      const menu = document.querySelector(".profile-menu") as HTMLElement | null;
      if (!menu || menu.querySelector(`.${BOTAO}`)) return;
      const b = document.createElement("button");
      b.type = "button";
      b.className = BOTAO;
      b.textContent = "Central do CRM";
      b.title = "Imobiliárias, usuários e senhas do Imobi-Board";
      b.addEventListener("click", () => { setAberto(true); void carregar(); });
      const sair = Array.from(menu.querySelectorAll("button"))
        .find((n) => /sair/i.test(n.textContent || ""));
      if (sair) menu.insertBefore(b, sair); else menu.appendChild(b);
    };
    prender();
    const observador = new MutationObserver(prender);
    observador.observe(document.body, { childList: true, subtree: true });
    return () => {
      observador.disconnect();
      document.querySelectorAll(`.${BOTAO}`).forEach((n) => n.remove());
    };
  }, [permitido, carregar]);

  useEffect(() => {
    if (!aberto) return;
    const antes = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = antes; };
  }, [aberto]);

  useEffect(() => {
    if (!aviso) return;
    const t = window.setTimeout(() => setAviso(""), 4000);
    return () => window.clearTimeout(t);
  }, [aviso]);

  /* Senha revelada some sozinha. Sem isto ela ficaria na tela até alguém
     fechar o modal — e a tela costuma ficar aberta enquanto se resolve
     outra coisa. */
  useEffect(() => {
    if (!Object.keys(expiraEm).length) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setAgora(t);
      const vencidos = Object.entries(expiraEm).filter(([, ate]) => ate <= t).map(([k]) => k);
      if (vencidos.length) {
        setReveladas((r) => { const c = { ...r }; vencidos.forEach((k) => delete c[k]); return c; });
        setExpiraEm((e) => { const c = { ...e }; vencidos.forEach((k) => delete c[k]); return c; });
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [expiraEm]);

  // sair da aba esconde tudo
  useEffect(() => {
    const aoOcultar = () => {
      if (document.hidden) { setReveladas({}); setExpiraEm({}); }
    };
    document.addEventListener("visibilitychange", aoOcultar);
    return () => document.removeEventListener("visibilitychange", aoOcultar);
  }, []);

  const totais = useMemo(() => ({
    imobiliarias: imobiliarias.length,
    usuarios: imobiliarias.reduce((s, t) => s + t.usuarios.length, 0),
    noCofre: imobiliarias.reduce((s, t) => s + t.usuarios.filter((u) => u.no_cofre).length, 0),
    desatualizadas: imobiliarias.reduce(
      (s, t) => s + t.usuarios.filter((u) => u.senha_desatualizada).length, 0),
  }), [imobiliarias]);

  function fechar() {
    setAberto(false);
    setAlvo(null); setNovaSenha(""); setSenhaDoPainel("");
    setConvidando(null); setEmailConvite(""); setLinkGerado(""); setErro("");
  }

  async function definirSenha() {
    if (!alvo) return;
    setSalvando(true); setErro("");
    try {
      await chamar({
        action: "DEFINIR_SENHA",
        tenant_id: alvo.t.tenant_id,
        tenant_nome: alvo.t.nome,
        user_id: alvo.u.user_id,
        papel: alvo.u.papel,
        senha: novaSenha,
        dashboard_password: senhaDoPainel,
      });
      setAviso(`Senha de ${alvo.u.email} alterada e guardada no cofre de ${alvo.t.cliente}.`);
      setAlvo(null); setNovaSenha(""); setSenhaDoPainel("");
      await carregar();
    } catch (e) {
      setErro(rotulo((e as Error).message));
    } finally {
      setSalvando(false);
    }
  }

  async function convidar() {
    if (!convidando) return;
    setSalvando(true); setErro(""); setLinkGerado("");
    try {
      const j = await chamar({
        action: "CONVIDAR",
        tenant_id: convidando.tenant_id,
        email: emailConvite,
        papel: papelConvite,
        dashboard_password: senhaDoPainel,
      });
      setLinkGerado(String(j.convite?.link || ""));
      setAviso("Convite criado. Copie o link e envie para a pessoa.");
      await carregar();
    } catch (e) {
      setErro(rotulo((e as Error).message));
    } finally {
      setSalvando(false);
    }
  }

  async function revelar() {
    if (!revelando) return;
    setSalvando(true); setErro("");
    try {
      const j = await chamar({
        action: "REVELAR",
        tenant_id: revelando.t.tenant_id,
        user_id: revelando.u.user_id,
        dashboard_password: senhaDoPainel,
      });
      const c = j.credencial || {};
      const chave = revelando.u.user_id;
      setReveladas((r) => ({
        ...r,
        [chave]: { login: String(c.login ?? ""), senha: String(c.senha ?? "") },
      }));
      setExpiraEm((e) => ({
        ...e,
        [chave]: Date.now() + Number(c.expira_em_segundos || 180) * 1000,
      }));
      setRevelando(null); setSenhaDoPainel("");
    } catch (e) {
      setErro(rotulo((e as Error).message));
    } finally {
      setSalvando(false);
    }
  }

  function esconder(userId: string) {
    setReveladas((r) => { const c = { ...r }; delete c[userId]; return c; });
    setExpiraEm((e) => { const c = { ...e }; delete c[userId]; return c; });
  }

  async function ligar(t: Imobiliaria, clientId: string) {
    setErro("");
    if (!senhaDoPainel) {
      setErro("Digite a senha do seu Dashboard no campo abaixo antes de ligar a imobiliária.");
      return;
    }
    try {
      await chamar({
        action: "LIGAR_CLIENTE", tenant_id: t.tenant_id, client_id: clientId || null,
        dashboard_password: senhaDoPainel,
      });
      setAviso("Imobiliária ligada ao cliente.");
      await carregar();
    } catch (e) {
      setErro(rotulo((e as Error).message));
    }
  }

  if (!permitido || !aberto) return null;

  const caixa: React.CSSProperties = {
    background: "var(--panel)", border: "1px solid var(--line)",
    borderRadius: 14, padding: 14, marginBottom: 10,
  };
  const chip: React.CSSProperties = {
    fontSize: 11, padding: "2px 8px", borderRadius: 999,
    border: "1px solid var(--line)", color: "var(--muted)",
  };

  return createPortal(
    <div
      role="dialog" aria-modal="true" aria-label="Central do CRM"
      onClick={(e) => { if (e.target === e.currentTarget) fechar(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,.6)",
        backdropFilter: "blur(4px)", display: "flex", alignItems: "flex-start",
        justifyContent: "center", padding: "5vh 16px", overflowY: "auto",
      }}
    >
      <div style={{
        width: "min(980px, 100%)", background: "var(--bg, var(--panel))",
        border: "1px solid var(--line)", borderRadius: 18, padding: 20,
        boxShadow: "0 40px 120px rgba(0,0,0,.5)",
      }}>
        <header style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, letterSpacing: ".08em", color: "var(--muted)" }}>
              IMOBI-BOARD
            </div>
            <h2 style={{ margin: "2px 0 0", fontSize: 20 }}>Central do CRM</h2>
          </div>
          <button type="button" onClick={fechar} style={{
            border: "1px solid var(--line)", background: "transparent", color: "var(--text)",
            borderRadius: 9, padding: "7px 12px", cursor: "pointer",
          }}>Fechar</button>
        </header>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <span style={chip}>{totais.imobiliarias} imobiliárias</span>
          <span style={chip}>{totais.usuarios} usuários</span>
          <span style={chip}>{totais.noCofre} no cofre</span>
          {totais.desatualizadas > 0 && (
            <span style={{ ...chip, color: "var(--danger, #f87171)", borderColor: "currentColor" }}>
              {totais.desatualizadas} desatualizada(s)
            </span>
          )}
        </div>

        {erro && (
          <div style={{
            ...caixa, borderColor: "var(--danger, #f87171)",
            color: "var(--danger, #f87171)", fontSize: 13,
          }}>{erro}</div>
        )}
        {aviso && (
          <div style={{ ...caixa, borderColor: "var(--ok, #34d399)", fontSize: 13 }}>{aviso}</div>
        )}

        {carregando && <p style={{ color: "var(--muted)" }}>Carregando…</p>}

        {imobiliarias.map((t) => (
          <section key={t.tenant_id} style={caixa}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 15 }}>{t.nome}</strong>
              <span style={chip}>{t.leads} leads</span>
              {t.cliente
                ? <span style={chip}>cliente: {t.cliente}</span>
                : <span style={{ ...chip, color: "var(--danger, #f87171)", borderColor: "currentColor" }}>
                    sem cliente ligado
                  </span>}
              <span style={{ flex: 1 }} />
              <button type="button" onClick={() => setExpandida(expandida === t.tenant_id ? null : t.tenant_id)}
                style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12 }}>
                {expandida === t.tenant_id ? "Recolher" : `Ver ${t.usuarios.length} usuário(s)`}
              </button>
            </div>

            {!t.agency_client_id && (
              <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
                Sem cliente do Agency Ops, o acesso não tem cofre onde ser guardado.
                <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
                  <input type="password" placeholder="Sua senha do Dashboard"
                    value={senhaDoPainel} onChange={(e) => setSenhaDoPainel(e.target.value)}
                    style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 8, padding: "5px 9px" }} />
                  <select
                    defaultValue=""
                    onChange={(e) => { if (e.target.value) void ligar(t, e.target.value); }}
                    style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 8, padding: "5px 8px" }}
                  >
                    <option value="">Ligar a um cliente…</option>
                    {clientes.map((c) => (
                      <option key={c.client_id} value={c.client_id}>{c.display_name}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {expandida === t.tenant_id && (
              <div style={{ marginTop: 12 }}>
                {t.usuarios.map((u) => (
                  <div key={u.user_id} style={{
                    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
                    padding: "9px 0", borderTop: "1px solid var(--line)",
                  }}>
                    <div style={{ minWidth: 220 }}>
                      <div style={{ fontSize: 13 }}>{u.nome}</div>
                      <div style={{ fontSize: 11, color: "var(--muted)" }}>{u.email}</div>
                    </div>
                    <span style={chip}>{u.papel === "ADMIN" ? "Administrador" : "Corretor"}</span>
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>
                      último acesso {quando(u.ultimo_acesso)}
                    </span>
                    {u.senha_desatualizada ? (
                      <span style={{ ...chip, color: "var(--danger, #f87171)", borderColor: "currentColor" }}
                        title="A pessoa trocou a senha pelo CRM depois que ela foi definida aqui. O que está no cofre não abre mais.">
                        cofre desatualizado
                      </span>
                    ) : u.no_cofre ? (
                      <span style={{ ...chip, color: "var(--ok, #34d399)", borderColor: "currentColor" }}>
                        no cofre · {quando(u.senha_definida_em)}
                      </span>
                    ) : (
                      <span style={chip}>fora do cofre</span>
                    )}
                    <span style={{ flex: 1 }} />

                    {u.no_cofre && !reveladas[u.user_id] && (
                      <button type="button"
                        onClick={() => { setRevelando({ t, u }); setSenhaDoPainel(""); setErro(""); }}
                        style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12 }}>
                        Ver
                      </button>
                    )}
                    <button type="button"
                      onClick={() => { setAlvo({ t, u }); setNovaSenha(""); setSenhaDoPainel(""); setErro(""); }}
                      style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12 }}>
                      Definir senha
                    </button>

                    {reveladas[u.user_id] && (
                      <div style={{
                        flexBasis: "100%", marginTop: 8, padding: 10, borderRadius: 10,
                        background: "var(--wash)", border: "1px solid var(--line)",
                        display: "grid", gap: 6, fontSize: 13,
                      }}>
                        <Campo rotulo="Login" valor={reveladas[u.user_id].login}
                          aoCopiar={() => setAviso("Login copiado.")} />
                        <Campo rotulo="Senha" valor={reveladas[u.user_id].senha}
                          aoCopiar={() => setAviso("Senha copiada.")} />
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <small style={{ color: "var(--muted)" }}>
                            some em {Math.max(0, Math.ceil(((expiraEm[u.user_id] ?? agora) - agora) / 1000))}s
                          </small>
                          <button type="button" onClick={() => esconder(u.user_id)}
                            style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 8, padding: "3px 9px", cursor: "pointer", fontSize: 11 }}>
                            Esconder agora
                          </button>
                          {u.senha_desatualizada && (
                            <small style={{ color: "var(--danger, #f87171)" }}>
                              atenção: esta senha foi trocada pelo usuário e provavelmente não abre mais
                            </small>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {t.convites_pendentes.length > 0 && (
                  <div style={{ marginTop: 10, fontSize: 12, color: "var(--muted)" }}>
                    Convites pendentes: {t.convites_pendentes.map((c) => `${c.email} (${c.papel})`).join(", ")}
                  </div>
                )}

                <button type="button"
                  onClick={() => { setConvidando(t); setEmailConvite(""); setLinkGerado(""); setSenhaDoPainel(""); setErro(""); }}
                  style={{ marginTop: 10, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 8, padding: "6px 11px", cursor: "pointer", fontSize: 12 }}>
                  Convidar pessoa
                </button>
              </div>
            )}
          </section>
        ))}

        {/* ---------------------------------------------------- revelar --- */}
        {revelando && (
          <div style={{ ...caixa, borderColor: "var(--accent, #60a5fa)" }}>
            <strong style={{ fontSize: 14 }}>Ver o acesso de {revelando.u.email}</strong>
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 10px" }}>
              Confirme sua senha do Dashboard. O login e a senha ficam visíveis por 3 minutos
              e a consulta fica registrada na auditoria do cofre.
            </p>
            <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
              <input type="password" placeholder="Sua senha do Dashboard"
                value={senhaDoPainel} onChange={(e) => setSenhaDoPainel(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && senhaDoPainel) void revelar(); }}
                autoFocus
                style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={salvando || !senhaDoPainel}
                  onClick={() => void revelar()}
                  style={{ border: 0, background: "var(--accent, #2563eb)", color: "#fff", borderRadius: 9, padding: "9px 14px", cursor: "pointer" }}>
                  {salvando ? "Abrindo…" : "Mostrar login e senha"}
                </button>
                <button type="button" onClick={() => { setRevelando(null); setSenhaDoPainel(""); }}
                  style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 9, padding: "9px 14px", cursor: "pointer" }}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ----------------------------------------------- definir senha -- */}
        {alvo && (
          <div style={{ ...caixa, borderColor: "var(--accent, #60a5fa)" }}>
            <strong style={{ fontSize: 14 }}>Definir a senha de {alvo.u.email}</strong>
            {/* O banner do topo fica longe daqui: com varios cards abertos, um erro
                desta ação parecia ser de outra imobiliária. */}
            {erro && (
              <div style={{ marginTop: 8, fontSize: 12, color: "var(--danger, #f87171)" }}>
                {erro}
              </div>
            )}
            <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 10px" }}>
              A senha que você digitar passa a valer no CRM e vai cifrada para o cofre de{" "}
              {alvo.t.cliente || "—"}. Você digita — eu não gero senha por você.
            </p>
            <div style={{ display: "grid", gap: 8, maxWidth: 420 }}>
              <input type="password" placeholder="Nova senha do usuário (mín. 10)"
                value={novaSenha} onChange={(e) => setNovaSenha(e.target.value)}
                style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px" }} />
              <input type="password" placeholder="Sua senha do Dashboard (confirmação)"
                value={senhaDoPainel} onChange={(e) => setSenhaDoPainel(e.target.value)}
                style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={salvando || novaSenha.length < 10 || !senhaDoPainel}
                  onClick={() => void definirSenha()}
                  style={{ border: 0, background: "var(--accent, #2563eb)", color: "#fff", borderRadius: 9, padding: "9px 14px", cursor: "pointer" }}>
                  {salvando ? "Salvando…" : "Definir e guardar no cofre"}
                </button>
                <button type="button" onClick={() => setAlvo(null)}
                  style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 9, padding: "9px 14px", cursor: "pointer" }}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ---------------------------------------------------- convidar -- */}
        {convidando && (
          <div style={{ ...caixa, borderColor: "var(--accent, #60a5fa)" }}>
            <strong style={{ fontSize: 14 }}>Convidar para {convidando.nome}</strong>
            <div style={{ display: "grid", gap: 8, maxWidth: 420, marginTop: 10 }}>
              <input type="email" placeholder="E-mail da pessoa" value={emailConvite}
                onChange={(e) => setEmailConvite(e.target.value)}
                style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px" }} />
              <select value={papelConvite} onChange={(e) => setPapelConvite(e.target.value)}
                style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px" }}>
                <option value="BROKER">Corretor</option>
                <option value="ADMIN">Administrador</option>
              </select>
              <input type="password" placeholder="Sua senha do Dashboard (confirmação)"
                value={senhaDoPainel} onChange={(e) => setSenhaDoPainel(e.target.value)}
                style={{ background: "var(--panel)", color: "var(--text)", border: "1px solid var(--line)", borderRadius: 9, padding: "9px 11px" }} />
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={salvando || !emailConvite || !senhaDoPainel}
                  onClick={() => void convidar()}
                  style={{ border: 0, background: "var(--accent, #2563eb)", color: "#fff", borderRadius: 9, padding: "9px 14px", cursor: "pointer" }}>
                  {salvando ? "Criando…" : "Criar convite"}
                </button>
                <button type="button" onClick={() => setConvidando(null)}
                  style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 9, padding: "9px 14px", cursor: "pointer" }}>
                  Cancelar
                </button>
              </div>
              {linkGerado && (
                <div style={{ fontSize: 12 }}>
                  <div style={{ color: "var(--muted)", marginBottom: 4 }}>
                    Link do convite — nada é enviado automaticamente:
                  </div>
                  <code style={{ wordBreak: "break-all", display: "block", padding: 8, background: "var(--wash)", borderRadius: 8 }}>
                    {linkGerado}
                  </code>
                  <button type="button"
                    onClick={() => { void navigator.clipboard.writeText(linkGerado); setAviso("Link copiado."); }}
                    style={{ marginTop: 6, border: "1px solid var(--line)", background: "transparent", color: "var(--text)", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontSize: 12 }}>
                    Copiar link
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <p style={{ fontSize: 11, color: "var(--muted)", marginTop: 14 }}>
          As senhas definidas aqui aparecem em <strong>Cofre de acessos</strong>, no seu perfil,
          na categoria CRM. Toda ação fica registrada na auditoria do cofre.
          {crmUrl && <> O CRM está em <code>{crmUrl}</code>.</>}
        </p>
      </div>
    </div>,
    document.body,
  );
}
