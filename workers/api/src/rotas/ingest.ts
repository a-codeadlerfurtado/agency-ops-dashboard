import { rpc, sha256Hex, ErroDeBanco, type Env } from "../lib/db";
import { anotarErro, avisosDeLead, buscarLead, tokenDaPagina } from "./meta";
import { fonteDaPagina } from "./meta-oauth";
import type { ParametrosSla } from "../sla-workflow";

export interface LeadNormalizado {
  nome: string;
  telefone?: string;
  email?: string;
  atribuicao: Record<string, string | undefined>;
  eventoExterno?: string;
}

/* ======================================================== adaptadores ===
   Cada integracao so precisa saber traduzir o payload dela para
   LeadNormalizado. O nucleo da ingestao nao muda quando entra uma origem nova
   - e o que permite a Meta ficar para o fim sem travar o resto (spec 53). */

type Adaptador = (corpo: unknown) => LeadNormalizado;

const texto = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
  return s === "" ? undefined : s;
};

/**
 * Formulario proprio / landing page / integracao generica.
 *
 * A lista de apelidos e larga de proposito. Quem chega aqui normalmente e um
 * repassador -- Zapier, Make, n8n, ou outro CRM com saida de lead -- e esses
 * costumam repassar o campo com o nome ORIGINAL da Meta (`full_name`,
 * `phone_number`), nao com o nosso. Aceitar so `telefone` fazia o lead ser
 * recusado com 422 por diferenca de nome de campo, que e o pior tipo de falha:
 * silenciosa do lado de quem manda.
 */
const adaptadorWebhook: Adaptador = (corpo) => {
  const c = corpo as Record<string, unknown>;
  return {
    nome: texto(c.nome ?? c.name ?? c.full_name ?? c.nome_completo) ?? "Sem nome",
    telefone: texto(
      c.telefone ?? c.phone ?? c.whatsapp ?? c.phone_number ?? c.celular ?? c.tel
    ),
    email: texto(c.email ?? c.e_mail ?? c.email_address),
    atribuicao: {
      utm_source: texto(c.utm_source),
      utm_medium: texto(c.utm_medium),
      utm_campaign: texto(c.utm_campaign),
      utm_content: texto(c.utm_content),
      utm_term: texto(c.utm_term),
    },
    eventoExterno: texto(c.event_id ?? c.id),
  };
};

/**
 * Meta Lead Ads. O formato real vem como lista de {name, values}; aceitamos
 * tambem o formato ja achatado, que e o que os fixtures de teste usam.
 */
const adaptadorMeta: Adaptador = (corpo) => {
  const c = corpo as Record<string, unknown>;
  const campos: Record<string, string> = {};

  const brutos = c.field_data ?? c.fields;
  if (Array.isArray(brutos)) {
    for (const f of brutos as { name?: string; values?: unknown[] }[]) {
      if (f?.name) campos[f.name] = texto(f.values?.[0]) ?? "";
    }
  }

  const pegar = (...chaves: string[]) => {
    for (const k of chaves) {
      const v = texto(campos[k]) ?? texto(c[k]);
      if (v) return v;
    }
    return undefined;
  };

  return {
    nome: pegar("full_name", "nome", "name") ?? "Sem nome",
    telefone: pegar("phone_number", "telefone", "phone"),
    email: pegar("email"),
    atribuicao: {
      campaign_id: texto(c.campaign_id),
      campaign_name: texto(c.campaign_name),
      adset_id: texto(c.adset_id),
      adset_name: texto(c.adset_name),
      ad_id: texto(c.ad_id),
      ad_name: texto(c.ad_name),
      form_id: texto(c.form_id),
      platform_lead_id: texto(c.leadgen_id ?? c.lead_id),
    },
    // leadgen_id e o identificador estavel da Meta: e ele que torna o reenvio
    // do mesmo lead inofensivo (spec 64).
    eventoExterno: texto(c.leadgen_id ?? c.lead_id ?? c.event_id),
  };
};

/**
 * Google Ads - formulario de lead (lead form asset).
 *
 * Nao precisa de app nem de OAuth: o Google Ads chama um webhook direto. O
 * payload vem com os campos numa lista `user_column_data`, cada item com
 * `column_id` e `string_value`.
 *
 * A leitura e por `column_id`, nao por `column_name`: o nome vem traduzido
 * para o idioma da conta ("Nome completo", "Full Name"), e casar por texto
 * quebraria conforme o idioma de quem configurou. O nome so serve de reserva,
 * para as perguntas personalizadas, que nao tem id padronizado.
 *
 * O Google nao manda cabecalho de autenticacao. Ele manda `google_key` no
 * corpo, com o valor que o anunciante digitou na tela do Ads -- e por isso a
 * conferencia dela acontece no handler, contra o mesmo token que ja esta na
 * URL.
 */
