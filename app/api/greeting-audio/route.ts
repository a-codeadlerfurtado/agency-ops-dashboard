import { GREETING_AUDIO_V6_00 } from "../../greeting-audio-v6/part-00";
import { GREETING_AUDIO_V6_01 } from "../../greeting-audio-v6/part-01";
import { GREETING_AUDIO_V6_02 } from "../../greeting-audio-v6/part-02";
import { GREETING_AUDIO_V6_03 } from "../../greeting-audio-v6/part-03";

export const dynamic = "force-dynamic";

// Ordem física validada no histórico do áudio v6:
// 00=chunk0, 03=chunk1, 02=chunk2, 01=chunk3.
const FULL_GREETING_B64 = [
  GREETING_AUDIO_V6_00,
  GREETING_AUDIO_V6_03,
  GREETING_AUDIO_V6_02,
  GREETING_AUDIO_V6_01,
].join("");

let cachedBytes: Uint8Array | null = null;

function getAudioBytes() {
  if (cachedBytes) return cachedBytes;
  const binary = atob(FULL_GREETING_B64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  cachedBytes = bytes;
  return bytes;
}

function commonHeaders(total: number) {
  return {
    "content-type": "audio/mpeg",
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600, must-revalidate",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline; filename=opsquestion-greeting.mp3",
    "x-opsquestion-audio": "mp3-v6-http-range",
    "x-opsquestion-audio-size": String(total),
  };
}

export async function GET(request: Request) {
  const bytes = getAudioBytes();
  const total = bytes.byteLength;
  const range = request.headers.get("range");

  if (!range) {
    return new Response(bytes.slice().buffer, {
      status: 200,
      headers: {
        ...commonHeaders(total),
        "content-length": String(total),
      },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
  if (!match) {
    return new Response(null, {
      status: 416,
      headers: {
        ...commonHeaders(total),
        "content-range": `bytes */${total}`,
      },
    });
  }

  const startText = match[1];
  const endText = match[2];
  let start: number;
  let end: number;

  if (!startText && endText) {
    const suffixLength = Math.max(0, Number(endText));
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = startText ? Number(startText) : 0;
    end = endText ? Number(endText) : total - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
    return new Response(null, {
      status: 416,
      headers: {
        ...commonHeaders(total),
        "content-range": `bytes */${total}`,
      },
    });
  }

  end = Math.min(end, total - 1);
  const chunk = bytes.slice(start, end + 1);

  return new Response(chunk.buffer, {
    status: 206,
    headers: {
      ...commonHeaders(total),
      "content-length": String(chunk.byteLength),
      "content-range": `bytes ${start}-${end}/${total}`,
    },
  });
}
