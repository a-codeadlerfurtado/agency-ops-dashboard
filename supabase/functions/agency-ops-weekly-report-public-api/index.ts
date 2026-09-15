import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

type Row=Record<string,any>;
const PREVIEW_BUCKET="agency-meta-creative-previews";
const SIGNED_SECONDS=6*60*60;
const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"content-type","access-control-allow-methods":"GET,OPTIONS","access-control-max-age":"86400"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-robots-tag":"noindex, nofollow, noarchive"}});
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(req.method!=="GET")return json({error:"method_not_allowed"},405);
  const token=String(new URL(req.url).searchParams.get("token")||"").trim();if(!UUID.test(token))return json({error:"not_found"},404);
  const supabaseUrl=Deno.env.get("SUPABASE_URL"),serviceRole=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!supabaseUrl||!serviceRole)return json({error:"server_configuration"},500);
  const db=createClient(supabaseUrl,serviceRole,{auth:{persistSession:false,autoRefreshToken:false}}),ops=db.schema("agency_ops");
  try{
    const{data:report,error}=await ops.from("weekly_client_reports").select("client_name,period_start,period_end,week_start,week_end,report_kind,status,audit_status,snapshot,editorial_narrative,editorial_status,edited_at,generated_at").eq("public_token",token).eq("status","READY").eq("audit_status","PASS").maybeSingle();
    if(error)throw error;if(!report)return json({error:"not_found"},404);
    const snapshot:Row={...(report.snapshot||{})};snapshot.narrative=report.editorial_narrative||snapshot.narrative||null;
    const creatives:Array<Row>=Array.isArray(snapshot.creatives)?snapshot.creatives:[];const paths=[...new Set(creatives.map((r:Row)=>String(r.preview_storage_path||"")).filter(Boolean))];
    if(paths.length){const{data,error:signError}=await db.storage.from(PREVIEW_BUCKET).createSignedUrls(paths,SIGNED_SECONDS);if(!signError&&Array.isArray(data)){const map=new Map<string,string>();data.forEach((item:any,index:number)=>{const path=String(item?.path||paths[index]||""),url=String(item?.signedUrl||"");if(path&&url)map.set(path,url);});snapshot.creatives=creatives.map((r:Row)=>({...r,image_url:map.get(String(r.preview_storage_path||""))||null}));}}
    return json({ok:true,client_name:report.client_name,period_start:report.period_start||report.week_start,period_end:report.period_end||report.week_end,week_start:report.week_start,week_end:report.week_end,report_kind:report.report_kind,generated_at:report.generated_at,editorial_status:report.editorial_status,edited_at:report.edited_at,report:snapshot});
  }catch(error){return json({error:"report_failed",detail:String(error instanceof Error?error.message:error)},500);}
});
