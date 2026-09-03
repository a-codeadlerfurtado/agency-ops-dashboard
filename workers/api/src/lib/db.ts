/**
 * Acesso ao Postgres via PostgREST, sem supabase-js.
 *
 * Motivo: o worker so precisa chamar RPC. Carregar o SDK inteiro custaria
 * ~40kB de bundle e tempo de cold start em toda requisicao de ingestao, para
 * usar 1% dele. `fetch` resolve.
 *
 * Aqui usamos service role, que ignora RLS. Por isso NENHUMA funcao chamada
 * daqui aceita tenant_id vindo do request: o tenant e sempre derivado de uma
 * credencial (ingest_sources) ou do proprio registro no banco.
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  AGENCY_BRIDGE_TOKEN?: string;
  AMBIENTE: string;
  SLA: Workflow;
}

export class ErroDeBanco extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codigo?: string
  ) {
    super(message);
    this.name = "ErroDeBanco";
  }
}

export async function rpc<T>(
  env: Env,
  funcao: string,
  args: Record<string, unknown>
): Promise<T> {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${funcao}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Profile": "imobi_board",
      "Accept-Profile": "imobi_board",
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify(args),
  });

  const texto = await r.text();

  if (!r.ok) {
    let mensagem = texto;
    let codigo: string | undefined;
    try {
      const j = JSON.parse(texto) as { message?: string; code?: string };
      mensagem = j.message ?? texto;
      codigo = j.code;
    } catch {
      /* resposta nao-JSON: fica o texto cru mesmo */
    }
    throw new ErroDeBanco(mensagem, r.status, codigo);
  }

  return (texto ? JSON.parse(texto) : null) as T;
}

/** sha256 em hex - mesmo formato guardado em ingest_sources.token_sha256. */
export async function sha256Hex(valor: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(valor));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
