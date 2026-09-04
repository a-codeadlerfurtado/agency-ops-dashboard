import { describe, expect, it } from "vitest";
import { derivePaymentStatus } from "../../supabase/functions/_shared/billing/payment-status.ts";

const HOJE = "2026-09-10";

describe("derivePaymentStatus", () => {
  it("sem cobranca vencida em aberto esta em dia", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-20", status: "PENDING", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("CURRENT");
    expect(result.overdue_since).toBeNull();
    expect(result.next_due_date).toBe("2026-09-20");
    expect(result.days_late).toBe(0);
  });

  it("vencida ha 1 dia esta atrasada", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-09", status: "OVERDUE", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("OVERDUE");
    expect(result.overdue_since).toBe("2026-09-09");
    expect(result.days_late).toBe(1);
  });

  it("vencida ha 4 dias ainda e atraso", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-06", status: "OVERDUE", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("OVERDUE");
    expect(result.days_late).toBe(4);
  });

  it("vencida ha 5 dias e inadimplencia", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-05", status: "OVERDUE", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DELINQUENT");
    expect(result.days_late).toBe(5);
  });

  it("o corte e configuravel", () => {
    const charges = [{ due_date: "2026-09-08", status: "OVERDUE", payment_date: null }];
    expect(derivePaymentStatus({ charges, today: HOJE, overdueDays: 2 }).payment_status)
      .toBe("DELINQUENT");
    expect(derivePaymentStatus({ charges, today: HOJE, overdueDays: 10 }).payment_status)
      .toBe("OVERDUE");
  });

  it("cobranca paga nao conta como vencida, mesmo com data antiga", () => {
    const result = derivePaymentStatus({
      charges: [
        { due_date: "2026-08-01", status: "RECEIVED", payment_date: "2026-08-03" },
        { due_date: "2026-07-01", status: "CONFIRMED", payment_date: "2026-07-01" },
        { due_date: "2026-06-01", status: "RECEIVED_IN_CASH", payment_date: "2026-06-02" },
      ],
      today: HOJE,
    });
    expect(result.payment_status).toBe("CURRENT");
    expect(result.last_payment_at).toBe("2026-08-03");
  });

  it("cobranca cancelada ou estornada nao gera inadimplencia", () => {
    const result = derivePaymentStatus({
      charges: [
        { due_date: "2026-07-01", status: "DELETED", payment_date: null },
        { due_date: "2026-07-15", status: "REFUNDED", payment_date: "2026-07-16" },
      ],
      today: HOJE,
    });
    expect(result.payment_status).toBe("CURRENT");
  });

  it("o ciclo de estorno inteiro encerra a cobranca, nao gera inadimplencia", () => {
    for (const status of ["REFUND_IN_PROGRESS", "PARTIALLY_REFUNDED"]) {
      const result = derivePaymentStatus({
        charges: [{ due_date: "2026-07-01", status, payment_date: "2026-07-02" }],
        today: HOJE,
      });
      expect(result.payment_status, status).toBe("CURRENT");
      expect(result.overdue_since, status).toBeNull();
      expect(result.days_late, status).toBe(0);
    }
  });

  it("o ciclo de chargeback e o boleto cancelado tambem encerram a cobranca", () => {
    for (const status of ["CHARGEBACK_DISPUTE", "AWAITING_CHARGEBACK_REVERSAL", "BANK_SLIP_CANCELLED"]) {
      const result = derivePaymentStatus({
        charges: [{ due_date: "2026-06-01", status, payment_date: null }],
        today: HOJE,
      });
      expect(result.payment_status, status).toBe("CURRENT");
    }
  });

  it("DUNNING_RECEIVED e dinheiro recebido: quem pagou na negativacao nao e inadimplente", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-06-01", status: "DUNNING_RECEIVED", payment_date: "2026-07-20" }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("CURRENT");
    expect(result.overdue_since).toBeNull();
    expect(result.last_payment_at).toBe("2026-07-20");
  });

  it("dueSoonDays configuravel muda a janela de aviso de vencimento", () => {
    const charges = [{ due_date: "2026-09-16", status: "PENDING", payment_date: null }];
    expect(derivePaymentStatus({ charges, today: HOJE, dueSoonDays: 3 }).payment_status).toBe("CURRENT");
    expect(derivePaymentStatus({ charges, today: HOJE, dueSoonDays: 6 }).payment_status).toBe("DUE_SOON");
    expect(derivePaymentStatus({ charges, today: HOJE, dueSoonDays: 0 }).payment_status).toBe("CURRENT");
    expect(
      derivePaymentStatus({
        charges: [{ due_date: HOJE, status: "PENDING", payment_date: null }],
        today: HOJE,
        dueSoonDays: 0,
      }).payment_status,
    ).toBe("DUE_SOON");
  });

  it("usa a cobranca vencida MAIS ANTIGA para contar o atraso", () => {
    const result = derivePaymentStatus({
      charges: [
        { due_date: "2026-09-09", status: "OVERDUE", payment_date: null },
        { due_date: "2026-07-10", status: "OVERDUE", payment_date: null },
        { due_date: "2026-08-10", status: "OVERDUE", payment_date: null },
      ],
      today: HOJE,
    });
    expect(result.overdue_since).toBe("2026-07-10");
    expect(result.payment_status).toBe("DELINQUENT");
    expect(result.days_late).toBe(62);
  });

  it("vencimento dentro de 3 dias e DUE_SOON", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-12", status: "PENDING", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DUE_SOON");
    expect(result.days_late).toBe(0);
  });

  it("vencimento hoje ainda nao e atraso, e DUE_SOON", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: HOJE, status: "PENDING", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DUE_SOON");
  });

  it("atraso vence DUE_SOON quando ha as duas coisas", () => {
    const result = derivePaymentStatus({
      charges: [
        { due_date: "2026-09-01", status: "OVERDUE", payment_date: null },
        { due_date: "2026-09-11", status: "PENDING", payment_date: null },
      ],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DELINQUENT");
    expect(result.next_due_date).toBe("2026-09-11");
  });

  it("vencimento exatamente 3 dias depois e DUE_SOON (limite inclusivo)", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-13", status: "PENDING", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("DUE_SOON");
    expect(result.days_late).toBe(0);
  });

  it("vencimento exatamente 4 dias depois e CURRENT (fora do limite)", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2026-09-14", status: "PENDING", payment_date: null }],
      today: HOJE,
    });
    expect(result.payment_status).toBe("CURRENT");
    expect(result.days_late).toBe(0);
  });

  it("cliente sem cobranca nenhuma esta em dia e sem proximo vencimento", () => {
    const result = derivePaymentStatus({ charges: [], today: HOJE });
    expect(result.payment_status).toBe("CURRENT");
    expect(result.next_due_date).toBeNull();
    expect(result.last_payment_at).toBeNull();
  });

  it("atravessa a virada do ano sem errar a contagem", () => {
    const result = derivePaymentStatus({
      charges: [{ due_date: "2025-12-30", status: "OVERDUE", payment_date: null }],
      today: "2026-01-02",
    });
    expect(result.days_late).toBe(3);
  });
});
