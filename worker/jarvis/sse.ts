/**
 * Server-Sent Events para o loop do agente.
 *
 * O agente demora: cada rodada de ferramenta e uma ida ao Supabase. Sem
 * streaming, quem fala com a Jarvis fica olhando para o nada por 8 segundos sem
 * saber se travou. Os eventos `tool_start` existem para isso -- nao sao enfeite,
 * sao o unico sinal de vida durante a parte lenta.
 */

export type EventoJarvis =
  | { evento: "token"; dados: { text: string } }
  | { evento: "speech_ready"; dados: { text: string } }
  | { evento: "tool_start"; dados: { name: string; summary: string } }
  | { evento: "tool_end"; dados: { name: string; ok: boolean; ms: number } }
  | { evento: "pending"; dados: { action_id: string; summary: string } }
  | { evento: "done"; dados: Record<string, unknown> }
  | { evento: "error"; dados: { message: string } };

export class CanalSse {
  private readonly codificador = new TextEncoder();
  private controle: ReadableStreamDefaultController<Uint8Array> | null = null;
  private fechado = false;
  readonly corpo: ReadableStream<Uint8Array>;

  constructor() {
    this.corpo = new ReadableStream<Uint8Array>({
      start: (controle) => { this.controle = controle; },
      cancel: () => { this.fechado = true; this.controle = null; },
    });
  }

  emitir(evento: EventoJarvis["evento"], dados: unknown): void {
    if (this.fechado || !this.controle) return;
    const quadro = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
    try {
      this.controle.enqueue(this.codificador.encode(quadro));
    } catch {
      // navegador fechou a aba no meio da resposta; nao e erro nosso
      this.fechado = true;
      this.controle = null;
    }
  }

  encerrar(): void {
    if (this.fechado || !this.controle) return;
    this.fechado = true;
    try { this.controle.close(); } catch { /* ja fechado do outro lado */ }
    this.controle = null;
  }

  /** Cabecalhos de SSE. `no-transform` impede que algum proxy junte os quadros. */
  static cabecalhos(): HeadersInit {
    return {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
  }
}
