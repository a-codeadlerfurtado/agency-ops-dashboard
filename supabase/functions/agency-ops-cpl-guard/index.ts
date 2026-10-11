// CPL Guard: regras automáticas da Meta que pausam anúncio (2x CPL ideal) ou conjunto
// (3x CPL ideal) que gastou no dia sem gerar lead, e avisos com leitura operacional para o
// GT responsável e o Adler (WhatsApp + notificação no dash).
//
// Ações (POST, header x-cpl-guard-secret):
//   SYNC_RULES    { client_id?, dry_run? }  cria/ajusta/desliga as regras em cada conta
//   CHECK_HISTORY {}                        lê o histórico das regras, gera leitura e avisa
//   STATUS        {}                        resumo
import postgres from "npm:postgres@3.4.5";
import * as L from "./logic.ts";

const JOB_NAME = "cpl_guard";
const GRAPH = "https://graph.facebook.com/v26.0";
const ZAPI_BASE = "https://api.z-api.io";
const MANAGER_PERSON = "Adler Furtado";
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4 });

type Row = Record<string, any>;
class GraphError extends Error {
  code: number | null;
  constructor(message: string, code: number | null) { super(message); this.code = code; }
}

let TOKEN = "";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function clean(v: unknown, max = 500) {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function vault(name: string): Promise<string> {
  const rows = await sql`select agency_ops.get_internal_secret(${name}) as s`;
  return String(rows[0]?.s ?? "").trim();
}

async function config(): Promise<Row> {
  const rows = await sql`select value from agency_ops.automation_settings where key = 'cpl_guard'`;
  const v = (rows[0]?.value || {}) as Row;
  return {
    enabled: v.enabled !== false,
    whatsapp: v.whatsapp !== false,
    notify_adler: v.notify_adler !== false,
    ad_multiplier: L.num(v.ad_multiplier) ?? 2,
    adset_multiplier: L.num(v.adset_multiplier) ?? 3,
    min_threshold_brl: L.num(v.min_threshold_brl) ?? 20,
    reading_model: clean(v.reading_model, 60) || "gpt-5-mini",
  };
}

async function graph(method: "GET" | "POST" | "DELETE", path: string, params: Row = {}): Promise<Row> {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (method === "GET") url.searchParams.set(k, s); else body.set(k, s);
  }
  if (method === "GET") url.searchParams.set("access_token", TOKEN); else body.set("access_token", TOKEN);
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        body: method === "GET" ? undefined : body,
        signal: AbortSignal.timeout(30_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.error) {
        const err = new GraphError(clean(data?.error?.error_user_msg || data?.error?.message || `HTTP ${res.status}`, 300), data?.error?.code ?? null);
        // 1/2 = erro temporário da Meta; tenta de novo.
        if ((err.code === 1 || err.code === 2 || res.status >= 500) && attempt < 2) { lastErr = err; await sleep(1500 * (attempt + 1)); continue; }
        throw err;
      }
      return data;
    } catch (e) {
      if (e instanceof GraphError) throw e;
      lastErr = e;
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("graph_failed");
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function isAccessError(e: unknown) {
  const code = e instanceof GraphError ? e.code : null;
  return code === 10 || code === 200 || code === 190 || (code === 100 && /permission|not exist|cannot be loaded|missing/i.test(String((e as Error)?.message)));
}

// ---------------------------------------------------------------- SYNC_RULES

async function syncRules(cfg: Row, clientId: string | null, dryRun: boolean) {
  const targets = clientId
    ? await sql`select * from agency_ops.cpl_guard_targets where client_id = ${clientId}`
    : await sql`select * from agency_ops.cpl_guard_targets`;
  const accounts = targets.map((t: Row) => String(t.ad_account_id));
  const existing = accounts.length
    ? await sql`select * from agency_ops.cpl_guard_rules where ad_account_id = any(${accounts})`
    : [];
  const byKey = new Map(existing.map((r: Row) => [`${r.ad_account_id}:${r.level}`, r]));
  const levels: [L.Level, number][] = [["AD", cfg.ad_multiplier], ["ADSET", cfg.adset_multiplier]];
  const report: Row[] = [];

  await pool(targets as Row[], 5, async (t) => {
    const acct = String(t.ad_account_id);
    const cpl = L.num(t.cpl_alvo);
    let library: Row[] = [];
    let currency = "BRL";
    let accountError: unknown = null;
    try {
      const info = await graph("GET", `act_${acct}`, {
        fields: "currency,adrules_library.limit(200){id,name,status,evaluation_spec}",
      });
      currency = String(info.currency || "BRL");
      library = (info.adrules_library?.data || []).filter((r: Row) => String(r.name || "").startsWith(L.RULE_PREFIX));
    } catch (e) {
      accountError = e;
    }

    for (const [level, multiplier] of levels) {
      const row = byKey.get(`${acct}:${level}`) as Row | undefined;
      const marker = level === "AD" ? `${L.RULE_PREFIX} Pausa anuncio` : `${L.RULE_PREFIX} Pausa conjunto`;
      const metaRule = library.find((r) => row?.meta_rule_id && String(r.id) === String(row.meta_rule_id))
        || library.find((r) => String(r.name || "").startsWith(marker));
      const base = {
        client_id: t.client_id, ad_account_id: acct, level, multiplier,
        cpl_alvo: cpl, cpl_origem: t.cpl_origem,
      };
      const out: Row = { client: t.display_name, account: acct, level, cpl_alvo: cpl, origem: t.cpl_origem };

      try {
        if (accountError) {
          const status = isAccessError(accountError) ? "NO_ACCESS" : "ERROR";
          out.status = status; out.error = clean((accountError as Error).message, 200);
          if (!dryRun) await saveRule({ ...base, meta_rule_id: row?.meta_rule_id ?? null, threshold_cents: null, status, last_error: out.error });
          report.push(out);
          continue;
        }
        if (currency !== "BRL") {
          out.status = "SKIPPED"; out.error = `moeda ${currency}`;
          if (!dryRun) await saveRule({ ...base, meta_rule_id: metaRule?.id ?? null, threshold_cents: null, status: "SKIPPED", last_error: out.error });
          report.push(out);
          continue;
        }
        if (!cfg.enabled || cpl === null || cpl <= 0) {
          out.status = "NO_TARGET";
          if (!dryRun && metaRule && metaRule.status === "ENABLED") {
            await graph("POST", String(metaRule.id), { status: "DISABLED" });
          }
          if (!dryRun) await saveRule({ ...base, meta_rule_id: metaRule?.id ?? null, threshold_cents: null, status: cfg.enabled ? "NO_TARGET" : "DISABLED", last_error: null });
          report.push(out);
          continue;
        }
        const desired = L.thresholdCents(cpl, multiplier, cfg.min_threshold_brl);
        out.threshold_brl = desired / 100;
        const spec = L.ruleSpec(level, multiplier, desired);

        // Alguém desligou a regra na mão no Gerenciador: respeita e não religa.
        if (metaRule && metaRule.status !== "ENABLED" && row?.status === "ACTIVE") {
          out.status = "DISABLED"; out.error = "desligada manualmente no Gerenciador";
          if (!dryRun) await saveRule({ ...base, meta_rule_id: metaRule.id, threshold_cents: L.currentThreshold(metaRule), status: "DISABLED", last_error: out.error });
          report.push(out);
          continue;
        }
        if (row?.status === "DISABLED" && row?.last_error === "desligada manualmente no Gerenciador") {
          out.status = "DISABLED"; out.error = row.last_error;
          report.push(out);
          continue;
        }

        let ruleId = metaRule?.id ? String(metaRule.id) : null;
        if (!ruleId) {
          out.action = "CREATE";
          if (!dryRun) {
            const created = await graph("POST", `act_${acct}/adrules_library`, { ...spec, status: "ENABLED" });
            ruleId = String(created.id);
          }
        } else if (L.thresholdChanged(L.currentThreshold(metaRule), desired) || metaRule?.status !== "ENABLED") {
          out.action = "UPDATE";
          if (!dryRun) await graph("POST", ruleId, { ...spec, status: "ENABLED" });
        } else {
          out.action = "KEEP";
        }
        out.status = "ACTIVE";
        out.rule_id = ruleId;
        if (!dryRun) await saveRule({ ...base, meta_rule_id: ruleId, threshold_cents: desired, status: "ACTIVE", last_error: null });
      } catch (e) {
        out.status = isAccessError(e) ? "NO_ACCESS" : "ERROR";
        out.error = clean((e as Error).message, 200);
        if (!dryRun) await saveRule({ ...base, meta_rule_id: row?.meta_rule_id ?? null, threshold_cents: row?.threshold_cents ?? null, status: out.status, last_error: out.error });
      }
      report.push(out);
    }
  });

  const count = (s: string) => report.filter((r) => r.status === s).length;
  return {
    dry_run: dryRun,
    accounts: targets.length,
    rules_active: count("ACTIVE"),
    created: report.filter((r) => r.action === "CREATE").length,
    updated: report.filter((r) => r.action === "UPDATE").length,
    no_target: count("NO_TARGET"),
    no_access: count("NO_ACCESS"),
    disabled: count("DISABLED"),
    errors: count("ERROR"),
    report,
  };
}

async function saveRule(r: Row) {
  await sql`
    insert into agency_ops.cpl_guard_rules
      (client_id, ad_account_id, level, meta_rule_id, cpl_alvo, cpl_origem, multiplier, threshold_cents, status, last_error, last_synced_at, history_cursor, updated_at)
    values
      (${r.client_id}, ${r.ad_account_id}, ${r.level}, ${r.meta_rule_id}, ${r.cpl_alvo}, ${r.cpl_origem}, ${r.multiplier},
       ${r.threshold_cents}, ${r.status}, ${r.last_error}, now(), case when ${r.status} = 'ACTIVE' then now() else null end, now())
    on conflict (ad_account_id, level) do update set
      client_id = excluded.client_id,
      meta_rule_id = coalesce(excluded.meta_rule_id, agency_ops.cpl_guard_rules.meta_rule_id),
      cpl_alvo = excluded.cpl_alvo,
      cpl_origem = excluded.cpl_origem,
      multiplier = excluded.multiplier,
      threshold_cents = excluded.threshold_cents,
      status = excluded.status,
      last_error = excluded.last_error,
      last_synced_at = now(),
      history_cursor = coalesce(agency_ops.cpl_guard_rules.history_cursor, excluded.history_cursor),
      updated_at = now()`;
}

// ------------------------------------------------------------- CHECK_HISTORY

async function collectHistory() {
  const rules = await sql`
    select r.*, c.display_name, c.gt_owner
    from agency_ops.cpl_guard_rules r
    join agency_ops.clients c on c.id = r.client_id
    where r.status = 'ACTIVE' and r.meta_rule_id is not null`;
  let found = 0;
  const errors: Row[] = [];
  await pool(rules as Row[], 6, async (r) => {
    try {
      const hist = await graph("GET", `${r.meta_rule_id}/history`, { hide_no_changes: "true", limit: "25" });
      const since = r.history_cursor ? new Date(r.history_cursor).getTime() : Date.now() - 2 * 3600_000;
      let newest = since;
      for (const entry of hist.data || []) {
        const ts = new Date(String(entry.timestamp || "").replace(/\+0000$/, "Z")).getTime();
        if (!Number.isFinite(ts) || ts <= since) continue;
        newest = Math.max(newest, ts);
        for (const res of entry.results || []) {
          const objectId = clean(res.object_id, 40);
          if (!objectId) continue;
          const actions = (res.actions || []).map((a: Row) => clean(a.action, 60));
          const inserted = await sql`
            insert into agency_ops.cpl_guard_events
              (event_key, client_id, gt_owner, ad_account_id, level, meta_rule_id, entity_id, executed_at,
               cpl_alvo, cpl_origem, threshold_brl, diagnosis)
            values
              (${`${r.meta_rule_id}:${objectId}:${ts}`}, ${r.client_id}, ${r.gt_owner}, ${r.ad_account_id}, ${r.level},
               ${r.meta_rule_id}, ${objectId}, ${new Date(ts).toISOString()}, ${r.cpl_alvo}, ${r.cpl_origem},
               ${L.num(r.threshold_cents) !== null ? Number(r.threshold_cents) / 100 : null},
               ${sql.json({ meta_actions: actions, multiplier: L.num(r.multiplier) })})
            on conflict (event_key) do nothing
            returning id`;
          found += inserted.length;
        }
      }
      if (newest > since) {
        await sql`update agency_ops.cpl_guard_rules set history_cursor = ${new Date(newest).toISOString()}, updated_at = now() where id = ${r.id}`;
      } else if (!r.history_cursor) {
        await sql`update agency_ops.cpl_guard_rules set history_cursor = now() - interval '2 hours', updated_at = now() where id = ${r.id}`;
      }
    } catch (e) {
      errors.push({ account: r.ad_account_id, level: r.level, error: clean((e as Error).message, 200) });
      if (isAccessError(e)) {
        await sql`update agency_ops.cpl_guard_rules set status = 'NO_ACCESS', last_error = ${clean((e as Error).message, 300)}, updated_at = now() where id = ${r.id}`;
      }
    }
  });
  return { rules_checked: rules.length, new_events: found, errors };
}

const accountBenchCache = new Map<string, Row | null>();
async function accountBench(acct: string): Promise<Row | null> {
  if (accountBenchCache.has(acct)) return accountBenchCache.get(acct)!;
  let out: Row | null = null;
  try {
    const r = await graph("GET", `act_${acct}/insights`, {
      date_preset: "last_7d",
      fields: "spend,impressions,cpm,inline_link_click_ctr,inline_link_clicks,actions",
      filtering: [{ field: "campaign.objective", operator: "IN", value: L.LEAD_OBJECTIVES }],
    });
    out = r.data?.[0] || null;
  } catch { out = null; }
  accountBenchCache.set(acct, out);
  return out;
}

async function insights(id: string, preset: string, extra = ""): Promise<Row | null> {
  try {
    const r = await graph("GET", `${id}/insights`, {
      date_preset: preset,
      fields: "spend,impressions,reach,frequency,cpm,inline_link_click_ctr,inline_link_clicks,actions" + extra,
    });
    return r.data?.[0] || null;
  } catch { return null; }
}

async function enrich(ev: Row, cfg: Row) {
  const level = ev.level as L.Level;
  const fields = level === "AD"
    ? "name,created_time,effective_status,adset{id,name,optimization_goal,learning_stage_info,daily_budget},campaign{id,name,objective}"
    : "name,created_time,effective_status,optimization_goal,learning_stage_info,daily_budget,campaign{id,name,objective},ads.limit(50){id,effective_status}";
  const entity = await graph("GET", ev.entity_id, { fields });
  const [today, last7, acc] = await Promise.all([
    insights(ev.entity_id, "today"),
    insights(ev.entity_id, "last_7d", level === "AD" ? ",quality_ranking,engagement_rate_ranking,conversion_rate_ranking" : ""),
    accountBench(ev.ad_account_id),
  ]);
  const adset = level === "AD" ? entity.adset || {} : entity;
  const created = entity.created_time ? new Date(String(entity.created_time).replace(/\+0000$/, "Z")).getTime() : NaN;
  const cpl = L.num(ev.cpl_alvo) ?? 0;
  const multiplier = L.num(ev.diagnosis?.multiplier) ?? (level === "AD" ? cfg.ad_multiplier : cfg.adset_multiplier);
  const facts: L.Facts = {
    level,
    cpl_alvo: cpl,
    threshold_brl: L.num(ev.threshold_brl) ?? cpl * multiplier,
    hours_since_created: Number.isFinite(created) ? (Date.now() - created) / 3600_000 : null,
    learning_status: clean(adset.learning_stage_info?.status, 30) || null,
    today,
    last7,
    account7: acc,
    rankings: level === "AD"
      ? { quality: last7?.quality_ranking, engagement: last7?.engagement_rate_ranking, conversion: last7?.conversion_rate_ranking }
      : {},
    ads_in_adset: level === "ADSET" ? (entity.ads?.data || []).length : null,
  };
  const signals = L.diagnose(facts);
  let reading: string[] | null = null;
  let source = "REGRAS";
  try {
    reading = await aiReading(cfg, {
      nivel: level === "AD" ? "anúncio" : "conjunto de anúncios",
      nome: entity.name,
      campanha: entity.campaign?.name,
      objetivo: entity.campaign?.objective,
      otimizacao: adset.optimization_goal,
      orcamento_diario: L.num(adset.daily_budget) !== null ? Number(adset.daily_budget) / 100 : null,
      cpl_ideal: cpl,
      limite_do_dia: facts.threshold_brl,
      horas_desde_criacao: facts.hours_since_created !== null ? Math.round(facts.hours_since_created) : null,
      aprendizado: facts.learning_status ? (L.LEARNING_PT[facts.learning_status] || facts.learning_status) : null,
      hoje: compact(today),
      ultimos_7_dias: compact(last7),
      conta_7_dias_campanhas_de_lead: compact(acc),
      rankings_meta: facts.rankings,
      anuncios_no_conjunto: facts.ads_in_adset,
      sinais_calculados: signals.map((s) => s.text),
    });
    if (reading) source = "IA";
  } catch (e) {
    console.error("cpl_guard_ai_failed", clean((e as Error).message, 200));
  }
  if (!reading) reading = signals.slice(0, 4).map((s) => s.text);
  const step = L.nextStep(signals);
  await sql`
    update agency_ops.cpl_guard_events set
      entity_name = ${clean(entity.name, 300) || null},
      adset_id = ${clean(adset.id, 40) || null},
      adset_name = ${level === "AD" ? clean(entity.adset?.name, 300) || null : null},
      campaign_id = ${clean(entity.campaign?.id, 40) || null},
      campaign_name = ${clean(entity.campaign?.name, 300) || null},
      spend_today = ${L.num(today?.spend)},
      diagnosis = ${sql.json({ ...(ev.diagnosis || {}), multiplier, signals, next_step: step, facts: { ...facts, today: compact(today), last7: compact(last7), account7: compact(acc) } })},
      reading = ${reading.map(L.tidy).join("\n")},
      reading_source = ${source},
      error = null
    where id = ${ev.id}`;
}

function compact(ins: Row | null) {
  if (!ins) return null;
  return {
    gasto: L.num(ins.spend),
    impressoes: L.num(ins.impressions),
    alcance: L.num(ins.reach),
    frequencia: L.num(ins.frequency),
    cpm: L.num(ins.cpm),
    ctr_link_pct: L.num(ins.inline_link_click_ctr),
    cliques_link: L.linkClicks(ins),
    leads_ou_conversas: L.resultCount(ins.actions),
  };
}

const READING_PROMPT = `Você é um gestor de tráfego sênior de Meta Ads para imobiliárias.
A regra automática pausou um anúncio ou conjunto que gastou acima do limite do dia (múltiplo do CPL ideal) sem gerar nenhum lead.
Com base SOMENTE nos dados recebidos, escreva a leitura operacional do porquê isso pode ter acontecido, para o gestor de tráfego e o gerente olharem no Gerenciador.
Regras:
- Português do Brasil, direto, frases curtas, sem jargão desnecessário.
- De 2 a 4 itens, do mais provável para o menos provável. Cada item com no máximo 220 caracteres.
- Cite números que estão nos dados (CTR, CPM, cliques, frequência, CPL) quando ajudarem. Nunca invente número.
- Diferencie problema antes do clique (criativo, público, leilão) de problema depois do clique (formulário, WhatsApp, página, oferta).
- Se os dados forem poucos, diga isso em vez de afirmar com certeza.
- Não use travessão.
Responda em JSON: {"leitura": ["...", "..."]}`;

async function aiReading(cfg: Row, data: Row): Promise<string[] | null> {
  let key = "";
  try {
    const rows = await sql`select agency_ops.get_secret('OPENAI_API_KEY') as s`;
    key = String(rows[0]?.s || "").trim();
  } catch { key = ""; }
  if (!key) key = String(Deno.env.get("OPENAI_API_KEY") || "").trim();
  if (!key) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: cfg.reading_model,
      response_format: { type: "json_object" },
      reasoning_effort: "low",
      messages: [
        { role: "system", content: READING_PROMPT },
        { role: "user", content: JSON.stringify(data) },
      ],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`openai_${res.status}`);
  const body = await res.json();
  const parsed = JSON.parse(String(body?.choices?.[0]?.message?.content || "{}"));
  const items = Array.isArray(parsed?.leitura) ? parsed.leitura : [];
  const out = items.map((s: unknown) => L.tidy(clean(s, 300))).filter((s: string) => s.length > 10).slice(0, 4);
  return out.length >= 1 ? out : null;
}

