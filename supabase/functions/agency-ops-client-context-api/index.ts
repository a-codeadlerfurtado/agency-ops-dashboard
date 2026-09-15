import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);
const CORS_BASE = {
  "access-control-allow-headers": "authorization,apikey,content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-max-age": "86400",
};
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 750_000;

type Row = Record<string, any>;

function normalizeFileName(value: unknown) {
  return String(value || "transcricao.txt").replace(/[\\/\0]/g, "-").trim().slice(0, 180) || "transcricao.txt";
}

function extensionOf(name: string) {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "";
}

function extractHeader(content: string) {
  const lines = content.split(/\r?\n/).slice(0, 60);
  const pick = (label: string) => {
    const rx = new RegExp(`^${label}\\s*:\\s*(.+)$`, "i");
    for (const raw of lines) {
      const m = raw.trim().match(rx);
      if (m?.[1]) return m[1].trim();
    }
    return "";
  };
  const participants: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    const match = raw.match(/^Participantes\s*:\s*(.*)$/i);
    if (!match) continue;
    if (match[1]?.trim()) participants.push(...match[1].split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean));
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j].trim();
      if (!next || next === "---" || /^(Cliente|Data|Hor[aá]rio|Assunto)\s*:/i.test(next)) break;
      if (/^[-•]\s+/.test(next)) participants.push(next.replace(/^[-•]\s+/, "").trim());
      else break;
    }
    break;
  }
  return {
    client: pick("Cliente"), date: pick("Data"), time: pick("Hor[aá]rio"), subject: pick("Assunto"),
    participants: [...new Set(participants)].slice(0, 30),
  };
}

