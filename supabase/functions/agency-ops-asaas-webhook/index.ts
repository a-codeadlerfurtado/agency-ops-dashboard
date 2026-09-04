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
  // recebido: e sucesso, nao erro — o Asaas nao deve reenviar.
  const { data: stored, error: storeError } = await ops
    .from("billing_webhook_events")
    .insert({ asaas_event_id: eventId, event, payment_id: payment?.id ?? null, payload: body })
    .select("id")
    .maybeSingle();

  if (storeError) {
    if (storeError.code === "23505") return json({ ok: true, duplicate: true });
    return json({ error: "store_failed" }, 500);
  }

  try {
    if (payment?.id) {
      const { data: link } = await ops
        .from("asaas_customers")
        .select("client_id")
        .eq("asaas_customer_id", String(payment.customer || ""))
        .not("confirmed_at", "is", null)
        .maybeSingle();

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

        const { error: controlError } = await ops.from("client_finance_controls").upsert(
          {
            client_id: row.client_id,
            payment_status: derived.payment_status,
            overdue_since: derived.overdue_since,
            next_due_date: derived.next_due_date,
            last_payment_at: derived.last_payment_at,
            updated_by: "SISTEMA",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "client_id" },
        );
        if (controlError) throw new Error(controlError.message);
      }
    }

    await ops.from("billing_webhook_events").update({ processed_at: new Date().toISOString() }).eq("id", stored?.id);
    return json({ ok: true });
  } catch (caught) {
    // O evento ja esta persistido: registra a falha e responde 200 para o Asaas
    // nao reenviar. A fila com processed_at nulo e retentada depois.
    await ops
      .from("billing_webhook_events")
      .update({ error: caught instanceof Error ? caught.message : "unknown" })
      .eq("id", stored?.id);
    return json({ ok: true, deferred: true });
  }
});
