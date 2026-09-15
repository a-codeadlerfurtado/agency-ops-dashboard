"use client";

import { useEffect } from "react";
import { SUPABASE_URL } from "./shared";
import WorkCenterPlaybooks from "./work-center-playbooks";

const CORE_PATH = "/functions/v1/agency-ops-dashboard-api";
const WORK_API = `${SUPABASE_URL}/functions/v1/agency-ops-work-center-api`;

function redirectedUrl(input: RequestInfo | URL) {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, window.location.href);
    if (url.origin !== SUPABASE_URL || url.pathname !== CORE_PATH) return null;
    const view = url.searchParams.get("view");
    if (view !== "work" && view !== "work-item-update") return null;
    return WORK_API;
  } catch {
    return null;
  }
}

/**
 * A Central de Trabalho tem uma regra diferente de outras telas: autoria não é
 * destinatário. Quem criou uma tarefa para outra pessoa/equipe não pode recebê-la
 * de volta só por ter sido o autor.
 *
 * Este bridge garante que todas as leituras/alterações feitas pela interface usem
 * o endpoint com escopo ASSIGNEE_ONLY. O endpoint valida novamente no servidor:
 * - Adler vê tudo;
 * - target_person preenchido => somente aquela pessoa;
 * - sem target_person => somente colaboradores do target_role;
 * - created_by_person nunca concede visibilidade nem permissão de ação.
 *
 * A camada WorkCenterPlaybooks monta, na mesma tela, os novos recursos de Projetos,
 * Modelos/Playbooks e Anotações por cliente. Ela usa a mesma sessão autenticada e
 * nunca acessa as tabelas diretamente: toda autorização continua no endpoint da
 * Central de Trabalho.
 */
export default function WorkCenterScopeNetwork() {
  useEffect(() => {
    const nativeFetch = window.fetch.bind(window);

    const scopedFetch: typeof window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const next = redirectedUrl(input);
      if (!next) return nativeFetch(input, init);

      if (input instanceof Request) {
        const request = new Request(next, input);
        return nativeFetch(request, init);
      }
      return nativeFetch(next, init);
    };

    window.fetch = scopedFetch;
    return () => {
      if (window.fetch === scopedFetch) window.fetch = nativeFetch;
    };
  }, []);

  return <WorkCenterPlaybooks />;
}
