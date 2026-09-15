Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    return new Response(JSON.stringify({
      ok: true,
      service: 'ingest-zapi-whatsapp',
      retired: true,
      replacement: 'zapi-direct-test-ingest',
      writes_disabled: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const source = url.searchParams.get('source');
  const mode = url.searchParams.get('mode');
  if (source === 'backfill' || mode === 'heartbeat') {
    return new Response(JSON.stringify({ ok: true, retired: true, ignored: true, reason: 'direct_zapi_is_official_source' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ ok: false, retired: true, error: 'legacy_ingest_disabled', replacement: 'zapi-direct-test-ingest' }), {
    status: 410,
    headers: { 'content-type': 'application/json' },
  });
});
