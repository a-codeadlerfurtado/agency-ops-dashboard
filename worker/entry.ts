import baseWorker from "./index";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const OLD_IMG_SRC = "img-src 'self' data:";
const NEW_IMG_SRC = `img-src 'self' data: ${SUPABASE}`;
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const VISION_PROBE_KEY = "cvp_20260829_7f0e3a44c8c249bd";

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

async function runVisionProbe(request: Request, env: any): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/creative-vision-probe") return null;
  if (request.method !== "POST") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }
  if (request.headers.get("x-creative-probe-key") !== VISION_PROBE_KEY) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  if (env.AI_RATE_LIMITER?.limit) {
    const limited = await env.AI_RATE_LIMITER.limit({ key: "creative-vision-probe" });
    if (!limited?.success) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
  }

  try {
    const body = await request.json().catch(() => null) as any;
    const base64 = String(body?.image_base64 || "");
    const contentType = String(body?.content_type || "image/jpeg").toLowerCase();
    if (!base64 || base64.length > 11_000_000) {
      return Response.json({ ok: false, error: "invalid_image" }, { status: 400 });
    }
    if (!/^image\/(jpeg|jpg|png|webp|gif)$/.test(contentType)) {
      return Response.json({ ok: false, error: "unsupported_image_type" }, { status: 400 });
    }

    const input = {
      messages: [
        {
          role: "system",
          content:
            "Voce classifica criativos imobiliarios olhando APENAS a imagem fornecida. Nao use nome de campanha, cliente ou anuncio. Responda em portugues do Brasil.",
        },
        {
          role: "user",
          content:
            "Analise a imagem e devolva uma descricao curta e objetiva contendo: tipo visual (foto, layout, render, print etc.); assunto principal (fachada, interior, lazer, planta, pessoa/corretor, terreno, empreendimento ou outro); textos legiveis importantes; se ha preco/oferta/condicao; se ha pessoa; e o estilo geral. Nao invente elementos nao visiveis.",
        },
      ],
      image: `data:${contentType};base64,${base64}`,
      max_tokens: 180,
      temperature: 0,
    };

    const result = await env.AI.run(VISION_MODEL, input);
    return Response.json({ ok: true, model: VISION_MODEL, result });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}

export default {
  async fetch(request: Request, env: any, context: any): Promise<Response> {
    const probe = await runVisionProbe(request, env);
    if (probe) return probe;

    const response = await baseWorker.fetch(request, env, context);
    return widenImageCsp(response);
  },
};
