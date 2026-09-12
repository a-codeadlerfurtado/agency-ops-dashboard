/**
 * Rondas automaticas.
 *
 * Rodam pelo Cron Trigger do Worker, sem ninguem logado. Aqui esta a UNICA
 * excecao ao principio de "a Jarvis nao tem permissao propria": sem usuario na
 * frente, alguem precisa emprestar identidade. Duas travas compensam isso:
 *
 *   1. so ferramentas de LEITURA entram -- `tools_allowed` da ronda e filtrado
 *      de novo aqui contra `mode = 'read'`, entao nem um catalogo mal semeado
 *      faz uma ronda escrever;
 *   2. exige JARVIS_SERVICE_JWT explicito. Sem o segredo, a ronda nao roda --
 *      preferi falhar visivel a rodar com permissao que ninguem revisou.
 *
 * O resultado vira notificacao em platform_notifications, que e de onde o
 * agency-ops-notifications-home le.
 */

import { rodarAgente, type Identidade } from "./agent";
import type { EnvJarvis } from "./tools";

const SUPABASE = "https://bfzdetibfcwihfkltbkp.supabase.co";
const IDENTIDADE_SERVICO: Identidade = { pessoa: "Jarvis", papel: "MGMT", userId: null };

type Ronda = {
  key: string;
  title: string;
  prompt: string;
  tools_allowed: string[];
  notify_roles: string[];
};

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

export async function rodarRondas(env: EnvJarvis & { JARVIS_SERVICE_JWT?: string }): Promise<Response> {
  const jwt = env.JARVIS_SERVICE_JWT;
  if (!jwt) {
    return Response.json(
      { ok: false, error: "jarvis_service_jwt_ausente", detalhe: "defina o segredo JARVIS_SERVICE_JWT para as rondas rodarem" },
      { status: 503 },
    );
  }

  const busca = await rest("jarvis_routines?select=*&enabled=is.true", jwt, env).catch(() => null);
  if (!busca?.ok) return Response.json({ ok: false, error: "rondas_indisponiveis" }, { status: 502 });
  const rondas = (await busca.json().catch(() => [])) as Ronda[];

  const relatorio: Array<{ key: string; ok: boolean; chamadas: number; erro?: string }> = [];

  for (const ronda of rondas) {
    try {
      const { resposta, chamadas } = await rodarAgente(
        { message: ronda.prompt, voice: false },
        jwt, env, null, IDENTIDADE_SERVICO, ronda.tools_allowed,
      );

      await rest("platform_notifications", jwt, env, {
        method: "POST",
        body: JSON.stringify({
          title: ronda.title,
          body: resposta,
          category: "JARVIS_RONDA",
          severity: "INFO",
          audience_roles: ronda.notify_roles,
          metadata: { routine: ronda.key, tool_calls: chamadas },
        }),
      }).catch(() => null);

      if (env.N8N_JARVIS_WEBHOOK) {
        await fetch(env.N8N_JARVIS_WEBHOOK, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ routine: ronda.key, title: ronda.title, text: resposta }),
          signal: AbortSignal.timeout(8_000),
        }).catch(() => null);
      }

      await rest(`jarvis_routines?key=eq.${encodeURIComponent(ronda.key)}`, jwt, env, {
        method: "PATCH",
        body: JSON.stringify({
          last_run_at: new Date().toISOString(),
          last_result: { ok: true, resposta: resposta.slice(0, 2000), tool_calls: chamadas },
        }),
      }).catch(() => null);

      relatorio.push({ key: ronda.key, ok: true, chamadas: chamadas.length });
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);
      await rest(`jarvis_routines?key=eq.${encodeURIComponent(ronda.key)}`, jwt, env, {
        method: "PATCH",
        body: JSON.stringify({ last_run_at: new Date().toISOString(), last_result: { ok: false, erro: motivo } }),
      }).catch(() => null);
      relatorio.push({ key: ronda.key, ok: false, chamadas: 0, erro: motivo });
    }
  }

  return Response.json({ ok: true, rondas: relatorio });
}
