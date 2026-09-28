// [LEONARDO IMOBI] agency-ops-autentique-backfill
//
// Carga inicial: varre TODOS os documentos ja' existentes na Autentique e
// popula agency_ops.client_contracts.
//
// A regra de ingestao NAO mora aqui: quem grava e'
// agency_ops.ingest_autentique_document(jsonb), a mesma funcao que o webhook
// usa, para as duas portas de entrada nao divergirem.
//
// Disparo e' ADLER ONLY e o token sai do Vault, nunca do codigo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "POST,OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...CORS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});
const notFound = () => json({ error: "not_found" }, 404);

const ENDPOINT = "https://api.autentique.com.br/v2/graphql";
const PAGE_SIZE = 60;
// A Autentique limita a 60 requisicoes por minuto.
const PAUSA_MS = 1100;

const QUERY = `query ($page: Int!, $limit: Int!) {
  documents(page: $page, limit: $limit) {
    total
    data {
      id
      name
      created_at
      updated_at
      expiration_at
      files { original signed }
      signatures { public_id name email created_at signed { created_at } }
    }
  }
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return notFound();

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const db = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  let authorized = false;
  const suppliedSyncSecret = (req.headers.get("x-ops-secret") || "").trim();
  if (suppliedSyncSecret) {
    const { data: secretRow } = await ops.from("automation_settings")
      .select("value").eq("key", "CONTRACT_ENRICH_SECRET").maybeSingle();
    const expectedSyncSecret = typeof secretRow?.value === "string" ? secretRow.value : "";
    if (expectedSyncSecret && suppliedSyncSecret.length === expectedSyncSecret.length) {
      let diff = 0;
      for (let i = 0; i < suppliedSyncSecret.length; i++) diff |= suppliedSyncSecret.charCodeAt(i) ^ expectedSyncSecret.charCodeAt(i);
      authorized = diff === 0;
    }
  }

  if (!authorized) {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return notFound();
    const auth = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
    const { data: userData } = await auth.auth.getUser();
    if (!userData?.user) return notFound();
    const { data: allowed, error: authorizationError } = await ops.rpc("is_contract_viewer", { p_user_key: userData.user.id });
    if (authorizationError || allowed !== true) return notFound();
  }

  const { data: token } = await ops.rpc("get_secret", { p_name: "AUTENTIQUE_API_TOKEN" });
  if (!token) {
    return json({ ok: false, error: "missing_secret",
      detail: "AUTENTIQUE_API_TOKEN ausente no Vault." }, 428);
  }

  const { data: runRow } = await ops.from("autentique_sync_runs")
    .insert({ mode: "BACKFILL", status: "RUNNING", started_at: new Date().toISOString() })
    .select("id").maybeSingle();
  const runId = runRow?.id;

  let page = 1, paginas = 0, recebidos = 0, gravados = 0, total = 0;
  const porStatus: Record<string, number> = {};

  try {
    for (;;) {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: QUERY, variables: { page, limit: PAGE_SIZE } }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.errors) {
        throw new Error(`Autentique ${response.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 400)}`);
      }

      const bloco = body?.data?.documents;
      const documentos: any[] = bloco?.data ?? [];
      total = Number(bloco?.total ?? total);
      paginas++; recebidos += documentos.length;

      for (const documento of documentos) {
        const { data: resultado, error } = await ops.rpc("ingest_autentique_document", { p_doc: documento });
        if (error) throw new Error(`ingest ${documento?.id}: ${error.message}`);
        const linha = Array.isArray(resultado) ? resultado[0] : resultado;
        if (linha?.acao !== "IGNORADO_DESATUALIZADO") gravados++;
        const status = String(linha?.match_status ?? "UNKNOWN");
        porStatus[status] = (porStatus[status] ?? 0) + 1;
      }

      if (documentos.length < PAGE_SIZE) break;
      page++;
      await new Promise((resolve) => setTimeout(resolve, PAUSA_MS));
    }

    if (runId) {
      await ops.from("autentique_sync_runs").update({
        status: "SUCCESS", finished_at: new Date().toISOString(),
        pages_fetched: paginas, documents_received: recebidos, documents_upserted: gravados,
        metadata: { total_reported: total, match_breakdown: porStatus },
      }).eq("id", runId);
    }

    return json({ ok: true, mode: "BACKFILL", pages_fetched: paginas,
      documents_received: recebidos, documents_upserted: gravados,
      total_reported: total, match_breakdown: porStatus });
  } catch (caught) {
    const mensagem = caught instanceof Error ? caught.message : String(caught);
    if (runId) {
      await ops.from("autentique_sync_runs").update({
        status: "ERROR", finished_at: new Date().toISOString(),
        pages_fetched: paginas, documents_received: recebidos, documents_upserted: gravados,
        error: mensagem.slice(0, 1000),
      }).eq("id", runId);
    }
    return json({ ok: false, error: "backfill_failed", detail: mensagem.slice(0, 600) }, 500);
  }
});
