import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";

let cachedMaterialSecret: string | null = null;
let cachedVideoWorkerToken: string | null = null;

async function getSettingSecret(key: string): Promise<string | null> {
  const rows = await sql`select value #>> '{}' as s from agency_ops.automation_settings where key = ${key}`;
  return rows.length ? (rows[0].s as string) : null;
}

async function getMaterialSecret(): Promise<string | null> {
  if (cachedMaterialSecret) return cachedMaterialSecret;
  cachedMaterialSecret = await getSettingSecret("MATERIAL_INGEST_SECRET");
  return cachedMaterialSecret;
}

async function getVideoWorkerToken(): Promise<string | null> {
  if (cachedVideoWorkerToken) return cachedVideoWorkerToken;
  cachedVideoWorkerToken = await getSettingSecret("VIDEO_EDIT_WORKER_TOKEN");
  return cachedVideoWorkerToken;
}

function classifyFileKind(mime: string | null): string {
  const m = (mime || "").toLowerCase();
  if (m.startsWith("image/")) return "IMAGE";
  if (m.startsWith("video/")) return "VIDEO";
  if (
    m === "application/pdf" ||
    m.startsWith("application/msword") ||
    m.includes("wordprocessingml") ||
    m.includes("spreadsheetml") ||
    m.includes("presentationml") ||
    m.startsWith("application/vnd.google-apps.document") ||
    m.startsWith("application/vnd.google-apps.spreadsheet") ||
    m.startsWith("application/vnd.google-apps.presentation") ||
    m === "text/plain" ||
    m === "application/rtf"
  ) return "DOCUMENT";
  return "OTHER";
}

function cleanFolderName(name: string): string {
  return (name || "").replace(/^\[/, "").replace(/\]$/, "").trim();
}

async function matchClient(nameHint: string, driveFolderId: string | null): Promise<{ client_id: string | null; match_confidence: string; matched_by: string | null }> {
  if (driveFolderId) {
    const byFolder = await sql`
      select client_id
      from agency_ops.client_drive_bindings
      where drive_folder_id = ${driveFolderId}
        and binding_status = 'VERIFIED'
      limit 1`;
    if (byFolder.length) return { client_id: byFolder[0].client_id as string, match_confidence: "ALTA", matched_by: "DRIVE_FOLDER_BINDING" };
  }

  const hint = (nameHint || "").trim();
  if (!hint) return { client_id: null, match_confidence: "NENHUMA", matched_by: null };
  const rows = await sql`
    with target as (
      select agency_ops.normalize_sender_identity(${hint}) as norm
    ),
    alias_hit as (
      select a.client_id, 'ALIAS_EXACT' as matched_by
      from agency_ops.client_name_aliases a, target t
      where a.alias_normalized = t.norm
      limit 1
    ),
    exact_hit as (
      select c.id as client_id, 'DISPLAY_EXACT' as matched_by
      from agency_ops.clients c, target t
      where agency_ops.normalize_sender_identity(c.display_name) = t.norm
      limit 1
    ),
    contains_hit as (
      select c.id as client_id, 'DISPLAY_CONTAINS' as matched_by
      from agency_ops.clients c, target t
      where t.norm <> '' and (
        agency_ops.normalize_sender_identity(c.display_name) like '%' || t.norm || '%'
        or t.norm like '%' || agency_ops.normalize_sender_identity(c.display_name) || '%'
      )
      order by length(c.display_name) desc
      limit 1
    )
    select * from alias_hit
    union all select * from exact_hit where not exists (select 1 from alias_hit)
    union all select * from contains_hit where not exists (select 1 from alias_hit) and not exists (select 1 from exact_hit)
    limit 1`;
  if (!rows.length) return { client_id: null, match_confidence: "NENHUMA", matched_by: null };
  const r = rows[0] as any;
  const confidence = r.matched_by === "DISPLAY_CONTAINS" ? "MEDIA" : "ALTA";
  return { client_id: r.client_id, match_confidence: confidence, matched_by: r.matched_by };
}

async function canonicalDriveFolder(clientId: string | null, supplied: string | null): Promise<string | null> {
  if (supplied) return supplied;
  if (!clientId) return null;
  const rows = await sql`
    select drive_folder_id
    from agency_ops.client_drive_bindings
    where client_id = ${clientId}
      and binding_status = 'VERIFIED'
    order by verified_at desc nulls last
    limit 1`;
  return rows.length ? String(rows[0].drive_folder_id || "") || null : null;
}

async function isSystemTestClient(clientId: string | null): Promise<boolean> {
  if (!clientId) return false;
  const rows = await sql`
    select service, metadata
    from agency_ops.clients
    where id = ${clientId}::uuid
    limit 1`;
  if (!rows.length) return false;
  const r = rows[0] as any;
  return String(r.service || "").toUpperCase() === "TESTE" || r.metadata?.excluded_from_metrics === true || r.metadata?.system_test === "video_pipeline";
}

