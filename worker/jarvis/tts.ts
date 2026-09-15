/**
 * Voz da Jarvis via servidor proprio.
 *
 * TTS Cedar-only via OpenAI. Nao existe fallback para VPS nem Web Speech.
 * Se a OpenAI falhar, a rota retorna erro e o Jarvis fica sem voz.
 */

import type { EnvJarvis } from "./tools";

const LIMITE_CHARS = 1200;
const TIMEOUT_MS = 55_000;
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = "cedar";

const INSTRUCOES_VOZ = [
  "Fale em português brasileiro natural.",
  "Use uma voz adulta, encorpada, quente e confiante, com registro levemente grave e presença.",
  "Soe como uma pessoa conversando de perto, nunca como GPS, URA, locutor ou audiobook.",
  "Use ritmo espontâneo, um pouco mais lento que o padrão, com micro-pausas naturais e pausas maiores entre ideias.",
  "Varie a entonação discretamente e evite terminar todas as frases com a mesma cadência.",
  "Evite dicção excessivamente perfeita, pressa, monotonia e energia artificial.",
  "Leia números, nomes e siglas com clareza, sem correr.",
].join(" ");

export type EntradaTts = { text: string };

function json(corpo: unknown, status: number): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function prepararTexto(bruto: string): string {
  return bruto
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*[-•][ \t]+/gm, "")
    .replace(/[\[\]]/g, " ")
    .replace(/[*_`#>]/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, LIMITE_CHARS);
}
function endpointTts(env: EnvJarvis): { url: string; token: string } | null {
  const base = String(env.JARVIS_TTS_URL ?? env.KOKORO_URL ?? "").trim();
  const token = String(env.JARVIS_TTS_TOKEN ?? env.KOKORO_TOKEN ?? "").trim();
  if (!base || !token) return null;
  const limpo = base.replace(/\/+$/, "");
  return {
    url: limpo.endsWith("/tts") ? limpo : `${limpo}/tts`,
    token,
  };
}

async function openAiTts(text: string, env: EnvJarvis): Promise<Response | null> {
  const key = String(env.OPENAI_API_KEY ?? "").trim();
  if (!key) return null;
  try {
    const resposta = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input: text,
        instructions: INSTRUCOES_VOZ,
        response_format: "pcm",
        stream_format: "audio",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resposta.ok || !resposta.body) {
      const detalhe = await resposta.text().catch(() => "");
      console.error({ event: "jarvis_tts_falhou", etapa: "openai", status: resposta.status, detalhe: detalhe.slice(0, 600) });
      return null;
    }
    return resposta;
  } catch (erro) {
    console.error({ event: "jarvis_tts_falhou", etapa: "openai", detalhe: erro instanceof Error ? erro.message : String(erro) });
    return null;
  }
}

export async function sintetizar(request: Request, env: EnvJarvis): Promise<Response> {
  const corpo = (await request.json().catch(() => null)) as EntradaTts | null;
  const text = prepararTexto(String(corpo?.text ?? ""));
  if (!text) return json({ erro: "texto_vazio" }, 400);

  const resposta = await openAiTts(text, env);
  if (!resposta) return json({ erro: "cedar_indisponivel" }, 502);
  const engine = "openai";

  const upstreamType = (resposta.headers.get("content-type") ?? "").toLowerCase();
  if (upstreamType && !upstreamType.includes("audio") && !upstreamType.includes("octet-stream")) {
    console.error({ event: "jarvis_tts_falhou", etapa: "content_type_invalido", upstreamType });
    return json({ erro: "cedar_audio_invalido" }, 502);
  }

  // PCM bruto 24 kHz / 16-bit little-endian: formato recomendado para baixa latencia.
  // O Worker apenas repassa os chunks; o navegador agenda os samples assim que chegam.
  console.info({ event: "jarvis_tts_ok", engine: "openai", voice: OPENAI_TTS_VOICE, streaming: true });
  return new Response(resposta.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-jarvis-tts-engine": engine,
      "x-jarvis-tts-build": "cedar-only-v4",
      "x-jarvis-tts-format": "pcm_s16le_24000",
      "x-jarvis-tts-sample-rate": "24000",
      "x-jarvis-tts-stream": "1",
      ...(engine === "openai" ? { "x-jarvis-tts-voice": OPENAI_TTS_VOICE } : {}),
    },
  });
}

export { LIMITE_CHARS };
