import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
type Identity = { userId: string; email: string; person: string; role: string };
type Client = { client_id: string; display_name: string; lifecycle?: string | null; gt_owner?: string | null; cs_owner?: string | null };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const ENV_VAULT_KEY_B64 = Deno.env.get("CLIENT_VAULT_KEY_B64") || "";
const PROD_ORIGIN = "https://agency-ops-dashboard.lakassessoriadigital.workers.dev";
const EXTRA_ORIGINS = (Deno.env.get("CLIENT_VAULT_ALLOWED_ORIGINS") || "").split(",").map((v) => v.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([PROD_ORIGIN, "http://localhost:3000", ...EXTRA_ORIGINS]);
const CATEGORIES = new Set(["CRM", "SITE", "GOOGLE_BUSINESS", "PORTAL", "OTHER"]);
const REAUTH_FAILURE_LIMIT = 5;
const REAUTH_WINDOW_MINUTES = 15;

function cors(req: Request) {
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": !origin || ALLOWED_ORIGINS.has(origin) ? (origin || PROD_ORIGIN) : "null",
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
      "expires": "0",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

const clean = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max);
const norm = (value: unknown) => clean(value, 500).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ");

function ownerMatches(owner: unknown, person: string) {
  const a = norm(owner), b = norm(person);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.split(/\s*(?:,|;|\||\/|&|\be\b)\s*/g).filter(Boolean).includes(b);
}

function safeUrl(value: unknown) {
  const raw = clean(value, 1000);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function b64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function bytesToB64(value: Uint8Array) {
  let binary = "";
  for (let i = 0; i < value.length; i += 0x8000) binary += String.fromCharCode(...value.subarray(i, i + 0x8000));
  return btoa(binary);
}

function makeAdmin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

let keyPromise: Promise<CryptoKey> | null = null;
async function encryptionKey(admin: ReturnType<typeof makeAdmin>) {
  if (!keyPromise) {
    keyPromise = (async () => {
      let b64 = ENV_VAULT_KEY_B64;
      if (!b64) {
        const { data, error } = await admin.schema("agency_ops").rpc("get_client_vault_key");
        if (error || !data) throw new Error("vault_key_missing");
        b64 = String(data);
      }
      const raw = b64ToBytes(b64);
      if (raw.byteLength !== 32) throw new Error("vault_key_invalid_length");
      return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
  }
  return keyPromise;
}

async function encrypt(admin: ReturnType<typeof makeAdmin>, value: string | null) {
  if (!value) return { ciphertext: null, iv: null };
  const key = await encryptionKey(admin);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return { ciphertext: bytesToB64(new Uint8Array(encrypted)), iv: bytesToB64(iv) };
}

async function decrypt(admin: ReturnType<typeof makeAdmin>, ciphertext: unknown, iv: unknown) {
  if (!ciphertext || !iv) return null;
  const key = await encryptionKey(admin);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(String(iv)) }, key, b64ToBytes(String(ciphertext)));
  return new TextDecoder().decode(plaintext);
}

async function getIdentity(admin: ReturnType<typeof makeAdmin>, req: Request): Promise<Identity | null> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const { data: authData, error } = await admin.auth.getUser(token);
  const user = authData?.user;
  if (error || !user?.id || !user.email) return null;
  const email = user.email.toLowerCase();
  const { data: login } = await admin.schema("agency_ops").from("team_login_emails").select("person").eq("email", email).eq("active", true).maybeSingle();
  if (!login?.person) return null;
  const { data: roster } = await admin.schema("agency_ops").from("team_roster").select("role,is_former").eq("person", login.person).maybeSingle();
  if (!roster?.role || roster.is_former === true) return null;
  return { userId: user.id, email, person: String(login.person), role: String(roster.role).toUpperCase() };
}

async function getClient(admin: ReturnType<typeof makeAdmin>, body: Row): Promise<Client | null | "AMBIGUOUS"> {
  const id = clean(body.client_id, 80);
  const select = "client_id,display_name,lifecycle,gt_owner,cs_owner";
  if (id) {
    const { data } = await admin.schema("agency_ops").from("dashboard_client_overview").select(select).eq("client_id", id).maybeSingle();
    return data ? data as Client : null;
  }
  const name = clean(body.client_name, 240);
  if (!name) return null;
  const { data } = await admin.schema("agency_ops").from("dashboard_client_overview").select(select).eq("display_name", name).limit(2);
  if (!data?.length) return null;
  if (data.length > 1) return "AMBIGUOUS";
  return data[0] as Client;
}

function canAccess(actor: Identity, client: Client) {
  if (actor.role === "MGMT") return true;
  if (actor.role === "GT") return ownerMatches(client.gt_owner, actor.person);
  if (actor.role === "CS") return ownerMatches(client.cs_owner, actor.person);
  return false;
}
const canManage = (actor: Identity) => actor.role === "MGMT";

async function audit(admin: ReturnType<typeof makeAdmin>, actor: Identity, client: Client, action: string, itemId: string | null = null, detail: Row = {}) {
  const safe: Row = {};
  for (const [key, value] of Object.entries(detail)) {
    if (["password", "login", "notes", "ciphertext", "iv", "dashboard_password"].includes(key)) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  await admin.schema("agency_ops").from("client_access_vault_audit").insert({
    client_id: client.client_id, vault_item_id: itemId, actor_user_id: actor.userId,
    actor_person: actor.person, actor_role: actor.role, action, detail: safe,
  });
}

async function reauthenticate(admin: ReturnType<typeof makeAdmin>, actor: Identity, client: Client, suppliedValue: unknown) {
  const since = new Date(Date.now() - REAUTH_WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await admin.schema("agency_ops").from("client_access_vault_audit").select("id", { count: "exact", head: true })
    .eq("actor_user_id", actor.userId).eq("action", "REAUTH_FAILED").gte("created_at", since);
  if (Number(count || 0) >= REAUTH_FAILURE_LIMIT) {
    await audit(admin, actor, client, "REAUTH_LOCKED", null, { window_minutes: REAUTH_WINDOW_MINUTES });
    return { ok: false as const, status: 429, error: "reauth_locked" };
  }
  const password = String(suppliedValue || "");
  if (!password || password.length > 256) {
    await audit(admin, actor, client, "REAUTH_FAILED", null, { reason: "missing_or_invalid_length" });
    return { ok: false as const, status: 403, error: "invalid_reauthentication" };
  }
  const verifier = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await verifier.auth.signInWithPassword({ email: actor.email, password });
  if (error || data.user?.id !== actor.userId) {
    await audit(admin, actor, client, "REAUTH_FAILED", null, { reason: "password_rejected" });
    return { ok: false as const, status: 403, error: "invalid_reauthentication" };
  }
  try { await verifier.auth.signOut(); } catch { /* no-op */ }
  return { ok: true as const };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(req, { ok: false, error: "origin_not_allowed" }, 403);
  if (req.method !== "POST") return json(req, { ok: false, error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) return json(req, { ok: false, error: "server_configuration_missing" }, 503);

  const admin = makeAdmin();
  const actor = await getIdentity(admin, req);
  if (!actor) return json(req, { ok: false, error: "unauthorized" }, 401);
  let body: Row;
  try { body = await req.json(); } catch { return json(req, { ok: false, error: "invalid_json" }, 400); }
  const action = clean(body.action, 40).toUpperCase();
  const client = await getClient(admin, body);
  if (client === "AMBIGUOUS") return json(req, { ok: false, error: "ambiguous_client" }, 409);
  if (!client) return json(req, { ok: false, error: "client_not_found" }, 404);
  if (!canAccess(actor, client)) {
    await audit(admin, actor, client, "ACCESS_DENIED", null, { requested_action: action });
    return json(req, { ok: false, error: "forbidden" }, 403);
  }

  if (action === "LIST") {
    const { data: items, error } = await admin.schema("agency_ops").from("client_access_vault")
      .select("id,client_id,category,system_name,login_url,encryption_version,created_at,created_by_person,updated_at,updated_by_person")
      .eq("client_id", client.client_id).order("category").order("system_name");
    if (error) return json(req, { ok: false, error: "vault_read_failed" }, 500);
    await audit(admin, actor, client, "LIST", null, { item_count: items?.length || 0 });
    let auditRows: Row[] = [];
    if (canManage(actor)) {
      const { data } = await admin.schema("agency_ops").from("client_access_vault_audit")
        .select("id,vault_item_id,actor_person,actor_role,action,detail,created_at")
        .eq("client_id", client.client_id).order("created_at", { ascending: false }).limit(25);
      auditRows = data || [];
    }
    return json(req, { ok: true, client: { client_id: client.client_id, display_name: client.display_name }, permissions: { role: actor.role, can_manage: canManage(actor), can_reveal: true }, items: items || [], audit: auditRows });
  }

  const itemId = clean(body.item_id, 80);

  if (action === "REVEAL") {
    if (!itemId) return json(req, { ok: false, error: "item_id_required" }, 400);
    const reauth = await reauthenticate(admin, actor, client, body.dashboard_password);
    if (!reauth.ok) return json(req, { ok: false, error: reauth.error }, reauth.status);
    const { data: item } = await admin.schema("agency_ops").from("client_access_vault")
      .select("id,category,system_name,login_url,login_ciphertext,login_iv,password_ciphertext,password_iv,notes_ciphertext,notes_iv")
      .eq("id", itemId).eq("client_id", client.client_id).maybeSingle();
    if (!item) return json(req, { ok: false, error: "credential_not_found" }, 404);
    try {
      const [login, password, notes] = await Promise.all([
        decrypt(admin, item.login_ciphertext, item.login_iv),
        decrypt(admin, item.password_ciphertext, item.password_iv),
        decrypt(admin, item.notes_ciphertext, item.notes_iv),
      ]);
      await audit(admin, actor, client, "REVEAL", item.id, { system_name: item.system_name, category: item.category });
      return json(req, { ok: true, credential: { id: item.id, category: item.category, system_name: item.system_name, login_url: item.login_url, login, password, notes, revealed_at: new Date().toISOString(), expires_in_seconds: 60 } });
    } catch (error) {
      const code = error instanceof Error ? error.message : "credential_decryption_failed";
      return json(req, { ok: false, error: code.startsWith("vault_key_") ? code : "credential_decryption_failed" }, 500);
    }
  }

  if (action === "COPY") {
    const field = clean(body.field, 20).toUpperCase();
    if (!itemId || !["LOGIN", "PASSWORD"].includes(field)) return json(req, { ok: false, error: "invalid_copy_request" }, 400);
    const { data: item } = await admin.schema("agency_ops").from("client_access_vault").select("id,system_name").eq("id", itemId).eq("client_id", client.client_id).maybeSingle();
    if (!item) return json(req, { ok: false, error: "credential_not_found" }, 404);
    await audit(admin, actor, client, field === "LOGIN" ? "COPY_LOGIN" : "COPY_PASSWORD", item.id, { system_name: item.system_name });
    return json(req, { ok: true });
  }

  if (!canManage(actor)) return json(req, { ok: false, error: "management_only" }, 403);

  if (action === "CREATE") {
    const reauth = await reauthenticate(admin, actor, client, body.dashboard_password);
    if (!reauth.ok) return json(req, { ok: false, error: reauth.error }, reauth.status);
    const category = clean(body.category, 40).toUpperCase() || "CRM";
    const systemName = clean(body.system_name, 120);
    const loginUrl = safeUrl(body.login_url);
    const loginValue = clean(body.login, 320);
    const passwordValue = String(body.password || "").slice(0, 1000);
    const notesValue = clean(body.notes, 2000);
    if (!CATEGORIES.has(category)) return json(req, { ok: false, error: "invalid_category" }, 400);
    if (!systemName) return json(req, { ok: false, error: "system_name_required" }, 400);
    if (!passwordValue) return json(req, { ok: false, error: "password_required" }, 400);
    if (body.login_url && !loginUrl) return json(req, { ok: false, error: "invalid_login_url" }, 400);
    try {
      const [loginEnc, passEnc, notesEnc] = await Promise.all([encrypt(admin, loginValue || null), encrypt(admin, passwordValue), encrypt(admin, notesValue || null)]);
      const { data: created, error } = await admin.schema("agency_ops").from("client_access_vault").insert({
        client_id: client.client_id, category, system_name: systemName, login_url: loginUrl,
        login_ciphertext: loginEnc.ciphertext, login_iv: loginEnc.iv,
        password_ciphertext: passEnc.ciphertext, password_iv: passEnc.iv,
        notes_ciphertext: notesEnc.ciphertext, notes_iv: notesEnc.iv,
        encryption_version: 1, created_by_user_id: actor.userId, created_by_person: actor.person,
        updated_by_user_id: actor.userId, updated_by_person: actor.person,
      }).select("id,category,system_name,login_url,created_at,updated_at").single();
      if (error || !created) return json(req, { ok: false, error: "credential_create_failed" }, 500);
      await audit(admin, actor, client, "CREATE", created.id, { system_name: systemName, category });
      return json(req, { ok: true, item: created }, 201);
    } catch (error) {
      const code = error instanceof Error ? error.message : "credential_encryption_failed";
      return json(req, { ok: false, error: code.startsWith("vault_key_") ? code : "credential_encryption_failed" }, 503);
    }
  }

  if (action === "UPDATE") {
    if (!itemId) return json(req, { ok: false, error: "item_id_required" }, 400);
    const reauth = await reauthenticate(admin, actor, client, body.dashboard_password);
    if (!reauth.ok) return json(req, { ok: false, error: reauth.error }, reauth.status);
    const { data: current } = await admin.schema("agency_ops").from("client_access_vault").select("id").eq("id", itemId).eq("client_id", client.client_id).maybeSingle();
    if (!current) return json(req, { ok: false, error: "credential_not_found" }, 404);
    const patch: Row = { updated_at: new Date().toISOString(), updated_by_user_id: actor.userId, updated_by_person: actor.person };
    if (Object.hasOwn(body, "category")) {
      const category = clean(body.category, 40).toUpperCase();
      if (!CATEGORIES.has(category)) return json(req, { ok: false, error: "invalid_category" }, 400);
      patch.category = category;
    }
    if (Object.hasOwn(body, "system_name")) {
      const systemName = clean(body.system_name, 120);
      if (!systemName) return json(req, { ok: false, error: "system_name_required" }, 400);
      patch.system_name = systemName;
    }
    if (Object.hasOwn(body, "login_url")) {
      const loginUrl = safeUrl(body.login_url);
      if (body.login_url && !loginUrl) return json(req, { ok: false, error: "invalid_login_url" }, 400);
      patch.login_url = loginUrl;
    }
    try {
      if (body.clear_login === true) { patch.login_ciphertext = null; patch.login_iv = null; }
      else if (clean(body.login, 320)) { const x = await encrypt(admin, clean(body.login, 320)); patch.login_ciphertext = x.ciphertext; patch.login_iv = x.iv; }
      if (String(body.password || "")) { const x = await encrypt(admin, String(body.password).slice(0, 1000)); patch.password_ciphertext = x.ciphertext; patch.password_iv = x.iv; }
      if (body.clear_notes === true) { patch.notes_ciphertext = null; patch.notes_iv = null; }
      else if (clean(body.notes, 2000)) { const x = await encrypt(admin, clean(body.notes, 2000)); patch.notes_ciphertext = x.ciphertext; patch.notes_iv = x.iv; }
    } catch (error) {
      const code = error instanceof Error ? error.message : "credential_encryption_failed";
      return json(req, { ok: false, error: code.startsWith("vault_key_") ? code : "credential_encryption_failed" }, 503);
    }
    const { data: updated, error } = await admin.schema("agency_ops").from("client_access_vault").update(patch).eq("id", itemId).eq("client_id", client.client_id)
      .select("id,category,system_name,login_url,created_at,updated_at").single();
    if (error || !updated) return json(req, { ok: false, error: "credential_update_failed" }, 500);
    await audit(admin, actor, client, "UPDATE", itemId, { system_name: updated.system_name, category: updated.category, login_changed: Boolean(body.login || body.clear_login), password_changed: Boolean(body.password), notes_changed: Boolean(body.notes || body.clear_notes) });
    return json(req, { ok: true, item: updated });
  }

  if (action === "DELETE") {
    if (!itemId) return json(req, { ok: false, error: "item_id_required" }, 400);
    const reauth = await reauthenticate(admin, actor, client, body.dashboard_password);
    if (!reauth.ok) return json(req, { ok: false, error: reauth.error }, reauth.status);
    const { data: current } = await admin.schema("agency_ops").from("client_access_vault").select("id,system_name,category").eq("id", itemId).eq("client_id", client.client_id).maybeSingle();
    if (!current) return json(req, { ok: false, error: "credential_not_found" }, 404);
    const { error } = await admin.schema("agency_ops").from("client_access_vault").delete().eq("id", itemId).eq("client_id", client.client_id);
    if (error) return json(req, { ok: false, error: "credential_delete_failed" }, 500);
    await audit(admin, actor, client, "DELETE", itemId, { system_name: current.system_name, category: current.category });
    return json(req, { ok: true });
  }

  return json(req, { ok: false, error: "invalid_action" }, 400);
});
