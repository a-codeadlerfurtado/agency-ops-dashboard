import { ops, verifierFor } from "./supabase.js";

export type AccessLevel = "FULL" | "WALLET_ONLY" | "RESTRICTED";

export type Identity = {
  userId: string;
  email: string | null;
  person: string | null;
  role: string | null;
  accessLevel: AccessLevel;
  elevated: boolean;
  accountApproved: boolean;
  /** Conta sem aprovacao de cadastro ou sem vinculo no quadro: nao ve' nada. */
  locked: boolean;
  isFull: boolean;
  isWalletOnly: boolean;
};

/**
 * Resolve identidade e autorizacao a partir do access token do Supabase.
 *
 * Espelha `supabase/functions/agency-ops-dashboard-api` deliberadamente: se a IA
 * usasse uma regra propria, um colaborador poderia enxergar pela IA um cliente
 * que o Dashboard esconde dele. As duas telas precisam concordar.
 *
 * Retorna null quando o token e' invalido/expirado.
 */
export async function resolveIdentity(accessToken: string): Promise<Identity | null> {
  const { data, error } = await verifierFor(accessToken).auth.getUser();
  if (error || !data?.user) return null;

  const userId = data.user.id;
  const email = data.user.email ?? null;

  let person: string | null = null;
  let role: string | null = null;
  let accessLevel: AccessLevel = "RESTRICTED";

  const { data: pref } = await ops
    .from("user_preferences")
    .select("collaborator_person")
    .eq("user_key", userId)
    .maybeSingle();

  const collaboratorPerson = pref?.collaborator_person ?? null;
  if (collaboratorPerson) {
    const { data: roster } = await ops
      .from("team_roster")
      .select("person,role,access_level")
      .eq("person", collaboratorPerson)
      .eq("is_former", false)
      .maybeSingle();
    if (roster) {
      person = roster.person;
      role = roster.role;
      accessLevel = (roster.access_level as AccessLevel) ?? "RESTRICTED";
    }
  }

  // Duas aprovacoes distintas, nunca a mesma:
  //   SIGNUP    libera a CONTA
  //   ELEVATION libera acesso alem do papel
  const { data: decisions } = await ops
    .from("access_requests")
    .select("kind,status")
    .eq("user_key", userId)
    .eq("status", "APPROVED");

  const approvals = decisions ?? [];
  const accountApproved = approvals.some((row: { kind: string }) => row.kind === "SIGNUP");
  const elevated =
    accessLevel === "RESTRICTED" && approvals.some((row: { kind: string }) => row.kind === "ELEVATION");

  const locked = !accountApproved || (!person && !elevated);

  return {
    userId,
    email,
    person,
    role,
    accessLevel,
    elevated,
    accountApproved,
    locked,
    isFull: accessLevel === "FULL" || elevated,
    isWalletOnly: accessLevel === "WALLET_ONLY" && !elevated,
  };
}
