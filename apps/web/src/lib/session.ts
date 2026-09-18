import { useCallback, useEffect, useState } from "react";
import { supabase, mensagemDeErro } from "./supabase";
import type { Role, Sessao, Tenant } from "./types";

const MASTER_TENANT_KEY = "imobi-board:master-tenant";

type Estado =
  | { fase: "carregando" }
  | { fase: "deslogado" }
  | { fase: "operador"; userId: string; email: string; nome: string; isMaster: boolean }
  | { fase: "sem-tenant"; email: string }
  | { fase: "erro"; mensagem: string }
  | { fase: "pronto"; sessao: Sessao };

function tenantMestreSalvo(): Tenant | null {
  try {
    const bruto = sessionStorage.getItem(MASTER_TENANT_KEY);
    if (!bruto) return null;
    const t = JSON.parse(bruto) as Tenant;
    return t?.id && t?.name && t?.slug ? t : null;
  } catch {
    return null;
  }
}

function sessaoMestre(userId: string, email: string, tenant: Tenant): Sessao {
  return {
    userId, email, nome: "ImobiBoard Master", tenant,
    role: "ADMIN", isAdmin: true, ehOperador: true, modoMestre: true,
  };
}
async function resolverSessao(userId: string, email: string): Promise<Estado> {
  const [vinculo, operador, master] = await Promise.all([
    supabase
      .from("memberships")
      .select("role, tenant:tenants(id, name, slug), profile:profiles(full_name)")
      .eq("user_id", userId)
      .eq("status", "ACTIVE")
      .eq("is_internal", false)
      .limit(1)
      .maybeSingle(),
    supabase.rpc("sou_operador"),
    supabase.rpc("sou_master"),
  ]);

  if (vinculo.error) return { fase: "erro", mensagem: mensagemDeErro(vinculo.error) };
  if (operador.error) return { fase: "erro", mensagem: mensagemDeErro(operador.error) };
  if (master.error) return { fase: "erro", mensagem: mensagemDeErro(master.error) };

  const ehOperador = operador.data === true;
  const ehMaster = master.data === true;

  if (ehMaster) {
    const selecionado = tenantMestreSalvo();
    if (selecionado) return { fase: "pronto", sessao: sessaoMestre(userId, email, selecionado) };
    return { fase: "operador", userId, email, nome: "ImobiBoard Master", isMaster: true };
  }

  const data = vinculo.data;
  if (!data?.tenant) {
    return ehOperador
      ? { fase: "operador", userId, email, nome: email, isMaster: false }
      : { fase: "sem-tenant", email };
  }

  const tenant = data.tenant as unknown as Tenant;
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
        sessionStorage.removeItem(MASTER_TENANT_KEY);
        setEstado({ fase: "deslogado" });
        return;
      }
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
  const entrarComoMestre = useCallback(async (tenant: Tenant) => {
    const { data: usuario } = await supabase.auth.getUser();
    const u = usuario.user;
    if (!u) throw new Error("Sessao expirada. Entre novamente.");

    const { data: ehMaster, error: erroMaster } = await supabase.rpc("sou_master");
    if (erroMaster) throw erroMaster;
    if (ehMaster !== true) throw new Error("Esta conta nao tem acesso Master.");

    const { error: erroAuditoria } = await supabase.rpc("registrar_acesso_mestre", {
      p_tenant: tenant.id,
      p_acao: "ENTER",
    });
    if (erroAuditoria) throw erroAuditoria;

    sessionStorage.setItem(MASTER_TENANT_KEY, JSON.stringify(tenant));
    setEstado({ fase: "pronto", sessao: sessaoMestre(u.id, u.email ?? "", tenant) });
  }, []);

  const voltarAoMestre = useCallback(async () => {
    if (estado.fase !== "pronto" || !estado.sessao.modoMestre) return;
    const s = estado.sessao;
    await supabase.rpc("registrar_acesso_mestre", {
      p_tenant: s.tenant.id,
      p_acao: "EXIT",
    });
    sessionStorage.removeItem(MASTER_TENANT_KEY);
    setEstado({
      fase: "operador", userId: s.userId, email: s.email,
      nome: "ImobiBoard Master", isMaster: true,
    });
  }, [estado]);
  const sair = useCallback(async () => {
    sessionStorage.removeItem(MASTER_TENANT_KEY);
    await supabase.auth.signOut();
  }, []);

  return { estado, entrar, sair, entrarComoMestre, voltarAoMestre };
}
