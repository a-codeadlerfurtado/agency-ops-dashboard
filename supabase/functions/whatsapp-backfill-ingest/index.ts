Deno.serve(async (req) => {
  if (req.method === 'GET') {
    return new Response(JSON.stringify({
      ok: true,
      service: 'whatsapp-backfill-ingest',
      retired: true,
      writes_disabled: true,
      replacement: 'zapi-direct-test-ingest',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  return new Response(JSON.stringify({
    ok: true,
    retired: true,
    ignored: true,
    reason: 'direct_zapi_is_official_source',
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});
