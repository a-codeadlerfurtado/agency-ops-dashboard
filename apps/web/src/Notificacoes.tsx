import { useEffect, useRef, useState } from "react";
import { irPara } from "./App";
import { relativo } from "./lib/format";
import { useNotificacoes } from "./lib/notificacoes";
import { Ico } from "./ui";

export default function Notificacoes({ userId }: { userId: string }) {
  const { lista, naoLidas, marcarLidas, erro } = useNotificacoes(userId);
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

  // Realtime indisponivel nao pode quebrar a topbar: some o sino e segue.
  if (erro) return null;

  return (
    <div ref={caixa} style={{ position: "relative" }}>
      <button
        className="btn ghost sm"
        onClick={() => { setAberto((a) => !a); if (!aberto && naoLidas > 0) void marcarLidas(); }}
        aria-label={`Notificacoes${naoLidas > 0 ? `, ${naoLidas} nao lidas` : ""}`}
        aria-expanded={aberto}
        style={{ position: "relative" }}
      >
        {Ico.bell({ size: 16 })}
        {naoLidas > 0 && (
          <span style={{
            position: "absolute", top: 2, right: 2,
            minWidth: 15, height: 15, padding: "0 4px",
            borderRadius: 99, background: "var(--accent)", color: "#1b0d04",
            fontSize: 10, fontWeight: 700, lineHeight: "15px", textAlign: "center",
          }}>
            {naoLidas > 9 ? "9+" : naoLidas}
          </span>
        )}
      </button>

      {aberto && (
        <div style={{
          position: "absolute", right: 0, top: "calc(100% + 8px)",
          width: "min(340px, calc(100vw - 32px))", zIndex: 60,
          background: "var(--panel)", border: "1px solid var(--line-card)",
          borderRadius: "var(--r-lg)", boxShadow: "var(--shadow-hover)",
          maxHeight: 380, overflowY: "auto",
        }}>
          <div style={{
            padding: "11px 13px", borderBottom: "1px solid var(--line-soft)",
            fontSize: 12, fontWeight: 600, letterSpacing: "0.05em",
            textTransform: "uppercase", color: "var(--text-subtle)",
          }}>
            Notificacoes
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
                  if (n.entity_type === "opportunity" && n.entity_id) irPara(`/leads/${n.entity_id}`);
                }}
                style={{
                  display: "block", width: "100%", textAlign: "left", cursor: "pointer",
                  padding: "10px 13px", border: 0,
                  borderBottom: "1px solid var(--line-soft)",
                  background: n.read_at ? "transparent" : "var(--blue-wash)",
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
  );
}
