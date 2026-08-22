"use client";

import { useEffect } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from "./shared";

const API_URL = `${SUPABASE_URL}/functions/v1/agency-ops-onboarding-api`;
const FOCUSED = new Set(["Gustavo Lima", "Joel Antoniete"]);

export default function OnboardingRoleRouter() {
  useEffect(() => {
    if (window.location.pathname !== "/onboarding") return;
    let active = true;

    const route = async () => {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      if (!session || !active) return;
      try {
        const response = await fetch(API_URL, {
          headers: { Authorization: `Bearer ${session.access_token}`, apikey: SUPABASE_ANON_KEY },
          cache: "no-store",
        });
        if (!response.ok || !active) return;
        const body = await response.json().catch(() => ({}));
        const person = String(body?.profile?.person || "");
        const role = String(body?.profile?.role || "");
        const params = new URLSearchParams(window.location.search);
        const wantsAll = params.get("view") === "all";

        // Adler nunca deve cair na tela operacional do GT. A entrada dele é a
        // visão completa: todos os clientes, todas as reuniões e todas as etapas.
        if (person === "Adler Furtado") {
          window.location.replace("/onboarding-overview");
          return;
        }

        // Joel e Gustavo entram primeiro na própria responsabilidade, mas podem
        // alternar para a visão geral completa para acompanhar e cobrar a equipe.
        if (FOCUSED.has(person)) {
          window.location.replace(wantsAll ? "/onboarding-overview" : "/onboarding-focus");
          return;
        }

        // Outros CS com acesso ao onboarding e pedido explícito de visão geral
        // também podem abrir o consolidado. GT continua na tela de integração.
        if (role === "CS" && wantsAll) window.location.replace("/onboarding-overview");
      } catch {
        // Se a identificação falhar, preserva a tela atual em vez de arriscar
        // mandar um usuário para uma visão fora do seu escopo.
      }
    };

    route();
    return () => { active = false; };
  }, []);

  return null;
}
