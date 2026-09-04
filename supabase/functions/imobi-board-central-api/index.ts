import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Console central do Imobi-Board, operado do agency-ops-dashboard.
 *
 * O dashboard e a central da agencia; o CRM e um dos sistemas que ela opera.
 * Esta funcao e a ponte: lista as imobiliarias e seus usuarios, convida gente
 * nova, e define a senha de qualquer usuario -- gravando esse acesso no cofre
 * do cliente.
 *
 * Sobre a senha no cofre, que e a parte delicada:
 *
 * O convite do Imobi-Board faz cada pessoa criar a propria senha, e o banco
 * guarda so o hash. Ou seja, ate aqui NAO EXISTIA senha para o cofre guardar.
 * Ela passa a existir no momento em que o Adler a define por este console --
 * e so entao vai para o cofre.
 *
 * Se o usuario trocar a senha depois, pela tela do CRM, o cofre passaria a
 * mentir em silencio. Por isso, junto com a senha, guardamos a impressao do
 * hash (imobi_board.marcar_senha_no_cofre). Quando a impressao de hoje difere
 * da guardada, a listagem marca o item como DESATUALIZADO. Um cofre que admite
 * nao saber vale mais que um que responde errado.
 *
 * Autorizacao: mesma trava da agency-ops-adler-vault-api -- pessoa
 * "Adler Furtado" com papel MGMT no roster. Acoes que alteram exigem a senha
 * do dashboard de novo, e toda acao vai para client_access_vault_audit.
 */

type Row = Record<string, unknown>;
type Ator = { userId: string; email: string; person: string; role: string };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ENV_VAULT_KEY_B64 = Deno.env.get("CLIENT_VAULT_KEY_B64") || "";
const CRM_URL = Deno.env.get("IMOBI_BOARD_APP_URL") ||
  "https://imobi-board-app.lakassessoriadigital.workers.dev";

const PROD_ORIGIN = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev";
const EXTRA_ORIGINS = (Deno.env.get("CLIENT_VAULT_ALLOWED_ORIGINS") || "")
  .split(",").map((v) => v.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([PROD_ORIGIN, "http://localhost:3000", ...EXTRA_ORIGINS]);

const FALHAS_LIMITE = 5;
const FALHAS_JANELA_MIN = 15;
const SENHA_MINIMA = 10;

function cors(req: Request) {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin":
      !origin || ALLOWED_ORIGINS.has(origin) ? (origin || PROD_ORIGIN) : "null",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(req),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "pragma": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

const limpo = (v: unknown, max = 500) => String(v ?? "").trim().slice(0, max);

function admin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
type Admin = ReturnType<typeof admin>;

/* --------------------------------------------------------------- cifra --- */
/* Mesmo formato da agency-ops-client-access-vault-api: AES-GCM, IV de 12
   bytes, ciphertext e IV em base64, encryption_version 1. Cifrar diferente
   quebraria o REVEAL do cofre. */

const b64ParaBytes = (v: string) => Uint8Array.from(atob(v), (c) => c.charCodeAt(0));
function bytesParaB64(v: Uint8Array) {
  let s = "";
  for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000));
  return btoa(s);
}

let chavePromise: Promise<CryptoKey> | null = null;
async function chaveDoCofre(db: Admin) {
  if (!chavePromise) {
    chavePromise = (async () => {
      let b64 = ENV_VAULT_KEY_B64;
      if (!b64) {
        const { data, error } = await db.schema("agency_ops").rpc("get_client_vault_key");
        if (error || !data) throw new Error("vault_key_missing");
        b64 = String(data);
      }
      const raw = b64ParaBytes(b64);
      if (raw.byteLength !== 32) throw new Error("vault_key_invalid_length");
      return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
  }
  return chavePromise;
}

async function cifrar(db: Admin, valor: string | null) {
  if (!valor) return { ciphertext: null, iv: null };
  const chave = await chaveDoCofre(db);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, chave, new TextEncoder().encode(valor));
  return { ciphertext: bytesParaB64(new Uint8Array(cifrado)), iv: bytesParaB64(iv) };
}

/* ----------------------------------------------------------------- ator --- */

async function quemChama(db: Admin, req: Request): Promise<Ator | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  const user = data?.user;
  if (error || !user?.id || !user.email) return null;
  const email = user.email.toLowerCase();

  const { data: login } = await db.schema("agency_ops").from("team_login_emails")
    .select("person").eq("email", email).eq("active", true).maybeSingle();
  if (!login?.person) return null;

  const { data: roster } = await db.schema("agency_ops").from("team_roster")
    .select("role,is_former").eq("person", login.person).maybeSingle();
  const role = String(roster?.role || "").toUpperCase();

  // mesma trava da adler-vault-api: a central e dele
  if (String(login.person) !== "Adler Furtado" || role !== "MGMT" || roster?.is_former === true) {
    return null;
  }
  return { userId: user.id, email, person: String(login.person), role };
}

