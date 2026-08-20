// [LEONARDO IMOBI] agency-ops-run-readonly-sql — executa 1 SELECT/WITH validado via role restrita agency_ops_ai_reader.
// Uso interno: chamado pelo cenário Make do OpsQuestion. Sempre HTTP 200, corpo {ok,...}.
import postgres from "npm:postgres@3.4.5";

const svcSql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });

const ROW_CAP = 200;
const STATEMENT_TIMEOUT_MS = 8000;

let cachedAskSecret: string | null = null;
let cachedReaderUrl: string | null = null;

async function getSetting(key: string): Promise<string | null> {
  const rows = await svcSql`select value #>> '{}' as s from agency_ops.automation_settings where key = ${key}`;
  return rows.length ? (rows[0].s as string) : null;
}

async function getAskSecret(): Promise<string | null> {
  if (cachedAskSecret) return cachedAskSecret;
  cachedAskSecret = await getSetting("AI_ASK_READ_SECRET");
  return cachedAskSecret;
}

// A senha do papel de leitura vive no Vault, nao em automation_settings - de la'
// qualquer select na tabela a devolvia em texto aberto. O fallback existe apenas
// durante a transicao e sai quando a linha antiga for removida.
async function getReaderPassword(): Promise<string | null> {
  try {
    const rows = await svcSql`select agency_ops.get_ai_reader_password() as s`;
    const fromVault = rows.length ? (rows[0].s as string | null) : null;
    if (fromVault) return fromVault;
  } catch { /* cai no fallback abaixo */ }
  return await getSetting("AI_READER_DB_PASSWORD");
}

async function getReaderUrl(): Promise<string> {
  if (cachedReaderUrl) return cachedReaderUrl;
  const pw = await getReaderPassword();
  if (!pw) throw new Error("missing AI_READER_DB_PASSWORD");
  const orig = new URL(Deno.env.get("SUPABASE_DB_URL")!);
  const suffix = orig.username.includes(".") ? orig.username.slice(orig.username.indexOf(".")) : "";
  orig.username = "agency_ops_ai_reader" + suffix;
  orig.password = pw;
  cachedReaderUrl = orig.toString();
  return cachedReaderUrl;
}

function sqlStructureOnly(input: string): string {
  return input
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""');
}

function validateReadOnlySql(raw: string): { ok: true; sql: string } | { ok: false; error: string } {
  let s = (raw || "").trim();
  if (!s) return { ok: false, error: "empty sql" };
  if (s.length > 6000) return { ok: false, error: "sql too long" };
  if (s.endsWith(";")) s = s.slice(0, -1).trim();

  const structure = sqlStructureOnly(s);
  if (structure.includes(";")) return { ok: false, error: "multiple statements not allowed" };
  if (/--|\/\*/.test(structure)) return { ok: false, error: "comments not allowed" };
  if (!/^(select|with)\b/i.test(structure.trim())) return { ok: false, error: "only SELECT/WITH statements allowed" };

  const bannedWords = [
    "insert", "update", "delete", "drop", "alter", "truncate", "grant", "revoke", "create",
    "copy", "call", "do", "vacuum", "execute", "merge", "lock", "listen", "notify", "refresh",
    "reindex", "cluster", "comment", "security", "dblink", "pg_read_file", "pg_ls_dir",
    "pg_terminate_backend", "pg_reload_conf", "set_config", "lo_import", "lo_export", "into",
    "nextval", "setval", "pg_advisory_lock", "pg_advisory_xact_lock", "pg_notify"
  ];
  for (const word of bannedWords) {
    const re = new RegExp(`\\b${word}\\b`, "i");
    if (re.test(structure)) return { ok: false, error: `disallowed keyword: ${word}` };
  }
  if (/\bfor\s+(update|share|key\s+share|no\s+key\s+update)\b/i.test(structure)) return { ok: false, error: "locking clauses not allowed" };
  return { ok: true, sql: s };
}

Deno.serve(async (req) => {
  if (req.method === "GET" && (new URL(req.url)).searchParams.get("health") === "1") {
    return new Response(JSON.stringify({ ok: true, service: "agency-ops-run-readonly-sql", v: 2, literal_safe_validator: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  let secret: string | null = null;
  try { secret = await getAskSecret(); } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "cfg:" + String(e).slice(0, 150) }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const given = req.headers.get("x-ai-ask-secret");
  if (!secret || !given || given !== secret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json body" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const v = validateReadOnlySql(String(body?.sql ?? ""));
  if (!v.ok) {
    return new Response(JSON.stringify({ ok: false, error: v.error }), { status: 200, headers: { "content-type": "application/json" } });
  }

  let readerSql;
  try {
    const url = await getReaderUrl();
    readerSql = postgres(url, { prepare: false, max: 1, connect_timeout: 8 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "conn-cfg:" + String(e).slice(0, 150) }), { status: 200, headers: { "content-type": "application/json" } });
  }

  try {
    const wrapped = `select * from (${v.sql}) as ai_sql_wrap limit ${ROW_CAP}`;
    const rows = await readerSql.begin(async (tx: any) => {
      await tx.unsafe(`set local statement_timeout = '${STATEMENT_TIMEOUT_MS}'`);
      return await tx.unsafe(wrapped);
    });
    return new Response(JSON.stringify({ ok: true, row_count: rows.length, row_cap: ROW_CAP, rows }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "query:" + String(e).slice(0, 300) }), { status: 200, headers: { "content-type": "application/json" } });
  } finally {
    try { await readerSql.end({ timeout: 1 }); } catch { /* ignore */ }
  }
});
