import postgres from "npm:postgres@3.4.5";

const GRAPH_API_VERSION = "v21.0";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

let cachedSecret: string | null = null;
async function getSecret() {
  if (cachedSecret) return cachedSecret;
  const rows = await sql`select value #>> '{}' as s from agency_ops.automation_settings where key='META_CAMPAIGN_SYNC_SECRET'`;
  cachedSecret = rows.length ? String(rows[0].s) : null;
  return cachedSecret;
}

function normalize(v: string) {
  return v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

type Account = {
  id?: string;
  account_id?: string;
  name?: string | null;
  account_status?: number | null;
  business?: { id?: string; name?: string } | null;
};

type Business = { id: string; name?: string | null };

type TaggedAccount = {
  meta_ad_account_id: string;
  name: string | null;
  account_status: number | null;
  owner_business_id: string | null;
  owner_business_name: string | null;
  sources: string[];
};

async function graphPaged(path: string, token: string) {
  const out: any[] = [];
  let url: string | null = `https://graph.facebook.com/${GRAPH_API_VERSION}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  while (url) {
    const resp = await fetch(url);
    const body = await resp.json().catch(() => null);
    if (!resp.ok || !body || body.error) throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
    for (const row of body.data ?? []) out.push(row);
    url = body.paging?.next ?? null;
  }
  return out;
}

async function graphOne(path: string, token: string) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  const body = await resp.json().catch(() => null);
  if (!resp.ok || !body || body.error) throw new Error(body?.error?.message ?? `HTTP ${resp.status}`);
  return body;
}

function toTagged(account: Account, source: string): TaggedAccount | null {
  const raw = account.account_id ?? account.id?.replace(/^act_/, "") ?? null;
  if (!raw) return null;
  return {
    meta_ad_account_id: String(raw),
    name: account.name ?? null,
    account_status: account.account_status ?? null,
    owner_business_id: account.business?.id ? String(account.business.id) : null,
    owner_business_name: account.business?.name ?? null,
    sources: [source],
  };
}

function mergeAccounts(groups: TaggedAccount[][]) {
  const map = new Map<string, TaggedAccount>();
  for (const group of groups) {
    for (const row of group) {
      const existing = map.get(row.meta_ad_account_id);
      if (!existing) {
        map.set(row.meta_ad_account_id, row);
        continue;
      }
      existing.name = existing.name ?? row.name;
      existing.account_status = existing.account_status ?? row.account_status;
      existing.owner_business_id = existing.owner_business_id ?? row.owner_business_id;
      existing.owner_business_name = existing.owner_business_name ?? row.owner_business_name;
      existing.sources = [...new Set([...existing.sources, ...row.sources])];
    }
  }
  return [...map.values()].sort((a, b) => String(a.name ?? a.meta_ad_account_id).localeCompare(String(b.name ?? b.meta_ad_account_id), "pt-BR"));
}

async function getConfiguredBusinessIds(): Promise<string[]> {
  const rows = await sql`select key,value from agency_ops.automation_settings where key in ('META_LAK_BUSINESS_ID','META_LAK_BUSINESS_IDS')`;
  const ids = new Set<string>();
  for (const row of rows as any[]) {
    const value = row.value;
    if (typeof value === "string") ids.add(value);
    else if (Array.isArray(value)) for (const id of value) if (id) ids.add(String(id));
    else if (value && typeof value === "object") {
      const candidates = [value.id, value.business_id, ...(Array.isArray(value.ids) ? value.ids : [])];
      for (const id of candidates) if (id) ids.add(String(id));
    }
  }
  return [...ids];
}

async function discoverBusinesses(token: string) {
  const errors: string[] = [];
  const found = new Map<string, Business>();

  try {
    const rows = await graphPaged(`/me/businesses?fields=id,name&limit=100`, token);
    for (const row of rows) if (row?.id) found.set(String(row.id), { id: String(row.id), name: row.name ?? null });
  } catch (e) {
    errors.push(`me/businesses: ${String(e instanceof Error ? e.message : e).slice(0, 220)}`);
  }

  try {
    const me = await graphOne(`/me?fields=id,name,business`, token);
    if (me?.business?.id) found.set(String(me.business.id), { id: String(me.business.id), name: me.business.name ?? null });
  } catch (e) {
    errors.push(`me.business: ${String(e instanceof Error ? e.message : e).slice(0, 220)}`);
  }

  return { businesses: [...found.values()], errors };
}

async function fetchDirectAccounts(token: string) {
  const fieldSets = [
    "id,account_id,name,account_status,business{id,name}",
    "id,account_id,name,account_status",
  ];
  let lastError: unknown = null;
  for (const fields of fieldSets) {
    try {
      const rows = await graphPaged(`/me/adaccounts?fields=${fields}&limit=500`, token);
      return { accounts: rows.map((r: Account) => toTagged(r, "ME_ADACCOUNTS")).filter(Boolean) as TaggedAccount[], error: null };
    } catch (e) {
      lastError = e;
    }
  }
  return { accounts: [] as TaggedAccount[], error: String(lastError instanceof Error ? lastError.message : lastError).slice(0, 220) };
}

async function fetchBusinessAccounts(businessId: string, token: string, edge: "client_ad_accounts" | "owned_ad_accounts") {
  const fieldSets = [
    "id,account_id,name,account_status,business{id,name}",
    "id,account_id,name,account_status",
  ];
  let lastError: unknown = null;
  for (const fields of fieldSets) {
    try {
      const rows = await graphPaged(`/${businessId}/${edge}?fields=${fields}&limit=500`, token);
      return {
        accounts: rows.map((r: Account) => toTagged(r, edge === "client_ad_accounts" ? `BM_${businessId}_PARTNER` : `BM_${businessId}_OWNED`)).filter(Boolean) as TaggedAccount[],
        error: null,
      };
    } catch (e) {
      lastError = e;
    }
  }
  return { accounts: [] as TaggedAccount[], error: String(lastError instanceof Error ? lastError.message : lastError).slice(0, 220) };
}

Deno.serve(async (req) => {
  if (req.method === "GET" && new URL(req.url).searchParams.get("health") === "1") {
    return new Response(JSON.stringify({ ok: true, service: "meta-partner-account-discovery", version: 1 }), { headers: { "content-type": "application/json" } });
  }
  if (req.method !== "POST") return new Response("method", { status: 405 });

  const secret = await getSecret().catch(() => null);
  if (!secret || req.headers.get("x-meta-campaign-secret") !== secret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
  }

  const token = Deno.env.get("META_SYSTEM_USER_TOKEN");
  if (!token) return new Response(JSON.stringify({ ok: false, error: "META_SYSTEM_USER_TOKEN nao configurado" }), { status: 500, headers: { "content-type": "application/json" } });

  let payload: { business_ids?: string[]; discover_businesses?: boolean; include_owned?: boolean } = {};
  try { payload = await req.json(); } catch { payload = {}; }

  const discovery = await discoverBusinesses(token);
  const configured = await getConfiguredBusinessIds().catch(() => [] as string[]);
  const requested = (payload.business_ids ?? []).map(String).filter(Boolean);

  const lakMatches = discovery.businesses.filter((b) => {
    const n = normalize(b.name ?? "");
    return n.includes("lak") || n.includes("assessoria digital");
  });

  let businessIds = [...new Set([...requested, ...configured])];
  if (!businessIds.length && lakMatches.length) businessIds = lakMatches.map((b) => b.id);
  if (!businessIds.length && discovery.businesses.length === 1) businessIds = [discovery.businesses[0].id];

  const direct = await fetchDirectAccounts(token);
  const partnerGroups: TaggedAccount[][] = [];
  const ownedGroups: TaggedAccount[][] = [];
  const businessResults: any[] = [];

  for (const businessId of businessIds) {
    const partner = await fetchBusinessAccounts(businessId, token, "client_ad_accounts");
    const owned = payload.include_owned === false ? { accounts: [] as TaggedAccount[], error: null } : await fetchBusinessAccounts(businessId, token, "owned_ad_accounts");
    partnerGroups.push(partner.accounts);
    ownedGroups.push(owned.accounts);
    businessResults.push({
      business_id: businessId,
      partner_accounts: partner.accounts.length,
      owned_accounts: owned.accounts.length,
      partner_error: partner.error,
      owned_error: owned.error,
    });
  }

  const partnerAccounts = mergeAccounts(partnerGroups);
  const ownedAccounts = mergeAccounts(ownedGroups);
  const allAccounts = mergeAccounts([direct.accounts, partnerAccounts, ownedAccounts]);

  const body = {
    ok: true,
    business_ids_used: businessIds,
    businesses_discovered: discovery.businesses,
    business_discovery_errors: discovery.errors,
    direct_error: direct.error,
    business_results: businessResults,
    total_direct: direct.accounts.length,
    total_partner: partnerAccounts.length,
    total_owned: ownedAccounts.length,
    total_union: allAccounts.length,
    partner_only: partnerAccounts.filter((p) => !direct.accounts.some((d) => d.meta_ad_account_id === p.meta_ad_account_id)).length,
    accounts: allAccounts,
  };

  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
});
