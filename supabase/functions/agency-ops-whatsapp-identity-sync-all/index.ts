import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json" },
    });
  }
  if (!SUPABASE_URL) {
    return new Response(JSON.stringify({ error: "server_configuration" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const token = req.headers.get("x-automation-secret") || "";
  const body = await req.text();
  const res = await fetch(`${SUPABASE_URL}/functions/v1/agency-ops-whatsapp-identity-sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-automation-secret": token,
    },
    body,
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") || "application/json",
      "cache-control": "no-store",
    },
  });
});
