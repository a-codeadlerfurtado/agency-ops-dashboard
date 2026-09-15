const ORIGIN = 'https://portainer.leonardoimobi.com.br';

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    let path = incoming.pathname;
    if (path === '/') path = '/reader/';
    else if (!path.startsWith('/reader')) path = '/reader' + path;

    const target = new URL(ORIGIN + path + incoming.search);
    const upstream = new Request(target, request);
    const response = await fetch(upstream);
    const headers = new Headers(response.headers);
    headers.set('X-Reader-Edge', 'cloudflare');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
