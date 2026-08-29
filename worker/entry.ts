import baseWorker from "./index";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const OLD_IMG_SRC = "img-src 'self' data:";
const NEW_IMG_SRC = `img-src 'self' data: ${SUPABASE}`;
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const VISION_BULK_KEY = "cvi_20260829_5b1d73f04c784898";

const VISION_SCHEMA = {
  type: "object",
  properties: {
    visual_type: { type: "string", enum: ["photo", "layout", "render", "print", "other"] },
    primary_subject: {
      type: "string",
      enum: ["facade", "interior", "kitchen", "living_room", "bedroom", "bathroom", "leisure", "pool", "condominium", "land", "floorplan", "map", "person_realtor", "lifestyle", "development", "other"],
    },
    secondary_subjects: { type: "array", items: { type: "string" }, maxItems: 8 },
    visible_text: { type: "array", items: { type: "string" }, maxItems: 10 },
    has_price: { type: "boolean" },
    price_text: { type: "string" },
    has_commercial_condition: { type: "boolean" },
    commercial_condition_text: { type: "string" },
    has_person: { type: "boolean" },
    person_role: { type: "string", enum: ["realtor", "resident", "model", "unknown", "none"] },
    has_property_photo: { type: "boolean" },
    has_render: { type: "boolean" },
    style: { type: "string", enum: ["luxury", "popular", "editorial", "minimalist", "promotional", "institutional", "other"] },
    information_density: { type: "string", enum: ["low", "medium", "high"] },
    dominant_colors: { type: "array", items: { type: "string" }, maxItems: 6 },
    notes: { type: "string", maxLength: 300 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "visual_type", "primary_subject", "secondary_subjects", "visible_text", "has_price", "price_text",
    "has_commercial_condition", "commercial_condition_text", "has_person", "person_role", "has_property_photo",
    "has_render", "style", "information_density", "dominant_colors", "notes", "confidence",
  ],
};

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

async function fetchImageDataUrl(rawUrl: string): Promise<{ dataUrl: string; bytes: number; contentType: string }> {
  if (!allowedImageUrl(rawUrl)) throw new Error("image_host_not_allowed");
  const response = await fetch(rawUrl, {
    headers: {
      accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 CreativeVisionBulk/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
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
  };
}

async function runVisionBulk(request: Request, env: any): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/internal/creative-vision") return null;
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  if (request.headers.get("x-creative-vision-key") !== VISION_BULK_KEY) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json().catch(() => null) as any;
    const imageUrl = String(body?.image_url || "").trim();
    if (!imageUrl) return Response.json({ ok: false, error: "missing_image_url" }, { status: 400 });

    const fetched = await fetchImageDataUrl(imageUrl);
    const input = {
      messages: [
        {
          role: "system",
          content:
            "Classifique o criativo imobiliario olhando APENAS a imagem. Ignore contexto externo, nomes de cliente/campanha e nao invente o que nao estiver visivel.",
        },
        {
          role: "user",
          content:
            "Extraia a estrutura visual, assunto, textos legiveis, preco/condicao, pessoas, tipo de imagem, estilo e densidade de informacao. Se algo nao estiver visivel, use false, string vazia ou lista vazia.",
        },
      ],
      image: fetched.dataUrl,
      response_format: {
        type: "json_schema",
        json_schema: VISION_SCHEMA,
      },
      max_tokens: 280,
      temperature: 0,
      repetition_penalty: 1.15,
    };

    const result = await env.AI.run(VISION_MODEL, input);
    return Response.json({
      ok: true,
      model: VISION_MODEL,
      image: { bytes: fetched.bytes, content_type: fetched.contentType },
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

    const response = await baseWorker.fetch(request, env, context);
    return widenImageCsp(response);
  },
};
