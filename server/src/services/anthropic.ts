import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";

const client = new Anthropic({ apiKey: env.anthropicApiKey });

export type ClaudeTurn = { role: "user" | "assistant"; content: string };

export type ClaudeResult = {
  text: string | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  stopReason: string | null;
  error: string | null;
};

/**
 * Chamada a Messages API oficial.
 *
 * Sem `temperature`/`top_p`/`budget_tokens`: esses parametros foram removidos
 * na familia Sonnet 5 / Opus 5 e a API responde 400 se forem enviados.
 */
export async function askClaude(system: string, turns: ClaudeTurn[]): Promise<ClaudeResult> {
  const started = Date.now();
  const model = env.anthropicModel;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: env.anthropicMaxTokens,
      system,
      messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return {
      text: text || null,
      model: response.model ?? model,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
      latencyMs: Date.now() - started,
      stopReason: response.stop_reason ?? null,
      // Um "refusal" nao e' falha de infraestrutura: a chamada foi bem sucedida
      // e o motivo precisa aparecer na auditoria sem virar erro 500.
      error: response.stop_reason === "refusal" ? "anthropic_refusal" : null,
    };
  } catch (caught) {
    // A mensagem do SDK nunca inclui a chave; ainda assim so' propagamos
    // status/nome do erro para nao arriscar vazar payload em log.
    const detail =
      caught instanceof Anthropic.APIError
        ? `anthropic_http_${caught.status}`
        : caught instanceof Error
          ? caught.name
          : "anthropic_request_failed";
    return {
      text: null,
      model,
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - started,
      stopReason: null,
      error: detail,
    };
  }
}
