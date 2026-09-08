export type EstadoSaldoMeta = {
  display_name: string;
  meta_balance?: number | null;
  meta_available_balance?: number | null;
  meta_currency?: string | null;
  meta_funding_type?: number | null;
  meta_funding_type_label?: string | null;
  meta_balance_source?: string | null;
};

function normalizar(v: unknown): string {
  return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function moeda(v: number, currency = "BRL"): string {
  try { return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(v); }
  catch { return `R$ ${v.toFixed(2).replace(".", ",")}`; }
}
export function respostaSaldoMeta(estado: EstadoSaldoMeta): string | null {
  const tipo = numero(estado.meta_funding_type);
  const label = normalizar(estado.meta_funding_type_label);
  const source = normalizar(estado.meta_balance_source);
  const posPago = tipo === 1 || /pos pago|cartao de credito/.test(label) || source.includes("postpaid");
  const currency = estado.meta_currency ?? "BRL";

  if (posPago) {
    const aberto = numero(estado.meta_balance);
    if (aberto === null) return `A conta Meta de ${estado.display_name} é pós-paga no cartão; não existe saldo pré-pago disponível para informar.`;
    if (aberto > 0) return `A conta Meta de ${estado.display_name} é pós-paga no cartão e está com ${moeda(aberto, currency)} em aberto.`;
    if (aberto === 0) return `A conta Meta de ${estado.display_name} é pós-paga no cartão e não tem valor em aberto no momento.`;
    return `A conta Meta de ${estado.display_name} é pós-paga no cartão. A Meta reporta ${moeda(aberto, currency)} no balanço da conta; não trato isso como saldo disponível.`;
  }

  const disponivel = numero(estado.meta_available_balance ?? estado.meta_balance);
  return disponivel === null ? null : `O saldo disponível no Meta de ${estado.display_name} é ${moeda(disponivel, currency)}.`;
}
