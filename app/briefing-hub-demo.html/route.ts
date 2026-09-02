export async function GET(request: Request): Promise<Response> {
  const target = new URL("/briefing-hub-demo", request.url);
  target.search = new URL(request.url).search;
  return Response.redirect(target, 307);
}
