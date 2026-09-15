import type { CanalSse } from "./sse";
import { executarFerramenta, type EnvJarvis, type FerramentaJarvis } from "./tools";
import {
  atualizarEstadoClienteCache,
  carregarEstadoCliente,
  carregarMidiaClienteDia,
  carregarMidiaPeriodo,
  carregarEstadoOperacao,
  carregarEstadoLifecycle,
  carregarMemoriaRapida,
  idadeSegundos,
  resolverNomeUnico,
  salvarMemoriaRapida,
  type EstadoCliente,
  type MemoriaRapida,
} from "./state";
import { ehAtivoOperacional, listarClientesAtivosPorResponsavel, normalizarTranscricaoOperacional, perguntaSobreOnboarding, type ClientePermitido, repartirPorEstagio } from "./memory";
import { confirmacaoDeLeitura, detectarConsultaClientesOperacionais, detectarConsultaLifecycle, detectarEscopoGlobal, detectarJanelaMidia, temTemaOperacionalExplicito } from "./intent";
import { respostaSaldoMeta } from "./balance-semantics";
import { executarConsultaCanonica } from "./canonical-query";

export type ChamadaFast = { name: string; ok: boolean; ms: number };
export type ResultadoFast = {
  resposta: string;
  chamadas: ChamadaFast[];
  memory: Omit<MemoriaRapida, "updated_at">;
  source: string;
};

const MEDIA_TODAY_MAX_AGE = 120;
const CAMPAIGN_MAX_AGE = 120;
const BALANCE_MAX_AGE = 300;

function norm(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function temNovoTemaExplicito(q: string): boolean {
  return temTemaOperacionalExplicito(q);
}
function moeda(v: number | null | undefined, currency = "BRL"): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return "sem dado";
  try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(Number(v)); }
  catch { return `R$ ${Number(v).toFixed(2).replace(".", ",")}`; }
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}


function dataOperacional(offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const d = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + offsetDays));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function periodoDaMensagem(q: string, anterior?: MemoriaRapida | null): "today" | "yesterday" | "current" {
  if (/\bontem\b/.test(q)) return "yesterday";
  if (/\bhoje\b/.test(q)) return "today";
  const prev = anterior?.period;
  return prev === "today" || prev === "yesterday" || prev === "current" ? prev : "today";
}

function metricDaMensagem(q: string): string | null {
  if (/\b(cpl|custo por lead|cost per lead)\b/.test(q)) return "cpl";
  if (/\b(leads?|contatos?)\b/.test(q)) return "leads";
  if (/\b(gastou|gasto|investimento|investiu|spend)\b/.test(q)) return "spend";
  if (/\b(saldo|balance)\b/.test(q)) return "balance";
  if (/\b(campanhas?|campaigns?)\b/.test(q)) return "campaigns";
  if (/\b(gt|gestor de trafego|trafego)\b/.test(q)) return "gt";
  if (/\b(cs|customer success)\b/.test(q)) return "cs";
  if (/\b(designer|design)\b/.test(q)) return "designer";
  return null;
}
function nomeResponsavel(qOriginal: string, q: string, memoria?: MemoriaRapida | null): string | null {
  const m = qOriginal.match(/\bcom\s+(?:o|a)?\s*([\p{L}-]+)/iu);
  if (m?.[1]) return m[1];
  if (memoria?.metric === "portfolio_active") {
    const curto = qOriginal.match(/^\s*(?:e\s+)?(?:o|a)?\s*([\p{L}-]+)\s*[?.!]*\s*$/iu);
    if (curto?.[1]) return curto[1];
  }
  if (/\bcarteira\b/.test(q)) {
    const partes = qOriginal.trim().split(/\s+/);
    return partes.at(-1)?.replace(/[^\p{L}-]/gu, "") || null;
  }
  return null;
}

