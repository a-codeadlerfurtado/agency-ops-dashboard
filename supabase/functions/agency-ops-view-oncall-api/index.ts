import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGINS = new Set([
  "https://agency-ops-dashboard.lakassessoriadigital.workers.dev",
  "http://localhost:3000",
  "http://localhost:5173",
]);

const TEMPLATE = `Oi, {{nome}}! 👋

Fechando o seu plantão de hoje. Pode me passar rapidinho:

1. Quantos leads você recebeu?
2. Quantos leads conseguiu atender?
3. Quantas ligações efetuou?
4. Quantas ligações foram atendidas?
5. Quantas visitas foram agendadas?
6. Quantas visitas foram realizadas?
7. Quantas propostas foram feitas?
8. Houve alguma venda? Quantas?
9. Quantos imóveis foram prospectados/captados?
10. Quantos imóveis foram cadastrados?
11. Alguma observação importante sobre o plantão?

Pode responder do seu jeito mesmo.`;

type Row = Record<string, any>;
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
function json(body: unknown, status = 200, origin?: string | null) {
  const h: Record<string,string> = {
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store",
    "access-control-allow-headers":"authorization,apikey,content-type,x-automation-secret",
    "access-control-allow-methods":"GET,POST,OPTIONS",
  };
  if (origin && ORIGINS.has(origin)) { h["access-control-allow-origin"] = origin; h.vary = "Origin"; }
  return new Response(JSON.stringify(body), { status, headers: h });
}

