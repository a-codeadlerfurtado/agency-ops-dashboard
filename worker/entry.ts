import baseWorker from "./index";
import { rotearJarvis } from "./jarvis/index";
import { rodarRondas } from "./jarvis/routines";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const OLD_IMG_SRC = "img-src 'self' data:";
const NEW_IMG_SRC = `img-src 'self' data: ${SUPABASE}`;
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const VISION_BULK_KEY = "cvi_20260829_5b1d73f04c784898";

function widenImageCsp(response: Response): Response {
  const headers = new Headers(response.headers);
  const csp = headers.get("content-security-policy");
  if (csp && csp.includes(OLD_IMG_SRC) && !csp.includes(NEW_IMG_SRC)) {
    headers.set("content-security-policy", csp.replace(OLD_IMG_SRC, NEW_IMG_SRC));
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function allowedImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host.endsWith(".fbcdn.net")
      || host === "fbcdn.net"
      || host.endsWith(".facebook.com")
      || host === "facebook.com"
      || host === "bfzdetibfcwihfkltbkp.supabase.co";
  } catch {
    return false;
  }
}

async function fetchImage(rawUrl: string, transformed: boolean): Promise<Response> {
  const baseOptions = {
    headers: {
      accept: "image/jpeg,image/webp,image/*,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 CreativeVisionBulk/1.1",
    },
    signal: AbortSignal.timeout(20_000),
  };
  if (!transformed) return fetch(rawUrl, baseOptions);
  return fetch(rawUrl, {
    ...baseOptions,
    cf: {
      image: {
        fit: "scale-down",
        width: 320,
        height: 320,
        format: "jpeg",
        quality: 78,
        metadata: "none",
      },
    },
  } as any);
}

async function fetchImageDataUrl(rawUrl: string): Promise<{ dataUrl: string; bytes: number; contentType: string; resized: boolean }> {
  if (!allowedImageUrl(rawUrl)) throw new Error("image_host_not_allowed");

  let resized = true;
  let response: Response;
  try {
    response = await fetchImage(rawUrl, true);
    if (!response.ok || !(response.headers.get("content-type") || "").toLowerCase().startsWith("image/")) {
      throw new Error(`transform_http_${response.status}`);
    }
  } catch {
    resized = false;
    response = await fetchImage(rawUrl, false);
  }

  if (!response.ok) throw new Error(`image_http_${response.status}`);
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (!bytes.length) throw new Error("image_empty");
  if (bytes.length > 8_000_000) throw new Error("image_too_large");
  const rawType = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
  const contentType = /^image\/(jpeg|jpg|png|webp|gif)$/.test(rawType) ? rawType : "image/jpeg";
  return {
    dataUrl: `data:${contentType};base64,${bytesToBase64(bytes)}`,
    bytes: bytes.length,
    contentType,
    resized,
  };
}

async function runVisionBulk(request: Request, env: any): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/internal/creative-vision") return null;
  if (request.method !== "POST") return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  if (request.headers.get("x-creative-vision-key") !== VISION_BULK_KEY) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => null) as any;
    const imageUrl = String(body?.image_url || "").trim();
    if (!imageUrl) return Response.json({ ok: false, error: "missing_image_url" }, { status: 400 });

    const fetched = await fetchImageDataUrl(imageUrl);
    const result = await env.AI.run(VISION_MODEL, {
      messages: [
        {
          role: "system",
          content: "Analise somente o criativo imobiliario visivel. Nao invente e nao repita.",
        },
        {
          role: "user",
          content:
            "Em ate 90 palavras: TIPO | ASSUNTO | SECUNDARIOS | TEXTO | PRECO | CONDICAO | PESSOA e papel | RENDER | ESTILO | DENSIDADE | CORES. Use SIM/NAO quando couber e registre apenas o que estiver visivel.",
        },
      ],
      image: fetched.dataUrl,
      max_tokens: 120,
      temperature: 0,
      repetition_penalty: 1.3,
      frequency_penalty: 0.3,
    });

    return Response.json({
      ok: true,
      model: VISION_MODEL,
      image: { bytes: fetched.bytes, content_type: fetched.contentType, resized: fetched.resized },
      result,
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: any, context: any): Promise<Response> {
    const vision = await runVisionBulk(request, env);
    if (vision) return vision;
    // A Jarvis entra aqui, antes do baseWorker, pelo mesmo motivo do
    // creative-vision: precisa do binding AI e nao pode passar pelo vinext.
    // /api/ai continua indo direto para o baseWorker, intocado.
    const jarvis = await rotearJarvis(request, env);
    if (jarvis) return jarvis;
    const response = await baseWorker.fetch(request, env, context);
    return widenImageCsp(response);
  },

  // Cron Trigger: 08h, 12h e 17h UTC = 05h, 09h e 14h em Brasilia.
  async scheduled(_evento: unknown, env: any, context: any): Promise<void> {
    context.waitUntil(rodarRondas(env));
  },
};
