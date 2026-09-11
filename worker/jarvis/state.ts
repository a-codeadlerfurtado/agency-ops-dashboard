import type { EnvJarvis } from "./tools";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const REFRESH_TTL_SECONDS = 60;
const CLIENT_CACHE_SECONDS = 300;
const OPERATION_CACHE_SECONDS = 120;
const MEMORY_CACHE_SECONDS = 6 * 60 * 60;

export type EstadoCliente = {
  client_id: string;
  display_name: string;
  lifecycle: string | null;
  gt_owner: string | null;
  cs_owner: string | null;
  designer_owner: string | null;
  leads_today: number | null;
  spend_today: number | null;
  cpl_today: number | null;
  today_checked_at: string | null;
  leads_yesterday: number | null;
  spend_yesterday: number | null;
  cpl_yesterday: number | null;
  yesterday_checked_at: string | null;
  spend_7d: number | null;
  media_latest_date: string | null;
  media_checked_at: string | null;
  active_campaigns: number | null;
  campaign_count: number | null;
  meta_balance: number | null;
  meta_available_balance: number | null;
  meta_currency: string | null;
  meta_funding_type: number | null;
  meta_funding_type_label: string | null;
  meta_payment_display: string | null;
  meta_balance_source: string | null;
  balance_run_status: string | null;
  balance_checked_at: string | null;
  state_updated_at: string;
  live_source?: string | null;
};

export type EstadoOperacao = {
  state_key: string;
  active_clients: number;
  onboarding_clients: number;
  team_counts: Record<string, number>;
  team_members?: Record<string, string[]>;
  owner_active_counts?: Record<string, number>;
  owner_onboarding_counts?: Record<string, number>;
  leads_today_total: number | null;
  leads_today_coverage: number;
  spend_today_total: number | null;
  leads_yesterday_total: number | null;
  leads_yesterday_coverage: number;
  spend_yesterday_total: number | null;
  spend_7d_total: number | null;
  clients_low_balance: string[];
  clients_without_active_campaigns: string[];
  updated_at: string;
};

export type EstadoLifecycle = {
  ok: boolean;
  lifecycle: "ACTIVE" | "ONBOARDING" | "CHURNED" | "PROSPECT";
  count: number;
  clients: Array<{ client_id: string; display_name: string; lifecycle: string; gt_owner?: string | null; cs_owner?: string | null; designer_owner?: string | null }>;
  updated_at?: string;
};

export type MemoriaRapida = {
  client_id?: string | null;
  client_name?: string | null;
  metric?: string | null;
  period?: "today" | "yesterday" | "current" | "last_days" | null;
  period_days?: number | null;
  person?: string | null;
  topic?: string | null;
  answer_kind?: "count" | "list" | "metric" | "text" | null;
  offered_action?: "list_portfolio" | "list_onboarding" | "list_lifecycle" | null;
  lifecycle?: "ACTIVE" | "ONBOARDING" | "CHURNED" | "PROSPECT" | null;
  updated_at: string;
};
function escopo(scopeKey: string): string {
  return scopeKey.replace(/[^a-zA-Z0-9:_-]/g, "_").slice(0, 120);
}

