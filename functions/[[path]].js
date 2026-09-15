const PUBLIC_HOST = 'app.leonardoimobi.com.br';
const ORIGIN_BASE = 'https://server.leonardoimobi.com.br/__imobia_chatwoot_origin__';

function securityHeaders(headers) {
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  headers.delete('Server');
  headers.delete('X-Powered-By');
  return headers;
}

export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const originUrl = new URL(ORIGIN_BASE + url.pathname);
  originUrl.search = url.search;

  const originRequest = new Request(originUrl.toString(), request);
  originRequest.headers.set('X-Forwarded-Host', PUBLIC_HOST);
  originRequest.headers.set('X-Forwarded-Proto', 'https');
  originRequest.headers.set('Host', 'server.leonardoimobi.com.br');
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) originRequest.headers.set('X-Real-IP', clientIp);

  const response = await fetch(originRequest);
  const headers = securityHeaders(new Headers(response.headers));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
