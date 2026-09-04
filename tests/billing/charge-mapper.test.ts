import { describe, expect, it } from "vitest";
import { mapAsaasPaymentToCharge } from "../../supabase/functions/_shared/billing/charge-mapper.ts";

const PAGAMENTO = {
  id: "pay_123",
  customer: "cus_1",
  subscription: "sub_1",
  value: 1200.5,
  netValue: 1180.2,
  dueDate: "2026-09-10",
  status: "RECEIVED",
  billingType: "BOLETO",
  paymentDate: "2026-09-09",
  invoiceUrl: "https://asaas.com/i/123",
  bankSlipUrl: "https://asaas.com/b/123",
  description: "Mensalidade setembro",
};

describe("mapAsaasPaymentToCharge", () => {
  it("mapeia os campos e classifica como mensalidade", () => {
    const row = mapAsaasPaymentToCharge(PAGAMENTO, "c1");
    expect(row.asaas_payment_id).toBe("pay_123");
    expect(row.client_id).toBe("c1");
    expect(row.asaas_subscription_id).toBe("sub_1");
    expect(row.kind).toBe("MENSALIDADE");
    expect(row.value).toBe(1200.5);
    expect(row.net_value).toBe(1180.2);
    expect(row.due_date).toBe("2026-09-10");
    expect(row.status).toBe("RECEIVED");
    expect(row.payment_date).toBe("2026-09-09");
  });

  it("aceita valor como string, que e o que a API devolve as vezes", () => {
    const row = mapAsaasPaymentToCharge({ ...PAGAMENTO, value: "1200.50", netValue: "1180.20" }, "c1");
    expect(row.value).toBe(1200.5);
    expect(row.net_value).toBe(1180.2);
  });

  it("client_id nulo e permitido: a cobranca chega antes do elo existir", () => {
    expect(mapAsaasPaymentToCharge(PAGAMENTO, null).client_id).toBeNull();
  });

  it("normaliza ausencia para null em vez de string vazia", () => {
    const row = mapAsaasPaymentToCharge(
      { id: "pay_9", dueDate: "2026-09-10", status: "PENDING", value: 100, subscription: "", description: "" },
      null,
    );
    expect(row.asaas_subscription_id).toBeNull();
    expect(row.description).toBeNull();
    expect(row.net_value).toBeNull();
    expect(row.billing_type).toBeNull();
    expect(row.kind).toBe("EXTRA");
  });

  it("usa confirmedDate quando paymentDate nao veio", () => {
    const row = mapAsaasPaymentToCharge(
      { ...PAGAMENTO, paymentDate: null, clientPaymentDate: null, confirmedDate: "2026-09-08" },
      "c1",
    );
    expect(row.payment_date).toBe("2026-09-08");
  });

  it("preserva o payload inteiro em raw", () => {
    expect(mapAsaasPaymentToCharge(PAGAMENTO, "c1").raw).toEqual(PAGAMENTO);
  });

  it("recusa pagamento sem id ou sem vencimento", () => {
    expect(() => mapAsaasPaymentToCharge({ ...PAGAMENTO, id: "" }, "c1")).toThrow("asaas_payment_id");
    expect(() => mapAsaasPaymentToCharge({ ...PAGAMENTO, dueDate: null }, "c1")).toThrow("due_date");
  });
});