async function chamarTool(
  nome: string,
  args: Record<string, unknown>,
  porNome: Map<string, FerramentaJarvis>,
  jwt: string,
  env: EnvJarvis,
  canal: CanalSse | null,
  chamadas: ChamadaFast[],
): Promise<{ ok: boolean; content: string } | null> {
  const ferramenta = porNome.get(nome);
  if (!ferramenta) return null;
  const t0 = Date.now();
  canal?.emitir("tool_start", { name: ferramenta.name, summary: ferramenta.description });
  const r = await executarFerramenta(ferramenta, args, jwt, env);
  const ms = Date.now() - t0;
  chamadas.push({ name: ferramenta.name, ok: r.ok, ms });
  canal?.emitir("tool_end", { name: ferramenta.name, ok: r.ok, ms });
  return { ok: r.ok, content: r.content };
}

function respostaMidiaSnapshot(estado: EstadoCliente, metric: string, period: "today" | "yesterday"): string | null {
  const hoje = period === "today";
  const sufixo = hoje ? "hoje" : "ontem";
  const leads = hoje ? estado.leads_today : estado.leads_yesterday;
  const spend = hoje ? estado.spend_today : estado.spend_yesterday;
  const cpl = hoje ? estado.cpl_today : estado.cpl_yesterday;
  if (metric === "leads" && leads !== null) return `${estado.display_name} teve ${leads} ${leads === 1 ? "lead" : "leads"} ${sufixo}.`;
  if (metric === "spend" && spend !== null) return `${estado.display_name} gastou ${moeda(spend)} ${sufixo}.`;
  if (metric === "cpl" && cpl !== null) return `O CPL de ${estado.display_name} ${sufixo} foi ${moeda(cpl)}.`;
  return null;
}
function intervaloDaJanela(janela: ReturnType<typeof detectarJanelaMidia>): { since: string; until: string; label: string } | null {
  if (!janela) return null;
  if (janela.kind === "today") { const d=dataOperacional(0); return { since:d, until:d, label:"hoje" }; }
  if (janela.kind === "yesterday") { const d=dataOperacional(-1); return { since:d, until:d, label:"ontem" }; }
  return { since:dataOperacional(-(janela.days-1)), until:dataOperacional(0), label:janela.label };
}

function respostaPeriodo(nome: string | null, metric: string, label: string, d: any): string | null {
  const leads=numero(d?.leads), spend=numero(d?.spend), cpl=numero(d?.cpl);
  const sujeito = nome ? nome : "No total, nossos clientes";
  let base: string | null = null;
  if (metric === "leads" && leads !== null) base = nome ? `${sujeito} teve ${leads} ${leads===1?"lead":"leads"} ${label}.` : `${sujeito} geraram ${leads} ${leads===1?"lead":"leads"} ${label}.`;
  if (metric === "spend" && spend !== null) base = `${sujeito} ${nome?"gastou":"gastaram"} ${moeda(spend)} ${label}.`;
  if (metric === "cpl" && cpl !== null) base = `O CPL ${nome?`de ${nome}`:"geral"} ${label} foi ${moeda(cpl)}.`;
  if (!base) return null;
  if (d?.complete === false && d?.available_until) base += ` O período ainda não está totalmente consolidado; os snapshots disponíveis vão até ${String(d.available_until).split('-').reverse().join('/')}.`;
  return base;
}

