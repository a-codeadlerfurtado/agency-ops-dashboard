import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../env.js";

// Dois clientes SEPARADOS, de proposito.
//
// `admin` carrega a credencial privilegiada e NUNCA recebe o Authorization do
// usuario. Se reaproveitassemos um unico cliente e injetassemos a sessao do
// colaborador nele, o header Authorization sobrescreveria a chave privilegiada
// e o backend passaria a ler o banco com a permissao de quem chamou - que e'
// exatamente o furo que esta arquitetura existe para impedir.
const admin: SupabaseClient = createClient(env.supabaseUrl, env.supabaseSecretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const ops = admin.schema("agency_ops");
export const adminAuth = admin.auth;
export const adminStorage = admin.storage;

// Cliente descartavel, so' para trocar o access token do usuario por uma
// identidade verificada pelo Supabase Auth. Nao le' dados operacionais.
export function verifierFor(accessToken: string): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabasePublishableKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
