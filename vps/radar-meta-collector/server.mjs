import { createServer } from "node:http";
import { BrowserBackend } from "@thenavidm/facebook-ad-library-mcp/dist/backends/browser.js";

const token = String(process.env.RADAR_COLLECTOR_TOKEN || "").trim();
const port = Number(process.env.PORT || 8788);
if (!token) throw new Error("RADAR_COLLECTOR_TOKEN is required");

const backend = new BrowserBackend({
  headless: true,
  hydrateMs: 9000,
  scrollWaitMs: 3000,
  retries: 1,
  retryDelayMs: 15000,
});

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const readJson = async (req) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 65536) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const clean = (v, n = 300) => String(v ?? "").trim().slice(0, n);

const server = createServer(async (req, res) => {
  if (req.url === "/health") return json(res, 200, { ok: true, backend: "meta-browser", version: 1 });
  if ((req.headers.authorization || "") !== `Bearer ${token}`) return json(res, 401, { ok: false, error: "unauthorized" });
  if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });

  try {
    if (req.url === "/search") {
      const body = await readJson(req);
      const query = clean(body.query, 100);
      const pageId = clean(body.page_id, 100);
      const country = (clean(body.country, 2) || "BR").toUpperCase();
      const limit = Math.min(30, Math.max(1, Number(body.limit || 25) || 25));
      if (!query && !pageId) return json(res, 400, { ok: false, error: "query_or_page_id_required" });

      const started = Date.now();
      const result = await backend.search({
        query: query || undefined,
        pageId: pageId || undefined,
        country,
        activeStatus: "active",
        adType: "all",
        mediaType: "all",
        limit,
      });

      return json(res, 200, {
        ok: true,
        backend: result.backend,
        count: result.count,
        has_more: result.hasMore,
        cursor: result.cursor || null,
        total_available: result.totalAvailable ?? null,
        elapsed_ms: Date.now() - started,
        ads: result.ads,
      });
    }

    if (req.url === "/advertisers") {
      const body = await readJson(req);
      const query = clean(body.query, 100);
      const country = (clean(body.country, 2) || "BR").toUpperCase();
      if (!query) return json(res, 400, { ok: false, error: "query_required" });
      const rows = await backend.listAdvertisers(query, country);
      return json(res, 200, { ok: true, advertisers: rows.slice(0, 20) });
    }

    return json(res, 404, { ok: false, error: "not_found" });
  } catch (error) {
    const message = clean(error?.message || error, 500);
    console.error("collector_error", message);
    return json(res, 502, { ok: false, error: "collector_failed", detail: message });
  }
});

const shutdown = async () => {
  await backend.close().catch(() => undefined);
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(port, "0.0.0.0", () => console.log(`radar-meta-collector listening on :${port}`));