async function forwardVideoToPipeline(args: {
  driveFileId: string;
  fileName: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  driveFolderId: string | null;
  driveUploadedAt: Date | null;
  clientId: string | null;
  productId?: string | null;
  explicitTestMode?: boolean;
}) {
  if (!SUPABASE_URL || !args.clientId || !args.driveFolderId) {
    return { forwarded: false, reason: !args.clientId ? "client_unresolved" : !args.driveFolderId ? "drive_folder_unresolved" : "supabase_url_missing" };
  }
  const token = await getVideoWorkerToken();
  if (!token) return { forwarded: false, reason: "video_worker_token_missing" };

  const testMode = args.explicitTestMode === true || await isSystemTestClient(args.clientId);
  const ts = args.driveUploadedAt?.toISOString() || "unknown";
  const payload: Record<string, unknown> = {
    action: "request_render",
    source: "DRIVE_DIRECT",
    event_type: "FILE_UPSERT",
    event_key: `RAW_MATERIAL_WATCH:${args.driveFileId}:${ts}`,
    drive_file_id: args.driveFileId,
    drive_folder_id: args.driveFolderId,
    parent_ids: [args.driveFolderId],
    file_name: args.fileName,
    mime_type: args.mimeType,
    size_bytes: args.fileSizeBytes,
    created_time: args.driveUploadedAt?.toISOString() || null,
    modified_time: args.driveUploadedAt?.toISOString() || null,
    test_mode: testMode,
    idempotency_key: `DRIVE_WATCH:${args.driveFileId}:${args.productId || "AUTO"}`,
    requested_formats: ["9:16"]
  };
  if (args.productId) payload.product_id = args.productId;

  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/agency-ops-video-drive-ingest-api`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-video-worker-token": token
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    return {
      forwarded: true,
      accepted: response.ok,
      http_status: response.status,
      ingest_ok: data?.ok === true,
      render_job_id: data?.render_job?.job_id || null,
      render_status: data?.render_job?.status || null,
      ingest_error: response.ok ? null : String(data?.error || "video_pipeline_rejected")
    };
  } catch (e) {
    return { forwarded: false, reason: "video_pipeline_fetch_failed", detail: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "GET" && (new URL(req.url)).searchParams.get("health") === "1") {
    return new Response(JSON.stringify({ ok: true, service: "raw-material-upload-ingest", v: 2, video_bridge: true }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  let secret: string | null = null;
  try { secret = await getMaterialSecret(); } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "cfg:" + String(e).slice(0, 150) }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const given = req.headers.get("x-material-ingest-secret");
  if (!secret || !given || given !== secret) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  let body: any;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ ok: false, error: "invalid json" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const driveFileId = String(body?.drive_file_id ?? "").trim();
  const fileName = String(body?.file_name ?? "").trim();
  const clientFolderName = String(body?.client_folder_name ?? "").trim();
  if (!driveFileId || !fileName || !clientFolderName) {
    return new Response(JSON.stringify({ ok: false, error: "drive_file_id, file_name and client_folder_name are required" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  const mimeType = body?.mime_type ? String(body.mime_type) : null;
  const fileKind = classifyFileKind(mimeType);
  const fileSizeBytes = body?.file_size_bytes != null ? Number(body.file_size_bytes) : null;
  const driveFolderId = body?.drive_folder_id ? String(body.drive_folder_id) : null;
  const driveUploadedAt = body?.drive_uploaded_at ? new Date(body.drive_uploaded_at) : null;

  try {
    const match = await matchClient(cleanFolderName(clientFolderName), driveFolderId);
    const canonicalFolderId = await canonicalDriveFolder(match.client_id, driveFolderId);
    const rows = await sql`
      insert into agency_ops.client_raw_material_uploads
        (client_id, client_folder_name, match_confidence, drive_file_id, file_name, mime_type, file_kind, file_size_bytes, drive_folder_id, drive_uploaded_at, source, metadata)
      values
        (${match.client_id}, ${clientFolderName}, ${match.match_confidence}, ${driveFileId}, ${fileName}, ${mimeType}, ${fileKind}, ${fileSizeBytes}, ${driveFolderId}, ${driveUploadedAt}, 'drive_watch', ${sql.json({ matched_by: match.matched_by, canonical_drive_folder_id: canonicalFolderId })})
      on conflict (drive_file_id)
      do update set
        client_id = excluded.client_id,
        client_folder_name = excluded.client_folder_name,
        match_confidence = excluded.match_confidence,
        file_name = excluded.file_name,
        mime_type = excluded.mime_type,
        file_kind = excluded.file_kind,
        file_size_bytes = excluded.file_size_bytes,
        drive_folder_id = excluded.drive_folder_id,
        drive_uploaded_at = excluded.drive_uploaded_at,
        metadata = coalesce(agency_ops.client_raw_material_uploads.metadata, '{}'::jsonb) || excluded.metadata
      returning id, client_id, file_kind, match_confidence`;

    let videoPipeline: any = { forwarded: false, reason: "not_video" };
    if (fileKind === "VIDEO") {
      videoPipeline = await forwardVideoToPipeline({
        driveFileId,
        fileName,
        mimeType,
        fileSizeBytes,
        driveFolderId: canonicalFolderId,
        driveUploadedAt,
        clientId: match.client_id,
        productId: body?.product_id ? String(body.product_id) : null,
        explicitTestMode: body?.test_mode === true
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      id: rows[0].id,
      client_id: rows[0].client_id,
      file_kind: rows[0].file_kind,
      match_confidence: rows[0].match_confidence,
      matched_by: match.matched_by,
      video_pipeline: videoPipeline
    }), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: "db:" + String(e).slice(0, 300) }), { status: 200, headers: { "content-type": "application/json" } });
  }
});