async function rpc(nome: string, jwt: string, env: EnvJarvis, body: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(`${SUPABASE}/rest/v1/rpc/${nome}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: env.SUPABASE_ANON_KEY ?? "",
      "content-type": "application/json",
      "content-profile": "agency_ops",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

export function idadeSegundos(ts: string | null | undefined): number {
  if (!ts) return Number.POSITIVE_INFINITY;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? Math.max(0, (Date.now() - n) / 1000) : Number.POSITIVE_INFINITY;
}

async function garantirSnapshot(jwt: string, env: EnvJarvis, scopeKey: string): Promise<void> {
  if (!env.JARVIS_CACHE) {
    await rpc("refresh_jarvis_operational_state", jwt, env).catch(() => null);
    await rpc("refresh_jarvis_balance_semantics", jwt, env).catch(() => null);
    return;
  }
  const chave = `jarvis:state:refresh:${escopo(scopeKey)}`;
  const hit = await env.JARVIS_CACHE.get(chave, "json").catch(() => null);
  if (hit) return;
  const atualizado = await rpc("refresh_jarvis_operational_state", jwt, env).catch(() => null);
  if (atualizado?.ok) {
    await rpc("refresh_jarvis_balance_semantics", jwt, env).catch(() => null);
    await env.JARVIS_CACHE.put(chave, JSON.stringify({ at: Date.now() }), { expirationTtl: REFRESH_TTL_SECONDS }).catch(() => {});
  }
}
export async function carregarEstadoCliente(
  clientId: string,
  jwt: string,
  env: EnvJarvis,
  scopeKey: string,
): Promise<EstadoCliente | null> {
  const chave = `jarvis:client:${escopo(scopeKey)}:${clientId}`;
  if (env.JARVIS_CACHE) {
    const [hit, hot] = await Promise.all([
      env.JARVIS_CACHE.get(chave, "json").catch(() => null),
      env.JARVIS_CACHE.get(`jarvis:hot:client:${clientId}`, "json").catch(() => null),
    ]);
    if (hit && typeof hit === "object") return { ...(hit as EstadoCliente), ...((hot && typeof hot === "object") ? hot as Partial<EstadoCliente> : {}) };
  }

  await garantirSnapshot(jwt, env, scopeKey);
  const estado = await rpc("jarvis_client_snapshot", jwt, env, { p_client_id: clientId });
  if (!estado || typeof estado !== "object") return null;
  let mesclado = estado as EstadoCliente;
  if (env.JARVIS_CACHE) {
    const hot = await env.JARVIS_CACHE.get(`jarvis:hot:client:${clientId}`, "json").catch(() => null);
    if (hot && typeof hot === "object") mesclado = { ...mesclado, ...(hot as Partial<EstadoCliente>) };
    await env.JARVIS_CACHE.put(chave, JSON.stringify(mesclado), { expirationTtl: CLIENT_CACHE_SECONDS }).catch(() => {});
  }
  return mesclado;
}

export async function carregarMidiaClienteDia(
  clientId: string, dia: string, jwt: string, env: EnvJarvis,
): Promise<{ ok: boolean; source?: string; client_id?: string; display_name?: string; date?: string; leads?: number | null; spend?: number | null; cpl?: number | null; checked_at?: string | null } | null> {
  let sub = ""; try { const b=jwt.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"); sub=String(JSON.parse(atob(b))?.sub ?? ""); } catch {}
  const chave = sub ? `jarvis:media-day:v1:${escopo(sub)}:${clientId}:${dia}` : null;
  if (chave && env.JARVIS_CACHE) { const hit=await env.JARVIS_CACHE.get(chave,"json").catch(()=>null); if (hit && typeof hit === "object") return hit as any; }
  const estado = await rpc("jarvis_client_media_snapshot", jwt, env, { p_client_id: clientId, p_date: dia });
  const out = estado && typeof estado === "object" ? estado : null;
  if (out && chave && env.JARVIS_CACHE) await env.JARVIS_CACHE.put(chave, JSON.stringify(out), { expirationTtl: 45 }).catch(()=>{});
  return out;
}

export type EstadoMidiaPeriodo = {
  ok: boolean; source?: string; error?: string; client_id?: string | null; display_name?: string | null;
  since?: string; until?: string; leads?: number | null; spend?: number | null; cpl?: number | null;
  available_from?: string | null; available_until?: string | null; coverage_days?: number; expected_days?: number;
  complete?: boolean; client_count?: number; checked_at?: string | null;
};

export async function carregarMidiaPeriodo(
  clientId: string | null, since: string, until: string, jwt: string, env: EnvJarvis, scopeKey: string,
): Promise<EstadoMidiaPeriodo | null> {
  const alvo = clientId || "global";
  const chave = `jarvis:media-period:v2:${escopo(scopeKey)}:${alvo}:${since}:${until}`;
  if (env.JARVIS_CACHE) {
    const hit = await env.JARVIS_CACHE.get(chave, "json").catch(() => null);
    if (hit && typeof hit === "object") return hit as EstadoMidiaPeriodo;
  }
  const estado = await rpc("jarvis_media_period_snapshot", jwt, env, { p_since: since, p_until: until, p_client_id: clientId });
  const out = estado && typeof estado === "object" ? estado as EstadoMidiaPeriodo : null;
  if (out && env.JARVIS_CACHE) await env.JARVIS_CACHE.put(chave, JSON.stringify(out), { expirationTtl: until === since ? 45 : 120 }).catch(() => {});
  return out;
}

export async function carregarEstadoOperacao(
  jwt: string,
  env: EnvJarvis,
  scopeKey: string,
): Promise<EstadoOperacao | null> {
  const chave = `jarvis:operation:${escopo(scopeKey)}`;
  if (env.JARVIS_CACHE) {
    const [hit, hot] = await Promise.all([
      env.JARVIS_CACHE.get(chave, "json").catch(() => null),
      env.JARVIS_CACHE.get("jarvis:hot:operation", "json").catch(() => null),
    ]);
    if (hit && typeof hit === "object") return { ...(hit as EstadoOperacao), ...((hot && typeof hot === "object") ? hot as Partial<EstadoOperacao> : {}) };
  }

  await garantirSnapshot(jwt, env, scopeKey);
  const estado = await rpc("jarvis_operation_snapshot", jwt, env);
  if (!estado || typeof estado !== "object") return null;
  let mesclado = estado as EstadoOperacao;
  if (env.JARVIS_CACHE) {
    const hot = await env.JARVIS_CACHE.get("jarvis:hot:operation", "json").catch(() => null);
    if (hot && typeof hot === "object") mesclado = { ...mesclado, ...(hot as Partial<EstadoOperacao>) };
    await env.JARVIS_CACHE.put(chave, JSON.stringify(mesclado), { expirationTtl: OPERATION_CACHE_SECONDS }).catch(() => {});
  }
  return mesclado;
}
export async function atualizarEstadoClienteCache(
  atual: EstadoCliente,
  patch: Partial<EstadoCliente>,
  env: EnvJarvis,
  scopeKey: string,
  ttlSeconds = CLIENT_CACHE_SECONDS,
): Promise<EstadoCliente> {
  const mesclado: EstadoCliente = { ...atual, ...patch };
  if (env.JARVIS_CACHE) {
    const chave = `jarvis:client:${escopo(scopeKey)}:${atual.client_id}`;
    await env.JARVIS_CACHE.put(chave, JSON.stringify(mesclado), { expirationTtl: ttlSeconds }).catch(() => {});
    const hotKey = `jarvis:hot:client:${atual.client_id}`;
    const hotAtual = await env.JARVIS_CACHE.get(hotKey, "json").catch(() => null);
    const hot = { ...((hotAtual && typeof hotAtual === "object") ? hotAtual as object : {}), ...patch };
    await env.JARVIS_CACHE.put(hotKey, JSON.stringify(hot), { expirationTtl: Math.max(420, ttlSeconds) }).catch(() => {});
  }
  return mesclado;
}

export async function carregarEstadoLifecycle(
  lifecycle: EstadoLifecycle["lifecycle"],
  jwt: string,
  env: EnvJarvis,
  scopeKey: string,
): Promise<EstadoLifecycle | null> {
  const chave = `jarvis:lifecycle:${escopo(scopeKey)}:${lifecycle}`;
  if (env.JARVIS_CACHE) {
    const hit = await env.JARVIS_CACHE.get(chave, "json").catch(() => null);
    if (hit && typeof hit === "object") return hit as EstadoLifecycle;
  }
  await garantirSnapshot(jwt, env, scopeKey);
  const estado = await rpc("jarvis_lifecycle_snapshot", jwt, env, { p_lifecycle: lifecycle });
  if (!estado || typeof estado !== "object" || estado.ok !== true) return null;
  const normalizado: EstadoLifecycle = {
    ok: true, lifecycle, count: Number(estado.count ?? 0),
    clients: Array.isArray(estado.clients) ? estado.clients : [],
    updated_at: typeof estado.updated_at === "string" ? estado.updated_at : undefined,
  };
  if (env.JARVIS_CACHE) await env.JARVIS_CACHE.put(chave, JSON.stringify(normalizado), { expirationTtl: 60 }).catch(() => {});
  return normalizado;
}

export async function carregarMemoriaRapida(
  conversationId: string | null,
  env: EnvJarvis,
  scopeKey: string,
): Promise<MemoriaRapida | null> {
  if (!conversationId || !env.JARVIS_CACHE) return null;
  const chave = `jarvis:memory:${escopo(scopeKey)}:${conversationId}`;
  const hit = await env.JARVIS_CACHE.get(chave, "json").catch(() => null);
  return hit && typeof hit === "object" ? hit as MemoriaRapida : null;
}

export async function salvarMemoriaRapida(
  conversationId: string | null,
  memory: Omit<MemoriaRapida, "updated_at">,
  env: EnvJarvis,
  scopeKey: string,
): Promise<void> {
  if (!conversationId || !env.JARVIS_CACHE) return;
  const chave = `jarvis:memory:${escopo(scopeKey)}:${conversationId}`;
  const payload: MemoriaRapida = { ...memory, updated_at: new Date().toISOString() };
  await env.JARVIS_CACHE.put(chave, JSON.stringify(payload), { expirationTtl: MEMORY_CACHE_SECONDS }).catch(() => {});
}

export function resolverNomeUnico(nome: string, candidatos: string[]): string | null {
  const alvo = nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (!alvo) return null;
  const normalizar = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const exatos = candidatos.filter((c) => normalizar(c) === alvo);
  if (exatos.length === 1) return exatos[0];
  const parciais = candidatos.filter((c) => {
    const n = normalizar(c);
    return n.split(/\s+/).includes(alvo) || n.startsWith(`${alvo} `);
  });
  return parciais.length === 1 ? parciais[0] : null;
}