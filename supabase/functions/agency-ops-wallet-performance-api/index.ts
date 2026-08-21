import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type,x-ops-device-id",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const n = (v: unknown) => Number(v ?? 0);
const iso = (v: unknown) => v ? String(v).slice(0, 10) : null;
const dayMs = 86_400_000;
const dateMs = (v: unknown) => { const s = iso(v); return s ? Date.parse(`${s}T00:00:00Z`) : NaN; };
const daysBetween = (a: unknown, b: unknown) => Math.floor((dateMs(b) - dateMs(a)) / dayMs);
const sectorOf = (row: any) => String(row?.service || row?.sector || "marketing").trim() || "marketing";
const avg = (values: number[]) => values.length ? Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(2)) : null;
const labelMonth = (d: Date) => new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(d).replace(/^./, (x) => x.toUpperCase());

function monthWindows() {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(2026, 0, 1));
  const rows: Array<{ start: Date; next: Date; end: Date; key: string; label: string; current: boolean }> = [];
  for (let cursor = new Date(start); cursor <= end; cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))) {
    const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    const monthEnd = new Date(next.getTime() - dayMs);
    rows.push({ start: new Date(cursor), next, end: monthEnd, key: cursor.toISOString().slice(0, 7), label: labelMonth(cursor), current: cursor.getTime() === end.getTime() });
  }
  return rows;
}

