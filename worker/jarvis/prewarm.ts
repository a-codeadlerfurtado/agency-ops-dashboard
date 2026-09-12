import type { EnvJarvis } from "./tools";
import { carregarEstadoOperacao } from "./state";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";

function dataHoje(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

async function getJson(url: string, jwt: string, env: EnvJarvis, timeout = 45_000): Promise<any> {
  const r = await fetch(url, {
    headers: { authorization: `Bearer ${jwt}`, apikey: env.SUPABASE_ANON_KEY ?? "" },
    signal: AbortSignal.timeout(timeout),
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

function n(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

export async function aquecerEstadoOperacional(jwt: string, env: EnvJarvis, scopeKey: string): Promise<{ ok: boolean; media: number; balances: number }> {
  if (!env.JARVIS_CACHE) return { ok: false, media: 0, balances: 0 };
  const markerKey = `jarvis:prewarm:${scopeKey}`;
  const marker = await env.JARVIS_CACHE.get(markerKey, "json").catch(() => null);
  if (marker) return { ok: true, media: 0, balances: 0 };
  const hoje = dataHoje();
  const [campanhas, saldos] = await Promise.all([
    getJson(`${SUPABASE}/functions/v1/agency-ops-campaigns-api?lifecycle=ACTIVE&since=${hoje}&until=${hoje}`, jwt, env, 45_000),
    getJson(`${SUPABASE}/functions/v1/agency-ops-client-balances-api`, jwt, env, 20_000),
  ]);
  let mediaCount = 0;
  const generatedAt = String(campanhas?.generated_at ?? new Date().toISOString());
  const clientes = Array.isArray(campanhas?.clients) ? campanhas.clients : [];
  for (const c of clientes) {
    const clientId = String(c?.client_id ?? "").trim();
    if (!clientId) continue;
    const leads = n(c?.leads);
    const spend = n(c?.spend);
    const active = n(c?.active_campaigns);
    const patch = {
      leads_today: leads,
      spend_today: spend,
      cpl_today: leads !== null && leads > 0 && spend !== null ? spend / leads : null,
      today_checked_at: generatedAt,
      active_campaigns: active,
      campaign_count: n(c?.campaign_count),
      media_checked_at: generatedAt,
      live_source: "META_MARKETING_API_PREWARM",
    };
    const key = `jarvis:hot:client:${clientId}`;
    const anterior = await env.JARVIS_CACHE.get(key, "json").catch(() => null);
    await env.JARVIS_CACHE.put(key, JSON.stringify({ ...((anterior && typeof anterior === "object") ? anterior as object : {}), ...patch }), { expirationTtl: 180 }).catch(() => {});
    mediaCount++;
  }

  if (clientes.length) {
    const leadsTotal = clientes.reduce((s: number, c: any) => s + (n(c?.leads) ?? 0), 0);
    const spendTotal = clientes.reduce((s: number, c: any) => s + (n(c?.spend) ?? 0), 0);
    await env.JARVIS_CACHE.put("jarvis:hot:operation", JSON.stringify({
      leads_today_total: leadsTotal,
      spend_today_total: spendTotal,
      leads_today_coverage: clientes.length,
      live_media_updated_at: generatedAt,
    }), { expirationTtl: 180 }).catch(() => {});
  }
  let balanceCount = 0;
  const rows = Array.isArray(saldos?.rows) ? saldos.rows : [];
  for (const r of rows) {
    const clientId = String(r?.client_id ?? "").trim();
    if (!clientId) continue;
    const key = `jarvis:hot:client:${clientId}`;
    const anterior = await env.JARVIS_CACHE.get(key, "json").catch(() => null);
    const patch = {
      meta_available_balance: n(r?.available_balance),
      meta_balance: n(r?.balance),
      meta_currency: String(r?.currency ?? "BRL"),
      meta_funding_type: n(r?.funding_type),
      meta_funding_type_label: String(r?.funding_type_label ?? "") || null,
      meta_payment_display: String(r?.payment_display ?? "") || null,
      meta_balance_source: String(r?.balance_source ?? "") || null,
      balance_run_status: String(r?.run_status ?? "") || null,
      balance_checked_at: String(r?.checked_at ?? saldos?.sync?.last_success_at ?? new Date().toISOString()),
    };
    await env.JARVIS_CACHE.put(key, JSON.stringify({ ...((anterior && typeof anterior === "object") ? anterior as object : {}), ...patch }), { expirationTtl: 420 }).catch(() => {});
    balanceCount++;
  }

  // Garante que o snapshot estrutural (clientes, donos, equipe) também esteja quente.
  await carregarEstadoOperacao(jwt, env, scopeKey).catch(() => null);
  await env.JARVIS_CACHE.put(markerKey, JSON.stringify({ at: Date.now(), media: mediaCount, balances: balanceCount }), { expirationTtl: 120 }).catch(() => {});
  return { ok: Boolean(campanhas || saldos), media: mediaCount, balances: balanceCount };
}
