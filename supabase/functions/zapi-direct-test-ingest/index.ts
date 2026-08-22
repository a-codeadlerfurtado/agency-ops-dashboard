import postgres from "npm:postgres@3.4.5";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false,
  max: 1,
  idle_timeout: 5,
  max_lifetime: 60,
  connect_timeout: 10,
});

let cachedToken: string | null = null;
async function getToken() {
  if (cachedToken) return cachedToken;
  const rows = await sql`select value #>> '{}' as token from agency_ops.automation_settings where key='WA_DIRECT_TEST_TOKEN'`;
  cachedToken = rows.length ? String(rows[0].token || '') : '';
  return cachedToken;
}

function bool(v: unknown) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
}

function eventAt(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const ms = n > 10_000_000_000 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

function messageType(p: Record<string, unknown>) {
  if (p.text) return 'text';
  if (p.image) return 'image';
  if (p.audio) return 'audio';
  if (p.video) return 'video';
  if (p.document) return 'document';
  if (p.sticker) return 'sticker';
  if (p.contact) return 'contact';
  if (p.location) return 'location';
  return 'other';
}

function nestedString(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

Deno.serve(async (req) => {
  if (req.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, service: 'zapi-direct-test-ingest', mode: 'RAW_ONLY', promotes_to_canonical: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (req.method !== 'POST') return new Response('method', { status: 405 });

  const url = new URL(req.url);
  const expected = await getToken();
  const given = url.searchParams.get('token') || req.headers.get('x-zapi-test-token') || '';
  if (!expected || given !== expected) {
    return new Response(JSON.stringify({ ok: false, error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  let p: Record<string, unknown>;
  try {
    p = await req.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'invalid_json' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
  }

  const messageId = String(p.messageId ?? p.messageid ?? '').trim();
  if (!messageId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing_messageId' }), {
      status: 422,
      headers: { 'content-type': 'application/json' },
    });
  }

  const instanceId = p.instanceId ? String(p.instanceId) : null;
  const connectedPhone = p.connectedPhone ? String(p.connectedPhone) : null;
  const chatId = p.phone ? String(p.phone) : (p.chatId ? String(p.chatId) : null);
  const participantPhone = p.participantPhone ? String(p.participantPhone) : null;
  const participantLid = p.participantLid ? String(p.participantLid) : null;
  const senderLid = p.senderLid ? String(p.senderLid) : null;
  const senderPhone = participantPhone || (p.phone ? String(p.phone) : null);
  const senderName = p.senderName ? String(p.senderName) : (p.pushName ? String(p.pushName) : (p.chatName ? String(p.chatName) : null));
  const textBody = nestedString(p.text, 'message');
  const caption = nestedString(p.image, 'caption') || nestedString(p.video, 'caption') || nestedString(p.document, 'caption');
  const momentRaw = p.momment ?? p.moment ?? null;
  const occurred = eventAt(momentRaw);
  const captureKey = messageId;

  const existing = await sql`select id from agency_ops.whatsapp_zapi_direct_test where capture_key=${captureKey} limit 1`;

  await sql`
    insert into agency_ops.whatsapp_zapi_direct_test(
      capture_key,message_id,instance_id,connected_phone,chat_id,chat_name,
      participant_phone,participant_lid,sender_phone,sender_lid,sender_name,
      from_me,is_group,is_newsletter,event_type,message_type,text_body,caption,
      moment_raw,event_at,status,raw_json,received_at,last_seen_at
    ) values (
      ${captureKey},${messageId},${instanceId},${connectedPhone},${chatId},${p.chatName ? String(p.chatName) : null},
      ${participantPhone},${participantLid},${senderPhone},${senderLid},${senderName},
      ${bool(p.fromMe)},${bool(p.isGroup)},${bool(p.isNewsletter)},${p.type ? String(p.type) : 'ReceivedCallback'},${messageType(p)},${textBody},${caption},
      ${momentRaw == null ? null : String(momentRaw)},${occurred},${p.status ? String(p.status) : null},${sql.json(p as any)},now(),now()
    )
    on conflict (capture_key) do update set
      duplicate_hits=agency_ops.whatsapp_zapi_direct_test.duplicate_hits+1,
      last_seen_at=now(),
      instance_id=coalesce(agency_ops.whatsapp_zapi_direct_test.instance_id,excluded.instance_id),
      connected_phone=coalesce(agency_ops.whatsapp_zapi_direct_test.connected_phone,excluded.connected_phone),
      chat_id=coalesce(agency_ops.whatsapp_zapi_direct_test.chat_id,excluded.chat_id),
      chat_name=coalesce(agency_ops.whatsapp_zapi_direct_test.chat_name,excluded.chat_name),
      participant_phone=coalesce(agency_ops.whatsapp_zapi_direct_test.participant_phone,excluded.participant_phone),
      participant_lid=coalesce(agency_ops.whatsapp_zapi_direct_test.participant_lid,excluded.participant_lid),
      sender_phone=coalesce(agency_ops.whatsapp_zapi_direct_test.sender_phone,excluded.sender_phone),
      sender_lid=coalesce(agency_ops.whatsapp_zapi_direct_test.sender_lid,excluded.sender_lid),
      sender_name=coalesce(agency_ops.whatsapp_zapi_direct_test.sender_name,excluded.sender_name),
      text_body=coalesce(agency_ops.whatsapp_zapi_direct_test.text_body,excluded.text_body),
      caption=coalesce(agency_ops.whatsapp_zapi_direct_test.caption,excluded.caption),
      event_at=coalesce(agency_ops.whatsapp_zapi_direct_test.event_at,excluded.event_at),
      raw_json=excluded.raw_json;
  `;

  await sql`
    insert into agency_ops.automation_health(job_name,last_success_at,last_error_at,last_error,updated_at)
    values ('zapi_direct_test',now(),null,null,now())
    on conflict(job_name) do update set last_success_at=now(),last_error_at=null,last_error=null,updated_at=now()
  `;

  return new Response(JSON.stringify({ ok: true, result: existing.length ? 'duplicate' : 'inserted', messageId }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