async function auditar(
  db: Admin, ator: Ator, clientId: string | null, acao: string,
  itemId: string | null = null, detalhe: Row = {},
) {
  if (!clientId) return;              // sem cliente ligado nao ha cofre onde auditar
  const seguro: Row = {};
  for (const [k, v] of Object.entries(detalhe)) {
    if (["password", "senha", "login", "notes", "dashboard_password", "token"].includes(k)) continue;
    seguro[k] = typeof v === "string" ? v.slice(0, 500) : v;
  }
  await db.schema("agency_ops").from("client_access_vault_audit").insert({
    client_id: clientId, vault_item_id: itemId, actor_user_id: ator.userId,
    actor_person: ator.person, actor_role: ator.role, action: acao, detail: seguro,
  });
}

async function reautenticar(db: Admin, ator: Ator, clientId: string | null, fornecida: unknown) {
  const desde = new Date(Date.now() - FALHAS_JANELA_MIN * 60_000).toISOString();
  const { count } = await db.schema("agency_ops").from("client_access_vault_audit")
    .select("id", { count: "exact", head: true })
    .eq("actor_user_id", ator.userId).eq("action", "REAUTH_FAILED").gte("created_at", desde);
  if (Number(count || 0) >= FALHAS_LIMITE) {
    await auditar(db, ator, clientId, "REAUTH_LOCKED", null, { janela_min: FALHAS_JANELA_MIN });
    return { ok: false as const, status: 429, error: "reauth_locked" };
  }
  const senha = String(fornecida || "");
  if (!senha || senha.length > 256) {
    await auditar(db, ator, clientId, "REAUTH_FAILED", null, { motivo: "ausente_ou_longa" });
    return { ok: false as const, status: 403, error: "invalid_reauthentication" };
  }
  const verificador = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await verificador.auth.signInWithPassword({ email: ator.email, password: senha });
  if (error || data.user?.id !== ator.userId) {
    await auditar(db, ator, clientId, "REAUTH_FAILED", null, { motivo: "senha_rejeitada" });
    return { ok: false as const, status: 403, error: "invalid_reauthentication" };
  }
  try { await verificador.auth.signOut({ scope: "local" }); } catch { /* verificador temporario */ }
  return { ok: true as const };
}

