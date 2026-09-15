import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-max-age": "86400",
};
const CLOUDFLARE_AI_BASE = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev/api/ai";
const MAX_PROMPT_CHARS = 18_000;
const AI_DEADLINE_MS = 11_000;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

type Row = Record<string, any>;
const finite = (v: unknown) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const brl = (v: unknown) => {
  const n = finite(v);
  return n === null ? "indisponível" : `R$ ${n.toFixed(2).replace(".", ",")}`;
};

function safeAnswer(body: any, raw = "") {
  const candidates = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message, body?.assistant_message?.content];
  for (const value of candidates) if (typeof value === "string" && value.trim()) return value.trim();
  if (raw.trim() && !raw.trim().startsWith("<")) return raw.trim();
  return null;
}

function extractDashboardContext(question: string): Row | null {
  const marker = "DADOS ATUAIS DO DASHBOARD:";
  const start = question.indexOf(marker);
  if (start < 0) return null;
  const after = question.slice(start + marker.length).trimStart();
  const endMarkers = ["\n\nResponda em português", "\n\nResponda em portugues", "\n\nEm 3 MELHORES"];
  let end = after.length;
  for (const markerText of endMarkers) {
    const idx = after.indexOf(markerText);
    if (idx >= 0) end = Math.min(end, idx);
  }
  try { return JSON.parse(after.slice(0, end).trim()); } catch { return null; }
}

function compressedPrompt(question: string) {
  const ctx = extractDashboardContext(question);
  if (!ctx) return question.slice(0, 12_000);
  const compact = {
    cliente: ctx.cliente || null,
    budget: ctx.budget || null,
    pacing: ctx.pacing ? {
      status: ctx.pacing.status,
      monthly_budget: ctx.pacing.monthly_budget,
      mtd_spend: ctx.pacing.mtd_spend,
      remaining_budget: ctx.pacing.remaining_budget,
      remaining_days: ctx.pacing.remaining_days,
      ideal_daily_remaining: ctx.pacing.ideal_daily_remaining,
      projected_month_spend: ctx.pacing.projected_month_spend,
      variance: ctx.pacing.variance,
      source: ctx.pacing.source,
    } : null,
    benchmark: ctx.benchmark_interno || null,
    meta_7d: ctx.meta_7d || null,
    meta_7d_anterior: ctx.meta_7d_anterior || null,
    campanhas: Array.isArray(ctx.campanhas) ? ctx.campanhas.slice(0, 12) : [],
    criativos: Array.isArray(ctx.criativos) ? ctx.criativos.slice(0, 8) : [],
    recomendacoes: Array.isArray(ctx.recomendacoes_deterministicas) ? ctx.recomendacoes_deterministicas.slice(0, 6) : [],
  };
  return `Você é o Ads Intelligence, copiloto sênior de mídia de uma agência imobiliária.\n\nREGRAS:\n- Budget mensal é teto operacional. Nunca proponha gasto total acima dele.\n- Se MTD estiver indisponível, não proponha aumento total.\n- Aumentar verba é só uma opção. Priorize redistribuição, redução, pausa, estrutura, criativo, oferta, LP/formulário, atendimento, saldo ou não alterar quando fizer mais sentido.\n- Benchmark é contexto, não meta universal. Diferencie fato de hipótese.\n- Seja curto, específico e executivo.\n\nDADOS:\n${JSON.stringify(compact)}\n\nResponda exatamente com estas seções:\nDIAGNÓSTICO\nRESTRIÇÃO DE BUDGET\n3 MELHORES AÇÕES AGORA\nO QUE EU NÃO FARIA\nEXPERIMENTO CONTROLADO\nO QUE MEDIR NAS PRÓXIMAS 48H`;
}

