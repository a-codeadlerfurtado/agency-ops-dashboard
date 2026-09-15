import { useNotificacoes } from "./lib/notificacoes";
import { relativo } from "./lib/format";
import { irPara } from "./App";
import { Avatar, Ico } from "./ui";
import { ImobiBoardMark } from "./Marca";
import { useEffect, useRef, useState } from "react";
import type { Sessao } from "./lib/types";

/**
 * Header do produto.
 *
 * O anterior era uma barra quase vazia com o título e o nome do tenant. O
 * Agency Ops apoia o produto num header com identidade (marca), contexto
 * (eyebrow + título) e controles com superfície própria — e é isso que separa
 * "produto proprietário" de "dashboard genérico".
 *
 * O indicador de tempo real reflete o estado REAL do canal do Supabase. Se a
 * conexão cair ele fica cinza. Nunca é decorativo.
 */
export default function Topbar({
  sessao, titulo, aoAbrirMenu,
}: { sessao: Sessao; titulo: string; aoAbrirMenu: () => void }) {
  const { lista, naoLidas, marcarLidas, conectado, erro } = useNotificacoes(sessao.userId);
  const [aberto, setAberto] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;
    const fora = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setAberto(false); };
    addEventListener("mousedown", fora);
    addEventListener("keydown", esc);
    return () => { removeEventListener("mousedown", fora); removeEventListener("keydown", esc); };
  }, [aberto]);

  const contexto = sessao.isAdmin ? "Administracao" : "Carteira";

  return (
    <header className="topbar">
      <button className="ctrl mobile-only" onClick={aoAbrirMenu} aria-label="Abrir menu">
        {Ico.menu({ size: 16 })}
      </button>

      <div className="topbar-marca">
        <ImobiBoardMark size={24} />
      </div>

      <div className="topbar-ctx">
        <span className="eyebrow">{sessao.tenant.name + " · " + contexto}</span>
        <span className="topbar-title">{titulo}</span>
      </div>

      <span className="spacer" />

      {!erro && (
        <span
          className={conectado ? "sinal" : "sinal frio"}
          title={conectado
            ? "Canal de tempo real conectado: lead novo aparece sem recarregar."
            : "Sem canal de tempo real. Os dados continuam corretos, mas nao chegam sozinhos."}
        >
          <span className="bolinha" />
          <span className="some-no-mobile">{conectado ? "Tempo real" : "Sem tempo real"}</span>
        </span>
      )}

      <div ref={caixa} style={{ position: "relative" }}>
        <button
          className="ctrl"
          onClick={() => { setAberto((a) => !a); if (!aberto && naoLidas > 0) void marcarLidas(); }}
          aria-label={"Notificacoes" + (naoLidas > 0 ? ", " + naoLidas + " nao lidas" : "")}
          aria-expanded={aberto}
          style={{ position: "relative" }}
        >
          {Ico.bell({ size: 16 })}
          {naoLidas > 0 && (
            <span style={{
              position: "absolute", top: -4, right: -4,
              minWidth: 16, height: 16, padding: "0 4px",
              borderRadius: 99, background: "var(--accent)", color: "#1b0d04",
              fontSize: 10, fontWeight: 800, lineHeight: "16px", textAlign: "center",
              border: "2px solid #051220",
            }}>
              {naoLidas > 9 ? "9+" : naoLidas}
            </span>
          )}
        </button>

        {aberto && (
          <div style={{
            position: "absolute", right: 0, top: "calc(100% + 9px)",
            width: "min(340px, calc(100vw - 32px))", zIndex: 60,
            background: "var(--panel)", border: "1px solid var(--line)",
            borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-hover)",
            maxHeight: 380, overflowY: "auto",
          }}>
            <div style={{ padding: "11px 14px", borderBottom: "1px solid var(--line-soft)" }}>
              <span className="eyebrow" style={{ marginBottom: 0 }}>Notificacoes</span>
            </div>
            {lista.length === 0 ? (
              <div style={{ padding: "26px 16px", textAlign: "center", fontSize: 13, color: "var(--text-subtle)" }}>
                Nada por aqui.
              </div>
            ) : (
              lista.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    setAberto(false);
                    if (n.entity_type === "opportunity" && n.entity_id) irPara("/leads/" + n.entity_id);
                  }}
                  style={{
                    display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                    padding: "10px 14px", border: 0,
                    borderBottom: "1px solid var(--line-soft)",
                    background: n.read_at ? "transparent" : "#0359a61f",
                    color: "var(--text)",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 550 }}>{n.title}</div>
                  {n.body && (
                    <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>{n.body}</div>
                  )}
                  <div style={{ fontSize: 11, color: "var(--text-subtle)", marginTop: 3 }}>
                    {relativo(n.created_at)}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="ctrl" style={{ paddingLeft: 4, paddingRight: 9, gap: 8 }}>
        <Avatar nome={sessao.nome} />
        <span className="rotulo some-no-mobile" style={{ color: "var(--text)" }}>
          {sessao.nome.split(" ")[0]}
        </span>
      </div>
    </header>
  );
}
