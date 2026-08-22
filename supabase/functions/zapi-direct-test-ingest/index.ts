declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

async function drainQueue(projectUrl: string, serviceRoleKey: string) {
  try {
    const res = await fetch(`${projectUrl}/rest/v1/rpc/process_zapi_direct_pending`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'apikey': serviceRoleKey,
        'authorization': `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ p_limit: 50 }),
    });
    if (!res.ok) console.error('zapi official queue drain failed', res.status, await res.text());
  } catch (error) {
    console.error('zapi official queue drain error', error);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    return new Response(JSON.stringify({
      ok: true,
      service: 'zapi-direct-test-ingest',
      mode: 'OFFICIAL_PRIMARY',
      durable_raw: true,
      promotes_to_canonical: true,
      lead_dispatch_routing: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const url = new URL(req.url);
  const token = url.searchParams.get('token') || req.headers.get('x-zapi-test-token') || '';

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
  }

  const messageId = String(payload.messageId ?? payload.messageid ?? '').trim();
  if (!messageId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing_messageId' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
  }

  const projectUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

  try {
    const rpc = await fetch(`${projectUrl}/rest/v1/rpc/ingest_zapi_direct_official_atomic`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'apikey': anonKey,
        'authorization': `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ p_payload: payload, p_token: token }),
    });

    const body = await rpc.text();
    if (!rpc.ok) {
      const unauthorized = rpc.status === 401 || rpc.status === 403 || body.includes('unauthorized');
      const missing = body.includes('missing_messageId');
      return new Response(JSON.stringify({ ok: false, error: unauthorized ? 'unauthorized' : missing ? 'missing_messageId' : 'db_write_failed' }), {
        status: unauthorized ? 401 : missing ? 422 : 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (serviceRoleKey) {
      EdgeRuntime.waitUntil(drainQueue(projectUrl, serviceRoleKey));
    }

    return new Response(body || JSON.stringify({ ok: true, accepted: true, queued: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    console.error('zapi official ingest failed', error);
    return new Response(JSON.stringify({ ok: false, error: 'upstream_failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
});
