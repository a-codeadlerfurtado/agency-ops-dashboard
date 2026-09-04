/** Normaliza CNPJ (14) ou CPF (11) para so digitos. Devolve null se nao for nenhum dos dois. */
export function normalizeDocument(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/\D/g, "");
  if (digits.length !== 11 && digits.length !== 14) return null;
  return digits;
}
