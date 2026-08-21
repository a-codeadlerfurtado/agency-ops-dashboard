import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const VALIDATION_VERSION = "grounding-v2";
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

function normalizarTexto(v: unknown): string {
  return String(v ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function areaEhTrafego(area: unknown): boolean {
  const a = normalizarTexto(area);
  return a === "gestor de trafego" || a === "trafego pago" || a === "gt";
}

async function resolverGtDoCliente(clientId: unknown): Promise<any> {
  if (!clientId) return { ok: false, reason: "missing_client_id" };
  const { data, error } = await ops.rpc("resolve_gt_clickup_assignee", { p_client_id: clientId });
  if (error) return { ok: false, reason: "assignment_rpc_error", detail: error.message };
  const assigneeId = Number(data?.clickup_user_id);
  if (!data?.ok || !Number.isFinite(assigneeId)) {
    return { ...(data ?? {}), ok: false, reason: data?.reason ?? "invalid_clickup_user_id" };
  }
  return { ...data, ok: true, clickup_user_id: String(data.clickup_user_id) };
}

function relatorioSomenteInformativo(ev: any): boolean {
  const sinais = Array.isArray(ev?.signals) ? ev.signals.map((s: unknown) => String(s)) : [];
  if (sinais.length !== 1 || sinais[0] !== "RELATORIO") return false;
  const texto = normalizarTexto(ev?.excerpt);
  const temCabecalho = /segue o relatorio|relatorio das ultimas atualizacoes/.test(texto);
  const ocorrencias = (texto.match(/ultima atualizacao/g) || []).length;
  const pedidoExplicito = /\b(poderia|preciso|precisamos|favor|por favor|enviar|envie|mande|fazer|corrigir|ajustar|agendar|marcar|subir|pausar|retorno|responder|verificar)\b/.test(texto);
  return temCabecalho && ocorrencias >= 2 && !pedidoExplicito;
}

function evidenciaEstaNaMensagem(evidencia: unknown, excerpt: unknown): boolean {
  const e = normalizarTexto(evidencia);
  const x = normalizarTexto(excerpt);
  if (!e || !x) return false;
  if (x.includes(e)) return true;
  const tokens = [...new Set(e.split(" ").filter((t) => t.length >= 4))];
  if (!tokens.length) return false;
  const presentes = tokens.filter((t) => x.includes(t)).length;
  return presentes / tokens.length >= 0.78;
}

const STOPWORDS = new Set([
  "para", "pela", "pelo", "pelos", "pelas", "com", "sem", "sobre", "entre", "mais", "menos", "uma", "umas", "uns", "dos", "das", "que", "isso", "essa", "esse", "esta", "este", "aqui", "ali", "como", "quando", "onde", "depois", "antes", "tambem", "mencionada", "mencionado",
]);
const VERBOS_OPERACIONAIS = new Set([
  "atualizar", "ajustar", "corrigir", "alterar", "trocar", "inserir", "adicionar", "remover", "retirar", "enviar", "mandar", "responder", "retornar", "solicitar", "pedir", "dar", "fazer", "criar", "subir", "publicar", "pausar", "ativar", "desativar", "agendar", "marcar", "confirmar", "verificar", "revisar", "validar", "acompanhar", "cobrar", "avisar", "informar",
]);
const METADADOS_GENERICOS = new Set(["cliente", "grupo", "conversa", "pedido", "mensagem", "task", "tarefa", "operacional"]);

function tokensSignificativos(v: unknown): string[] {
  return [...new Set(normalizarTexto(v).split(" ").filter((t) => t.length >= 4 && !STOPWORDS.has(t)))];
}

function tokenSuportado(token: string, excerptTokens: string[]): boolean {
  if (VERBOS_OPERACIONAIS.has(token) || METADADOS_GENERICOS.has(token)) return true;
  if (excerptTokens.includes(token)) return true;
  if (token.length >= 5) {
    const stem = token.slice(0, 5);
    return excerptTokens.some((x) => x.length >= 5 && x.slice(0, 5) === stem);
  }
  return false;
}

function groundingConteudo(titulo: unknown, descricao: unknown, excerpt: unknown) {
  const excerptTokens = tokensSignificativos(excerpt);
  const titleTokens = tokensSignificativos(titulo);
  const descriptionTokens = tokensSignificativos(descricao);
  const titleUnsupported = titleTokens.filter((t) => !tokenSuportado(t, excerptTokens));
  const descUnsupported = descriptionTokens.filter((t) => !tokenSuportado(t, excerptTokens));
  const total = Math.max(1, titleTokens.length + descriptionTokens.length);
  const supported = total - titleUnsupported.length - descUnsupported.length;
  const score = Math.max(0, Math.min(1, supported / total));
  return { score, titleUnsupported, descUnsupported };
}

function tarefaInternaDoSistema(titulo: unknown, descricao: unknown): boolean {
  const t = normalizarTexto(`${titulo ?? ""} ${descricao ?? ""}`);
  return /\btriagem\b/.test(t)
    || /\btitularidade\b/.test(t)
    || /\bclassificar (?:o )?grupo\b/.test(t)
    || /\bconfirmar (?:o |a )?(?:grupo|rotulo|cadastro|vinculo)\b/.test(t)
    || /\bvincular (?:o )?(?:cliente|grupo)\b/.test(t)
    || /\bassociar (?:o )?(?:cliente|grupo)\b/.test(t)
    || /\breconciliar (?:o )?(?:cliente|grupo|cadastro)\b/.test(t)
    || /\bmapear (?:o )?grupo\b/.test(t)
    || /\bidentificar (?:de quem|titular|cliente do grupo)\b/.test(t);
}

async function sha256(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(String(v ?? ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SISTEMA = [
  "Voce e o motor operacional de uma agencia de trafego pago imobiliario.",
  "Recebe as mensagens de UMA conversa de grupo e um DOSSIE do cliente.",
  "Transforme SOMENTE pedidos, compromissos ou pendencias explicitamente executaveis das MENSAGENS em tasks.",
  "Responda APENAS JSON valido.",
  "",
  "REGRAS",
  "1. Uma task por acao executavel. Nunca agrupe acoes diferentes.",
  "2. Nao crie task para conversa generica, elogio, saudacao, ok, obrigado, confirmacao simples,",
  "   relatorio meramente informativo, status historico ou 'vou verificar' isolado.",
  "3. O DOSSIE serve apenas para enriquecer uma acao que JA ESTA explicita nas MENSAGENS.",
  "   Nunca crie uma acao nova usando apenas o dossie, tasks_abertas, datas antigas, resumo ou contexto lateral.",
  "4. O TITULO e a DESCRICAO nao podem introduzir assunto, objeto, motivo ou qualificacao que nao esteja escrito nas MENSAGENS.",
  "   Use o dossie somente para metadados como responsavel quando houver correspondencia clara; nunca para completar o assunto da task.",
  "5. Exemplo proibido: mensagem 'poderia dar um retorno?' -> titulo 'dar retorno sobre pagamento'.",
  "   'pagamento' nao esta na mensagem, portanto o titulo correto deve ser apenas 'dar retorno'.",
  "6. Nunca gere task humana para manutencao interna do sistema: triagem de grupo, titularidade, vinculo de cliente, rotulo, cadastro, reconciliacao ou classificacao.",
  "7. Se o assunto ja aparece em tasks_abertas, nao proponha de novo como nova pendencia:",
  "   devolva a task somente como registro de duplicidade e marque duplicata_provavel=true.",
  "8. area: uma de Gestor de trafego | CS | Designer | Editor de video | Gerente operacional | Comercial.",
  "9. prioridade: Urgente | Alta | Media | Baixa. Campanha de imovel vendido que segue no ar e Urgente.",
  "10. evidencia deve ser um TRECHO LITERAL copiado das MENSAGENS recebidas neste evento.",
  "    Nao use texto do dossie como evidencia e nao acrescente palavras ao trecho citado.",
  "11. Nunca invente fatos, acoes, responsaveis, prazos ou necessidades.",
  "12. responsavel_sugerido deve conter no maximo UMA pessoa. So escolha quando o dossie indicar claramente o responsavel;",
  "    se houver varias pessoas possiveis, deixe vazio.",
  "13. Se nao houver uma acao explicitamente pedida ou assumida nas MENSAGENS, responda {\"tasks\":[]}.",
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
    return json({ ok: true, service: "agency-ops-task-engine", modo_padrao: "SHADOW", version: 7, validation_version: VALIDATION_VERSION, gt_routing: "clients.gt_owner+team_identity_map" });
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
  if (!eventos?.length) return json({ ok: true, processados: 0, modo, provider, modelo, validation_version: VALIDATION_VERSION });

  const resumo = { processados: 0, ignorados: 0, propostas: 0, duplicadas: 0, descartadas: 0, revisao_sistema: 0, bloqueadas_atribuicao: 0, enviadas: 0, erros: 0 };

  for (const ev of eventos) {
    await ops.from("task_generation_events")
      .update({ status: "PROCESSING", locked_at: new Date().toISOString(), attempt_count: (ev.attempt_count ?? 0) + 1 })
      .eq("id", ev.id);

    try {
      if (relatorioSomenteInformativo(ev)) {
        await ops.from("task_generation_events")
          .update({ status: "DONE", processed_at: new Date().toISOString(), last_error: null }).eq("id", ev.id);
        resumo.processados++;
        resumo.ignorados++;
        continue;
      }

      const { data: dossie } = await ops.rpc("build_task_context", { p_client_id: ev.client_id, p_chat_id: ev.chat_id });
      const saida = chave
        ? await chamarOpenAI(chave, modelo, dossie ?? {}, ev.excerpt || "")
        : await chamarBackend(endpoint!, readSecret!, dossie ?? {}, ev.excerpt || "");
      const propostas: any[] = Array.isArray(saida?.tasks) ? saida.tasks : [];
      const sourceHash = await sha256(ev.excerpt || "");

      for (const t of propostas) {
        if (!t?.titulo) continue;
        const titulo = String(t.titulo).slice(0, 250);
        const descricao = t.descricao == null ? null : String(t.descricao).slice(0, 4000);
        const isTrafficTask = areaEhTrafego(t.area);
        const gtRoute = isTrafficTask ? await resolverGtDoCliente(ev.client_id) : null;
        const gtAssigneeId = Number(gtRoute?.clickup_user_id);
        const gtRouteOk = !isTrafficTask || (gtRoute?.ok === true && Number.isFinite(gtAssigneeId));

        const evidenceGrounded = evidenciaEstaNaMensagem(t.evidencia, ev.excerpt);
        const internalSystemTask = tarefaInternaDoSistema(titulo, descricao);
        const grounding = groundingConteudo(titulo, descricao, ev.excerpt);
        const unsupported = [...grounding.titleUnsupported, ...grounding.descUnsupported];
        const contentGrounded = unsupported.length === 0;
        const grounded = evidenceGrounded && contentGrounded && !internalSystemTask;
        const groundingReason = internalSystemTask
          ? "internal_system_task"
          : !evidenceGrounded
            ? "evidence_not_in_current_event"
            : !contentGrounded
              ? `unsupported_context:${unsupported.slice(0, 8).join(",")}`
              : "accepted";

        const { data: dup } = grounded
          ? await ops.rpc("find_duplicate_task", { p_client_id: ev.client_id, p_titulo: titulo })
          : { data: null } as any;
        const achou = Array.isArray(dup) ? dup[0] : dup;
        const duplicataIA = t.duplicata_provavel === true;
        const duplicada = grounded && (Boolean(achou) || duplicataIA);
        const descartada = !grounded;
        const { data: norm } = await ops.rpc("normalize_task_subject", { p_nome: titulo });
        const tituloNorm = String(norm || titulo.toLowerCase());

        if (internalSystemTask) {
          await ops.from("system_review_events").upsert({
            source_event_id: ev.id,
            client_id: ev.client_id,
            chat_id: ev.chat_id,
            proposed_title: titulo,
            proposed_title_norm: tituloNorm,
            proposed_description: descricao,
            reason: "internal_system_task",
            validation_version: VALIDATION_VERSION,
            source_excerpt_hash: sourceHash,
            payload: {
              message_id: ev.message_id,
              signals: ev.signals,
              ai_evidence: t.evidencia ?? null,
              ai_reason: t.motivo ?? null,
              provider,
              model: modelo,
            },
          }, { onConflict: "source_event_id,reason,proposed_title_norm", ignoreDuplicates: true });
          resumo.revisao_sistema++;
        }

        const linha: Record<string, unknown> = {
          event_id: ev.id,
          client_id: ev.client_id,
          chat_id: ev.chat_id,
          titulo,
          titulo_norm: tituloNorm,
          descricao,
          area: t.area ?? null,
          responsavel_sugerido: isTrafficTask ? (gtRoute?.gt_owner ?? null) : (t.responsavel_sugerido ?? null),
          resolved_assignee_person: isTrafficTask ? (gtRoute?.gt_owner ?? null) : null,
          resolved_clickup_user_id: isTrafficTask && gtRouteOk ? String(gtRoute.clickup_user_id) : null,
          assignment_source: isTrafficTask ? "clients.gt_owner+team_identity_map" : null,
          prioridade: t.prioridade ?? null,
          prazo_sugerido: Number.isFinite(Number(t.prazo_dias))
            ? new Date(Date.now() + Number(t.prazo_dias) * 86400000).toISOString().slice(0, 10)
            : null,
          urgencia: ev.urgency,
          sinais: ev.signals,
          contexto: dossie ?? null,
          grounding_score: Number(grounding.score.toFixed(4)),
          grounding_reason: groundingReason,
          source_excerpt_hash: sourceHash,
          validation_version: VALIDATION_VERSION,
          evidencia: {
            trecho: t.evidencia ?? null,
            motivo: t.motivo ?? null,
            message_id: ev.message_id,
            provider,
            duplicata_provavel_ia: duplicataIA,
            grounded_in_current_event: evidenceGrounded,
            content_grounded_in_current_event: contentGrounded,
            unsupported_terms: unsupported,
            internal_system_task: internalSystemTask,
            discard_reason: descartada ? groundingReason : null,
            validation_version: VALIDATION_VERSION,
            traffic_assignment: isTrafficTask ? {
              ok: gtRouteOk,
              source: "clients.gt_owner+team_identity_map",
              client_id: ev.client_id ?? null,
              client_name: gtRoute?.client_name ?? null,
              gt_owner: gtRoute?.gt_owner ?? null,
              clickup_user_id: gtRouteOk ? String(gtRoute.clickup_user_id) : null,
              reason: gtRoute?.reason ?? null,
            } : null,
          },
          modelo,
          modo,
          status: descartada ? "DESCARTADA" : (duplicada ? "DUPLICADA" : "PROPOSTA"),
          similaridade: achou?.similaridade ?? null,
        };

        const { data: gravada } = await ops.from("generated_tasks").insert(linha).select("id").maybeSingle();
        if (descartada) { resumo.descartadas++; continue; }
        if (duplicada) { resumo.duplicadas++; continue; }

        if (modo === "LIVE" && isTrafficTask && !gtRouteOk) {
          await ops.from("generated_tasks").update({
            status: "ERRO",
            erro: `gt_assignment_unresolved:${String(gtRoute?.reason ?? "unknown")}`.slice(0, 500),
          }).eq("id", gravada?.id);
          resumo.bloqueadas_atribuicao++;
          continue;
        }

        resumo.propostas++;

        if (modo === "LIVE") {
          const tokenCu = await segredo("CLICKUP_API_TOKEN");
          const lista = await segredo("TASK_ENGINE_CLICKUP_LIST");
          if (tokenCu && lista) {
            const prio: Record<string, number> = { Urgente: 1, Alta: 2, Media: 3, "Média": 3, Baixa: 4 };
            const clickupBody: Record<string, unknown> = {
              name: titulo,
              description: descricao || "",
              priority: prio[String(t.prioridade)] ?? 3,
            };
            if (isTrafficTask) clickupBody.assignees = [gtAssigneeId];

            const r = await fetch(`https://api.clickup.com/api/v2/list/${lista}/task`, {
              method: "POST",
              headers: { Authorization: tokenCu, "content-type": "application/json" },
              body: JSON.stringify(clickupBody),
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

  return json({ ok: true, modo, provider, modelo, validation_version: VALIDATION_VERSION, ...resumo });
});