import { classifyChargeKind } from "./charge-kind.ts";
import type { AsaasPayment, BillingChargeRow } from "./types.ts";

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const rendered = String(value).trim();
  return rendered ? rendered : null;
}

function money(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapAsaasPaymentToCharge(
  payment: AsaasPayment,
  clientId: string | null,
): BillingChargeRow {
  const asaas_payment_id = text(payment.id);
  if (!asaas_payment_id) throw new Error("asaas_payment_id ausente no payload");

  const due_date = text(payment.dueDate);
  if (!due_date) throw new Error("due_date ausente no payload");

  const asaas_subscription_id = text(payment.subscription);
  const description = text(payment.description);
  const value = money(payment.value);
  if (value === null) throw new Error("value ausente ou invalido no payload");

  return {
    asaas_payment_id,
    client_id: clientId,
    asaas_subscription_id,
    kind: classifyChargeKind({ subscriptionId: asaas_subscription_id, description }),
    value,
    net_value: money(payment.netValue),
    due_date,
    status: text(payment.status) || "UNKNOWN",
    billing_type: text(payment.billingType),
    payment_date:
      text(payment.paymentDate) || text(payment.clientPaymentDate) || text(payment.confirmedDate),
    invoice_url: text(payment.invoiceUrl),
    bank_slip_url: text(payment.bankSlipUrl),
    description,
    raw: payment,
  };
}
