import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";

const VERSION = "v21.0";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1 });
let cachedSecret: string | null = null;

async function secret() {
  if (cachedSecret) return cachedSecret;
  const r = await sql`select value #>> '{}' as s from agency_ops.automation_settings where key='META_CAMPAIGN_SYNC_SECRET'`;
  cachedSecret = r.length ? String(r[0].s || "") : null;
  return cachedSecret;
}

function norm(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

async function getJson(url: string) {
  const r = await fetch(url);
  const b = await r.json().catch(() => null);
  if (!r.ok || b?.error) throw new Error(b?.error?.message || `HTTP ${r.status}`);
  return b;
}

Deno.serve(async (req) => {
  const expected = await secret().catch(() => null);
  if (!expected || req.headers.get("x-meta-campaign-secret") !== expected) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const token = Deno.env.get("META_SYSTEM_USER_TOKEN") || "";
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: "token_missing" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  const body = await req.json().catch(() => ({}));
  const terms = (Array.isArray(body?.terms) ? body.terms : [])
    .map((x: unknown) => norm(String(x)))
    .filter(Boolean);

  if (!terms.length) {
    return new Response(JSON.stringify({ ok: false, error: "terms_required" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const accounts: any[] = [];
  let next = `https://graph.facebook.com/${VERSION}/me/adaccounts?fields=id,account_id,name,account_status&limit=500&access_token=${encodeURIComponent(token)}`;
  while (next) {
    const page = await getJson(next);
    accounts.push(...(page.data || []));
    next = page.paging?.next || "";
  }

  const matches: any[] = [];
  for (let i = 0; i < accounts.length; i += 50) {
    const chunk = accounts.slice(i, i + 50);
    const batch = chunk.map((a: any) => ({
      method: "GET",
      relative_url: `act_${a.account_id}/campaigns?fields=id,name,status,effective_status&limit=200`,
    }));

    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set("batch", JSON.stringify(batch));

    const r = await fetch(`https://graph.facebook.com/${VERSION}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const out = await r.json().catch(() => null);
    if (!r.ok || !Array.isArray(out)) continue;

    for (let j = 0; j < out.length; j++) {
      const a = chunk[j];
      const item = out[j];
      if (!item || item.code !== 200) continue;

      let parsed: any = {};
      try {
        parsed = JSON.parse(item.body || "{}");
      } catch {}

      const campaigns = (parsed.data || []).filter((c: any) => {
        const n = norm(String(c.name || ""));
        return terms.some((t: string) => n.includes(t));
      });
      const accountHit = terms.some((t: string) => norm(String(a.name || "")).includes(t));

      if (accountHit || campaigns.length) {
        matches.push({
          meta_ad_account_id: String(a.account_id),
          account_name: a.name || null,
          account_status: a.account_status ?? null,
          campaigns: campaigns.map((c: any) => ({
            id: String(c.id),
            name: c.name || null,
            status: c.status || null,
            effective_status: c.effective_status || null,
          })),
        });
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, total_accounts: accounts.length, terms, matches }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});
