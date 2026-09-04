import { useEffect, useRef, type ReactNode } from "react";
import { Ico } from "./ui";

/**
 * Modal e drawer sobre <dialog> nativo.
 *
 * Por que nativo e não uma div com z-index:
 *  - focus trap, Esc e retorno de foco vêm do browser, corretos;
 *  - `::backdrop` e o top layer eliminam a guerra de z-index;
 *  - a saída anima em CSS puro (`allow-discrete` + `overlay`), sem precisar
 *    manter o componente montado à mão nem instalar AnimatePresence.
 *
 * O elemento fica sempre montado e alternamos `showModal()` / `close()`: se
 * desmontássemos no React, o DOM sumiria antes de a animação de saída rodar.
 */
export default function Dialogo({
  aberto,
  titulo,
  aoFechar,
  children,
  variante = "centro",
  rodape,
  largura,
}: {
  aberto: boolean;
  titulo: string;
  aoFechar: () => void;
  children: ReactNode;
  variante?: "centro" | "lateral";
  rodape?: ReactNode;
  /** largura em px; o CSS ja limita ao viewport */
  largura?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (aberto && !d.open) d.showModal();
    else if (!aberto && d.open) d.close();
  }, [aberto]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // Esc e clique no backdrop passam pelo evento nativo `cancel`/`close`
    const aoCancelar = (e: Event) => { e.preventDefault(); aoFechar(); };
    d.addEventListener("cancel", aoCancelar);
    return () => d.removeEventListener("cancel", aoCancelar);
  }, [aoFechar]);

  return (
    <dialog
      ref={ref}
      className={`mdl ${variante}`}
      aria-label={titulo}
      style={largura ? ({ "--mdl-w": largura + "px" } as React.CSSProperties) : undefined}
      // clique fora fecha; o alvo só é o próprio <dialog> quando é o backdrop
      onClick={(e) => { if (e.target === ref.current) aoFechar(); }}
    >
      <div className="mdl-caixa">
        <div className="mdl-head">
          <h2>{titulo}</h2>
          <span className="spacer" />
          <button className="btn ghost sm" onClick={aoFechar} aria-label="Fechar">
            {Ico.close({ size: 16 })}
          </button>
        </div>
        <div className="mdl-body">{children}</div>
        {rodape && (
          <div className="mdl-head" style={{ borderBottom: 0, borderTop: "1px solid var(--line-soft)" }}>
            {rodape}
          </div>
        )}
      </div>
    </dialog>
  );
}
