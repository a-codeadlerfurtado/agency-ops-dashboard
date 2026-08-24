const DASHBOARD_HOME = "https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/agency-ops-dashboard-api?view=home";
const SUPABASE_ANON_KEY = "sb_publishable_mHdRMLiKvTHqB7q9tAnq2A_64VOrwU7";
const UPSTREAM_TIMEOUT_MS = 12_000;

export const dynamic = "force-dynamic";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    return json({ error: "unauthorized" }, 401);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(DASHBOARD_HOME, {
      headers: {
        authorization,
        apikey: SUPABASE_ANON_KEY,
      },
      cache: "no-store",
      signal: controller.signal,
    });

    const headers = new Headers();
    headers.set("content-type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.set("x-dashboard-home-proxy", "same-origin");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return json({ error: "home_upstream_timeout" }, 504);
    }
    return json({ error: "home_upstream_unavailable" }, 502);
  } finally {
    clearTimeout(timer);
  }
}
