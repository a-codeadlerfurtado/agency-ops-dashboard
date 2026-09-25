import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

export interface Notificacao {
  id: number;
  type: string;
  title: string;
  body: string | null;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

async function buscar(): Promise<Notificacao[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, type, title, body, entity_type, entity_id, read_at, created_at")
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data ?? []) as Notificacao[];
}

/**
 * Realtime seletivo (spec 56): um canal por usuario, filtrado no servidor por
 * user_id. Nao existe subscription global — e nao ha polling: sem evento, a
 * conexao fica quieta e nao custa nada.
 *
 * A RLS vale no canal tambem. O filtro abaixo economiza trafego; quem garante
 * que ninguem recebe notificacao alheia continua sendo a policy.
 */
export function useNotificacoes(userId: string) {
  const [lista, setLista] = useState<Notificacao[]>([]);
  const [erro, setErro] = useState(false);
  const [conectado, setConectado] = useState(false);

  const recarregar = useCallback(() => {
    buscar().then(setLista).catch(() => setErro(true));
  }, []);

  useEffect(() => {
    recarregar();

    const canal = supabase
      .channel(`notificacoes:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "imobi_board",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (msg) => setLista((l) => [msg.new as Notificacao, ...l].slice(0, 30))
      )
      .subscribe((estado) => setConectado(estado === "SUBSCRIBED"));

    return () => { setConectado(false); void supabase.removeChannel(canal); };
  }, [userId, recarregar]);

  const marcarLidas = useCallback(async () => {
    const { error } = await supabase.rpc("marcar_notificacoes_lidas");
    if (error) throw error;
    setLista((l) => l.map((n) => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })));
  }, []);

  return {
    lista,
    erro,
    /** estado REAL do canal - nao um indicador decorativo */
    conectado,
    naoLidas: lista.filter((n) => !n.read_at).length,
    marcarLidas,
    recarregar,
  };
}

export async function definirStatusCorretor(membershipId: string, ativo: boolean) {
  const { error } = await supabase.rpc("definir_status_corretor", {
    p_membership_id: membershipId,
    p_ativo: ativo,
  });
  if (error) throw error;
}

/* ============================================================ convites === */

export interface Convite {
  id: string;
  email: string;
  role: "ADMIN" | "BROKER";
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
}

export async function convites(tenantId: string): Promise<Convite[]> {
  const { data, error } = await supabase
    .from("invites")
    .select("id, email, role, created_at, expires_at, accepted_at, revoked_at")
    .eq("tenant_id", tenantId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Convite[];
}

/** Devolve o token UMA vez: ele nao e legivel por policy depois disso. */
export async function convidarMembro(
  tenantId: string, email: string, role: "ADMIN" | "BROKER"
) {
  const { data, error } = await supabase.rpc("convidar_membro", {
    p_email: email,
    p_role: role,
    p_tenant_id: tenantId,
  });
  if (error) throw error;
  return data as { token: string; email: string; role: string };
}

export async function revogarConvite(id: string) {
  const { error } = await supabase.rpc("revogar_convite", { p_id: id });
  if (error) throw error;
}