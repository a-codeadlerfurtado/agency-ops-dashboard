import { useCallback, useEffect, useState } from "react";
import { supabase, mensagemDeErro } from "./supabase";
import type { Role, Sessao } from "./types";

type Estado =
  | { fase: "carregando" }
  | { fase: "deslogado" }
  /* Operador sem imobiliaria propria: e o caso normal do dono da operacao.
     Sem esta fase ele cairia na tela "conta sem imobiliaria" e nao teria por
     onde criar a primeira. */
  | { fase: "operador"; email: string }
  | { fase: "sem-tenant"; email: string }
  | { fase: "erro"; mensagem: string }
  | { fase: "pronto"; sessao: Sessao };

/**
 * Resolve, em UMA ida ao banco, quem e o usuario e a que imobiliaria pertence.
 * A RLS ja garante que memberships so devolve o que e dele - nao precisamos
 * filtrar por tenant aqui, e nao daria para confiar se precisasse.
 */
async function resolverSessao(userId: string, email: string): Promise<Estado> {
  const [vinculo, operador] = await Promise.all([
    supabase
      .from("memberships")
      .select("role, tenant:tenants(id, name, slug), profile:profiles(full_name)")
      .eq("user_id", userId)
      .eq("status", "ACTIVE")
      .limit(1)
      .maybeSingle(),
    supabase.rpc("sou_operador"),
  ]);
  const { data, error } = vinculo;
  const ehOperador = operador.data === true;

  if (error) return { fase: "erro", mensagem: mensagemDeErro(error) };
  if (!data?.tenant) {
    return ehOperador ? { fase: "operador", email } : { fase: "sem-tenant", email };
  }

  const tenant = data.tenant as unknown as { id: string; name: string; slug: string };
  const profile = data.profile as unknown as { full_name: string | null } | null;
  const role = data.role as Role;

  return {
    fase: "pronto",
    sessao: {
      userId,
      email,
      nome: profile?.full_name ?? email,
      tenant,
      role,
      isAdmin: role === "ADMIN",
      ehOperador,
    },
  };
}

export function useSessao() {
  const [estado, setEstado] = useState<Estado>({ fase: "carregando" });

  useEffect(() => {
    let vivo = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!vivo) return;
      const u = data.session?.user;
      setEstado(u ? await resolverSessao(u.id, u.email ?? "") : { fase: "deslogado" });
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (evento, sessao) => {
      if (!vivo) return;
      if (evento === "SIGNED_OUT" || !sessao?.user) {
        setEstado({ fase: "deslogado" });
        return;
      }
      // TOKEN_REFRESHED nao muda quem e o usuario: nao vale outra ida ao banco.
      if (evento === "SIGNED_IN" || evento === "INITIAL_SESSION") {
        setEstado(await resolverSessao(sessao.user.id, sessao.user.email ?? ""));
      }
    });

    return () => {
      vivo = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const entrar = useCallback(async (email: string, senha: string) => {
    setEstado({ fase: "carregando" });
    const { error } = await supabase.auth.signInWithPassword({ email, password: senha });
    if (error) {
      setEstado({ fase: "deslogado" });
      throw new Error(
        error.message === "Invalid login credentials"
          ? "E-mail ou senha incorretos."
          : mensagemDeErro(error)
      );
    }
  }, []);

  const sair = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return { estado, entrar, sair };
}
