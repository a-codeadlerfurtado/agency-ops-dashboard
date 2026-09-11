import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const WEBHOOK_SECRET = Deno.env.get("AGENDA_WEBHOOK_SECRET") || "";
const INSTANCE_PHONE = "13997811685";
const ops = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false }, db: { schema: "agency_ops" } });

function json(body: unknown, status=200) { return new Response(JSON.stringify(body), { status, headers: { "content-type":"application/json; charset=utf-8", "cache-control":"no-store" } }); }
function digits(v: unknown) { return String(v ?? "").replace(/\D/g, ""); }
function clean(v: unknown, n=4000) { return String(v ?? "").trim().slice(0,n); }
async function hash(v:string) { const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)); return [...new Uint8Array(d)].map((b)=>b.toString(16).padStart(2,"0")).join(""); }
async function secretOk(received:string) { if (!WEBHOOK_SECRET || !received) return false; return await hash(received) === await hash(WEBHOOK_SECRET); }

async function resolvePerson(phone:string) {
  const { data, error } = await ops.from("team_identity_map").select("person,whatsapp_phone").not("whatsapp_phone","is",null);
  if (error) throw error;
  const target = digits(phone);
  return (data || []).find((row:any)=>digits(row.whatsapp_phone) === target)?.person || null;
}
Deno.serve(async (req:Request) => {
  if (req.method === "GET") return json({ ok:true, service:"agency-ops-whatsapp-agenda-webhook" });
  if (req.method !== "POST") return json({ error:"method_not_allowed" },405);
  const url = new URL(req.url);
  if (!(await secretOk(clean(url.searchParams.get("k"),500)))) return new Response("", { status:404 });
  try {
    const body = await req.json().catch(()=>({}));
    const connected = digits(body.connectedPhone);
    if (!connected.endsWith(INSTANCE_PHONE)) return json({ ok:true, ignored:"wrong_instance" });
    if (body.fromMe || body.isGroup || body.isNewsletter || body.isStatusReply) return json({ ok:true, ignored:"not_direct_inbound" });
    const messageId = clean(body.messageId,300);
    const senderPhone = digits(body.phone || body.participantPhone);
    const text = clean(body?.text?.message || body?.text?.description,4000);
    if (!messageId || !senderPhone || !text) return json({ ok:true, ignored:"not_text" });
    const { data: existing } = await ops.from("whatsapp_agenda_commands").select("id,status").eq("zapi_message_id",messageId).maybeSingle();
    if (existing) return json({ ok:true, duplicate:true, command_id:existing.id, status:existing.status });
    const person = await resolvePerson(senderPhone);
    if (!person) return json({ ok:true, ignored:"unauthorized_sender" });
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const { data: pending } = await ops.from("whatsapp_agenda_commands")
      .select("id,root_command_id,calendar_event_id,parsed_intent,pending_field")
      .eq("sender_phone",senderPhone).eq("owner_person",person).eq("status","NEEDS_INPUT")
      .gte("received_at",cutoff).order("received_at",{ascending:false}).limit(1).maybeSingle();
    const insertRow:any = { zapi_message_id:messageId, sender_phone:senderPhone, owner_person:person, raw_text:text, status:"QUEUED" };
    if (pending?.id) {
      insertRow.parent_command_id = pending.id;
      insertRow.root_command_id = pending.root_command_id || pending.id;
    }
    const { data: row, error } = await ops.from("whatsapp_agenda_commands").insert(insertRow).select("id,parent_command_id,root_command_id").single();
    if (error) { if ((error as any).code === "23505") return json({ ok:true, duplicate:true }); throw error; }
    const { data: job, error:jobError } = await ops.rpc("enqueue_heavy_job", { p_job_type:"WHATSAPP_AGENDA_COMMAND", p_payload:{ command_id:row.id }, p_dedupe_key:`whatsapp-agenda:${messageId}`, p_max_attempts:4, p_available_at:new Date().toISOString() });
    if (jobError) throw jobError;
    return json({ ok:true, queued:true, command_id:row.id, parent_command_id:row.parent_command_id || null, root_command_id:row.root_command_id || row.id, job_id:job });
  } catch (e) {
    console.error("whatsapp-agenda-webhook",e);
    return json({ ok:false, error:clean(e instanceof Error ? e.message : e,800) },500);
  }
});
