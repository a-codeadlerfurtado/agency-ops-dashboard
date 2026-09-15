/**
 * Voz da Jarvis: pm_jarvis local primeiro, Cedar como fallback.
 * O cerebro e as ferramentas da Jarvis nao dependem deste modulo.
 */

import type { EnvJarvis } from "./tools";

const LIMITE_CHARS = 1200;
const LOCAL_TIMEOUTS_MS = [12_000, 8_000] as const;
const LOCAL_RETRY_DELAY_MS = 350;
const OPENAI_TIMEOUT_MS = 55_000;
const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
const OPENAI_TTS_VOICE = "cedar";
const LOCAL_TTS_VOICE = "pm_jarvis";

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
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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

function endpointLocal(env: EnvJarvis): string | null {
  const base = String(env.JARVIS_TTS_URL ?? env.KOKORO_URL ?? "").trim();
  if (!base) return null;
  const limpo = base.replace(/\/+$/, "");
  if (limpo.endsWith("/api/tts") || limpo.endsWith("/tts")) return limpo;
  return `${limpo}/api/tts`;
}
async function localTts(text: string, env: EnvJarvis): Promise<Response | null> {
  const url = endpointLocal(env);
  if (!url) return null;
  const token = String(env.JARVIS_TTS_TOKEN ?? env.KOKORO_TOKEN ?? "").trim();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-jarvis-token"] = token;

  for (let tentativa = 0; tentativa < LOCAL_TIMEOUTS_MS.length; tentativa++) {
    const timeout = LOCAL_TIMEOUTS_MS[tentativa];
    try {
      const resposta = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ text, voice: LOCAL_TTS_VOICE, speed: 1.0, docId: "jarvis-dashboard" }),
        signal: AbortSignal.timeout(timeout),
      });
      const tipo = (resposta.headers.get("content-type") ?? "").toLowerCase();
      if (resposta.ok && resposta.body && (tipo.includes("audio") || tipo.includes("octet-stream"))) return resposta;

      const detalhe = await resposta.text().catch(() => "");
      console.error({ event: "jarvis_tts_falhou", etapa: "local", tentativa: tentativa + 1, status: resposta.status, tipo, detalhe: detalhe.slice(0, 240) });
      if (resposta.status >= 400 && resposta.status < 500) return null;
    } catch (erro) {
      console.error({ event: "jarvis_tts_falhou", etapa: "local", tentativa: tentativa + 1, timeout_ms: timeout, detalhe: erro instanceof Error ? erro.message : String(erro) });
    }

    if (tentativa + 1 < LOCAL_TIMEOUTS_MS.length) {
      await new Promise((resolve) => setTimeout(resolve, LOCAL_RETRY_DELAY_MS));
    }
  }
  return null;
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
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
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
  const local = await localTts(text, env);
  if (local) {
    console.info({ event: "jarvis_tts_ok", engine: "local", voice: LOCAL_TTS_VOICE });
    return new Response(local.body, {
      status: 200,
      headers: {
        "content-type": local.headers.get("content-type") || "audio/mpeg",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-jarvis-tts-engine": "local",
        "x-jarvis-tts-voice": LOCAL_TTS_VOICE,
        "x-jarvis-tts-build": "hybrid-local-first-v1",
        "x-jarvis-tts-format": "mp3",
        "x-jarvis-tts-cache": local.headers.get("x-readerpro-tts-cache") || "UNKNOWN",
      },
    });
  }

  const cedar = await openAiTts(text, env);
  if (!cedar) return json({ erro: "tts_indisponivel" }, 502);
  console.warn({ event: "jarvis_tts_fallback", engine: "openai", voice: OPENAI_TTS_VOICE });
  return new Response(cedar.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "x-jarvis-tts-engine": "openai",
      "x-jarvis-tts-voice": OPENAI_TTS_VOICE,
      "x-jarvis-tts-build": "hybrid-local-first-v1",
      "x-jarvis-tts-format": "pcm_s16le_24000",
      "x-jarvis-tts-sample-rate": "24000",
      "x-jarvis-tts-stream": "1",
    },
  });
}

export { LIMITE_CHARS };
