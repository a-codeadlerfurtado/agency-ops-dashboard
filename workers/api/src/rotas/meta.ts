import { rpc, type Env } from "../lib/db";

/**
 * Webhook de Lead Ads da Meta.
 *
 * O ponto que costuma pegar quem monta essa integracao pela primeira vez: o
 * webhook NAO entrega o lead. Ele entrega um aviso com `leadgen_id`. Nome,
 * telefone e e-mail so existem depois de uma chamada a Graph API usando um
 * token de pagina. Sem esse token a integracao recebe tudo e nao consegue
 * montar nenhum lead -- por isso a tela de integracoes cobra o token e marca
 * a conexao como incompleta enquanto ele nao estiver la.
 *
 * Formato do aviso:
 *   { object: "page", entry: [ { id, time, changes: [
 *       { field: "leadgen", value: { leadgen_id, page_id, form_id, ad_id, ... } }
 *   ] } ] }
 */

// v26.0: mesma versao em que o webhook do app foi assinado. Manter as duas
// pontas na mesma versao evita diferenca de formato de payload entre elas.
const GRAPH = "https://graph.facebook.com/v26.0";

const CAMPOS = [
  "id", "created_time", "form_id",
  "ad_id", "ad_name", "adset_id", "adset_name", "campaign_id", "campaign_name",
  "field_data",
].join(",");

interface Aviso {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  ad_id?: string;
}

/** Reconhece o envelope da Meta. Payload achatado (teste, Zapier) devolve null. */
export function avisosDeLead(corpo: unknown): Aviso[] | null {
  const c = corpo as { object?: string; entry?: unknown[] };
  if (c?.object !== "page" || !Array.isArray(c.entry)) return null;

  const avisos: Aviso[] = [];
  for (const e of c.entry as { changes?: unknown[] }[]) {
    if (!Array.isArray(e?.changes)) continue;
    for (const ch of e.changes as { field?: string; value?: Aviso }[]) {
      if (ch?.field === "leadgen" && ch.value?.leadgen_id) avisos.push(ch.value);
    }
  }
  return avisos;
}

/**
 * Troca o aviso pelo lead de verdade.
 *
 * Devolve o objeto no formato que o adaptador da Meta ja sabe ler, entao o
 * nucleo da ingestao nao muda. Devolve null quando nao da para completar --
 * e o chamador decide se registra o erro ou apenas ignora.
 */
export async function buscarLead(
  aviso: Aviso,
  tokenDaPagina: string
): Promise<Record<string, unknown> | null> {
  const url = `${GRAPH}/${encodeURIComponent(aviso.leadgen_id!)}` +
    `?fields=${CAMPOS}&access_token=${encodeURIComponent(tokenDaPagina)}`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const corpo = (await r.json().catch(() => null)) as Record<string, unknown> | null;

  if (!r.ok || !corpo) {
    const erro = (corpo?.error as { message?: string } | undefined)?.message;
    throw new Error(erro ?? `Graph respondeu ${r.status}`);
  }

  // o id do formulario as vezes so vem no aviso; o adaptador le os dois
  return {
    ...corpo,
    leadgen_id: aviso.leadgen_id,
    form_id: corpo.form_id ?? aviso.form_id,
    page_id: aviso.page_id,
  };
}

export async function tokenDaPagina(env: Env, tokenSha: string): Promise<string | null> {
  return rpc<string | null>(env, "token_da_pagina", { p_token_sha256: tokenSha });
}

/** Deixa o erro visivel na tela de integracoes em vez de so no log. */
export async function anotarErro(env: Env, tokenSha: string, erro: string): Promise<void> {
  try {
    await rpc(env, "registrar_erro_de_fonte", { p_token_sha256: tokenSha, p_erro: erro });
  } catch {
    /* diagnostico nao pode derrubar a ingestao */
  }
}
