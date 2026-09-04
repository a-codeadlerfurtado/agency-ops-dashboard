import { describe, expect, it } from "vitest";
import { mapAsaasPaymentToCharge } from "../../supabase/functions/_shared/billing/charge-mapper.ts";
import { derivePaymentStatus } from "../../supabase/functions/_shared/billing/payment-status.ts";
import type { AsaasPayment, ChargeSnapshot } from "../../supabase/functions/_shared/billing/types.ts";

/**
 * A juncao entre o mapper e o derivador so acontece dentro da edge function,
 * que fica fora do tsconfig e fora do alcance do vitest. Aqui a saida do
 * mapper entra no derivador exatamente como entra em producao: cada linha
 * mapeada vira o ChargeSnapshot lido de volta de billing_charges.
 */
const HOJE = "2026-09-10";

function derivar(payloads: AsaasPayment[], clientId: string | null = "c1") {
  const snapshots: ChargeSnapshot[] = payloads.map((payload) => {
    const row = mapAsaasPaymentToCharge(payload, clientId);
    return { due_date: row.due_date, status: row.status, payment_date: row.payment_date };
  });
  return derivePaymentStatus({ charges: snapshots, today: HOJE });
}

describe("mapper -> derivePaymentStatus (ponta a ponta)", () => {
  it("historico pago mais mensalidade futura resulta em CURRENT", () => {
    const result = derivar([
      {
        id: "pay_ago",
        customer: "cus_1",
        subscription: "sub_1",
        value: 1500,
        dueDate: "2026-08-05",
        status: "RECEIVED",
        billingType: "PIX",
        paymentDate: "2026-08-04",
        description: "Mensalidade agosto",
      },
      {
        id: "pay_set",
        customer: "cus_1",
        subscription: "sub_1",
        value: 1500,
        dueDate: "2026-09-25",
        status: "PENDING",
        billingType: "BOLETO",
        description: "Mensalidade setembro",
      },
    ]);
    expect(result.payment_status).toBe("CURRENT");
    expect(result.overdue_since).toBeNull();
    expect(result.next_due_date).toBe("2026-09-25");
    expect(result.last_payment_at).toBe("2026-08-04");
    expect(result.days_late).toBe(0);
  });

  it("mensalidade vencida ha muito tempo chega ao derivador como DELINQUENT", () => {
    const result = derivar([
      {
        id: "pay_jul",
        customer: "cus_2",
        subscription: "sub_2",
        value: "980.00",
        dueDate: "2026-07-05",
        status: "OVERDUE",
        billingType: "BOLETO",
        description: "Mensalidade julho",
      },
      {
        id: "pay_ago",
        customer: "cus_2",
        subscription: "sub_2",
        value: "980.00",
        dueDate: "2026-08-05",
        status: "OVERDUE",
        billingType: "BOLETO",
        description: "Mensalidade agosto",
      },
    ]);
    expect(result.payment_status).toBe("DELINQUENT");
    expect(result.overdue_since).toBe("2026-07-05");
    expect(result.days_late).toBe(67);
    expect(result.last_payment_at).toBeNull();
  });

  it("confirmedDate mapeado vira o last_payment_at do derivador", () => {
    const result = derivar([
      {
        id: "pay_impl",
        customer: "cus_3",
        value: 3000,
        dueDate: "2026-08-20",
        status: "CONFIRMED",
        paymentDate: null,
        clientPaymentDate: null,
        confirmedDate: "2026-08-19",
        description: "Implantacao",
      },
      {
        id: "pay_prox",
        customer: "cus_3",
        subscription: "sub_3",
        value: 1200,
        dueDate: "2026-09-12",
        status: "PENDING",
        description: "Mensalidade setembro",
      },
    ]);
    expect(result.payment_status).toBe("DUE_SOON");
    expect(result.last_payment_at).toBe("2026-08-19");
    expect(result.next_due_date).toBe("2026-09-12");
  });

  it("cobranca ingerida antes do elo mantem o customer e ainda deriva o status", () => {
    const payload: AsaasPayment = {
      id: "pay_orfa",
      customer: "cus_9",
      subscription: "sub_9",
      value: 890,
      dueDate: "2026-08-01",
      status: "OVERDUE",
      description: "Mensalidade agosto",
    };
    const row = mapAsaasPaymentToCharge(payload, null);
    expect(row.client_id).toBeNull();
    expect(row.asaas_customer_id).toBe("cus_9");

    const result = derivePaymentStatus({
      charges: [{ due_date: row.due_date, status: row.status, payment_date: row.payment_date }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DELINQUENT");
    expect(result.overdue_since).toBe("2026-08-01");
  });
});
