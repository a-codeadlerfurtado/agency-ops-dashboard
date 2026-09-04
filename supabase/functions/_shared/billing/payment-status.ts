import type { ChargeSnapshot, DeriveStatusInput, DerivedFinanceControl } from "./types.ts";

/** Status do Asaas que significam dinheiro recebido. */
const PAGO = new Set(["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH", "DUNNING_RECEIVED"]);

/** Status que encerram a cobranca sem divida: nao geram inadimplencia. */
const ENCERRADO = new Set(["DELETED", "REFUNDED", "REFUND_REQUESTED", "CHARGEBACK_REQUESTED"]);

const DIA_MS = 86_400_000;

/** Converte YYYY-MM-DD em ms UTC. Trabalhar em UTC evita que horario de verao mova o dia. */
function toUtcMs(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(from: string, to: string): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DIA_MS);
}

function isOpen(charge: ChargeSnapshot): boolean {
  const status = String(charge.status || "").toUpperCase();
  return !PAGO.has(status) && !ENCERRADO.has(status);
}

function isPaid(charge: ChargeSnapshot): boolean {
  return PAGO.has(String(charge.status || "").toUpperCase());
}

/**
 * Deriva o estado financeiro do cliente a partir das cobrancas.
 * `today` entra como parametro (data em America/Sao_Paulo, calculada por quem
 * chama) para que a funcao seja deterministica e testavel.
 */
export function derivePaymentStatus(input: DeriveStatusInput): DerivedFinanceControl {
  const { charges, today } = input;
  const overdueDays = input.overdueDays ?? 5;
  const dueSoonDays = input.dueSoonDays ?? 3;

  const open = charges.filter(isOpen);
  const overdue = open.filter((charge) => charge.due_date < today);

  const overdue_since = overdue.length
    ? overdue.reduce((oldest, charge) => (charge.due_date < oldest ? charge.due_date : oldest), overdue[0].due_date)
    : null;

  const upcoming = open.filter((charge) => charge.due_date >= today);
  const next_due_date = upcoming.length
    ? upcoming.reduce((soonest, charge) => (charge.due_date < soonest ? charge.due_date : soonest), upcoming[0].due_date)
    : null;

  const payments = charges.filter(isPaid).map((charge) => charge.payment_date).filter((date): date is string => !!date);
  const last_payment_at = payments.length ? payments.reduce((latest, date) => (date > latest ? date : latest)) : null;

  const days_late = overdue_since ? daysBetween(overdue_since, today) : 0;
  const days_to_next = next_due_date ? daysBetween(today, next_due_date) : null;

  let payment_status: DerivedFinanceControl["payment_status"];
  if (days_late >= overdueDays) payment_status = "DELINQUENT";
  else if (days_late >= 1) payment_status = "OVERDUE";
  else if (days_to_next !== null && days_to_next <= dueSoonDays) payment_status = "DUE_SOON";
  else payment_status = "CURRENT";

  return { payment_status, overdue_since, next_due_date, last_payment_at, days_late };
}
