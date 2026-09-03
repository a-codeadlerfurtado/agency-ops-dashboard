import { rpc, sha256Hex, ErroDeBanco, type Env } from "../lib/db";
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

/** Formulario proprio / landing page / integracao generica. */
const adaptadorWebhook: Adaptador = (corpo) => {
  const c = corpo as Record<string, unknown>;
  return {
    nome: texto(c.nome ?? c.name ?? c.full_name) ?? "Sem nome",
    telefone: texto(c.telefone ?? c.phone ?? c.whatsapp),
    email: texto(c.email),
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

const ADAPTADORES: Record<string, Adaptador> = {
  meta: adaptadorMeta,
  "meta-ads": adaptadorMeta,
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

  const lead = adaptador(corpo);
  if (!lead.telefone && !lead.email) {
    return json({ erro: "Lead sem telefone e sem e-mail: nao da para atender." }, 422);
  }

  let r: RespostaIngestao;
  try {
    r = await rpc<RespostaIngestao>(env, "ingerir_lead", {
      p_token_sha256: await sha256Hex(token),
      p_full_name: lead.nome,
      p_phone: lead.telefone ?? null,
      p_email: lead.email ?? null,
      p_attribution: limpar(lead.atribuicao),
      p_external_event_id: lead.eventoExterno ?? null,
    });
  } catch (e) {
    if (e instanceof ErroDeBanco && e.codigo === "42501") {
      return json({ erro: "Credencial de ingestao invalida." }, 401);
    }
    console.error(JSON.stringify({
      evento: "ingest.falhou", integracao,
      erro: e instanceof Error ? e.message : String(e),
    }));
    return json({ erro: "Nao foi possivel registrar o lead." }, 502);
  }

  // Lead distribuido: abre o Workflow que vai cobrar o aceite. O id da
  // instancia e derivado do assignment, entao uma reentrega do webhook nao
  // cria dois relogios para o mesmo lead.
  if (!r.duplicado && r.assignment_id && r.sla_segundos) {
    try {
      await env.SLA.create({
        id: `assignment-${r.assignment_id}`,
        params: {
          assignmentId: r.assignment_id,
          segundos: r.sla_segundos,
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

  return json(
    { ok: true, duplicado: r.duplicado, opportunity_id: r.opportunity_id },
    r.duplicado ? 200 : 201
  );
}

function tokenDoRequest(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-imobi-token");
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
