/**
 * Transcricao de fallback.
 *
 * O caminho normal e a Web Speech API no navegador -- de graca, sem round-trip.
 * Isto aqui existe para Safari e iOS, que nao a implementam. So e chamado
 * quando o navegador avisa que nao tem reconhecimento nativo.
 */

import type { EnvJarvis } from "./tools";
import { normalizarTranscricaoOperacional } from "./memory";

const MODELO = "@cf/openai/whisper-large-v3-turbo";
const AUDIO_MAX_BYTES = 8 * 1024 * 1024;

function bytesParaBase64(bytes: Uint8Array): string {
  let binario = "";
  const bloco = 0x8000;
  for (let i = 0; i < bytes.length; i += bloco) {
    binario += String.fromCharCode(...bytes.subarray(i, i + bloco));
  }
  return btoa(binario);
}

export async function transcrever(request: Request, env: EnvJarvis): Promise<Response> {
  if (!env.AI) {
    return Response.json({ ok: false, error: "workers_ai_not_configured" }, { status: 503 });
  }

  const buffer = await request.arrayBuffer();
  if (!buffer.byteLength) {
    return Response.json({ ok: false, error: "audio_vazio" }, { status: 400 });
  }
  if (buffer.byteLength > AUDIO_MAX_BYTES) {
    return Response.json({ ok: false, error: "audio_grande_demais" }, { status: 413 });
  }

  try {
    const resultado: any = await env.AI.run(MODELO, {
      audio: bytesParaBase64(new Uint8Array(buffer)),
      language: "pt",
      task: "transcribe",
      vad_filter: true,
      condition_on_previous_text: false,
      no_speech_threshold: 0.48,
      compression_ratio_threshold: 2.2,
      log_prob_threshold: -0.8,
      hallucination_silence_threshold: 0.6,
    });
    let texto = normalizarTranscricaoOperacional(resultado?.text ?? resultado?.result?.text).trim();
    if (/^(?:transcri[cç][aã]o e )?legendas?(?: por)?\s+[\p{L} .'-]{2,}$/iu.test(texto)) texto = "";
    if (/^(?:legenda|subt[ií]tulos?)\s+[\p{L} .'-]{2,}$/iu.test(texto)) texto = "";
    return Response.json({ ok: true, text: texto });
  } catch (erro) {
    return Response.json(
      { ok: false, error: erro instanceof Error ? erro.message : "stt_falhou" },
      { status: 502 },
    );
  }
}
