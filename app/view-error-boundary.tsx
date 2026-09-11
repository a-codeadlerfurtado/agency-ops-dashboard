"use client";

/**
 * Cerca em volta de uma aba lazy.
 *
 * Sem isto, um throw durante o render de UMA view derruba a arvore inteira do
 * React: some a sidebar, some o Jarvis, some o dashboard, e o usuario ve a tela
 * recarregar sozinha. Foi o que aconteceu ao clicar em "Capacidade".
 *
 * A cerca e' deliberadamente burra: nao tenta consertar nada, so' impede que o
 * estrago passe da aba. Quem quiser tentar de novo clica no botao, que remonta
 * o filho com estado limpo.
 */

import { Component, type ReactNode } from "react";

type Props = { titulo: string; children: ReactNode };
type State = { erro: Error | null; tentativa: number };

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { erro: null, tentativa: 0 };

  static getDerivedStateFromError(erro: Error): Partial<State> {
    return { erro };
  }

  componentDidCatch(erro: Error) {
    // Log sem payload: nome e mensagem bastam para achar a view culpada.
    console.error({ event: "view_render_failed", view: this.props.titulo, error_name: erro.name, error_message: erro.message });
  }

  render() {
    if (!this.state.erro) return this.props.children;
    return (
      <div className="card section" style={{ display: "grid", gap: 10, placeItems: "start" }}>
        <div className="section-title">Não foi possível carregar {this.props.titulo}.</div>
        <p style={{ color: "var(--muted)", fontSize: 12, margin: 0 }}>
          O restante do dashboard continua funcionando normalmente.
        </p>
        <button
          className="btn"
          onClick={() => this.setState((s) => ({ erro: null, tentativa: s.tentativa + 1 }))}
        >
          Tentar novamente
        </button>
      </div>
    );
  }
}
