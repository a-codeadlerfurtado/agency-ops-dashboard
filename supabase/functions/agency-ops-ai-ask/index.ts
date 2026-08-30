import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

function isMetaConsultantRequest(rawBody: string) {
  try {
    const body = JSON.parse(rawBody);
    const question = typeof body?.question === "string" ? body.question : "";
    return question.includes("DADOS ATUAIS DO DASHBOARD:") ||
      (question.includes("DADOS ATUAIS:") && question.includes("PERGUNTA DO GT:"));
  } catch {
    return false;
  }
}

/**
 * Compatibilidade da rota original do OpsQuestion.
 *
 * Perguntas humanas continuam em agency-ops-ai-ask-team, com os limites normais
 * do OpsQuestion. Prompts estruturados gerados pelo Consultor de Performance são
 * encaminhados para uma rota dedicada, com autenticação e escopo GT/MGMT próprios.
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) return reply({ ok: false, error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply({ ok: false, error: "unauthorized" }, 401);

  const rawBody = await req.text();
  const functionName = isMetaConsultantRequest(rawBody)
    ? "agency-ops-meta-consultant-ai"
    : "agency-ops-ai-ask-team";
  const target = `${supabaseUrl}/functions/v1/${functionName}`;

  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        apikey: req.headers.get("apikey") || anonKey,
        "content-type": "application/json",
      },
      body: rawBody,
    });
    const text = await response.text();
    return new Response(text, {
      status: response.status,
      headers: {
        ...CORS,
        "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return reply({
      ok: false,
      error: functionName === "agency-ops-meta-consultant-ai"
        ? "Não foi possível gerar a leitura agora. Tente novamente em alguns segundos."
        : "Falha temporária no OpsQuestion.",
      detail: String(error instanceof Error ? error.message : error).slice(0, 300),
    }, 502);
  }
});
