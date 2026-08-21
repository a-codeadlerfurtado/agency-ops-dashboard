import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), {
  status: s,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ops = db.schema("agency_ops");

async function segredo(n: string): Promise<string | null> {
  const { data, error } = await ops.rpc("get_secret", { p_name: n });
  return error ? null : ((data as string) || null);
}

async function config(n: string): Promise<string | null> {
  const { data, error } = await ops.from("automation_settings").select("value").eq("key", n).maybeSingle();
  if (error) return null;
  const value = data?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const SISTEMA = [
  "Voce e o motor operacional de uma agencia de trafego pago imobiliario.",
  "Recebe as mensagens de UMA conversa de grupo e um DOSSIE do cliente.",
  "Transforme pendencias executaveis em tasks. Responda APENAS JSON valido.",
  "",
  "REGRAS",
  "1. Uma task por acao executavel. Nunca agrupe acoes diferentes.",
  "2. Nao crie task para conversa generica, elogio, saudacao, ok, obrigado,",
  "   confirmacao simples ou 'vou verificar' isolado.",
  "3. Use o dossie. Se o pedido mexe em verba, compare com budget_mensal_brl e",
  "   diga o impacto. Se envolve lead/CRM, cite o CRM do cliente pelo nome.",
  "4. Se o assunto ja aparece em tasks_abertas, nao proponha de novo como nova pendencia:",
  "   devolva a task somente como registro de duplicidade e marque duplicata_provavel=true.",
  "5. area: uma de Gestor de trafego | CS | Designer | Editor de video |",
  "   Gerente operacional | Comercial.",
  "6. prioridade: Urgente | Alta | Media | Baixa. Campanha de imovel vendido",
  "   que segue no ar e sempre Urgente: e verba queimando.",
  "7. evidencia: cite o trecho literal da mensagem que originou a task.",
  "8. Nunca invente dado que nao esteja no dossie ou nas mensagens.",
  "9. responsavel_sugerido deve conter no maximo UMA pessoa. So escolha quando o dossie",
  "   indicar claramente o responsavel; se houver varias pessoas possiveis, deixe vazio.",
  "",
  '{"tasks":[{"titulo":"","descricao":"","area":"","responsavel_sugerido":"",',
  '"prioridade":"","prazo_dias":0,"evidencia":"","duplicata_provavel":false,"motivo":""}]}',
].join("\n");

function parseJsonText(text: string): any {
  const limpo = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return JSON.parse(limpo || "{}");
}

async function chamarOpenAI(chave: string, modelo: string, dossie: unknown, mensagens: string) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${chave}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: modelo,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SISTEMA },
        { role: "user", content: `DOSSIE DO CLIENTE:\n${JSON.stringify(dossie, null, 1)}\n\nMENSAGENS DA CONVERSA:\n${mensagens}` },
      ],
    }),
  });
  const raw = await r.text();
  let j: any = null;
  try { j = raw ? JSON.parse(raw) : null; } catch { j = null; }
  if (!r.ok) throw new Error(`openai ${r.status}: ${raw.slice(0, 300)}`);
  return parseJsonText(j?.choices?.[0]?.message?.content || "{}");
}

