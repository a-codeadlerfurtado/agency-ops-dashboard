/**
 * Compara o token do header com o segredo do servidor.
 * Nega quando o segredo nao esta configurado — um servidor mal configurado
 * fecha, nunca abre. A comparacao percorre o comprimento inteiro para nao
 * vazar onde as strings divergem.
 */
export function isAuthorizedWebhookToken(
  received: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const secret = (expected ?? "").trim();
  if (!secret) return false;

  const token = received ?? "";
  if (token.length !== secret.length) return false;

  let mismatch = 0;
  for (let index = 0; index < secret.length; index += 1) {
    mismatch |= token.charCodeAt(index) ^ secret.charCodeAt(index);
  }
  return mismatch === 0;
}
