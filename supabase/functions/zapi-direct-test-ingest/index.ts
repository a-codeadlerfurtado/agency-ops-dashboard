Deno.serve(async (req) => {
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, service: 'zapi-direct-test-ingest', mode: 'RAW_ONLY_ATOMIC_RPC', promotes_to_canonical: false }), {
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

  const projectUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  try {
    const rpc = await fetch(`${projectUrl}/rest/v1/rpc/ingest_zapi_direct_test_atomic`, {
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
      const unauthorized = rpc.status === 401 || body.includes('unauthorized');
      return new Response(JSON.stringify({ ok: false, error: unauthorized ? 'unauthorized' : 'db_write_failed' }), {
        status: unauthorized ? 401 : 500,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(body || JSON.stringify({ ok: true, accepted: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (error) {
    console.error('zapi direct ingest failed', error);
    return new Response(JSON.stringify({ ok: false, error: 'upstream_failed' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
});