const adaptadorGoogle: Adaptador = (corpo) => {
  const c = corpo as Record<string, unknown>;
  const colunas = Array.isArray(c.user_column_data)
    ? (c.user_column_data as { column_id?: string; column_name?: string; string_value?: unknown }[])
    : [];

  const porId: Record<string, string> = {};
  const porNome: Record<string, string> = {};
  for (const col of colunas) {
    const v = texto(col?.string_value);
    if (!v) continue;
    if (col.column_id) porId[String(col.column_id).toUpperCase()] = v;
    if (col.column_name) porNome[String(col.column_name).toLowerCase()] = v;
  }

  const pegar = (ids: string[], nomes: string[] = []) => {
    for (const id of ids) if (porId[id]) return porId[id];
    for (const n of nomes) if (porNome[n]) return porNome[n];
    return undefined;
  };

  // o Google separa nome e sobrenome quando a pergunta e essa; juntar aqui
  // evita gravar "Maria" e perder "Silva"
  const nome =
    pegar(["FULL_NAME"], ["nome completo", "full name"]) ??
    ([pegar(["FIRST_NAME"], ["nome"]), pegar(["LAST_NAME"], ["sobrenome"])]
      .filter(Boolean).join(" ").trim() || undefined);

  return {
    nome: nome || "Sem nome",
    telefone: pegar(["PHONE_NUMBER", "WORK_PHONE"], ["telefone", "phone"]),
    email: pegar(["EMAIL", "WORK_EMAIL"], ["e-mail", "email"]),
    atribuicao: {
      utm_source: "google",
      utm_medium: "cpc",
      campaign_id: texto(c.campaign_id),
      adset_id: texto(c.adgroup_id),
      ad_id: texto(c.creative_id),
      form_id: texto(c.form_id),
      gclid: texto(c.gcl_id),
      platform_lead_id: texto(c.lead_id),
    },
    // lead_id e o identificador estavel do Google: e ele que torna o reenvio
    // do mesmo lead inofensivo, como o leadgen_id faz na Meta
    eventoExterno: texto(c.lead_id),
  };
};

const ADAPTADORES: Record<string, Adaptador> = {
  meta: adaptadorMeta,
  "meta-ads": adaptadorMeta,
  google: adaptadorGoogle,
  "google-ads": adaptadorGoogle,
  webhook: adaptadorWebhook,
  site: adaptadorWebhook,
  form: adaptadorWebhook,
};

/* ========================================================== handler === */

interface RespostaIngestao {
  opportunity_id: string;
  contact_id?: string;
  contato_novo?: boolean;
  tenant_id?: string;
  assignment_id?: string | null;
  sla_expira_em?: string | null;
  sla_segundos?: number | null;
  duplicado: boolean;
}

export async function ingerir(
  req: Request,
  env: Env,
  integracao: string
): Promise<Response> {
  const adaptador = ADAPTADORES[integracao.toLowerCase()];
  if (!adaptador) {
    return json({ erro: `Integracao desconhecida: ${integracao}` }, 404);
  }

  const token = tokenDoRequest(req);
  if (!token) {
    return json({ erro: "Credencial de ingestao ausente." }, 401);
  }

  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return json({ erro: "Corpo da requisicao nao e JSON valido." }, 400);
  }

  const tokenSha = await sha256Hex(token);

  // Envelope real da Meta: e um aviso, nao um lead. Precisa buscar na Graph.
  const avisos = avisosDeLead(corpo);
  if (avisos) {
    return ingerirAvisosDaMeta(avisos, env, tokenSha, integracao);
  }

  /* --------------------------------------------- particularidades do Google ---
     Duas coisas que so existem aqui e que, se ignoradas, fazem o Google
     recusar a configuracao ou entregar lead falso no funil. */
  if (integracao.toLowerCase().startsWith("google")) {
    const c = corpo as Record<string, unknown>;

    // 1. A chave. O Google nao manda cabecalho de autenticacao: manda
    //    `google_key` no corpo, com o valor digitado na tela do Ads. Exigir
    //    que seja o mesmo token da URL da uma segunda checagem sem inventar
    //    outro segredo para alguem guardar.
    const chave = typeof c.google_key === "string" ? c.google_key.trim() : "";
    if (chave && chave !== token) {
      return json({ erro: "google_key nao confere com a chave desta conexao." }, 401);
    }

    // 2. O lead de teste. Ao configurar, o Google envia um lead falso e SO
    //    aceita a URL se a resposta for 200. Gravar esse lead sujaria o funil
    //    com "Test Lead" logo na estreia; recusar faria o Google dizer que a
    //    integracao esta quebrada. Responde 200 e nao grava.
    if (c.is_test === true || c.is_test === "true") {
      return json({ ok: true, teste: true, gravado: false }, 200);
    }
  }

  const lead = adaptador(corpo);
  if (!lead.telefone && !lead.email) {
    return json({ erro: "Lead sem telefone e sem e-mail: nao da para atender." }, 422);
  }

  const salvo = await salvarLead(env, tokenSha, lead, integracao);
  if ("erro" in salvo) return json({ erro: salvo.erro }, salvo.status);
  const r = salvo.r;

  return json(
    { ok: true, duplicado: r.duplicado, opportunity_id: r.opportunity_id },
    r.duplicado ? 200 : 201
  );
}

