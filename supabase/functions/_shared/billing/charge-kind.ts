import type { ChargeKind } from "./types.ts";

const IMPLANTACAO = /implanta|implementa|setup/;

/** Remove acentos e baixa a caixa, para a comparacao nao depender de como foi digitado. */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Cobranca ligada a assinatura e sempre mensalidade — o vinculo e mais
 * confiavel que qualquer texto livre digitado por gente.
 */
export function classifyChargeKind(input: {
  subscriptionId: string | null;
  description: string | null;
}): ChargeKind {
  if (input.subscriptionId) return "MENSALIDADE";
  const description = input.description ? fold(input.description) : "";
  if (IMPLANTACAO.test(description)) return "IMPLANTACAO";
  return "EXTRA";
}
