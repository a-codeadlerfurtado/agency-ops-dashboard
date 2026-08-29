import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const REPOSITORY = "a-codeadlerfurtado/agency-ops-dashboard";
const AUDIENCE = "agency-ops-system-updates";
const OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const VALID_ROLES = new Set(["ALL", "MGMT", "GT", "CS", "DESIGN", "AI", "COMMERCIAL"]);

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
});

const b64url = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

async function verifyGithubOidc(token: string) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_oidc_token");
  const header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
  const claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  if (header.alg !== "RS256" || !header.kid) throw new Error("invalid_oidc_header");

  const jwksResponse = await fetch(JWKS_URL, { cache: "no-store" });
  if (!jwksResponse.ok) throw new Error("github_jwks_unavailable");
  const jwks = await jwksResponse.json();
  const jwk = (jwks?.keys || []).find((key: any) => key.kid === header.kid);
  if (!jwk) throw new Error("github_jwk_not_found");
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new Error("invalid_oidc_signature");

  const now = Math.floor(Date.now() / 1000);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== OIDC_ISSUER) throw new Error("invalid_oidc_issuer");
  if (!audience.includes(AUDIENCE)) throw new Error("invalid_oidc_audience");
  if (claims.repository !== REPOSITORY) throw new Error("invalid_oidc_repository");
  if (claims.ref !== "refs/heads/main") throw new Error("invalid_oidc_ref");
  if (claims.event_name !== "push") throw new Error("invalid_oidc_event");
  if (Number(claims.exp || 0) < now - 10) throw new Error("expired_oidc_token");
  if (Number(claims.nbf || 0) > now + 30) throw new Error("oidc_not_yet_valid");
  return claims;
}

function explicitScopes(message: string) {
  const match = message.match(/^Update-Scopes:\s*(.+)$/mi);
  if (!match) return null;
  const roles = match[1].split(/[;,]/).map((item) => item.trim().toUpperCase()).filter((item) => VALID_ROLES.has(item));
  return roles.length ? Array.from(new Set(roles)) : null;
}

