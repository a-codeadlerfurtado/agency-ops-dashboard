/**
 * Transcricao de fallback.
 *
 * O caminho normal e a Web Speech API no navegador -- de graca, sem round-trip.
 * Isto aqui existe para Safari/iOS e para o Relato quando ele precisa de Whisper.
 */

import { Buffer } from "node:buffer";
import type { EnvJarvis } from "./tools";
import { normalizarTranscricaoOperacional } from "./memory";

const MODELO = "@cf/openai/whisper-large-v3-turbo";
const RAW_AUDIO_MAX_BYTES = 64 * 1024 * 1024;
const STT_AUDIO_MAX_BYTES = 8 * 1024 * 1024;

function compactarWavParaStt(input: ArrayBuffer): ArrayBuffer {
  const bytes = new Uint8Array(input);
  if (bytes.byteLength < 44) return input;
  const ascii = (offset: number, len: number) => String.fromCharCode(...bytes.subarray(offset, offset + len));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return input;

  const view = new DataView(input);
  let fmtOffset = -1, fmtSize = 0, dataOffset = -1, dataSize = 0;
  let cursor = 12;
  while (cursor + 8 <= bytes.byteLength) {
    const id = ascii(cursor, 4);
    const size = view.getUint32(cursor + 4, true);
    const payload = cursor + 8;
    if (payload + size > bytes.byteLength) break;
    if (id === "fmt ") { fmtOffset = payload; fmtSize = size; }
    if (id === "data") { dataOffset = payload; dataSize = size; break; }
    cursor = payload + size + (size % 2);
  }
  if (fmtOffset < 0 || fmtSize < 16 || dataOffset < 0 || dataSize <= 0) return input;

  let format = view.getUint16(fmtOffset, true);
  const channels = view.getUint16(fmtOffset + 2, true);
  const sampleRate = view.getUint32(fmtOffset + 4, true);
  const blockAlign = view.getUint16(fmtOffset + 12, true);
  const bits = view.getUint16(fmtOffset + 14, true);
  if (!channels || !sampleRate || !blockAlign || !bits) return input;

  // WAVE_FORMAT_EXTENSIBLE: the first 16 bits of SubFormat contain PCM (1) or IEEE float (3).
  if (format === 0xfffe && fmtSize >= 40) format = view.getUint16(fmtOffset + 24, true);
  if (![1, 3].includes(format)) return input;

  const inputFrames = Math.floor(dataSize / blockAlign);
  if (!inputFrames) return input;
  const targetRate = Math.min(16000, sampleRate);
  const outputFrames = Math.max(1, Math.floor(inputFrames * targetRate / sampleRate));
  const outputDataBytes = outputFrames * 2;
  const output = new ArrayBuffer(44 + outputDataBytes);
  const out = new DataView(output);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) out.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, "RIFF"); out.setUint32(4, 36 + outputDataBytes, true); writeAscii(8, "WAVE");
  writeAscii(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
  out.setUint16(22, 1, true); out.setUint32(24, targetRate, true); out.setUint32(28, targetRate * 2, true);
  out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  writeAscii(36, "data"); out.setUint32(40, outputDataBytes, true);

  const bytesPerSample = Math.max(1, Math.floor(bits / 8));
  const readSample = (offset: number) => {
    if (format === 3 && bits === 32) return Math.max(-1, Math.min(1, view.getFloat32(offset, true)));
    if (format === 1 && bits === 16) return view.getInt16(offset, true) / 32768;
    if (format === 1 && bits === 24) {
      let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
      if (value & 0x800000) value |= 0xff000000;
      return value / 8388608;
    }
    if (format === 1 && bits === 32) return view.getInt32(offset, true) / 2147483648;
    if (format === 1 && bits === 8) return (view.getUint8(offset) - 128) / 128;
    return 0;
  };

  for (let i = 0; i < outputFrames; i++) {
    const sourceFrame = Math.min(inputFrames - 1, Math.floor(i * sampleRate / targetRate));
    const frameOffset = dataOffset + sourceFrame * blockAlign;
    let mixed = 0;
    for (let ch = 0; ch < channels; ch++) mixed += readSample(frameOffset + ch * bytesPerSample);
    mixed = Math.max(-1, Math.min(1, mixed / channels));
    out.setInt16(44 + i * 2, Math.round(mixed * 32767), true);
  }
  return output;
}

export async function transcrever(request: Request, env: EnvJarvis): Promise<Response> {
  if (!env.AI) {
    return Response.json({ ok: false, error: "workers_ai_not_configured" }, { status: 503 });
  }

  const rawBuffer = await request.arrayBuffer();
  if (!rawBuffer.byteLength) {
    return Response.json({ ok: false, error: "audio_vazio" }, { status: 400 });
  }
  if (rawBuffer.byteLength > RAW_AUDIO_MAX_BYTES) {
    return Response.json({ ok: false, error: "audio_grande_demais" }, { status: 413 });
  }

  try {
    // Desktop grava WAV bruto de alta qualidade. Para STT nao precisamos enviar
    // dezenas de MB: compactamos para mono/16 kHz/PCM16 preservando a fala e,
    // crucialmente, mantendo local e remoto em canais independentes.
    const buffer = compactarWavParaStt(rawBuffer);
    if (buffer.byteLength > STT_AUDIO_MAX_BYTES) {
      return Response.json({ ok: false, error: "audio_grande_demais_apos_compactacao" }, { status: 413 });
    }
    const audio = Buffer.from(buffer).toString("base64");
    const limpar = (valor: unknown) => {
      let texto = normalizarTranscricaoOperacional(valor).trim();
      if (/^(?:transcri[cç][aã]o e )?legendas?(?: por)?\s+[\p{L} .'-]{2,}$/iu.test(texto)) texto = "";
      if (/^(?:legenda|subt[ií]tulos?)\s+[\p{L} .'-]{2,}$/iu.test(texto)) texto = "";
      return texto;
    };
    const executar = async (relaxed: boolean) => env.AI!.run(MODELO, {
      audio,
      language: "pt",
      task: "transcribe",
      vad_filter: relaxed ? false : true,
      condition_on_previous_text: false,
      no_speech_threshold: relaxed ? 0.92 : 0.48,
      compression_ratio_threshold: relaxed ? 2.8 : 2.2,
      log_prob_threshold: relaxed ? -1.6 : -0.8,
      hallucination_silence_threshold: relaxed ? 1.2 : 0.6,
      beam_size: relaxed ? 5 : 3,
    });
    let resultado: any = await executar(false);
    let texto = limpar(resultado?.text ?? resultado?.result?.text);
    let pass = "primary";
    if (!texto) {
      resultado = await executar(true);
      texto = limpar(resultado?.text ?? resultado?.result?.text);
      pass = "relaxed";
    }
    return Response.json({ ok: true, text: texto, pass });
  } catch (erro) {
    return Response.json(
      { ok: false, error: erro instanceof Error ? erro.message : "stt_falhou" },
      { status: 502 },
    );
  }
}
