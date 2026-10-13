/**
 * Contexto de tela: o cliente que esta' aberto no dashboard quando a pessoa fala.
 *
 * O navegador manda apenas o UUID do cliente aberto (`screen_client_id`). Ele
 * NAO e' confiavel por si so: so vale se estiver na lista de clientes que o
 * usuario ja' pode ver, e so e' usado quando a frase aponta para a tela
 * ("ele", "esse cliente", "essa conta", "aqui"). Sem essa trava, deixar um
 * drawer aberto mudaria o sentido de perguntas globais como "quantos leads
 * tivemos hoje?".
 *
 * Prioridade no agente: cliente citado pelo nome > cliente da tela > memoria.
 */

import type { ClientePermitido } from "./memory";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const APONTA_PARA_TELA = new RegExp(
  "\\b(?:" + [
    "ele", "ela", "dele", "dela", "nele", "nela",
    "(?:d|n)?ess[ea] (?:cliente|conta|imobiliaria|corretor|corretora)",
    "(?:d|n)?est[ea] (?:cliente|conta|imobiliaria|corretor|corretora)",
    "ess[ea] aqui", "est[ea] aqui",
    "cliente abert[oa]", "conta abert[oa]",
    "(?:cliente|conta) (?:da|na) tela", "(?:aqui )?na tela",
  ].join("|") + ")\\b",
);

function semAcento(valor: unknown): string {
  return String(valor ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** UUID valido ou null. Qualquer outra coisa vinda do navegador e' descartada. */
export function idDeTela(valor: unknown): string | null {
  const id = String(valor ?? "").trim();
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** A frase aponta para o que esta' na tela, em vez de citar um nome? */
export function referenciaClienteDaTela(mensagem: string): boolean {
  return APONTA_PARA_TELA.test(semAcento(mensagem));
}

/**
 * Cliente da tela, ou null. Exige as tres coisas: UUID bem formado, frase que
 * aponta para a tela e cliente presente na lista permitida do usuario.
 */
export function resolverClienteDaTela(
  mensagem: string, screenClientId: unknown, clientes: ClientePermitido[],
): ClientePermitido | null {
  const id = idDeTela(screenClientId);
  if (!id || !Array.isArray(clientes) || !clientes.length) return null;
  if (!referenciaClienteDaTela(mensagem)) return null;
  return clientes.find((c) => String(c?.client_id ?? "").toLowerCase() === id) ?? null;
}