/**
 * Onde a credencial pode vir.
 *
 * Header e o caminho certo e e o que integracao propria deve usar. A query
 * "?k=" existe porque a Meta nao manda header nenhum no webhook: la a URL de
 * callback E a credencial. Por isso ela fica por ultimo -- quem puder mandar
 * header, manda header.
 */
export function tokenDoRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const header = req.headers.get("x-imobi-token");
  if (header) return header;
  const k = new URL(req.url).searchParams.get("k");
  return k && k.trim() !== "" ? k.trim() : null;
}

function limpar(o: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v != null && v !== "")
  ) as Record<string, string>;
}

export function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/* ============================================ nucleo reutilizavel ===
   O mesmo caminho serve para o webhook generico e para cada lead que a Meta
   devolve num aviso. Extrair isto e o que permite processar um lote sem
   duplicar a criacao do Workflow de SLA. */

type Salvo = { r: RespostaIngestao } | { erro: string; status: number };

async function salvarLead(
  env: Env,
  tokenSha: string,
  lead: LeadNormalizado,
  integracao: string
): Promise<Salvo> {
  let r: RespostaIngestao;
  try {
    r = await rpc<RespostaIngestao>(env, "ingerir_lead", {
      p_token_sha256: tokenSha,
      p_full_name: lead.nome,
      p_phone: lead.telefone ?? null,
      p_email: lead.email ?? null,
      p_attribution: limpar(lead.atribuicao),
      p_external_event_id: lead.eventoExterno ?? null,
    });
  } catch (e) {
    if (e instanceof ErroDeBanco && e.codigo === "42501") {
      return { erro: "Credencial de ingestao invalida.", status: 401 };
    }
    console.error(JSON.stringify({
      evento: "ingest.falhou", integracao,
      erro: e instanceof Error ? e.message : String(e),
    }));
    return { erro: "Nao foi possivel registrar o lead.", status: 502 };
  }

  // Lead distribuido: abre o Workflow que vai cobrar o aceite. O id da
  // instancia e derivado do assignment, entao uma reentrega do webhook nao
  // cria dois relogios para o mesmo lead.
  // Com horario de atendimento, o prazo pode vencer em minutos ou so na
  // segunda-feira. Preferimos a DATA e calculamos os segundos aqui; o campo
  // sla_segundos fica de reserva para bancos ainda sem a migration 0019.
  const segundos = r.sla_expira_em
    ? Math.max(Math.ceil((new Date(r.sla_expira_em).getTime() - Date.now()) / 1000), 30)
    : (r.sla_segundos ?? 0);

  if (!r.duplicado && r.assignment_id && segundos > 0) {
    try {
      await env.SLA.create({
        id: "assignment-" + r.assignment_id,
        params: {
          assignmentId: r.assignment_id,
          segundos,
          tentativa: 1,
        } satisfies ParametrosSla,
      });
    } catch (e) {
      // O lead ja esta salvo e atribuido. Falhar o Workflow nao pode devolver
      // erro ao Meta, senao ele reenvia e nos duplicamos trabalho.
      console.error(JSON.stringify({
        evento: "sla.workflow_nao_criado",
        assignment_id: r.assignment_id,
        erro: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  console.log(JSON.stringify({
    evento: r.duplicado ? "ingest.duplicado" : "ingest.criado",
    integracao,
    tenant_id: r.tenant_id,
    opportunity_id: r.opportunity_id,
    contato_novo: r.contato_novo,
  }));

  return { r };
}

/**
 * Lote de avisos da Meta.
 *
 * Sempre responde 200, mesmo quando nao consegue montar nenhum lead. A Meta
 * reenvia o webhook em cima de qualquer status de erro e desativa a inscricao
 * depois de reenviar muito; devolver 500 aqui transformaria uma falha de
 * configuracao (token de pagina faltando) em integracao desligada. O que
 * aconteceu fica no last_error da fonte, que a tela mostra.
 */
async function ingerirAvisosDaMeta(
  avisos: { leadgen_id?: string }[],
  env: Env,
  tokenSha: string,
  integracao: string
): Promise<Response> {
  const pagina = await tokenDaPagina(env, tokenSha).catch(() => null);
  if (!pagina) {
    await anotarErro(env, tokenSha,
      "Chegou aviso de lead da Meta, mas falta o token de pagina para ler os dados.");
    console.warn(JSON.stringify({ evento: "meta.sem_token_de_pagina", avisos: avisos.length }));
    return json({ ok: true, ignorados: avisos.length, motivo: "sem token de pagina" });
  }

  let criados = 0, duplicados = 0, falhas = 0;
  for (const aviso of avisos) {
    try {
      const bruto = await buscarLead(aviso, pagina);
      if (!bruto) { falhas++; continue; }
      const lead = adaptadorMeta(bruto);
      if (!lead.telefone && !lead.email) { falhas++; continue; }

      const salvo = await salvarLead(env, tokenSha, lead, integracao);
      if ("erro" in salvo) { falhas++; continue; }
      if (salvo.r.duplicado) duplicados++; else criados++;
    } catch (e) {
      falhas++;
      await anotarErro(env, tokenSha, e instanceof Error ? e.message : String(e));
      console.error(JSON.stringify({
        evento: "meta.aviso_falhou",
        leadgen_id: aviso.leadgen_id,
        erro: e instanceof Error ? e.message : String(e),
      }));
    }
  }

  return json({ ok: true, criados, duplicados, falhas });
}

/**
 * Webhook do app da Meta (uma URL para todas as imobiliarias).
 *
 * Diferenca para o caminho com ?k=: aqui nao existe credencial na URL. Quem
 * diz de quem e o lead e o page_id que vem dentro do proprio evento -- por
 * isso uma pagina so pode estar ligada a uma conexao (indice unico na 0027).
 *
 * Aviso de pagina que ninguem conectou e ignorado em silencio com 200: a
 * inscricao pode ter sobrado de uma conexao removida, e responder erro faria
 * a Meta reenviar para sempre.
 */
export async function webhookDoApp(req: Request, env: Env): Promise<Response> {
  let corpo: unknown;
  try {
    corpo = await req.json();
  } catch {
    return json({ erro: "Corpo invalido." }, 400);
  }

  const c = corpo as { object?: string; entry?: { id?: string; changes?: unknown[] }[] };
  if (c?.object !== "page" || !Array.isArray(c.entry)) {
    return json({ ok: true, ignorado: "evento sem paginas" });
  }

  let criados = 0, duplicados = 0, falhas = 0, semDestino = 0;

  for (const entrada of c.entry) {
    const avisos = (entrada.changes ?? [])
      .filter((ch): ch is { field: string; value: { leadgen_id?: string; page_id?: string } } => {
        const x = ch as { field?: string; value?: { leadgen_id?: string } };
        return x?.field === "leadgen" && Boolean(x.value?.leadgen_id);
      })
      .map((ch) => ch.value);
    if (avisos.length === 0) continue;

    const pageId = avisos[0]?.page_id ?? entrada.id;
    if (!pageId) { semDestino += avisos.length; continue; }

    const fonte = await fonteDaPagina(env, pageId);
    if (!fonte?.token_sha256) { semDestino += avisos.length; continue; }
    if (!fonte.page_access_token) {
      await anotarErro(env, fonte.token_sha256,
        "Chegou lead da Meta, mas a conexao esta sem token de pagina.");
      falhas += avisos.length;
      continue;
    }

    for (const aviso of avisos) {
      try {
        const bruto = await buscarLead(aviso, fonte.page_access_token);
        if (!bruto) { falhas++; continue; }
        const lead = adaptadorMeta(bruto);
        if (!lead.telefone && !lead.email) { falhas++; continue; }

        const salvo = await salvarLead(env, fonte.token_sha256, lead, "meta");
        if ("erro" in salvo) { falhas++; continue; }
        if (salvo.r.duplicado) duplicados++; else criados++;
      } catch (e) {
        falhas++;
        await anotarErro(env, fonte.token_sha256, e instanceof Error ? e.message : String(e));
      }
    }
  }

  console.log(JSON.stringify({
    evento: "meta.webhook_app", criados, duplicados, falhas, semDestino,
  }));
  // 200 sempre: erro faz a Meta reenviar e acabar desligando a inscricao
  return json({ ok: true, criados, duplicados, falhas, semDestino });
}