async function zapiSend(db: any, phone: string, message: string) {
  const { data: creds, error: credsError } = await db.schema("agency_ops").rpc("view_oncall_zapi_credentials");
  if (credsError) throw new Error(`zapi_credentials:${credsError.message}`);
  const instance = String(creds?.instance_id || "");
  const token = String(creds?.instance_token || "");
  const clientToken = String(creds?.client_token || "");
  if (!instance || !token || !clientToken) throw new Error("zapi_configuration_missing");
  const r = await fetch(`https://api.z-api.io/instances/${instance}/token/${token}/send-text`, {
    method:"POST",
    headers:{"content-type":"application/json","Client-Token":clientToken},
    body:JSON.stringify({ phone: digits(phone), message, delayTyping: 5 }),
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(`zapi_${r.status}:${JSON.stringify(data)}`);
  return { ...data, _provider_instance_id: instance };
}


function norm(v: unknown) {
  return String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
function matchNum(t: string, patterns: RegExp[], zeroPatterns: RegExp[] = []) {
  for (const z of zeroPatterns) if (z.test(t)) return 0;
  for (const rx of patterns) {
    const m = t.match(rx);
    if (m) { const n = Number(m[1]); if (Number.isFinite(n) && n >= 0) return n; }
  }
  return null;
}
function parseMetricsText(raw: string) {
  const t = norm(raw).replace(/\s+/g, " ");
  const metrics: Row = {};
  metrics.leads_received = matchNum(t,[/recebi\s+(\d+)\s+leads?/,/(\d+)\s+leads?\s+(?:recebidos?|entraram?)/,/leads?\s+(?:recebidos?|recebi)\D{0,8}(\d+)/]);
  metrics.leads_attended = matchNum(t,[/atendi\s+(\d+)(?:\s+leads?)?/,/(\d+)\s+(?:leads?\s+)?atendidos?/,/consegui\s+atender\s+(\d+)/]);
  metrics.calls_made = matchNum(t,[/fiz\s+(\d+)\s+liga/,/efetuei\s+(\d+)\s+liga/,/(\d+)\s+ligacoes?\s+(?:feitas|efetuadas)/,/(\d+)\s+ligacoes?/]);
  metrics.calls_answered = matchNum(t,[/(\d+)\s+(?:ligacoes?\s+)?(?:atendidas|atenderam)/,/liga(?:cao|coes)\s+atendidas?\D{0,8}(\d+)/]);
  metrics.visits_scheduled = matchNum(t,[/(?:marquei|agendei)\s+(\d+)\s+visitas?/,/(\d+)\s+visitas?\s+(?:agendadas|marcadas)/]);
  metrics.visits_completed = matchNum(t,[/(?:realizei|fiz)\s+(\d+)\s+visitas?/,/(\d+)\s+visitas?\s+(?:realizadas|feitas)/,/(\d+)\s+(?:visitas?\s+)?realizadas?/]);
  metrics.proposals = matchNum(t,[/(?:fiz|enviei)\s+(\d+)\s+propostas?/,/(\d+)\s+propostas?/],[/nenhuma\s+proposta/,/sem\s+proposta/]);
  metrics.sales = matchNum(t,[/(?:vendi|fechei)\s+(\d+)/,/(\d+)\s+vendas?/],[/nenhuma\s+venda/,/sem\s+venda/]);
  metrics.properties_prospected = matchNum(t,[/(?:captei|prospectei)\s+(\d+)/,/(\d+)\s+(?:captacoes?|imoveis?\s+(?:captados|prospectados))/,/(\d+)\s+captac(?:ao|oes)/],[/nenhuma\s+captacao/,/sem\s+captacao/]);
  metrics.properties_listed = matchNum(t,[/cadastrei\s+(\d+)/,/(\d+)\s+(?:cadastros?|imoveis?\s+cadastrados)/],[/nenhum\s+cadastro/,/sem\s+cadastro/]);
  const keys = Object.keys(metrics);
  const found = keys.filter(k=>metrics[k] !== null).length;
  return { metrics, confidence: found / keys.length };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return json({ok:true}, 200, origin);
  if (origin && !ORIGINS.has(origin)) return json({error:"origin_not_allowed"},403,origin);

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const autoSecret = Deno.env.get("VIEW_ONCALL_AUTOMATION_SECRET") || Deno.env.get("OPS_AUDIT_SECRET") || Deno.env.get("DASHBOARD_SECRET");
  if (!url || !anon || !service) return json({error:"server_configuration"},500,origin);

  const authHeader = req.headers.get("authorization") || "";
  const automation = authHeader === `Bearer ${service}` || (!!autoSecret && req.headers.get("x-automation-secret") === autoSecret);
  let actor = "AUTOMATION";
  let role = "AUTOMATION";
  const db = createClient(url, service, { auth:{persistSession:false,autoRefreshToken:false} });
  const ops = db.schema("agency_ops");

  if (!automation) {
    if (!authHeader.startsWith("Bearer ")) return json({error:"unauthorized"},401,origin);
    const auth = createClient(url, anon, { global:{headers:{Authorization:authHeader}}, auth:{persistSession:false} });
    const {data:u} = await auth.auth.getUser();
    if (!u?.user) return json({error:"unauthorized"},401,origin);
    const {data:p} = await ops.from("user_preferences").select("collaborator_person").eq("user_key",u.user.id).maybeSingle();
    actor = p?.collaborator_person || "";
    if (!actor) return json({error:"forbidden"},403,origin);
    const {data:r} = await ops.from("team_roster").select("role,is_former").eq("person",actor).maybeSingle();
    role = String(r?.role || "").toUpperCase();
    if (!r || r.is_former || !["MGMT","CS"].includes(role)) return json({error:"forbidden"},403,origin);
  }

  if (req.method === "GET") {
    const [brokers, shifts, config] = await Promise.all([
      ops.from("view_brokers").select("*").order("name"),
      ops.from("view_oncall_dashboard").select("*").gte("shift_date",new Date(Date.now()-14*86400000).toISOString().slice(0,10)).order("shift_date",{ascending:false}),
      ops.from("view_oncall_config").select("*").order("config_key"),
    ]);
    const {data:monitor} = await ops.from("view_oncall_response_monitor").select("*").gte("shift_date",new Date(Date.now()-14*86400000).toISOString().slice(0,10)).order("sent_at",{ascending:false,nullsFirst:false}).limit(300);
    return json({ok:true,actor,brokers:brokers.data||[],shifts:shifts.data||[],monitor:monitor||[],config:config.data||[],template:TEMPLATE},200,origin);
  }

  if (req.method !== "POST") return json({error:"method_not_allowed"},405,origin);
  const body = await req.json().catch(()=>({}));
  const action = String(body.action || "");

  if (action === "set_broker_phone") {
    const name = String(body.name || "").trim(); const phone = digits(body.phone);
    if (!name || phone.length < 10) return json({error:"invalid_broker_or_phone"},400,origin);
    const {data:current} = await ops.from("view_brokers").select("source_metadata").ilike("name",name).maybeSingle();
    const metadata = {...(current?.source_metadata || {}), fixture_phone:false, fixture_phone_note:null, phone_source:"manual"};
    const {data,error} = await ops.from("view_brokers").update({phone_e164:phone,source_metadata:metadata,updated_at:new Date().toISOString()}).ilike("name",name).select("*").maybeSingle();
    return error ? json({error:error.message},400,origin) : json({ok:true,broker:data},200,origin);
  }

  if (action === "test_whatsapp") {
    if (!automation && role !== "MGMT") return json({error:"forbidden"},403,origin);
    let phone = digits(body.phone);
    if (phone.length === 11 && !phone.startsWith("55")) phone = `55${phone}`;
    if (phone.length < 12) return json({error:"invalid_phone"},400,origin);
    const message = String(body.message || "[TESTE VIEW] Integração de check-in de plantão funcionando. Nenhuma ação é necessária.").trim();
    if (!message) return json({error:"message_required"},400,origin);
    try {
      const z = await zapiSend(db, phone, message);
      return json({
        ok:true,
        sent:true,
        target:`***${phone.slice(-4)}`,
        provider:{label:"JOEL_GUSTAVO",connected_phone:"5513988051839",instance_id:z._provider_instance_id},
        message_id:z.messageId || z.id || z.zaapId || null
      },200,origin);
    } catch (e) {
      return json({ok:false,error:String(e)},502,origin);
    }
  }

  if (action === "set_automation") {
    if (role !== "MGMT" && !automation) return json({error:"forbidden"},403,origin);
    const enabled = body.enabled === true;
    if (enabled) {
      const today = new Date().toISOString().slice(0,10);
      const {data:scheduled,error:scheduledError} = await ops.from("view_oncall_shifts")
        .select("id,shift_date,broker_name_snapshot,source_type,view_brokers!view_oncall_shifts_broker_id_fkey(phone_e164,source_metadata)")
        .gte("shift_date",today).neq("status","CANCELLED").limit(100);
      if (scheduledError) return json({error:scheduledError.message},400,origin);
      const blockers: Row[] = [];
      for (const shift of scheduled || []) {
        const b:any = Array.isArray(shift.view_brokers) ? shift.view_brokers[0] : shift.view_brokers;
        const phone = digits(b?.phone_e164);
        if (shift.source_type === "FIXTURE") blockers.push({shift_id:shift.id,broker:shift.broker_name_snapshot,reason:"fixture_shift"});
        else if (!phone) blockers.push({shift_id:shift.id,broker:shift.broker_name_snapshot,reason:"missing_phone"});
        else if (b?.source_metadata?.fixture_phone === true || /^0+$/.test(phone)) blockers.push({shift_id:shift.id,broker:shift.broker_name_snapshot,reason:"fixture_phone"});
      }
      if (blockers.length) return json({error:"activation_blocked",blockers},409,origin);
    }
    const {error} = await ops.from("view_oncall_config").upsert({config_key:"automation_enabled",config_value:enabled,updated_at:new Date().toISOString()},{onConflict:"config_key"});
    return error ? json({error:error.message},400,origin) : json({ok:true,automation_enabled:enabled},200,origin);
  }

  if (action === "clear_fixture_shifts") {
    if (role !== "MGMT" && !automation) return json({error:"forbidden"},403,origin);
    const {data,error} = await ops.from("view_oncall_shifts").delete().eq("source_type","FIXTURE").select("id");
    if (error) return json({error:error.message},400,origin);
    await ops.from("view_oncall_config").upsert({config_key:"fixture_mode",config_value:false,updated_at:new Date().toISOString()},{onConflict:"config_key"});
    return json({ok:true,deleted:(data||[]).length},200,origin);
  }

  if (action === "sync_shifts") {
    const rows = Array.isArray(body.shifts) ? body.shifts : [];
    if (!rows.length) return json({error:"shifts_required"},400,origin);
    const out: Row[] = [];
    const {data:cfg} = await ops.from("view_oncall_config").select("config_key,config_value");
    const cm = Object.fromEntries((cfg||[]).map((x:Row)=>[x.config_key,x.config_value]));
    const delay = Number(cm.send_delay_minutes ?? 5);
    for (const item of rows) {
      const name = String(item.broker_name || "").trim(); const day = String(item.shift_date || "").slice(0,10);
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      let {data:broker} = await ops.from("view_brokers").select("*").ilike("name",name).maybeSingle();
      if (!broker) broker = (await ops.from("view_brokers").insert({name,display_name:name,source_document_id:item.source_document_id||null}).select("*").single()).data;
      if (!broker) continue;
      const sync_key = String(item.sync_key || `${item.source_document_id||"manual"}:${day}:${name}:${item.starts_at||""}:${item.ends_at||""}`);
      const {data:s,error} = await ops.from("view_oncall_shifts").upsert({
        broker_id:broker.id,broker_name_snapshot:name,shift_date:day,starts_at:item.starts_at||null,ends_at:item.ends_at||null,
        timezone:item.timezone||"America/Sao_Paulo",status:item.status||"SCHEDULED",source_type:item.source_type||"DOC",
        source_document_id:item.source_document_id||null,source_revision_id:item.source_revision_id||null,source_locator:item.source_locator||null,
        source_payload:item.source_payload||{},sync_key,updated_at:new Date().toISOString()
      },{onConflict:"sync_key"}).select("*").single();
      if (error || !s) { out.push({broker_name:name,error:error?.message||"shift_upsert_failed"}); continue; }
      const scheduled = s.ends_at ? new Date(new Date(s.ends_at).getTime()+delay*60000).toISOString() : null;
      await ops.from("view_shift_checkins").upsert({shift_id:s.id,broker_id:broker.id,scheduled_send_at:scheduled,updated_at:new Date().toISOString()},{onConflict:"shift_id"});
      out.push({shift_id:s.id,broker_name:name,scheduled_send_at:scheduled});
    }
    return json({ok:true,synced:out},200,origin);
  }

  if (action === "dispatch_due") {
    if (!automation && role !== "MGMT") return json({error:"forbidden"},403,origin);
    const {data:autoCfg} = await ops.from("view_oncall_config").select("config_value").eq("config_key","automation_enabled").maybeSingle();
    if (autoCfg?.config_value !== true) return json({ok:true,disabled:true,processed:0,results:[]},200,origin);
    const now = new Date().toISOString();
    const {data:goLiveCfg} = await ops.from("view_oncall_config").select("config_value").eq("config_key","go_live_at").maybeSingle();
    const goLiveAt = typeof goLiveCfg?.config_value === "string" ? goLiveCfg.config_value : now;
    const {data:due,error} = await ops.from("view_shift_checkins")
      .select("id,shift_id,broker_id,scheduled_send_at,status,view_brokers!view_shift_checkins_broker_id_fkey(name,display_name,phone_e164,source_metadata)")
      .eq("status","PENDING").gte("scheduled_send_at",goLiveAt).lte("scheduled_send_at",now).limit(20);
    if (error) return json({error:error.message},400,origin);
    const results: Row[] = [];
    for (const c of due || []) {
      const b:any = Array.isArray(c.view_brokers) ? c.view_brokers[0] : c.view_brokers;
      const phone = digits(b?.phone_e164);
      if (!phone) { results.push({checkin_id:c.id,skipped:"missing_phone"}); continue; }
      if (b?.source_metadata?.whatsapp_send_blocked === true) { results.push({checkin_id:c.id,skipped:"send_blocked"}); continue; }
      if (b?.source_metadata?.fixture_phone === true || /^0+$/.test(phone)) { results.push({checkin_id:c.id,skipped:"fixture_phone"}); continue; }
      try {
        const z = await zapiSend(db,phone,TEMPLATE.replace("{{nome}}",b?.display_name||b?.name||"corretor"));
        const mid = z.messageId || z.id || z.zaapId || null;
        await ops.from("view_shift_checkins").update({status:"SENT",sent_at:now,outbound_message_id:mid,updated_at:now}).eq("id",c.id);
        await ops.from("view_shift_checkin_events").insert({checkin_id:c.id,event_type:"CHECKIN_SENT",message_id:mid,payload:{phone}});
        results.push({checkin_id:c.id,sent:true,message_id:mid});
      } catch(e) {
        await ops.from("view_shift_checkins").update({status:"FAILED",updated_at:now,source_payload:{dispatch_error:String(e)}}).eq("id",c.id);
        results.push({checkin_id:c.id,sent:false,error:String(e)});
      }
    }
    const {data:remCfg} = await ops.from("view_oncall_config").select("config_value").eq("config_key","reminder_delay_minutes").maybeSingle();
    const reminderMinutes = Math.max(15, Number(remCfg?.config_value ?? 120));
    const reminderCutoff = new Date(Date.now()-reminderMinutes*60000).toISOString();
    const {data:reminders} = await ops.from("view_shift_checkins")
      .select("id,sent_at,status,view_brokers!view_shift_checkins_broker_id_fkey(name,display_name,phone_e164,source_metadata)")
      .eq("status","SENT").gte("sent_at",goLiveAt).lte("sent_at",reminderCutoff).limit(20);
    for (const c of reminders || []) {
      const b:any = Array.isArray(c.view_brokers) ? c.view_brokers[0] : c.view_brokers;
      const phone = digits(b?.phone_e164);
      if (!phone || b?.source_metadata?.whatsapp_send_blocked === true || b?.source_metadata?.fixture_phone === true || /^0+$/.test(phone)) continue;
      try {
        const reminder = `Oi, ${b?.display_name||b?.name||"corretor"}! Passando só para lembrar do fechamento do seu plantão. Quando puder, me manda aquelas métricas do dia. Pode responder do seu jeito mesmo. 👋`;
        const z = await zapiSend(db,phone,reminder);
        const mid = z.messageId || z.id || z.zaapId || null;
        await ops.from("view_shift_checkins").update({status:"REMINDER_SENT",updated_at:now}).eq("id",c.id);
        await ops.from("view_shift_checkin_events").insert({checkin_id:c.id,event_type:"REMINDER_SENT",message_id:mid,payload:{phone,delay_minutes:reminderMinutes}});
        results.push({checkin_id:c.id,reminder_sent:true,message_id:mid});
      } catch(e) {
        results.push({checkin_id:c.id,reminder_sent:false,error:String(e)});
      }
    }
    return json({ok:true,processed:results.length,results},200,origin);
  }

  if (action === "parse_pending") {
    if (!automation && role !== "MGMT") return json({error:"forbidden"},403,origin);
    const {data:rows,error} = await ops.from("view_shift_checkins")
      .select("id,raw_response,status")
      .in("status",["PARTIAL","SENT","REMINDER_SENT"])
      .not("raw_response","is",null)
      .limit(50);
    if (error) return json({error:error.message},400,origin);
    const results: Row[] = [];
    const fields = ["leads_received","leads_attended","calls_made","calls_answered","visits_scheduled","visits_completed","proposals","sales","properties_prospected","properties_listed"];
    for (const row of rows || []) {
      const parsed = parseMetricsText(String(row.raw_response || ""));
      const patch: Row = {parsed_metrics:parsed.metrics, parser_confidence:parsed.confidence, parse_model:"rules-ptbr-v1", updated_at:new Date().toISOString()};
      const missing:string[]=[];
      for (const k of fields) {
        const v = parsed.metrics[k];
        if (v === null || v === undefined) missing.push(k); else patch[k]=Number(v);
      }
      patch.missing_fields=missing;
      patch.status=missing.length ? "PARTIAL" : "ANSWERED";
      const {error:updateError} = await ops.from("view_shift_checkins").update(patch).eq("id",row.id);
      if (!updateError) await ops.from("view_shift_checkin_events").insert({checkin_id:row.id,event_type:"AUTO_PARSED",payload:{confidence:parsed.confidence,missing_fields:missing}});
      results.push({checkin_id:row.id,confidence:parsed.confidence,missing_fields:missing,error:updateError?.message||null});
    }
    return json({ok:true,processed:results.length,results},200,origin);
  }

  if (action === "record_metrics") {
    const id = String(body.checkin_id || ""); if (!id) return json({error:"checkin_id_required"},400,origin);
    const m = body.metrics || {}; const fields = ["leads_received","leads_attended","calls_made","calls_answered","visits_scheduled","visits_completed","proposals","sales","properties_prospected","properties_listed"];
    const patch:Row = {updated_at:new Date().toISOString(),parsed_metrics:m,notes:m.notes??body.notes??null}; const missing:string[]=[];
    for (const k of fields) { const v=m[k]; if (v===null||v===undefined||v==="") missing.push(k); else patch[k]=Number(v); }
    patch.missing_fields=missing; patch.parser_confidence=body.parser_confidence??null; patch.parse_model=body.parse_model??null; patch.status=missing.length?"PARTIAL":"ANSWERED";
    const {data,error} = await ops.from("view_shift_checkins").update(patch).eq("id",id).select("*").single();
    if (error) return json({error:error.message},400,origin);
    await ops.from("view_shift_checkin_events").insert({checkin_id:id,event_type:"METRICS_RECORDED",payload:{missing_fields:missing,metrics:m}});
    return json({ok:true,checkin:data},200,origin);
  }

  return json({error:"unknown_action"},400,origin);
});

