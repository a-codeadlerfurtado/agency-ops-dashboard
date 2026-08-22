import { GREETING_AUDIO_V6_00 } from "../../greeting-audio-v6/part-00";
import { GREETING_AUDIO_V6_01 } from "../../greeting-audio-v6/part-01";
import { GREETING_AUDIO_V6_02 } from "../../greeting-audio-v6/part-02";
import { GREETING_AUDIO_V6_03 } from "../../greeting-audio-v6/part-03";

export const dynamic = "force-dynamic";

const FULL_GREETING_B64 = [
  GREETING_AUDIO_V6_00,
  GREETING_AUDIO_V6_03,
  GREETING_AUDIO_V6_02,
  GREETING_AUDIO_V6_01,
].join("").replace(/\s+/g, "");

let cachedBytes: Uint8Array | null = null;

function base64Value(code: number) {
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  if (code >= 48 && code <= 57) return code - 48 + 52;
  if (code === 43) return 62;
  if (code === 47) return 63;
  return -1;
}

function decodeBase64(value: string) {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean.length) return new Uint8Array(0);

  const out = new Uint8Array(Math.ceil(clean.length * 3 / 4));
  let outIndex = 0;
  let quartet: number[] = [];

  for (let index = 0; index < clean.length; index += 1) {
    const code = clean.charCodeAt(index);
    if (code === 61) {
      quartet.push(-2);
    } else {
      const value6 = base64Value(code);
      if (value6 < 0) continue;
      quartet.push(value6);
    }

    if (quartet.length !== 4) continue;

    const [a, b, c, d] = quartet;
    if (a >= 0 && b >= 0) {
      out[outIndex++] = (a << 2) | (b >> 4);
      if (c >= 0) {
        out[outIndex++] = ((b & 15) << 4) | (c >> 2);
        if (d >= 0) out[outIndex++] = ((c & 3) << 6) | d;
      }
    }
    quartet = [];
  }

  return out.slice(0, outIndex);
}

function getAudioBytes() {
  if (cachedBytes) return cachedBytes;
  const bytes = decodeBase64(FULL_GREETING_B64);
  if (!bytes.byteLength) throw new Error("Greeting audio bundle is empty");
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
    "x-opsquestion-audio": "mp3-v6-manual-base64-decoder",
    "x-opsquestion-audio-size": String(total),
  };
}

export async function GET(request: Request) {
  try {
    const bytes = getAudioBytes();
    const total = bytes.byteLength;
    const range = request.headers.get("range");

    if (!range) {
      return new Response(bytes.slice().buffer, {
        status: 200,
        headers: { ...commonHeaders(total), "content-length": String(total) },
      });
    }

    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (!match) {
      return new Response(null, {
        status: 416,
        headers: { ...commonHeaders(total), "content-range": `bytes */${total}` },
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
        headers: { ...commonHeaders(total), "content-range": `bytes */${total}` },
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "Greeting audio unavailable";
    return new Response(message, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
}
