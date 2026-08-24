import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import postgres from "npm:postgres@3.4.5";

const MCP_URL = "https://mcp.donnah.ai/mcp";
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const allowed = new Map<string, string>([
  ["Gustavo Lima", "DONNAH_MCP_GUSTAVO_LIMA"],
  ["Yuri Melo", "DONNAH_MCP_YURI_MELO"],
  ["Rodrigo Cavalheiro", "DONNAH_MCP_RODRIGO_CAVALHEIRO"],
]);

function parseWire(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const events: any[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try { events.push(JSON.parse(payload)); } catch {}
  }
  return events.length === 1 ? events[0] : events;
}

function unwrap(data: any) {
  const result = data?.result ?? data;
  if (result?.structuredContent != null) return result.structuredContent;
  if (Array.isArray(result?.content)) {
    const text = result.content
      .filter((item: any) => item?.type === "text" && typeof item.text === "string")
      .map((item: any) => item.text)
      .join("\n");
    if (text) {
      try { return JSON.parse(text); } catch { return text; }
    }
  }
  return result;
}

function dataOf(value: any) {
  return value?.success === true && value?.data != null ? value.data : value;
}

async function postMcp(token: string, body: any, session?: string | null, protocol = "2025-03-26") {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": protocol,
  };
  if (session) headers["Mcp-Session-Id"] = session;
  const response = await fetch(MCP_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    session: response.headers.get("mcp-session-id") || session || null,
    data: parseWire(raw),
    raw: raw.slice(0, 700),
  };
}

async function openSession(token: string) {
  let init: any = null;
  let protocol = "2025-03-26";
  for (const candidate of ["2025-03-26", "2024-11-05"]) {
    init = await postMcp(token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: candidate, capabilities: {}, clientInfo: { name: "agency-ops-dashboard", version: "1.0.0" } },
    }, null, candidate);
    protocol = candidate;
    if (init.ok && !init.data?.error) break;
  }
  if (!init?.ok || init.data?.error) throw new Error(init?.data?.error?.message || init?.raw || "initialize_failed");
  await postMcp(token, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.session, protocol).catch(() => null);
  return { session: init.session, protocol, serverInfo: init.data?.result?.serverInfo || null };
}

async function callTool(token: string, session: any, name: string, args: any) {
  const response = await postMcp(token, {
    jsonrpc: "2.0",
    id: Date.now() + Math.floor(Math.random() * 1000),
    method: "tools/call",
    params: { name, arguments: args },
  }, session.session, session.protocol);
  if (!response.ok || response.data?.error) throw new Error(response.data?.error?.message || response.raw || `${name}_failed`);
  return unwrap(response.data);
}

async function probeToken(token: string) {
  const session = await openSession(token);
  const page = dataOf(await callTool(token, session, "feed_list", { limit: 1 })) || {};
  return {
    server: session.serverInfo || null,
    feed_visible: Boolean(Array.isArray(page.items) && page.items.length),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!["GET", "POST"].includes(req.method)) return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const dbUrl = Deno.env.get("SUPABASE_DB_URL")!;
  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) return json({ ok: false, error: "UNAUTHORIZED" }, 401);

  const userClient = createClient(supabaseUrl, anon, { global: { headers: { Authorization: auth } } });
  const admin = createClient(supabaseUrl, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const sql = postgres(dbUrl, { prepare: false, max: 1 });

  try {
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData?.user) return json({ ok: false, error: "UNAUTHORIZED" }, 401);

    const user = authData.user;
    const meta = user.user_metadata || {};
    const { data: preferenceRows } = await admin
      .schema("agency_ops")
      .from("user_preferences")
      .select("name,role,collaborator_person")
      .eq("user_key", user.id)
      .limit(1);
    const preference = preferenceRows?.[0] || null;
    const person = String(preference?.collaborator_person || preference?.name || meta.collaborator_person || meta.full_name || meta.name || "").trim();
    if (person !== "Adler Furtado") return json({ ok: false, error: "FORBIDDEN" }, 403);

    if (req.method === "GET") {
      const { data: accounts, error } = await admin
        .schema("agency_ops")
        .from("donnah_mcp_accounts")
        .select("person,enabled,last_probe_at,last_probe_status,last_probe_detail,last_sync_at,last_sync_status,last_sync_detail,transcripts_seen,transcripts_ingested")
        .in("person", [...allowed.keys()])
        .order("person");
      if (error) return json({ ok: false, error: error.message }, 500);

      const secrets = await sql<{ name: string }[]>`
        select name from vault.secrets
        where name in ('DONNAH_MCP_GUSTAVO_LIMA','DONNAH_MCP_YURI_MELO','DONNAH_MCP_RODRIGO_CAVALHEIRO')
      `;
      const configured = new Set(secrets.map((row) => row.name));
      return json({
        ok: true,
        items: (accounts || []).map((row: any) => ({
          ...row,
          secret_configured: configured.has(allowed.get(String(row.person)) || ""),
        })),
      });
    }

    const body = await req.json().catch(() => ({}));
    const targetPerson = String(body?.person || "").trim();
    const token = String(body?.token || "").trim();
    const secretName = allowed.get(targetPerson);
    if (!secretName) return json({ ok: false, error: "PERSON_NOT_ALLOWED" }, 400);
    if (!token.startsWith("dnh_mcp_") || token.length < 40 || token.length > 300) {
      return json({ ok: false, error: "INVALID_DONNAH_TOKEN" }, 400);
    }

    let probe: any;
    try {
      probe = await probeToken(token);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await admin.schema("agency_ops").from("donnah_mcp_accounts").update({
        last_probe_at: new Date().toISOString(),
        last_probe_status: "ERROR",
        last_probe_detail: detail.slice(0, 500),
        updated_at: new Date().toISOString(),
      }).eq("person", targetPerson);
      return json({ ok: false, error: "DONNAH_PROBE_FAILED", detail: detail.slice(0, 300) }, 400);
    }

    const existing = await sql<{ id: string }[]>`
      select id::text from vault.secrets where name = ${secretName} limit 1
    `;
    const description = `Donnah MCP key for ${targetPerson}`;
    if (existing.length) {
      await sql`select vault.update_secret(${existing[0].id}::uuid, ${token}, ${secretName}, ${description})`;
    } else {
      await sql`select vault.create_secret(${token}, ${secretName}, ${description})`;
    }

    await admin.schema("agency_ops").from("donnah_mcp_accounts").upsert({
      person: targetPerson,
      secret_name: secretName,
      enabled: true,
      last_probe_at: new Date().toISOString(),
      last_probe_status: "OK",
      last_probe_detail: `MCP authenticated; feed_list OK; visible=${probe.feed_visible}`,
      mcp_server_info: probe.server,
      updated_at: new Date().toISOString(),
    }, { onConflict: "person" });

    let sync: any = null;
    try {
      const { data: syncSecret } = await admin.schema("agency_ops").rpc("get_donnah_mcp_sync_secret");
      if (syncSecret) {
        const response = await fetch(`${supabaseUrl}/functions/v1/donnah-mcp-sync`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-donnah-sync-secret": String(syncSecret) },
          body: JSON.stringify({ mode: "sync", person: targetPerson, maxFeeds: 5 }),
        });
        const result = await response.json().catch(() => null);
        sync = { ok: response.ok && Boolean(result?.ok), result };
      }
    } catch (error) {
      sync = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }

    return json({
      ok: true,
      person: targetPerson,
      secret_configured: true,
      probe,
      sync,
    });
  } finally {
    await sql.end({ timeout: 1 }).catch(() => null);
  }
});
