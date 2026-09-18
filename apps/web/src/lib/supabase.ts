import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY sao obrigatorios. Copie .env.example para .env."
  );
}

/**
 * O Imobi-Board vive num schema proprio, nao em `public`. Toda a API tipada
 * abaixo ja aponta para la; nada aqui enxerga as tabelas dos outros sistemas
 * que dividem o mesmo projeto Supabase.
 *
 * Somente a chave publishable/anon chega ao browser. A service role nunca
 * entra neste bundle (spec 61) - quem precisa dela e o worker, server-side.
 */
export const supabase = createClient(url, anonKey, {
  db: { schema: "imobi_board" },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
  global: {
    headers: { "x-client-info": "imobi-board-web" },
  },
});

/** Traduz erro do Postgres em algo que o corretor entende (spec 106). */
export function mensagemDeErro(e: unknown): string {
  const err = e as { code?: string; message?: string; details?: string } | null;
  if (!err) return "Algo deu errado. Tente novamente.";

  const codigo = err.code ?? "";

  // Mensagens que nos mesmos levantamos nas RPC ja vem prontas em portugues.
  if (codigo === "P0001" && err.message) return err.message;
  if (codigo === "42501") {
    return err.message?.includes("row-level security")
      ? "Voce nao tem permissao para essa alteracao."
      : (err.message ?? "Voce nao tem permissao para essa acao.");
  }
  if (codigo === "23505") return "Esse registro ja existe.";
  if (codigo === "23503") return "Registro relacionado nao encontrado.";
  if (codigo === "P0002") return "Registro nao encontrado.";
  if (codigo === "PGRST106") {
    return "O schema imobi_board ainda nao esta exposto na API do Supabase. Ver docs/supabase.md.";
  }
  if (codigo === "PGRST301" || codigo === "401") return "Sessao expirada. Entre novamente.";

  return err.message ?? "Algo deu errado. Tente novamente.";
}
