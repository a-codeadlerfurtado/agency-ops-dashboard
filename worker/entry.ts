import baseWorker from "./index";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const OLD_IMG_SRC = "img-src 'self' data:";
const NEW_IMG_SRC = `img-src 'self' data: ${SUPABASE}`;
const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const VISION_PROBE_IMAGE = "https://scontent-iad6-1.xx.fbcdn.net/v/t15.13418-10/484232698_1039545421533113_659905603519595124_n.jpg?_nc_cat=106&ccb=1-7&_nc_eui2=AeF1WfVQ1pLTHIbhb0y-2HrDpcPkJ5tKB1Klw-Qnm0oHUrShBcWAbKRyfKx79zEqd3F4MuVfzul8S9UIJZhh_XY3&_nc_ohc=wdWdBOTVsPEQ7kNvwHMr4pf&_nc_oc=AdohnkgAlcA6Bhmf7ZTDn5IVDgkWWMgNqS-55z-UDh_qb3tuZ9hGdESkrCA8CWTGuuFdIX2Hk_Lu_uIeTBEssJOi&_nc_zt=23&_nc_ht=scontent-iad6-1.xx&edm=AAT1rw8EAAAA&_nc_gid=jQ9yjIJYAokbUSnEo4vtrg&_nc_tpa=Q5bMBQI60u-9WaLsNBKn_n-iSpNt1UxB1wgz2tSfV2z2PrWl7Rlm35nokqsvqadAtgSyPr4pluZrYPaNkg&stp=c0.5000x0.5000f_dst-emg0_p600x600_q75_tt6&ur=aaa768&_nc_sid=58080a&oh=00_AQIkbgHrSNgp2mDcC4PuSC81nSeGRpf2qWjgnerhn0IbEw&oe=6A990CC7";

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
  if (request.method !== "GET") {
    return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  if (env.AI_RATE_LIMITER?.limit) {
    const limited = await env.AI_RATE_LIMITER.limit({ key: "creative-vision-probe" });
    if (!limited?.success) {
      return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
    }
  }

  const input = {
    messages: [
      {
        role: "system",
        content: "Analise apenas a imagem fornecida. Responda em portugues do Brasil, de forma objetiva.",
      },
      {
        role: "user",
        content:
          "Descreva o que realmente aparece na imagem. Informe: tipo de criativo, assunto visual principal, textos legiveis, se ha preco/oferta, se ha pessoa/corretor, se ha fachada/interior/lazer/planta e as cores dominantes. Nao invente o que nao estiver visivel.",
      },
    ],
    image: VISION_PROBE_IMAGE,
    max_tokens: 260,
    temperature: 0,
  };

  try {
    const result = await env.AI.run(VISION_MODEL, input);
    return Response.json({ ok: true, model: VISION_MODEL, result });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    if (/agree|license|licen[cç]a|acceptable use/i.test(message)) {
      try {
        await env.AI.run(VISION_MODEL, { prompt: "agree" });
        const result = await env.AI.run(VISION_MODEL, input);
        return Response.json({ ok: true, model: VISION_MODEL, license_agreed_now: true, result });
      } catch (retry) {
        return Response.json(
          { ok: false, error: retry instanceof Error ? retry.message : String(retry) },
          { status: 500 },
        );
      }
    }
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