export async function tentarFastPath(params: {
  message: string;
  conversationId: string | null;
  explicitClient: ClientePermitido | null;
  clients: ClientePermitido[];
  jwt: string;
  env: EnvJarvis;
  scopeKey: string;
  catalogo: FerramentaJarvis[];
  canal: CanalSse | null;
}): Promise<ResultadoFast | null> {
  const { message, conversationId, explicitClient, clients, jwt, env, scopeKey, catalogo, canal } = params;
  const mensagemNormalizada = normalizarTranscricaoOperacional(message);
  const q = norm(mensagemNormalizada);
  const chamadas: ChamadaFast[] = [];
  const memoria = await carregarMemoriaRapida(conversationId, env, scopeKey);
  const porNome = new Map(catalogo.map((f) => [f.name, f]));
  const janelaExplicita = detectarJanelaMidia(mensagemNormalizada);
  const escopoGlobal = detectarEscopoGlobal(mensagemNormalizada);
  const metricAtual = metricDaMensagem(q);

  if (escopoGlobal && ["leads","spend","cpl"].includes(String(metricAtual)) && janelaExplicita) {
    const faixa = intervaloDaJanela(janelaExplicita);
    if (faixa) {
      const snap = await carregarMidiaPeriodo(null, faixa.since, faixa.until, jwt, env, scopeKey).catch(() => null);
      const resposta = snap?.ok ? respostaPeriodo(null, String(metricAtual), faixa.label, snap) : null;
      if (resposta) {
        const memory = { metric: String(metricAtual), period: janelaExplicita.kind, period_days: janelaExplicita.days, client_id: null, client_name: null, topic: "media_global", answer_kind: "metric" as const };
        await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
        return { resposta, chamadas, memory, source: "snapshot:media_period_global" };
      }
    }
  }

  // Consultas operacionais previsiveis passam por um planner deterministico.
  // Ele suporta filtros compostos e conserva o conjunto anterior para follow-ups
  // como "e desses, quais estao sem campanha?" sem depender do LLM.
  const canonica = executarConsultaCanonica({ message: mensagemNormalizada, clients, memoria, explicitClient });
  if (canonica) {
    await salvarMemoriaRapida(conversationId, canonica.memory, env, scopeKey);
    return { resposta: canonica.resposta, chamadas, memory: canonica.memory, source: canonica.source };
  }

  // Continuação de uma ação de LEITURA oferecida no turno anterior. Isso é
  // separado de confirmação de escrita: ações mutáveis continuam passando pelo gate /confirm.
  if (confirmacaoDeLeitura(message) && memoria?.offered_action === "list_portfolio" && memoria.person) {
    const lista = listarClientesAtivosPorResponsavel(clients, memoria.person).map((c) => c.display_name).filter(Boolean).sort((a,b) => a.localeCompare(b, "pt-BR"));
    if (lista.length) {
      const resposta = `Os ${lista.length} clientes ativos de ${memoria.person} são: ${lista.join(", ")}.`;
      const memory = { metric: "portfolio_active", period: "current" as const, person: memoria.person, topic: "portfolio", answer_kind: "list" as const, offered_action: null };
      await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
      return { resposta, chamadas, memory, source: "snapshot:portfolio_list_followup" };
    }
  }

  if (confirmacaoDeLeitura(message) && (memoria?.offered_action === "list_onboarding" || memoria?.offered_action === "list_lifecycle") && memoria?.lifecycle) {
    const estado = await carregarEstadoLifecycle(memoria.lifecycle, jwt, env, scopeKey);
    if (estado) {
      const lista = estado.clients.map((c) => c.display_name).filter(Boolean).sort((a,b) => a.localeCompare(b, "pt-BR"));
      const rotulo = memoria.lifecycle === "ONBOARDING" ? "em onboarding" : memoria.lifecycle === "ACTIVE" ? "ativos" : memoria.lifecycle === "CHURNED" ? "com churn" : "prospects";
      const resposta = lista.length ? `${lista.length} clientes ${rotulo}: ${lista.join(", ")}.` : `Não há clientes ${rotulo} no momento.`;
      const memory = { metric: `lifecycle_${memoria.lifecycle.toLowerCase()}`, period: "current" as const, topic: `lifecycle:${memoria.lifecycle.toLowerCase()}`, answer_kind: "list" as const, offered_action: null, lifecycle: memoria.lifecycle };
      await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
      return { resposta, chamadas, memory, source: "snapshot:lifecycle_list_followup" };
    }
  }

  const consultaClientes = detectarConsultaClientesOperacionais(message);
  if (consultaClientes && !explicitClient) {
    const viva = clients.filter((c) => ehAtivoOperacional(c.lifecycle));
    const quebraViva = repartirPorEstagio(clients);
    const op = viva.length ? null : await carregarEstadoOperacao(jwt, env, scopeKey);
    const emOperacao = viva.length ? quebraViva.emOperacao : Number(op?.active_clients ?? 0);
    const emOnboarding = viva.length ? quebraViva.onboarding : Number(op?.onboarding_clients ?? 0);
    const total = emOperacao + emOnboarding;
    const nomes = viva.map((c) => c.display_name).filter(Boolean).sort((x,y) => x.localeCompare(y, "pt-BR"));
    const resposta = consultaClientes === "list"
      ? (nomes.length ? `${nomes.length} clientes hoje: ${nomes.join(", ")}.` : "Não consegui consultar a carteira operacional agora.")
      : `Temos ${total} ${total === 1 ? "cliente" : "clientes"} hoje: ${emOperacao} em operação e ${emOnboarding} em onboarding.`;
    const memory = { metric: "active_clients", period: "current" as const, topic: "active_clients", answer_kind: consultaClientes, offered_action: null };
    await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
    return { resposta, chamadas, memory, source: "snapshot:operational_clients" };
  }

  const consultaLifecycle = detectarConsultaLifecycle(message);
  if (consultaLifecycle && !explicitClient) {
    const estado = await carregarEstadoLifecycle(consultaLifecycle.lifecycle, jwt, env, scopeKey);
    if (!estado) {
      const memory = { metric: `lifecycle_${consultaLifecycle.lifecycle.toLowerCase()}`, period: "current" as const, topic: `lifecycle:${consultaLifecycle.lifecycle.toLowerCase()}`, answer_kind: consultaLifecycle.kind, offered_action: null, lifecycle: consultaLifecycle.lifecycle };
      return { resposta: "Não consegui consultar o cadastro operacional canônico agora. Prefiro não te passar um número possivelmente errado.", chamadas, memory, source: "snapshot:lifecycle_unavailable" };
    }
    {
      const nomes = estado.clients.map((c) => c.display_name).filter(Boolean).sort((a,b) => a.localeCompare(b, "pt-BR"));
      const rotulo = consultaLifecycle.lifecycle === "ONBOARDING" ? "em onboarding" : consultaLifecycle.lifecycle === "ACTIVE" ? "ativos" : consultaLifecycle.lifecycle === "CHURNED" ? "com churn" : "prospects";
      const metric = `lifecycle_${consultaLifecycle.lifecycle.toLowerCase()}`;
      const topic = `lifecycle:${consultaLifecycle.lifecycle.toLowerCase()}`;
      const resposta = consultaLifecycle.kind === "list"
        ? (nomes.length ? `${estado.count} clientes ${rotulo}: ${nomes.join(", ")}.` : `Não há clientes ${rotulo} no momento.`)
        : `${estado.count} ${estado.count === 1 ? "cliente" : "clientes"} ${rotulo} hoje.${estado.count ? " Se quiser, eu mando os nomes." : ""}`;
      const memory = { metric, period: "current" as const, topic, answer_kind: consultaLifecycle.kind, offered_action: consultaLifecycle.kind === "count" && estado.count ? "list_lifecycle" as const : null, lifecycle: consultaLifecycle.lifecycle };
      await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
      return { resposta, chamadas, memory, source: "snapshot:lifecycle" };
    }
  }

  if (/\bquantos?\s+clientes?\s+ativos?\b/.test(q) && !explicitClient) {
    const op = await carregarEstadoOperacao(jwt, env, scopeKey);
    if (!op) return null;
    // ATIVO OPERACIONAL = ACTIVE + ONBOARDING. Quem esta em onboarding ja e'
    // cliente e ja consome operacao; responder so o ACTIVE subnotifica a
    // carteira. A quebra vai junto para nao esconder a composicao.
    // A carteira viva (`clients`) e' a fonte preferida: o snapshot
    // jarvis_client_state estava devolvendo onboarding_clients = 0 enquanto a
    // lista viva acertava os clientes em onboarding, e responder pelos dois
    // produzia numeros que se contradiziam na mesma conversa. O snapshot fica
    // como fallback para quando a carteira nao veio.
    const viva = clients.length ? repartirPorEstagio(clients) : null;
    const emOperacao = viva ? viva.emOperacao : Number(op.active_clients ?? 0);
    const emOnboarding = viva ? viva.onboarding : Number(op.onboarding_clients ?? 0);
    const totalOperacional = emOperacao + emOnboarding;
    // A quebra sai SEMPRE que houver total: esconder o Z quando ele e' zero
    // fazia a resposta parecer igual a antiga e escondia de qual fonte o numero
    // veio. Com a quebra visivel, uma divergencia entre fontes aparece na hora.
    const resposta = totalOperacional
      ? `Temos ${totalOperacional} clientes ativos hoje: ${emOperacao} já em operação e ${emOnboarding} ainda em onboarding.`
      : "Não encontrei clientes ativos na base agora.";
    const memory = { metric: "active_clients", period: "current" as const, topic: "active_clients", answer_kind: "count" as const, offered_action: null };
    await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
    return { resposta, chamadas, memory, source: "snapshot:operation" };
  }

  if (perguntaSobreOnboarding(message) && !explicitClient) {
    const lista = clients
      .filter((c) => String(c.lifecycle ?? "").toUpperCase() === "ONBOARDING")
      .map((c) => c.display_name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
    const querLista = /\b(quais|quem|lista|listar|nomes?)\b/.test(q);
    const resposta = querLista
      ? (lista.length ? `Hoje, ${lista.length} clientes estão em onboarding: ${lista.join(", ")}.` : "Hoje não há clientes em onboarding.")
      : `Hoje, ${lista.length} ${lista.length === 1 ? "cliente está" : "clientes estão"} em onboarding.${lista.length ? " Se quiser, eu mando os nomes." : ""}`;
    const memory = { metric: "onboarding_clients", period: "current" as const, topic: "onboarding", answer_kind: querLista ? "list" as const : "count" as const, offered_action: (!querLista && lista.length) ? "list_onboarding" as const : null };
    await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
    return { resposta, chamadas, memory, source: "snapshot:onboarding" };
  }

  const teamRole = q.match(/\bquantos?\s+(gts?|cs|designers?|comerciais?|gestores?)\b/);
  if (teamRole && !explicitClient) {
    const op = await carregarEstadoOperacao(jwt, env, scopeKey);
    if (!op) return null;
    const raw = teamRole[1];
    const role = raw.startsWith("gt") ? "GT" : raw === "cs" ? "CS" : raw.startsWith("design") ? "DESIGN" : raw.startsWith("comerc") ? "COMMERCIAL" : "MGMT";
    const total = Number(op.team_counts?.[role] ?? 0);
    const resposta = `Temos ${total} ${role === "GT" ? "GTs" : role === "CS" ? "CS" : role === "DESIGN" ? "pessoas em Design" : role === "COMMERCIAL" ? "pessoas no Comercial" : "pessoas em Gestão"} ativos.`;
    const memory = { metric: "team_count", period: "current" as const };
    await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
    return { resposta, chamadas, memory, source: "snapshot:operation" };
  }

  // Listagem de carteira: funciona tanto como follow-up ("quais são esses
  // clientes?") quanto direto ("quais são os clientes do Felipe?"). Usa o
  // snapshot de clientes já carregado; não depende do LLM nem de uma tool de
  // equipe trazer a lista detalhada.
  const marcadorLista = (/\b(quais|cite|cita|citar|citasse|lista|listar|nomes?)\b/.test(q) || /\bquem sao\b/.test(q)) &&
    (/\b(clientes?|eles|esses|nomes?)\b/.test(q));
  const termoListaDireta = message.match(/\bclientes?\s+(?:do|da|de)\s+([\p{L}-]+)/iu)?.[1]
    ?? message.match(/\bclientes?\s+(?:que\s+)?(?:o|a)\s+([\p{L}-]+)\s+(?:atende|tem|cuida)/iu)?.[1]
    ?? null;
  const nomesResponsaveis = [...new Set(clients.flatMap((c) => [c.gt_owner, c.cs_owner, c.designer_owner]).filter(Boolean) as string[])];
  const podeHerdarCarteira = memoria?.metric === "portfolio_active" && !temNovoTemaExplicito(q);
  const pessoaLista = termoListaDireta ? resolverNomeUnico(termoListaDireta, nomesResponsaveis)
    : (podeHerdarCarteira ? memoria?.person ?? null : null);
  if (marcadorLista && pessoaLista) {
    const lista = listarClientesAtivosPorResponsavel(clients, pessoaLista)
      .map((c) => c.display_name)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "pt-BR"));
    if (lista.length) {
      const resposta = `Os ${lista.length} clientes ativos de ${pessoaLista} são: ${lista.join(", ")}.`;
      const memory = { metric: "portfolio_active", period: "current" as const, person: pessoaLista, topic: "portfolio", answer_kind: "list" as const, offered_action: null };
      await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
      return { resposta, chamadas, memory, source: "snapshot:portfolio_list" };
    }
  }

  const pessoaCurta = nomeResponsavel(message, q, memoria);
  if (pessoaCurta && (/\bquantos?\b/.test(q) || memoria?.metric === "portfolio_active")) {
    const op = await carregarEstadoOperacao(jwt, env, scopeKey);
    if (!op) return null;
    const nomes = Object.keys(op.owner_active_counts ?? {});
    const pessoa = resolverNomeUnico(pessoaCurta, nomes);
    if (pessoa) {
      const total = Number(op.owner_active_counts?.[pessoa] ?? 0);
      const resposta = `${pessoa} está com ${total} ${total === 1 ? "cliente ativo" : "clientes ativos"}.${total ? " Se quiser, eu mando os nomes." : ""}`;
      const memory = { metric: "portfolio_active", period: "current" as const, person: pessoa, topic: "portfolio", answer_kind: "count" as const, offered_action: total ? "list_portfolio" as const : null };
      await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
      return { resposta, chamadas, memory, source: "snapshot:operation" };
    }
  }
  const soCliente = Boolean(explicitClient) && (() => {
    const curto = norm(mensagemNormalizada);
    const nome = norm(explicitClient?.display_name);
    if (!curto || !nome) return false;
    return curto === nome || (curto.split(" ").length === 1 && nome.split(" ").includes(curto));
  })();
  if (soCliente && explicitClient) {
    const resposta = `Certo. Vou considerar ${explicitClient.display_name}.`;
    const memory = { client_id: explicitClient.client_id, client_name: explicitClient.display_name, metric: null, period: null, period_days: null, topic: "client_focus", answer_kind: "text" as const };
    await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
    return { resposta, chamadas, memory, source: "memory:client_focus" };
  }
  const apenasPeriodo = Boolean(janelaExplicita) && /^(?:e\s+)?(?:(?:hoje|ontem)|(?:nos?\s+)?ultim(?:o|os|a|as)\s+(?:\d{1,3}|tres|sete|quatorze|trinta|noventa)\s+dias?|(?:nas?\s+)?ultim(?:a|as)\s+(?:\d{1,2}|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+semanas?|(?:ultima|ultimos?)\s+semana)\s*[?.!]*$/i.test(q);
  const metric = metricAtual ?? (apenasPeriodo ? memoria?.metric ?? null : null);
  if (!metric || !["leads", "spend", "cpl", "balance", "campaigns", "gt", "cs", "designer"].includes(metric)) return null;

  let cliente = explicitClient;
  if (!cliente && memoria?.client_id) cliente = clients.find((c) => c.client_id === memoria.client_id) ?? null;
  if (!cliente && memoria?.client_name) cliente = clients.find((c) => norm(c.display_name) === norm(memoria.client_name)) ?? null;
  if (!cliente) return null;

  if (["leads","spend","cpl"].includes(metric) && janelaExplicita?.kind === "last_days") {
    const faixa = intervaloDaJanela(janelaExplicita);
    if (faixa) {
      const snap = await carregarMidiaPeriodo(cliente.client_id, faixa.since, faixa.until, jwt, env, scopeKey).catch(() => null);
      if (snap?.ok && snap.complete !== false) {
        const resposta = respostaPeriodo(cliente.display_name, metric, faixa.label, snap);
        if (resposta) {
          const memory = { client_id: cliente.client_id, client_name: cliente.display_name, metric, period: "last_days" as const, period_days: janelaExplicita.days, topic: "media_client", answer_kind: "metric" as const };
          await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
          return { resposta, chamadas, memory, source: "snapshot:media_period_client" };
        }
      }
      const live = await chamarTool("campanhas_cliente", { client_name: cliente.display_name, since: faixa.since, until: faixa.until, lifecycle: "ACTIVE", details: "0" }, porNome, jwt, env, canal, chamadas);
      if (live?.ok) {
        try {
          const d=JSON.parse(live.content);
          if (d?.ok) {
            const resposta=respostaPeriodo(cliente.display_name, metric, faixa.label, { leads:d?.totals?.leads, spend:d?.totals?.spend, cpl:(Number(d?.totals?.leads)>0?Number(d?.totals?.spend)/Number(d?.totals?.leads):null), complete:true });
            if (resposta) {
              const memory = { client_id: cliente.client_id, client_name: cliente.display_name, metric, period: "last_days" as const, period_days: janelaExplicita.days, topic: "media_client", answer_kind: "metric" as const };
              await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
              return { resposta, chamadas, memory, source: "live:media_period_client" };
            }
          }
        } catch {}
      }
      if (snap?.ok) {
        const resposta = respostaPeriodo(cliente.display_name, metric, faixa.label, snap);
        if (resposta) {
          const memory = { client_id: cliente.client_id, client_name: cliente.display_name, metric, period: "last_days" as const, period_days: janelaExplicita.days, topic: "media_client", answer_kind: "metric" as const };
          await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
          return { resposta, chamadas, memory, source: "snapshot:media_period_client_partial" };
        }
      }
    }
  }

  let estado = await carregarEstadoCliente(cliente.client_id, jwt, env, scopeKey);
  if (!estado) return null;
  const period = metric === "balance" || metric === "campaigns" || metric === "gt" || metric === "cs" || metric === "designer"
    ? "current" as const
    : periodoDaMensagem(q, memoria);

  if (metric === "gt" || metric === "cs" || metric === "designer") {
    const dono = metric === "gt" ? estado.gt_owner : metric === "cs" ? estado.cs_owner : estado.designer_owner;
    if (!dono) return null;
    const resposta = metric === "gt"
      ? `O GT de ${estado.display_name} é ${dono}.`
      : metric === "cs" ? `O CS de ${estado.display_name} é ${dono}.`
      : `O designer de ${estado.display_name} é ${dono}.`;
    const memory = { client_id: estado.client_id, client_name: estado.display_name, metric, period };
    await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
    return { resposta, chamadas, memory, source: "snapshot:client" };
  }

  if (metric === "balance" && idadeSegundos(estado.balance_checked_at) <= BALANCE_MAX_AGE &&
      (estado.meta_available_balance !== null || estado.meta_funding_type !== null || Boolean(estado.meta_funding_type_label))) {
    const resposta = respostaSaldoMeta(estado);
    if (resposta) {
      const memory = { client_id: estado.client_id, client_name: estado.display_name, metric, period };
      await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
      return { resposta, chamadas, memory, source: "snapshot:client" };
    }
  }

  if (metric === "campaigns" && estado.active_campaigns !== null && idadeSegundos(estado.media_checked_at) <= CAMPAIGN_MAX_AGE) {
    const total = Number(estado.active_campaigns);
    const resposta = `${estado.display_name} está com ${total} ${total === 1 ? "campanha ativa" : "campanhas ativas"}.`;
    const memory = { client_id: estado.client_id, client_name: estado.display_name, metric, period };
    await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
    return { resposta, chamadas, memory, source: "snapshot:client" };
  }
  if ((metric === "leads" || metric === "spend" || metric === "cpl") && period !== "current") {
    const checked = period === "today" ? estado.today_checked_at : estado.yesterday_checked_at;
    const pronto = period === "today" ? idadeSegundos(checked) <= MEDIA_TODAY_MAX_AGE : Boolean(checked);
    if (pronto) {
      const resposta = respostaMidiaSnapshot(estado, metric, period);
      if (resposta) {
        const memory = { client_id: estado.client_id, client_name: estado.display_name, metric, period };
        await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
        return { resposta, chamadas, memory, source: "snapshot:client" };
      }
    }
  }

  if (metric === "balance") {
    const live = await chamarTool("saldo_meta_cliente", { client_name: estado.display_name }, porNome, jwt, env, canal, chamadas);
    if (!live?.ok) return null;
    try {
      const d = JSON.parse(live.content);
      if (!d?.ok) return null;
      estado = await atualizarEstadoClienteCache(estado, {
        meta_available_balance: numero(d?.media?.available_balance),
        meta_balance: numero(d?.media?.balance),
        meta_currency: String(d?.media?.currency ?? estado.meta_currency ?? "BRL"),
        meta_funding_type: numero(d?.media?.funding_type),
        meta_funding_type_label: String(d?.media?.funding_type_label ?? "") || null,
        meta_payment_display: String(d?.media?.payment_display ?? "") || null,
        meta_balance_source: String(d?.media?.balance_source ?? "") || null,
        balance_run_status: String(d?.media?.run_status ?? estado.balance_run_status ?? "") || null,
        balance_checked_at: String(d?.media?.checked_at ?? d?.source_updated_at ?? new Date().toISOString()),
        live_source: "META_BALANCE_SYNC",
      }, env, scopeKey, 300);
      const resposta = respostaSaldoMeta(estado);
      if (!resposta) return null;
      const memory = { client_id: estado.client_id, client_name: estado.display_name, metric, period };
      await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
      return { resposta, chamadas, memory, source: "live:balance" };
    } catch { return null; }
  }

  const offset = period === "yesterday" ? -1 : 0;
  const dia = dataOperacional(offset);

  // Primeiro usa o snapshot diario canonico do banco. Para ontem ele e final e
  // evita uma chamada Meta desnecessaria; para hoje so vale se estiver recente.
  if ((metric === "leads" || metric === "spend" || metric === "cpl") && period !== "current") {
    const snap = await carregarMidiaClienteDia(estado.client_id, dia, jwt, env).catch(() => null);
    const snapValido = Boolean(snap?.ok && snap?.checked_at && (period === "yesterday" || idadeSegundos(snap.checked_at) <= 600));
    if (snapValido) {
      const leads = numero(snap?.leads);
      const spend = numero(snap?.spend);
      const cpl = numero(snap?.cpl) ?? (leads !== null && leads > 0 && spend !== null ? spend / leads : null);
      const checkedAt = String(snap?.checked_at ?? new Date().toISOString());
      const patch: Partial<EstadoCliente> = period === "yesterday"
        ? { leads_yesterday: leads, spend_yesterday: spend, cpl_yesterday: cpl, yesterday_checked_at: checkedAt, live_source: "META_CAMPAIGN_INSIGHTS" }
        : { leads_today: leads, spend_today: spend, cpl_today: cpl, today_checked_at: checkedAt, live_source: "META_CAMPAIGN_INSIGHTS" };
      estado = await atualizarEstadoClienteCache(estado, patch, env, scopeKey, period === "yesterday" ? 1800 : 120);
      const resposta = respostaMidiaSnapshot(estado, metric, period);
      if (resposta) {
        const memory = { client_id: estado.client_id, client_name: estado.display_name, metric, period };
        await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
        return { resposta, chamadas, memory, source: "snapshot:media_day" };
      }
    }
  }

  const live = await chamarTool("campanhas_cliente", {
    client_name: estado.display_name, since: dia, until: dia, lifecycle: "ACTIVE", details: "0",
  }, porNome, jwt, env, canal, chamadas);
  if (!live?.ok) return null;

  try {
    const d = JSON.parse(live.content);
    if (!d?.ok) return null;
    const leads = numero(d?.totals?.leads);
    const spend = numero(d?.totals?.spend);
    const active = numero(d?.totals?.active_campaigns);
    const cpl = leads !== null && leads > 0 && spend !== null ? spend / leads : null;
    const checkedAt = String(d?.source_updated_at ?? new Date().toISOString());
    const patch: Partial<EstadoCliente> = period === "yesterday"
      ? { leads_yesterday: leads, spend_yesterday: spend, cpl_yesterday: cpl, yesterday_checked_at: checkedAt, live_source: "META_MARKETING_API" }
      : { leads_today: leads, spend_today: spend, cpl_today: cpl, today_checked_at: checkedAt, live_source: "META_MARKETING_API" };
    if (active !== null) { patch.active_campaigns = active; patch.media_checked_at = checkedAt; }
    estado = await atualizarEstadoClienteCache(estado, patch, env, scopeKey, period === "yesterday" ? 1800 : 120);

    let resposta: string | null = null;
    if (metric === "campaigns" && active !== null) resposta = `${estado.display_name} está com ${active} ${active === 1 ? "campanha ativa" : "campanhas ativas"}.`;
    else if (period !== "current") resposta = respostaMidiaSnapshot(estado, metric, period);
    if (!resposta) return null;
    const memory = { client_id: estado.client_id, client_name: estado.display_name, metric, period };
    await salvarMemoriaRapida(conversationId, memory, env, scopeKey);
    return { resposta, chamadas, memory, source: "live:campaigns" };
  } catch { return null; }
}