const bandForDays = (days: number) => days < 90 ? "LESS_3M" : days < 180 ? "M3_6" : "OVER_6M";
const tenureBucket = (days: number) => days < 30 ? "ate_1m" : days < 60 ? "m1_2" : days < 90 ? "m2_3" : days < 120 ? "m3_4" : days < 150 ? "m4_5" : days < 180 ? "m5_6" : "mais_6m";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceRole || !anonKey) return json({ error: "server_configuration" }, 500);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData } = await auth.auth.getUser();
  if (!userData.user) return json({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const { data: pref } = await ops.from("user_preferences").select("collaborator_person").eq("user_key", userData.user.id).maybeSingle();
  const person = pref?.collaborator_person ?? null;
  if (!person) return json({ error: "forbidden" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return json({ error: "forbidden" }, 403);
  const { data: allowed } = await ops.rpc("dashboard_allowed_views", { p_person: roster.person, p_role: roster.role });
  if (!Array.isArray(allowed) || !allowed.includes("opsperf")) return json({ error: "forbidden" }, 403);

  const [walletRes, clientsRes, statusRes, churnRes, signalRes] = await Promise.all([
    ops.from("wallet_registry").select("carteira,ordem,gt_owner,criada_em").order("ordem"),
    ops.from("clients").select("id,display_name,lifecycle,service,entrada,saida,gt_owner").order("display_name"),
    ops.from("portfolio_client_status").select("*"),
    ops.from("client_churn_log").select("*").order("saida", { ascending: false }),
    ops.from("portfolio_operational_signal").select("*"),
  ]);
  const failed = [walletRes, clientsRes, statusRes, churnRes, signalRes].find((r: any) => r.error);
  if (failed?.error) return json({ error: "query_failed", detail: failed.error.message }, 500);

  const wallets = walletRes.data ?? [];
  const clients = clientsRes.data ?? [];
  const statuses = statusRes.data ?? [];
  const churnLog = churnRes.data ?? [];
  const signals = signalRes.data ?? [];
  const windows = monthWindows();
  const today = new Date().toISOString().slice(0, 10);

  const payload = wallets.map((wallet: any) => {
    const owned = clients.filter((c: any) => String(c.gt_owner || "") === String(wallet.gt_owner || ""));
    const ids = new Set(owned.map((c: any) => String(c.id)));
    const activeStatus = statuses.filter((s: any) => ids.has(String(s.client_id)));
    const ownedSignals = signals.filter((s: any) => String(s.gt_owner || "") === String(wallet.gt_owner || ""));
    const ownedChurns = churnLog.filter((c: any) => String(c.gt_owner || "") === String(wallet.gt_owner || ""));

    const timeline: any[] = [];
    for (const w of windows) {
      const m0 = w.start.getTime(); const m1 = w.next.getTime(); const fim = w.end.getTime();
      for (const sector of ["marketing", "ia"]) {
        const scoped = owned.filter((c: any) => sectorOf(c) === sector && c.entrada);
        const active = scoped.filter((c: any) => dateMs(c.entrada) <= fim && (!c.saida || dateMs(c.saida) > fim));
        const entries = scoped.filter((c: any) => dateMs(c.entrada) >= m0 && dateMs(c.entrada) < m1).length;
        const exits = ownedChurns.filter((c: any) => sectorOf(c) === sector && c.saida && dateMs(c.saida) >= m0 && dateMs(c.saida) < m1);
        const churns = exits.filter((c: any) => String(c.tipo) === "churn");
        const vendas = exits.filter((c: any) => String(c.tipo) === "venda_caida");
        const churnBase = scoped.filter((c: any) => dateMs(c.entrada) < m0 && (!c.saida || dateMs(c.saida) >= m0)).length;
        const ages = active.map((c: any) => Math.max(0, Math.floor((fim - dateMs(c.entrada)) / dayMs)));
        timeline.push({
          month: w.start.toISOString().slice(0, 10), month_key: w.key, label: w.label, sector,
          active_clients: active.length,
          clients_less_3m: ages.filter((d: number) => bandForDays(d) === "LESS_3M").length,
          clients_3_6m: ages.filter((d: number) => bandForDays(d) === "M3_6").length,
          clients_over_6m: ages.filter((d: number) => bandForDays(d) === "OVER_6M").length,
          ltv_months: ages.length ? Number((ages.reduce((s: number, d: number) => s + d, 0) / ages.length / 30).toFixed(2)) : null,
          entries, churns: churns.length, vendas_caidas: vendas.length, churn_base: churnBase,
          churn_rate: churnBase ? Number((100 * churns.length / churnBase).toFixed(1)) : 0,
          tpc_months: avg(churns.map((c: any) => n(c.permanencia_dias) / 30)),
          balance: entries - churns.length - vendas.length,
          quality: w.current ? "high" : "estimated",
          quality_label: w.current ? "Calculado ao vivo" : "Reconstruído por carteira",
          quality_detail: w.current ? "Carteira atual recalculada a cada consulta." : "Histórico reconstruído usando o GT atualmente vinculado ao cliente; trocas antigas de carteira ainda não são versionadas para todos os meses.",
          reference_date: today, origem: w.current ? "ao_vivo" : "reconstruido",
        });
      }
    }
    timeline.sort((a, b) => String(b.month_key).localeCompare(String(a.month_key)) || String(a.sector).localeCompare(String(b.sector)));

    const currentMarketing = timeline.find((r: any) => r.month_key === windows.at(-1)?.key && r.sector === "marketing") || {};
    const currentIa = timeline.find((r: any) => r.month_key === windows.at(-1)?.key && r.sector === "ia") || {};
    const statusSummary = {
      inadimplentes: activeStatus.filter((s: any) => s.inadimplente).length,
      juridico: activeStatus.filter((s: any) => s.juridico).length,
      churn_previsto: activeStatus.filter((s: any) => s.churn_previsto).length,
    };
    const transitions = activeStatus.filter((s: any) => s.dias_para_proxima != null && n(s.dias_para_proxima) <= 10).sort((a: any, b: any) => n(a.dias_para_proxima) - n(b.dias_para_proxima));
    const tenureMap: Record<string, number> = {};
    for (const row of activeStatus) { const key = tenureBucket(n(row.dias_casa)); tenureMap[key] = (tenureMap[key] || 0) + 1; }
    const tenure = Object.entries(tenureMap).map(([faixa, clientes]) => ({ sector: "marketing", faixa, clientes }));

    const survivalBands = [
      [1, "10 a 30 dias", 10, 30], [2, "1 a 2 meses", 30, 60], [3, "2 a 3 meses", 60, 90],
      [4, "3 a 4 meses", 90, 120], [5, "4 a 6 meses", 120, 180], [6, "mais de 6 meses", 180, 100000],
    ];
    const survival = survivalBands.map(([ordem, rotulo, ini, fim]) => ({
      ordem, rotulo, dia_inicial: ini, dia_final: fim,
      churns: ownedChurns.filter((c: any) => String(c.tipo) === "churn" && n(c.permanencia_dias) >= n(ini) && n(c.permanencia_dias) < n(fim)).length,
      expostos: ownedChurns.filter((c: any) => String(c.tipo) === "churn" && n(c.permanencia_dias) >= n(ini)).length + activeStatus.filter((s: any) => n(s.dias_casa) >= n(ini)).length,
      ativos_na_faixa: activeStatus.filter((s: any) => n(s.dias_casa) >= n(ini) && n(s.dias_casa) < n(fim)).length,
    }));

    const marketingChurns = ownedChurns.filter((c: any) => sectorOf(c) === "marketing" && String(c.tipo) === "churn");
    const marketingSales = ownedChurns.filter((c: any) => sectorOf(c) === "marketing" && String(c.tipo) === "venda_caida");
    const marketingActive = activeStatus.filter((s: any) => String(s.sector) === "marketing");
    const retentionBase = marketingActive.length + marketingChurns.length;
    const retention = [{
      gestor: wallet.gt_owner, ativos: marketingActive.length, churns: marketingChurns.length, vendas_caidas: marketingSales.length,
      permanencia_media_dias: avg(marketingChurns.map((c: any) => n(c.permanencia_dias))),
      idade_media_ativos: avg(marketingActive.map((s: any) => n(s.dias_casa))),
      churn_pct: retentionBase ? Number((100 * marketingChurns.length / retentionBase).toFixed(1)) : null,
    }];

    return {
      carteira: wallet.carteira, ordem: wallet.ordem, gt_owner: wallet.gt_owner, criada_em: wallet.criada_em,
      current: { marketing: currentMarketing, ia: currentIa },
      portfolio: {
        reference: today,
        total_active: activeStatus.length,
        sectors: [
          { sector: "marketing", active_clients: marketingActive.length },
          { sector: "ia", active_clients: activeStatus.filter((s: any) => String(s.sector) === "ia").length },
        ],
        status_summary: statusSummary,
        timeline,
        long_series: timeline.slice().reverse(),
        clients: activeStatus,
        transitions,
        tenure_distribution: tenure,
        churns: ownedChurns,
        audit: [],
        survival,
        operational_signal: ownedSignals,
        gt_retention: retention,
      },
    };
  });

  return json({ wallets: payload, attribution: "Histórico por carteira reconstruído pelo GT atualmente vinculado ao cliente. Churns usam o GT registrado no momento da saída quando disponível.", generated_at: new Date().toISOString() });
});