/* ---------------------------------------------------------------- rotas --- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json(req, { ok: false, error: "origin_not_allowed" }, 403);
  }
  if (req.method !== "POST") return json(req, { ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
    return json(req, { ok: false, error: "server_configuration_missing" }, 503);
  }

  const db = admin();
  const ator = await quemChama(db, req);
  if (!ator) return json(req, { ok: false, error: "unauthorized" }, 401);

  let body: Row;
  try { body = await req.json(); } catch { return json(req, { ok: false, error: "invalid_json" }, 400); }
  const acao = limpo(body.action, 30).toUpperCase();

  /* ------------------------------------------------------------ LISTAR -- */
  if (acao === "LISTAR") {
    const { data, error } = await db.schema("imobi_board").rpc("central_do_crm");
    if (error) return json(req, { ok: false, error: "crm_read_failed", detalhe: error.message }, 500);
    return json(req, { ok: true, imobiliarias: data ?? [], crm_url: CRM_URL });
  }

  /* ----------------------------------------------------- LIGAR_CLIENTE -- */
  if (acao === "LIGAR_CLIENTE") {
    const tenant = limpo(body.tenant_id, 80);
    const cliente = limpo(body.client_id, 80) || null;
    if (!tenant) return json(req, { ok: false, error: "tenant_id_required" }, 400);
    const { data, error } = await db.schema("imobi_board")
      .rpc("ligar_ao_cliente", { p_tenant: tenant, p_cliente: cliente });
    if (error) return json(req, { ok: false, error: error.message }, 400);
    await auditar(db, ator, cliente, "CRM_LIGAR_CLIENTE", null, { tenant_id: tenant });
    return json(req, { ok: true, ligacao: data });
  }

  /* ---------------------------------------------------------- CONVIDAR -- */
  if (acao === "CONVIDAR") {
    const tenant = limpo(body.tenant_id, 80);
    const email = limpo(body.email, 320);
    const papel = limpo(body.papel, 20).toUpperCase() || "BROKER";
    if (!tenant || !email) return json(req, { ok: false, error: "tenant_e_email_obrigatorios" }, 400);
    if (!["ADMIN", "BROKER"].includes(papel)) return json(req, { ok: false, error: "papel_invalido" }, 400);

    const cliente = await clienteDoTenant(db, tenant);
    const reauth = await reautenticar(db, ator, cliente, body.dashboard_password);
    if (!reauth.ok) return json(req, { ok: false, error: reauth.error }, reauth.status);

    const { data, error } = await db.schema("imobi_board").rpc("convidar_pelo_console", {
      p_tenant: tenant, p_email: email, p_papel: papel, p_por: ator.person,
    });
    if (error) return json(req, { ok: false, error: error.message }, 400);
    const convite = data as Row;
    await auditar(db, ator, cliente, "CRM_CONVIDAR", null, { tenant_id: tenant, email, papel });
    return json(req, {
      ok: true,
      convite: { ...convite, link: `${CRM_URL}/#/convite/${convite.token}` },
    });
  }

  /* ---------------------------------------------------- DEFINIR_SENHA --- */
  if (acao === "DEFINIR_SENHA") {
    const tenant = limpo(body.tenant_id, 80);
    const userId = limpo(body.user_id, 80);
    const senha = String(body.senha || "");
    if (!tenant || !userId) return json(req, { ok: false, error: "tenant_e_usuario_obrigatorios" }, 400);
    if (senha.length < SENHA_MINIMA) {
      return json(req, { ok: false, error: "senha_curta", minimo: SENHA_MINIMA }, 400);
    }
    if (senha.length > 200) return json(req, { ok: false, error: "senha_longa" }, 400);

    const cliente = await clienteDoTenant(db, tenant);
    if (!cliente) {
      return json(req, {
        ok: false,
        error: "imobiliaria_sem_cliente",
        detalhe: "Ligue a imobiliaria a um cliente do Agency Ops antes: sem isso nao ha cofre onde guardar o acesso.",
      }, 409);
    }

    const reauth = await reautenticar(db, ator, cliente, body.dashboard_password);
    if (!reauth.ok) return json(req, { ok: false, error: reauth.error }, reauth.status);

    // 1. aplica a senha no usuario do CRM
    const { data: alvo, error: erroUser } =
      await db.auth.admin.updateUserById(userId, { password: senha });
    if (erroUser || !alvo?.user) {
      return json(req, { ok: false, error: "falha_ao_definir_senha", detalhe: erroUser?.message }, 500);
    }
    const emailAlvo = alvo.user.email ?? "";

    // 2. cofre: atualiza o item deste usuario, ou cria o primeiro
    const { data: itemExistente } = await db.schema("imobi_board")
      .rpc("item_no_cofre", { p_user_id: userId });

    const nomeTenant = limpo(body.tenant_nome, 120) || "Imobi-Board";
    const papel = limpo(body.papel, 20) || "";
    const notas = [
      `Imobiliaria: ${nomeTenant}`,
      papel ? `Papel: ${papel}` : "",
      `Senha definida pelo console central em ${new Date().toISOString()}`,
      "Se o usuario trocar a senha na tela do CRM, este item aparece como DESATUALIZADO na central.",
    ].filter(Boolean).join("\n");

    let itemId: string | null = itemExistente ? String(itemExistente) : null;
    try {
      const [loginEnc, senhaEnc, notasEnc] = await Promise.all([
        cifrar(db, emailAlvo || null), cifrar(db, senha), cifrar(db, notas),
      ]);
      const campos = {
        category: "CRM",
        system_name: `Imobi-Board - ${emailAlvo}`,
        login_url: CRM_URL,
        login_ciphertext: loginEnc.ciphertext, login_iv: loginEnc.iv,
        password_ciphertext: senhaEnc.ciphertext, password_iv: senhaEnc.iv,
        notes_ciphertext: notasEnc.ciphertext, notes_iv: notasEnc.iv,
        encryption_version: 1,
        updated_by_user_id: ator.userId, updated_by_person: ator.person,
      };

      if (itemId) {
        const { error } = await db.schema("agency_ops").from("client_access_vault")
          .update({ ...campos, updated_at: new Date().toISOString() })
          .eq("id", itemId).eq("client_id", cliente);
        if (error) return json(req, { ok: false, error: "cofre_update_falhou", detalhe: error.message }, 500);
      } else {
        const { data: criado, error } = await db.schema("agency_ops").from("client_access_vault")
          .insert({
            ...campos, client_id: cliente,
            created_by_user_id: ator.userId, created_by_person: ator.person,
          })
          .select("id").single();
        if (error || !criado) {
          return json(req, { ok: false, error: "cofre_insert_falhou", detalhe: error?.message }, 500);
        }
        itemId = String(criado.id);
      }
    } catch (e) {
      const codigo = e instanceof Error ? e.message : "cofre_cifra_falhou";
      return json(req, {
        ok: false,
        error: codigo.startsWith("vault_key_") ? codigo : "cofre_cifra_falhou",
      }, 503);
    }

    // 3. impressao do novo hash: e o que permite dizer depois "isto envelheceu"
    await db.schema("imobi_board").rpc("marcar_senha_no_cofre", {
      p_user_id: userId, p_tenant: tenant, p_item: itemId, p_por: ator.person,
    });

    await auditar(db, ator, cliente, "CRM_DEFINIR_SENHA", itemId, {
      tenant_id: tenant, usuario: emailAlvo,
    });

    return json(req, {
      ok: true,
      usuario: { user_id: userId, email: emailAlvo },
      vault_item_id: itemId,
    });
  }

  return json(req, { ok: false, error: "invalid_action" }, 400);
});

async function clienteDoTenant(db: Admin, tenantId: string): Promise<string | null> {
  const { data } = await db.schema("imobi_board").from("tenants")
    .select("agency_client_id").eq("id", tenantId).maybeSingle();
  return (data?.agency_client_id as string | null) ?? null;
}
