import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row = Record<string, any>;
const SHEET_EXPORT = (id:string,gid:string)=>`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
const ALIASES: Record<string,string> = {
  "fabi":"Fabiane",
  "fabiane":"Fabiane",
  "kyth":"Maria Cristina",
  "kith":"Maria Cristina",
  "maria cristina":"Maria Cristina",
  "ju arantes":"Juliana",
  "juliana arantes":"Juliana",
  "juliana":"Juliana",
  "cesar":"Cesar",
  "césar":"Cesar",
  "claudete":"Claudete",
  "neila":"Neila",
  "maria jose":"Maria José",
  "maria josé":"Maria José",
};

function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
function clean(v:unknown){return String(v??"").trim();}
function key(v:unknown){return clean(v).normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase();}
function canonicalBroker(v:string){return ALIASES[key(v)] || clean(v);}
function localIso(date:string,time:string){return time ? `${date}T${time}:00-03:00` : null;}
function colLetter(i:number){let n=i+1,s="";while(n){n--;s=String.fromCharCode(65+(n%26))+s;n=Math.floor(n/26);}return s;}
function parseCsv(text:string){
  const rows:string[][]=[]; let row:string[]=[],cell="",quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){
      if(quoted && text[i+1]==='"'){cell+='"';i++;}
      else quoted=!quoted;
    } else if(ch===',' && !quoted){row.push(cell);cell="";}
    else if((ch==='\n'||ch==='\r') && !quoted){
      if(ch==='\r'&&text[i+1]==='\n')i++;
      row.push(cell);cell=""; if(row.some(x=>x!=="")) rows.push(row); row=[];
    } else cell+=ch;
  }
  if(cell||row.length){row.push(cell);if(row.some(x=>x!==""))rows.push(row);}
  return rows;
}

function parseDate(dm:string,baseYear:number){
  const m=clean(dm).match(/^(\d{1,2})\/(\d{1,2})$/); if(!m)return null;
  const day=Number(m[1]),month=Number(m[2]);
  const nowMonth=new Date().getUTCMonth()+1; let year=baseYear;
  if(month-nowMonth>6)year--; else if(nowMonth-month>6)year++;
  return `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}

