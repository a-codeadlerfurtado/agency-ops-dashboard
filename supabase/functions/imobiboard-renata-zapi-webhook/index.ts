const JSON_HEADERS = { "content-type": "application/json" };
const INSTANCE_ID = "3F95B37A38AAB17B4C56B2194C7A232A";

async function sbFetch(url: string, serviceRoleKey: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("apikey", serviceRoleKey);
  headers.set("authorization", "Bearer " + serviceRoleKey);
  return fetch(url, { ...init, headers });
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response(JSON.stringify({
      ok: true,
      service: "imobiboard-renata-zapi-webhook",
      instance_id: INSTANCE_ID,
      purpose: "IMOBIBOARD_LEAD_HISTORY",
    }), { status: 200, headers: JSON_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
      status: 405, headers: JSON_HEADERS,
    });
  }
  const projectUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!projectUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ ok: false, error: "server_configuration" }), {
      status: 500, headers: JSON_HEADERS,
    });
  }

  const url = new URL(req.url);
  const secret = url.searchParams.get("secret") || req.headers.get("x-renata-webhook-secret") || "";
  if (!secret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: JSON_HEADERS,
    });
  }

  const cfgRes = await sbFetch(
    projectUrl + "/rest/v1/renata_fiel_whatsapp_config?select=id,instance_id,active&instance_id=eq." +
      encodeURIComponent(INSTANCE_ID) + "&webhook_secret=eq." + encodeURIComponent(secret) + "&limit=1",
    serviceRoleKey,
    { headers: { "accept-profile": "imobi_board" } },
  );
  if (!cfgRes.ok) {
    return new Response(JSON.stringify({ ok: false, error: "config_lookup_failed" }), {
      status: 503, headers: JSON_HEADERS,
    });
  }
  const cfgRows = await cfgRes.json();
  if (!Array.isArray(cfgRows) || !cfgRows[0]?.active) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401, headers: JSON_HEADERS,
    });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid_json" }), {
      status: 422, headers: JSON_HEADERS,
    });
  }

  const payloadInstance = String((payload as any).instanceId ?? (payload as any).instance_id ?? "").trim();
  if (payloadInstance && payloadInstance !== INSTANCE_ID) {
    return new Response(JSON.stringify({ ok: false, error: "wrong_instance" }), {
      status: 403, headers: JSON_HEADERS,
    });
  }
  (payload as any).instanceId = INSTANCE_ID;

  const tokenRes = await sbFetch(
    projectUrl + "/rest/v1/automation_settings?key=eq.WA_DIRECT_TEST_TOKEN&select=value&limit=1",
    serviceRoleKey,
    { headers: { "accept-profile": "agency_ops" } },
  );
  if (!tokenRes.ok) {
    return new Response(JSON.stringify({ ok: false, error: "ingest_token_lookup_failed" }), {
      status: 503, headers: JSON_HEADERS,
    });
  }
  const tokenRows = await tokenRes.json();
  const tokenValue = Array.isArray(tokenRows) ? tokenRows[0]?.value : null;
  const officialToken = typeof tokenValue === "string"
    ? tokenValue
    : (typeof tokenValue === "object" && tokenValue
      ? String(tokenValue.token ?? tokenValue.value ?? "")
      : "");
  if (!officialToken) {
    return new Response(JSON.stringify({ ok: false, error: "ingest_token_missing" }), {
      status: 503, headers: JSON_HEADERS,
    });
  }

  const ingestRes = await sbFetch(
    projectUrl + "/rest/v1/rpc/ingest_zapi_direct_official_atomic",
    serviceRoleKey,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ p_payload: payload, p_token: officialToken }),
    },
  );
  const ingestText = await ingestRes.text();
  if (!ingestRes.ok) {
    return new Response(JSON.stringify({
      ok: false,
      error: "official_ingest_failed",
      status: ingestRes.status,
    }), {
      status: ingestRes.status >= 400 && ingestRes.status < 500 ? ingestRes.status : 503,
      headers: JSON_HEADERS,
    });
  }

  try {
    await sbFetch(
      projectUrl + "/rest/v1/rpc/zapi_direct_official_tick",
      serviceRoleKey,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-profile": "agency_ops",
          "accept-profile": "agency_ops",
        },
        body: JSON.stringify({ p_limit: 10 }),
      },
    );
  } catch (_) {}

  return new Response(ingestText || JSON.stringify({ ok: true, accepted: true }), {
    status: 200,
    headers: JSON_HEADERS,
  });
});
