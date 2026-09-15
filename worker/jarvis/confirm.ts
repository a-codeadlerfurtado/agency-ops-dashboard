/**
 * Resolucao de acoes pendentes.
 *
 * A pendencia expira em 15 minutos de proposito. "Sim" dito meia hora depois,
 * numa conversa que ja virou outra, nao pode executar o que foi proposto la
 * atras -- e exatamente assim que um assistente de voz cria uma task fantasma.
 */

import { executarFerramenta, type EnvJarvis, type FerramentaJarvis } from "./tools";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const VALIDADE_MS = 15 * 60_000;

async function rest(caminho: string, jwt: string, env: EnvJarvis, init?: RequestInit): Promise<Response> {
  return fetch(`${SUPABASE}/rest/v1/${caminho}`, {
    ...init,
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: env.SUPABASE_ANON_KEY ?? "",
      "content-type": "application/json",
      "accept-profile": "agency_ops",
      "content-profile": "agency_ops",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
}

export type Resolucao = { ok: boolean; summary: string; result_text: string };

export async function resolverPendencia(
  actionId: string,
  decisao: "confirm" | "cancel",
  jwt: string,
  env: EnvJarvis,
): Promise<Resolucao> {
  // A RLS ja limita ao dono; o filtro por status evita reexecutar o que ja rodou.
  const busca = await rest(
    `jarvis_pending_actions?select=*&id=eq.${encodeURIComponent(actionId)}&status=eq.PENDING&limit=1`,
    jwt, env,
  ).catch(() => null);
  if (!busca?.ok) return { ok: false, summary: "", result_text: "Não encontrei essa ação." };

  const linhas = (await busca.json().catch(() => [])) as any[];
  const pendencia = linhas?.[0];
  if (!pendencia) return { ok: false, summary: "", result_text: "Essa ação já foi resolvida ou expirou." };

  if (Date.now() - new Date(pendencia.created_at).getTime() > VALIDADE_MS) {
    await marcar(actionId, "CANCELLED", { motivo: "expirou" }, jwt, env);
    return { ok: false, summary: pendencia.summary, result_text: "Essa ação expirou. Peça de novo, se ainda vale." };
  }

  if (decisao === "cancel") {
    await marcar(actionId, "CANCELLED", null, jwt, env);
    return { ok: true, summary: pendencia.summary, result_text: "Cancelado." };
  }

  const cat = await rest(
    `jarvis_tools?select=*&name=eq.${encodeURIComponent(pendencia.tool_name)}&limit=1`, jwt, env,
  ).catch(() => null);
  const ferramentas = cat?.ok ? ((await cat.json().catch(() => [])) as FerramentaJarvis[]) : [];
  const ferramenta = ferramentas?.[0];
  if (!ferramenta) {
    await marcar(actionId, "FAILED", { motivo: "ferramenta ausente" }, jwt, env);
    return { ok: false, summary: pendencia.summary, result_text: "Essa ferramenta não está mais disponível." };
  }

  const r = await executarFerramenta(ferramenta, pendencia.arguments ?? {}, jwt, env);
  await marcar(actionId, r.ok ? "EXECUTED" : "FAILED", { status: r.status, content: r.content.slice(0, 1000) }, jwt, env);

  return {
    ok: r.ok,
    summary: pendencia.summary,
    result_text: r.ok ? "Feito." : `Não deu certo: ${r.status}.`,
  };
}

async function marcar(
  id: string, status: string, resultado: unknown, jwt: string, env: EnvJarvis,
): Promise<void> {
  await rest(`jarvis_pending_actions?id=eq.${encodeURIComponent(id)}`, jwt, env, {
    method: "PATCH",
    body: JSON.stringify({ status, result: resultado, resolved_at: new Date().toISOString() }),
  }).catch(() => null);
}
