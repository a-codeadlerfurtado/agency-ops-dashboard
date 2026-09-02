export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, probe: "briefing-hub-target-probe-20260902" }, { headers: { "cache-control": "no-store" } });
    }
    return new Response("Briefing Hub target probe — preview only", { status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
};