function resolveOccurredAt(explicitValue: unknown, dateText: string, timeText: string) {
  const explicit = String(explicitValue || "").trim();
  if (explicit) {
    const parsed = new Date(explicit);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  let isoDate = "";
  const br = dateText.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  const iso = dateText.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (br) isoDate = `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  if (iso) isoDate = `${iso[1]}-${iso[2]}-${iso[3]}`;
  if (isoDate) {
    const hm = timeText.match(/\b(\d{1,2}):(\d{2})\b/);
    return `${isoDate}T${hm ? hm[1].padStart(2, "0") : "12"}:${hm ? hm[2] : "00"}:00-03:00`;
  }
  return new Date().toISOString();
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const originAllowed = !origin || ALLOWED_ORIGINS.has(origin);
  const cors = origin && originAllowed ? { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" } : CORS_BASE;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
  if (req.method === "OPTIONS") return new Response(null, { status: originAllowed ? 204 : 403, headers: cors });
  if (!originAllowed) return reply({ error: "origin_not_allowed" }, 403);
  if (!["GET", "POST"].includes(req.method)) return reply({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !anonKey || !serviceRole) return reply({ error: "server_configuration" }, 500);
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return reply({ error: "unauthorized" }, 401);
  const auth = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: authError } = await auth.auth.getUser();
  if (authError || !userData?.user?.id) return reply({ error: "unauthorized" }, 401);

  const db = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false, autoRefreshToken: false } });
  const ops = db.schema("agency_ops");
  const userKey = userData.user.id;
  const [{ data: pref }, { data: approvals }] = await Promise.all([
    ops.from("user_preferences").select("collaborator_person,name").eq("user_key", userKey).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key", userKey).eq("status", "APPROVED"),
  ]);
  const person = String(pref?.collaborator_person || pref?.name || "").trim();
  if (!person || !(approvals || []).some((row: Row) => row.kind === "SIGNUP")) return reply({ error: "profile_locked" }, 403);
  const { data: roster } = await ops.from("team_roster").select("person,role,access_level,is_former").eq("person", person).eq("is_former", false).maybeSingle();
  if (!roster) return reply({ error: "profile_not_found" }, 403);
  const role = String(roster.role || "").toUpperCase();
  const isAdler = person === "Adler Furtado";
  const isLeonardo = person === "Leonardo Augusto" && role === "COMMERCIAL";
  if (!(isAdler || isLeonardo || ["GT", "CS", "MGMT"].includes(role))) return reply({ error: "forbidden" }, 403);
  const elevated = (approvals || []).some((row: Row) => row.kind === "ELEVATION");

  const requestUrl = new URL(req.url);
  let body: Row = {};
  if (req.method === "POST") { try { body = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); } }
  const clientId = String(req.method === "POST" ? body.client_id || "" : requestUrl.searchParams.get("client_id") || "").trim();
  const name = String(req.method === "POST" ? body.client_name || "" : requestUrl.searchParams.get("name") || "").trim();
  if (!clientId && !name) return reply({ error: "missing_client" }, 400);

  let client: Row | null = null;
  if (clientId) {
    const { data, error } = await ops.from("clients").select("id,display_name,lifecycle,gt_owner").eq("id", clientId).maybeSingle();
    if (error) return reply({ error: "query_failed" }, 500); client = data;
  } else {
    const { data, error } = await ops.from("clients").select("id,display_name,lifecycle,gt_owner").eq("display_name", name).limit(2);
    if (error) return reply({ error: "query_failed" }, 500);
    if ((data || []).length > 1) return reply({ error: "ambiguous_client" }, 409); client = data?.[0] ?? null;
  }
  if (!client) return reply({ error: "client_not_found" }, 404);
  if (role === "GT" && !elevated && String(client.gt_owner || "") !== person) return reply({ error: "forbidden" }, 403);

  if (req.method === "GET") {
    const transcriptId = Number(requestUrl.searchParams.get("transcript_id") || 0);
    if (transcriptId > 0) {
      const { data, error } = await ops.from("meeting_transcripts").select("id,source_system,source_file_name,meeting_started_at,transcript_text,summary,participants,decisions,commitments,ai_signals,metadata,created_at").eq("client_id", client.id).eq("id", transcriptId).maybeSingle();
      if (error) return reply({ error: "query_failed" }, 500);
      if (!data) return reply({ error: "transcript_not_found" }, 404);
      return reply({ client: { client_id: client.id, display_name: client.display_name }, transcript: data });
    }
    const { data, error } = await ops.from("meeting_transcripts").select("id,source_system,source_file_name,meeting_started_at,summary,transcript_chars,participants,ai_signals,metadata,created_at").eq("client_id", client.id).order("meeting_started_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(8);
    if (error) return reply({ error: "query_failed" }, 500);
    return reply({ client: { client_id: client.id, display_name: client.display_name }, records: data || [], permissions: { upload: true, view: true }, generated_at: new Date().toISOString() });
  }

  const fileName = normalizeFileName(body.file_name);
  const ext = extensionOf(fileName);
  if (!["txt", "md"].includes(ext)) return reply({ error: "unsupported_file_type", allowed: ["txt", "md"] }, 415);
  const mimeType = String(body.mime_type || (ext === "md" ? "text/markdown" : "text/plain")).slice(0, 120);
  const content = String(body.content || "").replace(/\u0000/g, "").trim();
  const byteSize = new TextEncoder().encode(content).byteLength;
  if (byteSize > MAX_BYTES || content.length > MAX_CHARS) return reply({ error: "file_too_large", max_bytes: MAX_BYTES }, 413);
  if (content.length < 20) return reply({ error: "transcript_too_short" }, 400);
  const userContext = String(body.context || "").trim().slice(0, 4000);
  const interactionType = String(body.interaction_type || "CALL").trim().toUpperCase().slice(0, 40);
  const header = extractHeader(content);
  const occurredAt = resolveOccurredAt(body.occurred_at, header.date, header.time);
  const contentHash = await sha256(content);
  const { data: duplicate, error: dupError } = await ops.from("meeting_transcripts").select("id,source_file_name,meeting_started_at,summary,transcript_chars").eq("client_id", client.id).eq("content_sha256", contentHash).limit(1).maybeSingle();
  if (dupError) return reply({ error: "query_failed" }, 500);
  if (duplicate) return reply({ ok: true, duplicate: true, transcript: duplicate, message: "Este conteúdo já está salvo neste cliente." });

  const sourceFileId = `dashboard-${crypto.randomUUID()}`;
  const participants = Array.isArray(body.participants) && body.participants.length ? body.participants.slice(0, 30) : header.participants;
  const { data: inserted, error: insertError } = await ops.from("meeting_transcripts").insert({
    source_system: "DASHBOARD_UPLOAD", source_file_id: sourceFileId, source_file_name: fileName, source_folder_id: null, source_url: null,
    meeting_key: `dashboard:${client.id}:${contentHash.slice(0, 20)}`, meeting_code: null, meeting_started_at: occurredAt,
    transcript_text: content, content_sha256: contentHash, source_file_ids: [sourceFileId], copies_seen: 1,
    client_id: client.id, client_name_raw: client.display_name, match_status: "MANUAL", match_confidence: 1, participants,
    source_created_at: new Date().toISOString(), source_updated_at: new Date().toISOString(),
    metadata: { transport: "DASHBOARD_UPLOAD", mime_type: mimeType, extension: ext, size: byteSize, uploaded_by: person, uploaded_by_user_id: userKey, interaction_type: interactionType, user_context: userContext || null, header },
  }).select("id,source_file_name,meeting_started_at,transcript_chars").single();
  if (insertError || !inserted) return reply({ error: "insert_failed", detail: insertError?.message || null }, 500);

  let processing: Row | null = null;
  try { const { data } = await ops.rpc("process_meeting_transcript", { p_id: inserted.id }); processing = data as Row | null; } catch { /* bruto preservado */ }
  const { data: enriched } = await ops.from("meeting_transcripts").select("id,source_system,source_file_name,meeting_started_at,summary,transcript_chars,participants,decisions,commitments,ai_signals,metadata,created_at").eq("id", inserted.id).maybeSingle();
  const subject = String(header.subject || body.subject || "").trim().slice(0, 220);
  const baseTitle = interactionType === "MEETING" ? "Reunião registrada" : interactionType === "NOTE" ? "Contexto registrado" : "Ligação registrada";
  const noteTitle = subject || `${baseTitle} — ${new Intl.DateTimeFormat("pt-BR").format(new Date(occurredAt))}`;
  const excerpt = content.replace(/\s+/g, " ").slice(0, 1800);
  const noteBody = String(enriched?.summary || "").trim() || [`${baseTitle} por ${person}.`, userContext ? `Contexto adicional: ${userContext}` : "", subject ? `Assunto: ${subject}.` : "", `Trecho da transcrição: ${excerpt}`].filter(Boolean).join("\n\n");
  await ops.from("client_notes").insert({ client_id: client.id, title: noteTitle, body: noteBody, note_type: "CONTEXT", importance: "IMPORTANT", is_pinned: false, use_as_ai_context: true, sensitivity: "NORMAL", created_by_user_key: userKey, created_by_person: person, metadata: { source_transcript_id: inserted.id, source_system: "DASHBOARD_UPLOAD", file_name: fileName, interaction_type: interactionType, occurred_at: occurredAt } });
  return reply({ ok: true, duplicate: false, client: { client_id: client.id, display_name: client.display_name }, transcript: enriched || inserted, processing, context_added: true }, 201);
});
