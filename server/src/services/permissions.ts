import { ops } from "./supabase.js";
import type { Identity } from "./identity.js";

export type ClientRow = Record<string, any>;

/**
 * Conjunto de client_ids que a pessoa pode alcancar.
 *
 * `null` = sem restricao de carteira. Regra copiada do dashboard-api:
 * somente WALLET_ONLY filtra por carteira (gt_owner). RESTRICTED nao filtra
 * carteira - ele restringe outras superficies (inadimplencia, juridico, churn).
 * Conta travada nao alcanca cliente nenhum.
 */
export async function walletScope(identity: Identity): Promise<Set<string> | null> {
  if (identity.locked) return new Set<string>();
  if (!identity.isWalletOnly) return null;

  const { data, error } = await ops
    .from("dashboard_client_overview")
    .select("client_id,gt_owner");
  if (error) throw new Error(`falha ao resolver carteira: ${error.message}`);

  return new Set(
    (data ?? [])
      .filter((row: ClientRow) => row.gt_owner === identity.person)
      .map((row: ClientRow) => String(row.client_id)),
  );
}

/** Clientes visiveis para a pessoa, ja' filtrados no servidor. */
export async function listAllowedClients(identity: Identity): Promise<ClientRow[]> {
  if (identity.locked) return [];

  const { data, error } = await ops
    .from("dashboard_client_overview")
    .select("client_id,display_name,lifecycle,gt_owner,cs_owner,designer_owner,priority")
    .order("display_name");
  if (error) throw new Error(error.message);

  const scope = await walletScope(identity);
  const rows = data ?? [];
  return scope ? rows.filter((row: ClientRow) => scope.has(String(row.client_id))) : rows;
}

export class ClientForbidden extends Error {
  constructor() {
    super("client_forbidden");
  }
}

/**
 * Porteiro de client_id. O frontend esconder um cliente nao e' seguranca:
 * toda entrada de client_id passa por aqui antes de virar contexto do modelo.
 */
export async function assertClientAllowed(
  identity: Identity,
  clientId: string | null,
): Promise<ClientRow | null> {
  if (!clientId) {
    if (identity.locked) throw new ClientForbidden();
    return null;
  }
  if (identity.locked) throw new ClientForbidden();

  const { data } = await ops
    .from("dashboard_client_overview")
    .select("*")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!data) throw new ClientForbidden();

  const scope = await walletScope(identity);
  if (scope && !scope.has(String(clientId))) throw new ClientForbidden();

  return data;
}
