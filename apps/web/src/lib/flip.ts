import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * FLIP (First, Last, Invert, Play) — animação de layout sem biblioteca.
 *
 * Por que existe: quando um card do Kanban muda de coluna, o React desmonta o
 * elemento de um lugar e monta em outro. Visualmente o card TELEPORTA. O olho
 * perde o rastro e o corretor não sabe para onde o lead foi.
 *
 * Como funciona: mede a posição ANTES da mudança (First), deixa o React
 * atualizar o DOM (Last), aplica a transformação inversa para o elemento
 * parecer que não saiu do lugar (Invert), e anima de volta ao zero (Play).
 *
 * Por que não usar Motion: `layout`/`layoutId` fazem exatamente isto, e
 * custariam ~30 kB gzip — 23% do nosso bundle. Isto aqui tem 60 linhas e anima
 * só `transform`, que roda no compositor sem tocar em layout nem em paint.
 *
 * Identificação por `data-flip-id` em vez de refs: o elemento que sai da coluna
 * A e o que entra na coluna B são nós de DOM DIFERENTES. O atributo casa os
 * dois pelo id do lead, que é o que o usuário está seguindo com o olho.
 */

const REDUZIDO = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useFlip<T extends HTMLElement = HTMLDivElement>(
  duracaoMs = 420
) {
  const container = useRef<T>(null);
  const antes = useRef<Map<string, DOMRect>>(new Map());
  const pendente = useRef(false);
  const emCurso = useRef<Map<string, Animation>>(new Map());

  const alvos = () =>
    container.current
      ? Array.from(container.current.querySelectorAll<HTMLElement>("[data-flip-id]"))
      : [];

  /** Chame ANTES de mexer no estado que muda o layout. */
  const capturar = useCallback(() => {
    if (REDUZIDO()) return;
    antes.current.clear();
    for (const el of alvos()) {
      const id = el.dataset.flipId;
      if (id) antes.current.set(id, el.getBoundingClientRect());
    }
    pendente.current = true;
  }, []);

  useLayoutEffect(() => {
    if (!pendente.current) return;
    pendente.current = false;
    if (REDUZIDO()) { antes.current.clear(); return; }

    for (const el of alvos()) {
      const id = el.dataset.flipId;
      if (!id) continue;
      const f = antes.current.get(id);
      if (!f) continue;

      const l = el.getBoundingClientRect();
      const dx = f.left - l.left;
      const dy = f.top - l.top;

      // menos de 1px nao e movimento, e animar isso so gasta frame
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;

      // arrastar dois cards seguidos nao pode empilhar animacao no mesmo no
      emCurso.current.get(id)?.cancel();

      const anim = el.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ],
        {
          duration: duracaoMs,
          easing: "cubic-bezier(0.32, 0.72, 0, 1)",  // --ease do design system
          composite: "replace",
        }
      );
      emCurso.current.set(id, anim);
      anim.finished.then(
        () => { if (emCurso.current.get(id) === anim) emCurso.current.delete(id); },
        () => { /* cancelada por outro arraste: nada a fazer */ }
      );
    }
    antes.current.clear();
  });

  return { container, capturar };
}
