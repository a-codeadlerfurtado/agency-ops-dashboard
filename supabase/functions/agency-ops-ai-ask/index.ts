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

/**
 * Compatibilidade da rota original do OpsQuestion.
 *
 * O frontend legado ainda chama agency-ops-ai-ask. A autorização e o escopo por
 * perfil agora vivem em agency-ops-ai-ask-team, portanto esta rota apenas encaminha
 * a requisição autenticada. Assim versões antigas do bundle deixam de aplicar o
 * antigo bloqueio Beta exclusivo do Adler sem abrir acesso anônimo.
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
  const target = `${supabaseUrl}/functions/v1/agency-ops-ai-ask-team`;

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
      error: "Falha temporária no OpsQuestion.",
      detail: String(error instanceof Error ? error.message : error).slice(0, 300),
    }, 502);
  }
});