function classifyRoles(files: Array<{ path?: string }>, message: string) {
  const explicit = explicitScopes(message);
  if (explicit) return explicit.includes("ALL") ? ["ALL"] : Array.from(new Set([...explicit, "MGMT"]));

  const paths = files.map((file) => String(file.path || "").toLowerCase());
  const roles = new Set<string>();
  const has = (pattern: RegExp) => paths.some((path) => pattern.test(path));

  if (has(/system-update|daily-greeting|sidebar-information|notifications-home|profile-menu|logout-shortcut|home-shortcut/)) roles.add("ALL");
  if (has(/meta-(consultant|weekly|performance|radar|analysis)|campaign|client-balances/)) roles.add("GT");
  if (has(/creative|vision/)) { roles.add("DESIGN"); roles.add("GT"); }
  if (has(/onboarding|client-notification|lead-quality|churned-client/)) { roles.add("CS"); roles.add("GT"); }
  if (has(/preclient|commercial/)) roles.add("COMMERCIAL");
  if (has(/donnah|opsquestion|ai-head|\/api\/ai|server\//)) roles.add("AI");
  if (has(/client-access-vault/)) roles.add("GT");
  if (has(/finance|contract|mensalidade/)) roles.add("MGMT");

  if (roles.has("ALL")) return ["ALL"];
  if (!roles.size) roles.add("ALL");
  else roles.add("MGMT");
  return Array.from(roles);
}

function fallbackSummary(subject: string, files: Array<{ path?: string }>) {
  const lower = subject.toLowerCase();
  const added: string[] = [];
  const fixed: string[] = [];
  const removed: string[] = [];
  if (/\b(add|adds|added|create|creates|created|launch|enable|implement|introduce)\b/.test(lower)) added.push(subject);
  else if (/\b(remove|removes|removed|delete|deletes|deleted)\b/.test(lower)) removed.push(subject);
  else fixed.push(subject);
  const areas = Array.from(new Set(files.map((f) => String(f.path || "").split("/").slice(0, 2).join("/")).filter(Boolean))).slice(0, 4);
  return {
    title: subject,
    added,
    fixed,
    removed,
    explanation: areas.length
      ? `Esta atualização mexe principalmente em ${areas.join(", ")}. O aviso foi filtrado para aparecer somente nos perfis relacionados a essas áreas.`
      : "Esta atualização foi registrada no histórico do Dashboard e será mostrada somente aos perfis afetados.",
    source: "DETERMINISTIC",
  };
}

function parseJsonAnswer(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return null;
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { return null; }
}

async function aiSummary(ops: any, subject: string, body: string, files: any[], roles: string[]) {
  const [{ data: endpointCfg }, { data: secretCfg }] = await Promise.all([
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_ENDPOINT_URL").maybeSingle(),
    ops.from("automation_settings").select("value").eq("key", "AI_ASK_READ_SECRET").maybeSingle(),
  ]);
  const endpoint = typeof endpointCfg?.value === "string" ? endpointCfg.value : null;
  const secret = typeof secretCfg?.value === "string" ? secretCfg.value : null;
  if (!endpoint || !secret) return null;

  const compactFiles = files.slice(0, 40).map((f) => `${f.status || "M"} ${f.path || ""} (+${f.additions || 0}/-${f.deletions || 0})`).join("\n");
  const prompt = `Você escreve patch notes internos do Dashboard Leonardo Imobi.\n\nTransforme este commit técnico em uma atualização curta, clara e útil em português do Brasil. Não invente nada. Explique o que mudou para a pessoa que usa o sistema, não para um programador.\n\nRetorne SOMENTE JSON válido neste formato:\n{\n  "title": "título humano com no máximo 70 caracteres",\n  "added": ["o que foi acrescentado"],\n  "fixed": ["o que foi corrigido ou melhorado"],\n  "removed": ["o que foi retirado"],\n  "explanation": "como isso se conecta ao trabalho do perfil e onde a pessoa percebe a mudança"\n}\n\nUse arrays vazios quando uma categoria não existir. Não cite SHA, arquivo, schema, banco ou código salvo se isso for indispensável para explicar o uso.\n\nPerfis que receberão este aviso: ${roles.join(", ")}\nCommit: ${subject}\nDescrição: ${body || "sem descrição adicional"}\nArquivos alterados:\n${compactFiles}`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ai-read-secret": secret },
      body: JSON.stringify({
        question: prompt,
        original_question: subject,
        source: "SystemUpdateReleaseNotes",
        constraints: { read_only: true, no_invention: true, language: "pt-BR", output: "json" },
      }),
    });
    if (!response.ok) return null;
    const raw = await response.text();
    let parsed: any = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch {}
    const answer = parsed?.answer ?? parsed?.response ?? parsed?.output ?? parsed?.result ?? parsed?.text ?? raw;
    const json = parseJsonAnswer(answer);
    if (!json?.title || !json?.explanation) return null;
    return {
      title: String(json.title).slice(0, 160),
      added: Array.isArray(json.added) ? json.added.map(String).slice(0, 6) : [],
      fixed: Array.isArray(json.fixed) ? json.fixed.map(String).slice(0, 6) : [],
      removed: Array.isArray(json.removed) ? json.removed.map(String).slice(0, 6) : [],
      explanation: String(json.explanation).slice(0, 1600),
      source: "AI",
    };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return reply({ ok: false, error: "missing_oidc_token" }, 401);

  let claims: any;
  try { claims = await verifyGithubOidc(auth.slice(7)); }
  catch (error) { return reply({ ok: false, error: String(error instanceof Error ? error.message : error) }, 401); }

  const body = await req.json().catch(() => ({}));
  const sha = String(body?.sha || "").trim();
  const subject = String(body?.subject || "").trim().slice(0, 500);
  const messageBody = String(body?.body || "").trim().slice(0, 12000);
  const committedAt = String(body?.committed_at || "").trim();
  const files = Array.isArray(body?.files) ? body.files.slice(0, 200).map((file: any) => ({
    path: String(file?.path || "").slice(0, 500),
    status: String(file?.status || "M").slice(0, 20),
    additions: Math.max(0, Number(file?.additions || 0)),
    deletions: Math.max(0, Number(file?.deletions || 0)),
  })) : [];
  if (!/^[0-9a-f]{40}$/i.test(sha) || !subject || !committedAt) return reply({ ok: false, error: "invalid_payload" }, 400);
  if (claims.sha && claims.sha !== sha) return reply({ ok: false, error: "sha_claim_mismatch" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRole) return reply({ ok: false, error: "server_configuration" }, 500);
  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");

  const roles = classifyRoles(files, `${subject}\n${messageBody}`);
  const fallback = fallbackSummary(subject, files);
  const generated = await aiSummary(ops, subject, messageBody, files, roles) || fallback;
  const additions = files.reduce((sum: number, file: any) => sum + Number(file.additions || 0), 0);
  const deletions = files.reduce((sum: number, file: any) => sum + Number(file.deletions || 0), 0);

  const { error } = await ops.from("system_update_commits").upsert({
    sha,
    committed_at: committedAt,
    subject,
    body: messageBody || null,
    changed_files: files,
    additions,
    deletions,
    target_roles: roles,
    title: generated.title,
    added: generated.added,
    fixed: generated.fixed,
    removed: generated.removed,
    explanation: generated.explanation,
    summary_source: generated.source,
    ingested_at: new Date().toISOString(),
  }, { onConflict: "sha" });
  if (error) return reply({ ok: false, error: "database_write_failed", detail: error.message }, 500);
  return reply({ ok: true, sha, target_roles: roles, summary_source: generated.source });
});