// ------------------------------------------------------------------- avisos

async function phoneOf(person: string | null): Promise<string> {
  if (!person) return "";
  const rows = await sql`select whatsapp_phone from agency_ops.team_identity_map where person = ${person} limit 1`;
  let phone = String(rows[0]?.whatsapp_phone || "").replace(/\D/g, "");
  if (!phone) {
    const ids = await sql`
      select identity_value from agency_ops.whatsapp_team_identities
      where identity_type = 'PHONE' and active and canonical_name = ${person} limit 2`;
    if (ids.length === 1) phone = String(ids[0].identity_value || "").replace(/\D/g, "");
  }
  return phone;
}

async function sendWhatsApp(phone: string, message: string) {
  const cfgRows = await sql`select value from agency_ops.worker_runtime_config where key = 'meeting_notifications'`;
  const cfg = (cfgRows[0]?.value || {}) as Row;
  if (String(cfg.mode || "off") !== "execute") throw new Error("whatsapp_notifications_off");
  const expected = clean(cfg.instance_id, 200);
  const candidates = [
    { label: "RELATO", instance: Deno.env.get("RELATO_ZAPI_INSTANCE_ID") || "", token: Deno.env.get("RELATO_ZAPI_TOKEN") || "", clientToken: Deno.env.get("RELATO_ZAPI_CLIENT_TOKEN") || Deno.env.get("ZAPI_CLIENT_TOKEN") || "" },
    { label: "ZAPI", instance: Deno.env.get("ZAPI_INSTANCIA") || Deno.env.get("ZAPI_INSTANCE_ID") || "", token: Deno.env.get("ZAPI_TOKEN") || "", clientToken: Deno.env.get("ZAPI_CLIENT_TOKEN") || "" },
  ].filter((c) => c.instance && c.instance === expected && c.token && c.clientToken);
  if (!candidates.length) throw new Error("zapi_sender_not_configured");
  const failures: string[] = [];
  for (const c of candidates) {
    const res = await fetch(`${ZAPI_BASE}/instances/${c.instance}/token/${c.token}/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json", "Client-Token": c.clientToken },
      body: JSON.stringify({ phone, message }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    const id = clean(body?.messageId || body?.message_id || body?.zaapId || body?.id, 200);
    if (res.ok && !body?.error && id) return { message_id: id, credential: c.label };
    failures.push(`${c.label}:${res.status}`);
  }
  throw new Error("zapi_send_failed:" + failures.join(","));
}

function eventView(ev: Row, clientName: string): L.EventView {
  const d = ev.diagnosis || {};
  const multiplier = L.num(d.multiplier) ?? (ev.level === "AD" ? 2 : 3);
  return {
    client_name: clientName,
    gt_owner: ev.gt_owner,
    level: ev.level,
    entity_name: ev.entity_name || ev.entity_id,
    campaign_name: ev.campaign_name,
    adset_name: ev.adset_name,
    spend_today: L.num(ev.spend_today),
    threshold_brl: L.num(ev.threshold_brl) ?? 0,
    multiplier,
    cpl_alvo: L.num(ev.cpl_alvo) ?? 0,
    cpl_origem: ev.cpl_origem,
    reading: String(ev.reading || "").split("\n").filter(Boolean),
    next_step: clean(d.next_step, 300) || "Abrir no Gerenciador e conferir.",
    url: L.adsManagerUrl(ev.ad_account_id, ev.level, ev.entity_id),
  };
}

async function notify(cfg: Row) {
  const pending = await sql`
    select e.*, c.display_name
    from agency_ops.cpl_guard_events e
    left join agency_ops.clients c on c.id = e.client_id
    where e.notified_at is null and e.reading is not null and e.executed_at > now() - interval '3 days'
    order by e.executed_at`;
  if (!pending.length) return { dash: 0, whatsapp: 0, waiting_window: 0 };
  let dash = 0, whatsapp = 0;

  // Dash: na hora, uma notificação por item pausado (GT da carteira e gestão veem).
  for (const ev of pending as Row[]) {
    if (ev.notify_result?.dash_at) continue;
    const v = eventView(ev, ev.display_name || "Cliente");
    const what = ev.level === "AD" ? "Anúncio" : "Conjunto";
    await sql`
      insert into agency_ops.platform_notifications
        (event_key, type, level, title, description, client_id, source, actor, occurred_at, read_at, metadata)
      values
        (${"cpl-guard:" + ev.event_key}, 'CPL_GUARD_PAUSE', 'ATTENTION',
         ${`Pausa automática por CPL · ${v.client_name}`},
         ${L.tidy(`${what} "${v.entity_name}" gastou ${v.spend_today !== null ? L.brl(v.spend_today) : "acima do limite"} hoje sem lead e foi pausado. ${v.reading[0] || ""} Primeiro passo: ${v.next_step}`).slice(0, 900)},
         ${ev.client_id}, 'cpl_guard', 'Regra automática Meta', ${ev.executed_at}, null,
         ${sql.json({
           gt_owner: ev.gt_owner, level: ev.level, entity_id: ev.entity_id, ad_account_id: ev.ad_account_id,
           campaign_name: ev.campaign_name, adset_name: ev.adset_name, cpl_alvo: v.cpl_alvo, cpl_origem: ev.cpl_origem,
           threshold_brl: v.threshold_brl, spend_today: v.spend_today, reading: v.reading, next_step: v.next_step,
           action_url: v.url, button_label: "Abrir no Gerenciador",
         })})
      on conflict (event_key) do nothing`;
    await sql`update agency_ops.cpl_guard_events set notify_result = notify_result || ${sql.json({ dash_at: new Date().toISOString() })} where id = ${ev.id}`;
    dash++;
  }

  if (!cfg.whatsapp) {
    await sql`update agency_ops.cpl_guard_events set notified_at = now() where id = any(${pending.map((e: Row) => e.id)})`;
    return { dash, whatsapp: 0, waiting_window: 0 };
  }
  if (!L.inSendWindow(new Date())) return { dash, whatsapp: 0, waiting_window: pending.length };

  // WhatsApp: uma mensagem por cliente para o GT e outra para o Adler.
  const byClient = new Map<string, Row[]>();
  for (const ev of pending as Row[]) {
    const k = String(ev.client_id || ev.ad_account_id);
    byClient.set(k, [...(byClient.get(k) || []), ev]);
  }
  const managerPhone = cfg.notify_adler ? await phoneOf(MANAGER_PERSON) : "";
  for (const evs of byClient.values()) {
    const views = evs.map((e) => eventView(e, e.display_name || "Cliente"));
    const gt = evs[0].gt_owner as string | null;
    const gtPhone = await phoneOf(gt);
    const result: Row = { whatsapp_at: new Date().toISOString() };
    if (gtPhone && gtPhone !== managerPhone) {
      try { result.gt = await sendWhatsApp(gtPhone, L.whatsappText(views, false)); whatsapp++; }
      catch (e) { result.gt_error = clean((e as Error).message, 200); }
    } else if (!gtPhone) {
      result.gt_error = gt ? "gt_sem_telefone" : "cliente_sem_gt";
    }
    if (managerPhone) {
      try { result.manager = await sendWhatsApp(managerPhone, L.whatsappText(views, true)); whatsapp++; }
      catch (e) { result.manager_error = clean((e as Error).message, 200); }
    }
    await sql`
      update agency_ops.cpl_guard_events
      set notified_at = now(), notify_result = notify_result || ${sql.json(result)}
      where id = any(${evs.map((e) => e.id)})`;
  }
  return { dash, whatsapp, waiting_window: 0 };
}

async function checkHistory(cfg: Row) {
  const history = await collectHistory();
  const toEnrich = await sql`
    select * from agency_ops.cpl_guard_events
    where reading is null and executed_at > now() - interval '3 days'
    order by executed_at limit 30`;
  let enriched = 0;
  const enrichErrors: Row[] = [];
  await pool(toEnrich as Row[], 3, async (ev) => {
    try { await enrich(ev, cfg); enriched++; }
    catch (e) {
      const msg = clean((e as Error).message, 300);
      enrichErrors.push({ entity: ev.entity_id, error: msg });
      // Sem acesso aos detalhes: avisa mesmo assim, com o que tem.
      await sql`
        update agency_ops.cpl_guard_events
        set error = ${msg}, reading = ${"Não consegui ler os detalhes na Meta agora. Abra no Gerenciador para ver a entrega do dia."}, reading_source = 'SEM_DADOS'
        where id = ${ev.id}`;
    }
  });
  const sent = await notify(cfg);
  return { ...history, enriched, enrich_errors: enrichErrors, notify: sent };
}

async function logRun(startedAt: Date, action: string, processed: number, error: string | null) {
  try {
    const finished = new Date();
    await sql`insert into agency_ops.job_runs(job_name, started_at, finished_at, status, events_processed, error, duration_ms)
      values (${JOB_NAME + ":" + action}, ${startedAt.toISOString()}, ${finished.toISOString()}, ${error ? "ERROR" : "SUCCESS"}, ${processed}, ${error}, ${finished.getTime() - startedAt.getTime()})`;
    if (error) {
      await sql`insert into agency_ops.automation_health(job_name, last_error_at, last_error, updated_at) values (${JOB_NAME}, now(), ${error}, now())
        on conflict (job_name) do update set last_error_at = now(), last_error = excluded.last_error, updated_at = now()`;
    } else {
      await sql`insert into agency_ops.automation_health(job_name, last_success_at, last_error, updated_at) values (${JOB_NAME}, now(), null, now())
        on conflict (job_name) do update set last_success_at = now(), last_error = null, updated_at = now()`;
    }
  } catch (e) {
    console.error("cpl_guard_log_failed", clean((e as Error).message, 200));
  }
}

Deno.serve(async (req) => {
  if (req.method === "GET" && new URL(req.url).searchParams.get("health") === "1") {
    return json({ ok: true, service: JOB_NAME, v: 1 });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  const secret = await vault("CPL_GUARD_SECRET").catch(() => "");
  if (!secret || req.headers.get("x-cpl-guard-secret") !== secret) return json({ ok: false, error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  const action = clean(body?.action, 40).toUpperCase();
  const startedAt = new Date();
  try {
    const cfg = await config();
    if (action === "STATUS") {
      const rules = await sql`select status, level, count(*)::int as n from agency_ops.cpl_guard_rules group by 1, 2 order by 1, 2`;
      const events = await sql`select count(*)::int as n, max(executed_at) as last from agency_ops.cpl_guard_events`;
      return json({ ok: true, config: cfg, rules, events: events[0] });
    }
    TOKEN = await vault("META_CAMPAIGN_BUILDER_TOKEN");
    if (!TOKEN) throw new Error("META_CAMPAIGN_BUILDER_TOKEN missing");
    if (action === "SYNC_RULES") {
      const clientId = /^[0-9a-f-]{36}$/i.test(String(body?.client_id || "")) ? String(body.client_id) : null;
      const out = await syncRules(cfg, clientId, body?.dry_run === true);
      if (!out.dry_run) await logRun(startedAt, action, out.rules_active, out.errors ? `${out.errors} regra(s) com erro` : null);
      return json({ ok: true, action, ...out });
    }
    if (action === "CHECK_HISTORY") {
      if (!cfg.enabled) return json({ ok: true, action, skipped: "disabled" });
      const out = await checkHistory(cfg);
      await logRun(startedAt, action, out.new_events, out.errors.length ? `${out.errors.length} regra(s) sem leitura` : null);
      return json({ ok: true, action, ...out });
    }
    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (e) {
    const msg = clean((e as Error).message, 300);
    await logRun(startedAt, action || "UNKNOWN", 0, msg);
    return json({ ok: false, error: msg }, 500);
  }
});
