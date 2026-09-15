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

function isSensitiveAuthAttempt(request, url) {
  if (request.method !== 'POST') return false;
  return /^\/auth\/(sign_in|password)/.test(url.pathname) || url.pathname === '/auth/sign_in';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname !== PUBLIC_HOST) return new Response('Not found', { status: 404 });

    if (isSensitiveAuthAttempt(request, url)) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const result = await env.AUTH_RATE_LIMITER.limit({ key: ip });
      if (!result.success) return new Response('Too many authentication attempts', { status: 429 });
    }

    const originUrl = new URL(ORIGIN_BASE + url.pathname);
    originUrl.search = url.search;

    const originRequest = new Request(originUrl.toString(), request);
    originRequest.headers.set('X-Forwarded-Host', PUBLIC_HOST);
    originRequest.headers.set('X-Forwarded-Proto', 'https');
    const clientIp = request.headers.get('CF-Connecting-IP');
    if (clientIp) originRequest.headers.set('X-Real-IP', clientIp);

    const response = await fetch(originRequest);
    const headers = securityHeaders(new Headers(response.headers));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
