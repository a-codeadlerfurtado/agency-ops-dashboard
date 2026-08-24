import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,OPTIONS","access-control-max-age":"86400"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"private, max-age=15"}});

function jwtSub(req:Request){
  try{
    const raw=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
    const part=raw.split(".")[1];
    if(!part)return null;
    const normalized=part.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(part.length/4)*4,"=");
    const payload=JSON.parse(atob(normalized));
    return typeof payload?.sub==="string"?payload.sub:null;
  }catch{return null;}
}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(req.method!=="GET")return respond({error:"method_not_allowed"},405);
  const userKey=jwtSub(req);
  if(!userKey)return respond({error:"unauthorized"},401);
  const url=Deno.env.get("SUPABASE_URL")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!service)return respond({error:"server_configuration"},500);
  const ops=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}}).schema("agency_ops");
  const {data:pref,error:prefError}=await ops.from("user_preferences").select("collaborator_person,name").eq("user_key",userKey).maybeSingle();
  if(prefError)return respond({error:"profile_query_failed"},500);
  const person=String(pref?.collaborator_person||pref?.name||"").trim();
  if(!person)return respond({error:"profile_not_found"},404);

  const [{data:roster,error:rosterError},{data:approvals}]=await Promise.all([
    ops.from("team_roster").select("person,role,access_level").eq("person",person).eq("is_former",false).maybeSingle(),
    ops.from("access_requests").select("kind,status").eq("user_key",userKey).eq("status","APPROVED"),
  ]);
  if(rosterError||!roster)return respond({error:"profile_not_found"},404);

  const approved=approvals??[];
  const accountApproved=approved.some((row:any)=>row.kind==="SIGNUP");
  const elevated=roster.access_level==="RESTRICTED"&&approved.some((row:any)=>row.kind==="ELEVATION");
  const isFull=accountApproved&&(roster.access_level==="FULL"||elevated);
  const {data:views,error:viewsError}=await ops.rpc("dashboard_allowed_views",{p_person:person,p_role:roster.role});

  return respond({
    ok:true,
    profile:{
      person:roster.person,
      role:roster.role,
      access_level:roster.access_level,
      account_approved:accountApproved,
      elevated,
      is_full:isFull,
      views:Array.isArray(views)&&!viewsError?views:[],
    },
    generated_at:new Date().toISOString(),
  });
});