function extractShifts(rows:string[][],baseYear:number,sheetName:string){
  const out:Row[]=[]; const periods=new Set(["MANHA","TARDE","NOITE"]);
  for(let i=0;i<rows.length;i++){
    if(key(rows[i]?.[2])!=="data")continue;
    const dates=(rows[i]||[]).slice(3,10);
    for(let j=i+1;j<Math.min(i+5,rows.length);j++){
      const pk=key(rows[j]?.[2]).toUpperCase(); if(!periods.has(pk))continue;
      const period=pk;
      for(let c=0;c<7;c++){
        const rawBroker=clean(rows[j]?.[3+c]); if(!rawBroker)continue;
        const date=parseDate(dates[c]||"",baseYear); if(!date)continue;
        out.push({date,period,broker_name:canonicalBroker(rawBroker),raw_broker:rawBroker,source_locator:`${sheetName}!${colLetter(3+c)}${j+1}`});
      }
    }
  }
  return out;
}
Deno.serve(async(req)=>{
  const url=Deno.env.get("SUPABASE_URL");
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const secret=Deno.env.get("VIEW_ONCALL_AUTOMATION_SECRET");
  if(!url||!service)return json({error:"server_configuration"},500);
  const auth=req.headers.get("authorization")||"";
  const allowed=auth===`Bearer ${service}` || (!!secret && req.headers.get("x-automation-secret")===secret);
  if(!allowed)return json({error:"unauthorized"},401);

  const db=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=db.schema("agency_ops");
  const {data:cfgRows}=await ops.from("view_oncall_config").select("config_key,config_value");
  const cfg=Object.fromEntries((cfgRows||[]).map((r:Row)=>[r.config_key,r.config_value]));
  const sheetId=String(cfg.schedule_sheet_id||"");
  const gid=String(cfg.schedule_sheet_gid??"0");
  const sheetName=String(cfg.schedule_sheet_name||"Página1");
  const baseYear=Number(cfg.schedule_year||new Date().getFullYear());
  const endTimes=(cfg.period_end_times&&typeof cfg.period_end_times==="object")?cfg.period_end_times:{};
  const delay=Number(cfg.send_delay_minutes??5);
  if(!sheetId)return json({error:"schedule_sheet_id_missing"},500);

  const {data:run,error:runErr}=await ops.from("view_oncall_sync_runs").insert({source_document_id:sheetId,payload:{gid,sheetName}}).select("id").single();
  if(runErr||!run)return json({error:"sync_run_create_failed",detail:runErr?.message},500);
  try{
    const response=await fetch(SHEET_EXPORT(sheetId,gid),{headers:{"user-agent":"Mozilla/5.0"}});
    if(!response.ok)throw new Error(`sheet_fetch_${response.status}`);
    const csv=await response.text();
    const parsedRows=parseCsv(csv);
    const shifts=extractShifts(parsedRows,baseYear,sheetName);
    if(!shifts.length)throw new Error("no_shifts_parsed");

    const seen=new Set<string>(); let upserted=0;
    for(const item of shifts){
      let {data:broker}=await ops.from("view_brokers").select("id,name").ilike("name",item.broker_name).maybeSingle();
      if(!broker){
        const inserted=await ops.from("view_brokers").insert({name:item.broker_name,display_name:item.broker_name,active:true,oncall_eligible:true,source_document_id:sheetId,source_metadata:{source:"PLANTÃO DE SETEMBRO",raw_name:item.raw_broker}}).select("id,name").single();
        broker=inserted.data;
      }
      if(!broker)continue;
      const syncKey=`gsheet:${sheetId}:${item.date}:${item.period}:${key(item.broker_name)}`;
      seen.add(syncKey);
      const endTime=clean(endTimes[item.period]);
      const endsAt=endTime?new Date(localIso(item.date,endTime)!).toISOString():null;
      const sourcePayload={period:item.period,raw_broker:item.raw_broker,source_locator:item.source_locator,sheet_name:sheetName};
      const shiftRes=await ops.from("view_oncall_shifts").upsert({
        broker_id:broker.id,broker_name_snapshot:item.broker_name,shift_date:item.date,starts_at:null,ends_at:endsAt,
        timezone:"America/Sao_Paulo",status:"SCHEDULED",source_type:"GOOGLE_SHEETS",source_document_id:sheetId,
        source_locator:item.source_locator,source_payload:sourcePayload,sync_key:syncKey,period:item.period,updated_at:new Date().toISOString()
      },{onConflict:"sync_key"}).select("id").single();
      if(shiftRes.error||!shiftRes.data)continue;
      const scheduled=endsAt?new Date(new Date(endsAt).getTime()+delay*60000).toISOString():null;
      await ops.from("view_shift_checkins").upsert({shift_id:shiftRes.data.id,broker_id:broker.id,scheduled_send_at:scheduled,updated_at:new Date().toISOString()},{onConflict:"shift_id"});
      upserted++;
    }

    const today=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const {data:existing}=await ops.from("view_oncall_shifts").select("id,sync_key,shift_date,status").eq("source_type","GOOGLE_SHEETS").eq("source_document_id",sheetId).gte("shift_date",today).neq("status","CANCELLED");
    let cancelled=0;
    for(const e of existing||[]){
      if(seen.has(e.sync_key))continue;
      await ops.from("view_oncall_shifts").update({status:"CANCELLED",updated_at:new Date().toISOString()}).eq("id",e.id);
      await ops.from("view_shift_checkins").update({status:"CANCELLED",updated_at:new Date().toISOString()}).eq("shift_id",e.id).not("status","eq","ANSWERED");
      cancelled++;
    }

    await ops.from("view_oncall_sync_runs").update({status:"OK",finished_at:new Date().toISOString(),rows_seen:parsedRows.length,shifts_upserted:upserted,shifts_cancelled:cancelled,payload:{gid,sheetName,parsed_shifts:shifts.length}}).eq("id",run.id);
    await ops.from("view_oncall_config").upsert([
      {config_key:"last_sheet_sync_at",config_value:new Date().toISOString()},
      {config_key:"last_sheet_sync_status",config_value:"OK"}
    ],{onConflict:"config_key"});
    return json({ok:true,rows:parsedRows.length,parsed_shifts:shifts.length,upserted,cancelled,times_configured:Object.keys(endTimes).filter(k=>clean(endTimes[k]))});
  }catch(e){
    const err=e instanceof Error?e.message:String(e);
    await ops.from("view_oncall_sync_runs").update({status:"ERROR",finished_at:new Date().toISOString(),error:err}).eq("id",run.id);
    await ops.from("view_oncall_config").upsert([{config_key:"last_sheet_sync_at",config_value:new Date().toISOString()},{config_key:"last_sheet_sync_status",config_value:`ERROR:${err}`}],{onConflict:"config_key"});
    return json({error:"sync_failed",detail:err},500);
  }
});