async function chamarBackend(endpoint: string, readSecret: string, dossie: unknown, mensagens: string) {
  const prompt = `${SISTEMA}\n\nDOSSIE DO CLIENTE:\n${JSON.stringify(dossie, null, 1)}\n\nMENSAGENS DA CONVERSA:\n${mensagens}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-read-secret": readSecret },
      body: JSON.stringify({
        question: prompt,
        original_question: "Gerar tasks operacionais desta conversa",
        source: "TaskEngine",
        request_id: crypto.randomUUID(),
        constraints: { read_only: true, schema: "agency_ops", timezone: "America/Sao_Paulo", no_invention: true },
      }),
      signal: controller.signal,
    });
    const raw = await r.text();
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    if (!r.ok) throw new Error(`ai_backend ${r.status}: ${raw.slice(0, 300)}`);
    const answer = [body?.answer, body?.response, body?.output, body?.result, body?.text, body?.message]
      .find((v) => typeof v === "string" && v.trim());
    if (!answer) throw new Error("ai_backend empty_answer");
    return parseJsonText(answer);
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("health") === "1") {
    return json({ ok: true, service: "agency-ops-task-engine", modo_padrao: "SHADOW", version: 4 });
  }

  const cronSecret = await segredo("TASK_ENGINE_CRON_SECRET");
  if (!cronSecret || req.headers.get("x-task-engine-key") !== cronSecret) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const [chave, modeloSecret, endpoint, readSecret] = await Promise.all([
    segredo("OPENAI_API_KEY"),
    segredo("TASK_ENGINE_MODEL"),
    config("AI_ASK_ENDPOINT_URL"),
    config("AI_ASK_READ_SECRET"),
  ]);
  const provider = chave ? "OPENAI" : (endpoint && readSecret ? "OPSQUESTION_BACKEND" : null);
  if (!provider) {
    return json({ ok: false, error: "missing_ai_configuration", detail: "Sem OPENAI_API_KEY e sem backend AI alternativo configurado. Fila preservada." }, 428);
  }
  const modelo = chave ? (modeloSecret || "gpt-5-mini") : "opsquestion-backend";

  const modo = url.searchParams.get("modo") === "LIVE" ? "LIVE" : "SHADOW";
  const limite = Math.min(Math.max(Number(url.searchParams.get("limite") || 1), 1), 25);

  const agora = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  await ops.from("task_generation_events")
    .update({ status: "ERROR", last_error: "stale_processing_recovered", available_at: agora })
    .eq("status", "PROCESSING")
    .lt("locked_at", staleBefore);

  const { data: eventos, error: erroFila } = await ops.from("task_generation_events")
    .select("*").in("status", ["PENDING", "ERROR"]).lte("available_at", agora)
    .order("urgency", { ascending: true }).order("id", { ascending: true }).limit(limite);
  if (erroFila) return json({ ok: false, error: erroFila.message }, 500);
  if (!eventos?.length) return json({ ok: true, processados: 0, modo, provider, modelo });

  const resumo = { processados: 0, propostas: 0, duplicadas: 0, enviadas: 0, erros: 0 };

  for (const ev of eventos) {
    await ops.from("task_generation_events")
      .update({ status: "PROCESSING", locked_at: new Date().toISOString(), attempt_count: (ev.attempt_count ?? 0) + 1 })
      .eq("id", ev.id);

    try {
      const { data: dossie } = await ops.rpc("build_task_context", { p_client_id: ev.client_id, p_chat_id: ev.chat_id });
      const saida = chave
        ? await chamarOpenAI(chave, modelo, dossie ?? {}, ev.excerpt || "")
        : await chamarBackend(endpoint!, readSecret!, dossie ?? {}, ev.excerpt || "");
      const propostas: any[] = Array.isArray(saida?.tasks) ? saida.tasks : [];

      for (const t of propostas) {
        if (!t?.titulo) continue;
        const titulo = String(t.titulo).slice(0, 250);
        const { data: dup } = await ops.rpc("find_duplicate_task", { p_client_id: ev.client_id, p_titulo: titulo });
        const achou = Array.isArray(dup) ? dup[0] : dup;
        const duplicataIA = t.duplicata_provavel === true;
        const duplicada = Boolean(achou) || duplicataIA;
        const { data: norm } = await ops.rpc("normalize_task_subject", { p_nome: titulo });

        const linha: Record<string, unknown> = {
          event_id: ev.id,
          client_id: ev.client_id,
          chat_id: ev.chat_id,
          titulo,
          titulo_norm: norm || titulo.toLowerCase(),
          descricao: t.descricao ?? null,
          area: t.area ?? null,
          responsavel_sugerido: t.responsavel_sugerido ?? null,
          prioridade: t.prioridade ?? null,
          prazo_sugerido: Number.isFinite(Number(t.prazo_dias))
            ? new Date(Date.now() + Number(t.prazo_dias) * 86400000).toISOString().slice(0, 10)
            : null,
          urgencia: ev.urgency,
          sinais: ev.signals,
          contexto: dossie ?? null,
          evidencia: {
            trecho: t.evidencia ?? null,
            motivo: t.motivo ?? null,
            message_id: ev.message_id,
            provider,
            duplicata_provavel_ia: duplicataIA,
          },
          modelo,
          modo,
          status: duplicada ? "DUPLICADA" : "PROPOSTA",
          similaridade: achou?.similaridade ?? null,
        };

        const { data: gravada } = await ops.from("generated_tasks").insert(linha).select("id").maybeSingle();
        if (duplicada) { resumo.duplicadas++; continue; }
        resumo.propostas++;

        if (modo === "LIVE") {
          const tokenCu = await segredo("CLICKUP_API_TOKEN");
          const lista = await segredo("TASK_ENGINE_CLICKUP_LIST");
          if (tokenCu && lista) {
            const prio: Record<string, number> = { Urgente: 1, Alta: 2, Media: 3, "Média": 3, Baixa: 4 };
            const r = await fetch(`https://api.clickup.com/api/v2/list/${lista}/task`, {
              method: "POST",
              headers: { Authorization: tokenCu, "content-type": "application/json" },
              body: JSON.stringify({ name: titulo, description: String(t.descricao ?? ""), priority: prio[String(t.prioridade)] ?? 3 }),
            });
            const jr = await r.json().catch(() => ({}));
            await ops.from("generated_tasks").update(
              r.ok
                ? { status: "ENVIADA", clickup_task_id: jr?.id ?? null, sent_at: new Date().toISOString() }
                : { status: "ERRO", erro: JSON.stringify(jr).slice(0, 500) },
            ).eq("id", gravada?.id);
            if (r.ok) resumo.enviadas++;
          }
        }
      }

      await ops.from("task_generation_events")
        .update({ status: "DONE", processed_at: new Date().toISOString(), last_error: null }).eq("id", ev.id);
      resumo.processados++;
    } catch (e) {
      resumo.erros++;
      await ops.from("task_generation_events")
        .update({ status: "ERROR", last_error: String(e).slice(0, 500), available_at: new Date(Date.now() + 300000).toISOString() })
        .eq("id", ev.id);
    }
  }

  return json({ ok: true, modo, provider, modelo, ...resumo });
});
