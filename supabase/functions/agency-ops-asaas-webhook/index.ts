import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { isAuthorizedWebhookToken } from "../_shared/billing/webhook-auth.ts";
import { mapAsaasPaymentToCharge } from "../_shared/billing/charge-mapper.ts";
import { derivePaymentStatus } from "../_shared/billing/payment-status.ts";

/** Data de hoje em America/Sao_Paulo, no formato YYYY-MM-DD. */
function todayInSaoPaulo(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const notFound = () => json({ error: "not_found" }, 404);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return notFound();

  // Token errado ou ausente nao revela que a rota existe.
  if (!isAuthorizedWebhookToken(req.headers.get("asaas-access-token"), Deno.env.get("ASAAS_WEBHOOK_TOKEN"))) {
    return notFound();
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !service) return json({ error: "server_configuration" }, 500);

  const body = await req.json().catch(() => null);
  const eventId = String(body?.id || "").trim();
  const event = String(body?.event || "").trim();
  const payment = body?.payment;
  if (!eventId || !event) return json({ error: "invalid_payload" }, 400);

  const db = createClient(supabaseUrl, service, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ops = db.schema("agency_ops");

  // Grava o bruto primeiro. Conflito no asaas_event_id significa evento ja
  // recebido; se ele ja foi processado, e sucesso e nao erro — mas se ficou
  // pendente, o reenvio precisa reprocessar (ver o tratamento do 23505).
  const { data: stored, error: storeError } = await ops
    .from("billing_webhook_events")
    .insert({ asaas_event_id: eventId, event, payment_id: payment?.id ?? null, payload: body })
    .select("id")
    .maybeSingle();

  // Id da linha do evento: a recem-inserida, ou a ja existente quando o evento
  // reentra pela unicidade de asaas_event_id.
  let eventRowId: number | null = stored?.id ?? null;

  if (storeError) {
    if (storeError.code !== "23505") return json({ error: "store_failed" }, 500);

    // Duplicata nao e necessariamente evento ja resolvido. Quem falhou no
    // processamento respondeu 200 com deferred, entao o Asaas nunca reenvia
    // sozinho; o reenvio manual pelo painel precisa reprocessar em vez de ser
    // descartado. Um PAYMENT_RECEIVED descartado deixa quem pagou marcado
    // inadimplente para sempre.
    const { data: existing, error: existingError } = await ops
      .from("billing_webhook_events")
      .select("id,processed_at")
      .eq("asaas_event_id", eventId)
      .maybeSingle();
    if (existingError || !existing) return json({ error: "store_failed" }, 500);
    if (existing.processed_at) return json({ ok: true, duplicate: true });
    eventRowId = existing.id;
  }

  try {
    if (payment?.id) {
      const { data: link, error: linkError } = await ops
        .from("asaas_customers")
        .select("client_id")
        .eq("asaas_customer_id", String(payment.customer || ""))
        .not("confirmed_at", "is", null)
        .maybeSingle();
      if (linkError) throw new Error(linkError.message);

      const row = mapAsaasPaymentToCharge(payment, link?.client_id ?? null);
      const { error: upsertError } = await ops
        .from("billing_charges")
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "asaas_payment_id" });
      if (upsertError) throw new Error(upsertError.message);

      // A inadimplencia deixa de ser flag marcada a mao: e recalculada aqui,
      // a partir de todas as cobrancas do cliente.
      if (row.client_id) {
        const { data: charges, error: chargesError } = await ops
          .from("billing_charges")
          .select("due_date,status,payment_date")
          .eq("client_id", row.client_id);
        if (chargesError) throw new Error(chargesError.message);

        // Pausa nao entra aqui: vive em operational_status, eixo proprio, e
        // continua sendo decisao humana. A derivacao so olha o pagamento.
        const derived = derivePaymentStatus({
          charges: charges || [],
          today: todayInSaoPaulo(),
        });

        // monthly_value e espelho do termo comercial vigente (spec 4) e e a
        // coluna que a tela de financeiro soma no tile de MRR. Sem espelhar,
        // a tela passaria a mostrar "N clientes, MRR R$ 0".
        const { data: terms, error: termsError } = await ops
          .from("client_commercial_terms")
          .select("monthly_value")
          .eq("client_id", row.client_id)
          .maybeSingle();
        if (termsError) throw new Error(termsError.message);

        const control: Record<string, unknown> = {
          client_id: row.client_id,
          payment_status: derived.payment_status,
          overdue_since: derived.overdue_since,
          next_due_date: derived.next_due_date,
          last_payment_at: derived.last_payment_at,
          updated_by: "SISTEMA",
          updated_at: new Date().toISOString(),
        };
        // Sem termo comercial o campo e OMITIDO: o upsert do PostgREST so
        // atualiza as colunas presentes no objeto, entao omitir preserva o
        // valor ja gravado em vez de sobrescrever com null ou 0.
        if (terms?.monthly_value !== null && terms?.monthly_value !== undefined) {
          control.monthly_value = terms.monthly_value;
        }

        const { error: controlError } = await ops
          .from("client_finance_controls")
          .upsert(control, { onConflict: "client_id" });
        if (controlError) throw new Error(controlError.message);
      }
    }

    await ops.from("billing_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", eventRowId);
    return json({ ok: true });
  } catch (caught) {
    // O evento ja esta persistido: registra a falha e responde 200 para o Asaas
    // nao reenviar. A fila com processed_at nulo e retentada depois.
    await ops
      .from("billing_webhook_events")
      .update({ error: caught instanceof Error ? caught.message : "unknown" })
      .eq("id", eventRowId);
    return json({ ok: true, deferred: true });
  }
});
