import OpenAI from "openai";
import { env } from "../env.js";

const client = new OpenAI({ apiKey: env.openaiApiKey });

export type Turn = { role: "user" | "assistant"; content: string };

export type LlmResult = {
  text: string | null;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  finishReason: string | null;
  error: string | null;
};

/**
 * Chamada ao provedor de linguagem.
 *
 * A familia gpt-5 rejeita `max_tokens` (exige `max_completion_tokens`) e nao
 * aceita `temperature` diferente do padrao. Por isso nenhum dos dois aparece
 * aqui - enviar qualquer um devolve 400.
 */
export async function askLlm(system: string, turns: Turn[]): Promise<LlmResult> {
  const started = Date.now();
  const model = env.openaiModel;
  const focusedSystem = [
    system,
    "REGRA DE FOCO DA CONVERSA:",
    "- A pergunta MAIS RECENTE do usuario tem prioridade absoluta sobre o historico.",
    "- Use mensagens anteriores apenas para resolver referencias como 'ele', 'esse cliente', 'isso' ou para manter continuidade quando a pergunta realmente depender delas.",
    "- Se a pergunta atual mudou de assunto, ignore numeros, listas e conclusoes de respostas anteriores que nao sejam necessarios para responder ao novo assunto.",
    "- Nunca reutilize um numero de uma resposta anterior como se fosse resposta da pergunta atual sem evidencia atual que sustente esse mesmo numero.",
    "- Quando houver evidencia operacional da rodada atual, ela vence qualquer memoria da conversa que entre em conflito.",
    "- Seja conciso por padrao; detalhe apenas quando a pergunta exigir.",
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model,
      // Mantemos teto suficiente para analises, mas impedimos respostas enormes de
      // varios milhares de tokens de aumentar latencia e contaminar a proxima rodada.
      max_completion_tokens: Math.min(env.openaiMaxTokens, 3000),
      messages: [
        { role: "system", content: focusedSystem },
        ...turns.map((turn) => ({ role: turn.role, content: turn.content }) as const),
      ],
    });

    const choice = response.choices[0];
    const text = choice?.message?.content?.trim() || null;
    const finishReason = choice?.finish_reason ?? null;

    return {
      text,
      model: response.model ?? model,
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
      latencyMs: Date.now() - started,
      finishReason,
      // Resposta cortada no limite nao e' falha de rede, mas precisa aparecer na
      // auditoria: e' a explicacao de um texto que termina no meio.
      error: finishReason === "length" ? "openai_max_tokens" : null,
    };
  } catch (caught) {
    // A mensagem do SDK nao inclui a chave; ainda assim so' propagamos o status
    // para nao arriscar levar payload para o log.
    const detail =
      caught instanceof OpenAI.APIError
        ? `openai_http_${caught.status}`
        : caught instanceof Error
          ? caught.name
          : "openai_request_failed";
    return {
      text: null,
      model,
      inputTokens: null,
      outputTokens: null,
      latencyMs: Date.now() - started,
      finishReason: null,
      error: detail,
    };
  }
}