function deterministicFallback(question: string) {
  const ctx = extractDashboardContext(question) || {};
  const pacing = ctx.pacing || {};
  const meta = ctx.meta_7d || {};
  const recs: Row[] = Array.isArray(ctx.recomendacoes_deterministicas) ? ctx.recomendacoes_deterministicas : [];
  const monthly = finite(ctx.budget?.monthly_budget ?? pacing.monthly_budget);
  const mtd = finite(pacing.mtd_spend);
  const remaining = finite(pacing.remaining_budget);
  const cpl = finite(meta.cpl ?? meta.cost_per_result);
  const ctr = finite(meta.ctr);
  const results = finite(meta.results);
  const status = String(pacing.status || "");
  const main = recs[0];
  const diagnosis = main
    ? `${main.title}. ${main.reason || main.action || ""}`.trim()
    : results !== null && results > 0
      ? `A conta está gerando resultados${cpl !== null ? ` com CPL/CPR de ${brl(cpl)}` : ""}${ctr !== null ? ` e CTR de ${ctr.toFixed(2).replace(".", ",")}%` : ""}. Não há evidência suficiente para uma mudança agressiva sem isolar a variável.`
      : "A amostra disponível não sustenta uma mudança agressiva. Priorize estabilidade, coleta de dados e correção de gargalos objetivos.";

  let restriction = `Budget mensal cadastrado: ${brl(monthly)}.`;
  if (status === "MTD_UNAVAILABLE" || mtd === null) restriction += " O gasto MTD não está confirmado; portanto não recomendo elevar o gasto total. Redistribuições neutras continuam válidas.";
  else if (status === "BUDGET_REACHED") restriction += ` O teto já foi atingido (${brl(mtd)} gastos). Não aumentar investimento.`;
  else if (status === "OVER_PACE") restriction += ` Gasto MTD de ${brl(mtd)}; o ritmo está acima do teto. Prioridade é reduzir/redistribuir.`;
  else restriction += ` Gasto MTD: ${brl(mtd)}${remaining !== null ? `; restante estimado: ${brl(remaining)}` : ""}. Qualquer escala deve caber integralmente nesse teto.`;

  const actions = recs.slice(0, 3).map((r, i) => `${i + 1}. ${r.action || r.title}`).filter(Boolean);
  while (actions.length < 3) {
    const defaults = [
      "Manter o investimento total dentro do budget aprovado e redistribuir apenas quando houver diferença clara de eficiência.",
      "Alterar uma variável por vez — primeiro criativo/estrutura antes de culpar orçamento.",
      "Reavaliar com nova amostra e checar se o gargalo está depois do clique/lead antes de mexer na mídia.",
    ];
    actions.push(`${actions.length + 1}. ${defaults[actions.length]}`);
  }
  const dont = (status === "MTD_UNAVAILABLE" || status === "BUDGET_REACHED" || status === "OVER_PACE")
    ? "Não aumentaria o gasto total nem usaria orçamento como resposta automática. Também não faria várias mudanças simultâneas, porque isso impede saber o que melhorou ou piorou a conta."
    : "Não faria uma mudança ampla só para gerar atividade. Evitaria aumentar verba antes de confirmar estabilidade, pacing e causa do gargalo.";
  const experiment = "Escolha uma única hipótese com maior evidência e teste-a mantendo o budget total constante. Se o sinal for criativo, troque apenas a peça; se for distribuição, mova uma parcela pequena entre frentes e preserve o restante da estrutura.";
  const measure = `Acompanhar CPL/CPR${cpl !== null ? ` (atual ${brl(cpl)})` : ""}, CTR${ctr !== null ? ` (atual ${ctr.toFixed(2).replace(".", ",")}% )` : ""}, volume de resultados, gasto vs. pacing e qualquer sinal de qualidade/atendimento dos leads. Não concluir por poucas horas de oscilação.`;

  return `DIAGNÓSTICO\n${diagnosis}\n\nRESTRIÇÃO DE BUDGET\n${restriction}\n\n3 MELHORES AÇÕES AGORA\n${actions.join("\n")}\n\nO QUE EU NÃO FARIA\n${dont}\n\nEXPERIMENTO CONTROLADO\n${experiment}\n\nO QUE MEDIR NAS PRÓXIMAS 48H\n${measure}`;
}

async function callCloudflare(authHeader: string, question: string, signal: AbortSignal) {
  let conversationId = "";
  async function post(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${CLOUDFLARE_AI_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const raw = await response.text();
    let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    if (!response.ok || !parsed?.ok) throw new Error(`cloudflare_${response.status}`);
    return parsed;
  }
  const created = await post("/conversations/create", { client_id: null, title: "Ads Intelligence" });
  conversationId = String(created?.conversation?.id || "");
  if (!conversationId) throw new Error("conversation_missing");
  try {
    const result = await post("/chat", { conversation_id: conversationId, message: question });
    const answer = safeAnswer({ assistant_message: result?.assistant_message });
    if (!answer) throw new Error("empty_answer");
    return answer;
  } finally {
    if (conversationId && !signal.aborted) {
      const cleanupController = new AbortController();
      const timer = setTimeout(() => cleanupController.abort(), 1200);
      fetch(`${CLOUDFLARE_AI_BASE}/conversations/delete`, {
        method: "POST",
        headers: { Authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId }),
        signal: cleanupController.signal,
      }).catch(() => {}).finally(() => clearTimeout(timer));
    }
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply({ ok: false, error: "Método não permitido." }, 405);
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ ok: false, error: "Consultor temporariamente indisponível." }, 500);
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return reply({ ok: false, error: "Sessão indisponível." }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData } = await auth.auth.getUser();
  const user = userData?.user;
  if (!user) return reply({ ok: false, error: "Sessão indisponível." }, 401);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person").eq("user_key", user.id).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", user.id).eq("kind", "SIGNUP").eq("status", "APPROVED"),
  ]);
  const person = pref?.collaborator_person ?? null;
  if (!person || !(approvals ?? []).length) return reply({ ok: false, error: "Seu acesso ao Consultor ainda não está liberado." }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role").eq("person", person).eq("is_former", false).maybeSingle();
  const role = String(roster?.role || "");
  if (!roster || !["GT", "MGMT"].includes(role)) return reply({ ok: false, error: "O Consultor de Performance não está disponível para este perfil." }, 403);
  const body = await req.json().catch(() => ({}));
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) return reply({ ok: false, error: "Não há contexto suficiente para gerar a leitura." }, 400);
  if (question.length > MAX_PROMPT_CHARS) return reply({ ok: false, error: "O contexto deste cliente ficou grande demais para uma única leitura. Atualize a carteira e tente novamente." }, 400);
  const isConsultantPrompt = question.includes("DADOS ATUAIS DO DASHBOARD:") || (question.includes("DADOS ATUAIS:") && question.includes("PERGUNTA DO GT:"));
  if (!isConsultantPrompt) return reply({ ok: false, error: "Esta rota é exclusiva do Consultor de Performance." }, 400);

  const fallback = deterministicFallback(question);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_DEADLINE_MS);
  try {
    const answer = await callCloudflare(authHeader, compressedPrompt(question), controller.signal);
    return reply({ ok: true, answer, source: "META_CONSULTANT_AI", fallback: false, generated_at: new Date().toISOString() });
  } catch (error) {
    console.warn("[meta-consultant-ai:fallback]", error instanceof Error ? error.message : String(error));
    return reply({ ok: true, answer: fallback, source: "DECISION_ENGINE_FALLBACK", fallback: true, generated_at: new Date().toISOString() });
  } finally {
    clearTimeout(timer);
  }
});
