import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGIN="https://agency-ops-dashboard.lakassessoriadigital.workers.dev";
const CORS={"access-control-allow-origin":ORIGIN,"access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
const clean=(v:unknown,n=1000)=>String(v??"").trim().slice(0,n);
const ALLOWED=new Set(["DESIGN","GT","CS","MGMT"]);
const safeUrl=(v:unknown)=>{try{const u=new URL(clean(v,2000));if(!["http:","https:"].includes(u.protocol))return "";return u.toString()}catch{return ""}};
const sha256=async(v:string)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)))).map(x=>x.toString(16).padStart(2,"0")).join("");

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(!["GET","POST"].includes(req.method))return json({ok:false,error:"method_not_allowed"},405);
  const authz=req.headers.get("authorization")||"";
  if(!authz.toLowerCase().startsWith("bearer "))return json({ok:false,error:"unauthorized"},401);
  const url=Deno.env.get("SUPABASE_URL")||"",anon=Deno.env.get("SUPABASE_ANON_KEY")||"",service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
  if(!url||!anon||!service)return json({ok:false,error:"server_configuration"},500);
  const userDb=createClient(url,anon,{global:{headers:{Authorization:authz}},auth:{persistSession:false,autoRefreshToken:false}});
  const {data:userData,error:userError}=await userDb.auth.getUser();
  if(userError||!userData?.user)return json({ok:false,error:"unauthorized"},401);
  const [{data:person},{data:role}]=await Promise.all([userDb.rpc("briefing_staff_person"),userDb.rpc("briefing_staff_role")]);
  const actor=clean(person,160),staffRole=clean(role,40).toUpperCase();
  if(!actor||!ALLOWED.has(staffRole))return json({ok:false,error:"forbidden"},403);

  const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
  const ops=admin.schema("agency_ops"),u=new URL(req.url);
  const action=clean(u.searchParams.get("action")||"bootstrap",60).toLowerCase();
  let body:any={};
  if(req.method==="POST"&&req.headers.get("content-type")?.includes("application/json"))body=await req.json().catch(()=>({}));

  const same=(a:unknown,b:unknown)=>clean(a,160).toLocaleLowerCase("pt-BR")===clean(b,160).toLocaleLowerCase("pt-BR");
  const canAccessClient=(client:any)=>staffRole==="MGMT"||(staffRole==="GT"&&same(client?.gt_owner,actor))||(staffRole==="CS"&&same(client?.cs_owner,actor))||(staffRole==="DESIGN"&&same(client?.designer_owner,actor));
  const assertClientAccess=async(clientId:string)=>{const {data,error}=await ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner").eq("id",clientId).maybeSingle();if(error)throw error;if(!data||!canAccessClient(data))throw new Error("radar_client_forbidden");return data};
  const assertContextAccess=async(contextId:string)=>{const {data,error}=await ops.from("ad_radar_product_contexts").select("id,client_id,briefing_product_id,product_entity_id,context_version").eq("id",contextId).maybeSingle();if(error)throw error;if(!data)throw new Error("radar_context_not_found");await assertClientAccess(String(data.client_id));return data};
  const assertProductAccess=async(productId:string)=>{const {data,error}=await admin.from("briefing_products").select("id,client_id").eq("id",productId).is("archived_at",null).maybeSingle();if(error)throw error;if(!data)throw new Error("radar_product_not_found");await assertClientAccess(String(data.client_id));return data};
  const assertContextAd=async(contextId:string,adId:string)=>{await assertContextAccess(contextId);const {data,error}=await ops.from("ad_radar_matches").select("id").eq("context_id",contextId).eq("ad_id",adId).limit(1).maybeSingle();if(error)throw error;if(!data)throw new Error("radar_ad_not_in_context")};
  const assertDirectionAccess=async(directionId:string)=>{const {data,error}=await ops.from("ad_radar_directions").select("id,context_id").eq("id",directionId).maybeSingle();if(error)throw error;if(!data)throw new Error("radar_direction_not_found");await assertContextAccess(String(data.context_id));return data};

  const ensureContext=async(productId:string)=>{
    await assertProductAccess(productId);
    let {data:ctx}=await ops.from("ad_radar_product_contexts").select("*").eq("briefing_product_id",productId).maybeSingle();
    if(!ctx){
      const {data,error}=await ops.rpc("ad_radar_context_for_product",{p_product_id:productId});
      if(error)throw error;
      const r=await ops.from("ad_radar_product_contexts").select("*").eq("id",data).single();
      if(r.error)throw r.error;ctx=r.data;
    }
    return ctx;
  };
  const signMedia=async(rows:any[])=>Promise.all((rows||[]).map(async(m:any)=>{
    if(m.storage_bucket&&m.storage_path){
      const {data}=await admin.storage.from(m.storage_bucket).createSignedUrl(m.storage_path,900);
      return {...m,signed_url:data?.signedUrl||null};
    }
    return {...m,signed_url:m.provider_url||null};
  }));

  try{
    if(action==="probe")return json({ok:true,role:staffRole});

    if(action==="bootstrap"){
      const [{data:clients,error:ce},{data:products,error:pe},{data:contexts,error:xe},{data:runs,error:re},{data:cfg,error:cfe}]=await Promise.all([
        ops.from("clients").select("id,display_name,lifecycle,gt_owner,cs_owner,designer_owner").in("lifecycle",["ACTIVE","ONBOARDING"]).order("display_name"),
        admin.from("briefing_products").select("id,client_id,name,completion_status,briefing_status,completed_at,updated_at").is("archived_at",null).order("updated_at",{ascending:false}).limit(500),
        ops.from("ad_radar_product_contexts").select("id,client_id,briefing_product_id,context_version,updated_at").limit(1000),
        ops.from("ad_radar_runs").select("id,context_id,status,requested_at,completed_at,is_partial,ads_found,error_code").order("requested_at",{ascending:false}).limit(1500),
        ops.from("ad_radar_runtime_config").select("*").eq("id",1).single()
      ]);
      if(ce||pe||xe||re||cfe)throw ce||pe||xe||re||cfe;
      const scopedClients=(clients||[]).filter((c:any)=>canAccessClient(c)),allowedClientIds=new Set(scopedClients.map((c:any)=>String(c.id)));
      const scopedProducts=(products||[]).filter((p:any)=>allowedClientIds.has(String(p.client_id)));
      const scopedContexts=(contexts||[]).filter((x:any)=>allowedClientIds.has(String(x.client_id))),allowedContextIds=new Set(scopedContexts.map((x:any)=>String(x.id)));
      const scopedRuns=(runs||[]).filter((r:any)=>allowedContextIds.has(String(r.context_id)));
      const contextByProduct=new Map(scopedContexts.map((x:any)=>[String(x.briefing_product_id),x]));
      const latestByContext=new Map<string,any>();for(const r of scopedRuns)if(!latestByContext.has(String(r.context_id)))latestByContext.set(String(r.context_id),r);
      return json({ok:true,person:actor,role:staffRole,clients:scopedClients,products:scopedProducts.map((p:any)=>{const c=contextByProduct.get(String(p.id));return {...p,radar_context_id:c?.id||null,radar_run:c?latestByContext.get(String(c.id))||null:null}}),config:{...cfg,provider_configured:Boolean(Deno.env.get("FOREPLAY_API_KEY"))},generated_at:new Date().toISOString()});
    }

    if(action==="product"){
      const productId=clean(u.searchParams.get("product_id"),80);if(!productId)return json({ok:false,error:"product_required"},400);
      const ctx=await ensureContext(productId);
      const page=Math.max(0,Number(u.searchParams.get("page")||0)||0),limit=Math.min(36,Math.max(6,Number(u.searchParams.get("limit")||24)||24));
      const category=clean(u.searchParams.get("category"),40).toUpperCase();
      let matchQuery=ops.from("ad_radar_matches").select("*",{count:"exact"}).eq("context_id",ctx.id).order("created_at",{ascending:false});
      if(["CONFIRMED","POSSIBLE","REGIONAL_COMPETITOR","EXECUTION_REFERENCE","OURS","REJECTED"].includes(category))matchQuery=matchQuery.eq("category",category);
      matchQuery=matchQuery.range(page*limit,page*limit+limit-1);
      const [{data:product},{data:entity},{data:runs},matchResult,{data:saved},{data:directions},{data:own}]=await Promise.all([
        admin.from("briefing_products").select("id,client_id,name,completion_status,briefing_status,completed_at,updated_at").eq("id",productId).single(),
        ops.from("ad_radar_product_entities").select("*").eq("id",ctx.product_entity_id).single(),
        ops.from("ad_radar_runs").select("*").eq("context_id",ctx.id).order("requested_at",{ascending:false}).limit(20),
        matchQuery,
        ops.from("ad_radar_saved_references").select("*").eq("context_id",ctx.id).order("created_at",{ascending:false}),
        ops.from("ad_radar_directions").select("*").eq("context_id",ctx.id).order("version",{ascending:false}),
        ops.from("meta_creative_catalog").select("ad_id,creative_id,creative_name,ad_name,campaign_name,creative_format,preview_storage_path,thumbnail_url,image_url,spend_7d,impressions_7d,clicks_7d,ctr_7d,leads_7d,cost_per_result_7d,last_seen_at,is_current").eq("client_id",ctx.client_id).order("last_seen_at",{ascending:false}).limit(24)
      ]);
      const matches=matchResult.data||[];
      const adIds=[...new Set((matches||[]).map((x:any)=>x.ad_id))];
      const {data:ads}=adIds.length?await ops.from("ad_radar_ads").select("*").in("id",adIds):{data:[] as any[]};
      const advertiserIds=[...new Set((ads||[]).map((x:any)=>x.advertiser_id).filter(Boolean))];
      const {data:advertisers}=advertiserIds.length?await ops.from("ad_radar_advertisers").select("*").in("id",advertiserIds):{data:[] as any[]};
      const {data:media}=adIds.length?await ops.from("ad_radar_media").select("*").in("ad_id",adIds).order("position"):{data:[] as any[]};
      const signed=await signMedia(media||[]);
      const mediaIds=(media||[]).map((m:any)=>m.id);
      const {data:analyses}=mediaIds.length?await ops.from("ad_radar_analyses").select("*").in("media_id",mediaIds).order("created_at",{ascending:false}):{data:[] as any[]};
      const ownSigned=await Promise.all((own||[]).map(async(x:any)=>{let preview=x.thumbnail_url||x.image_url||null;if(x.preview_storage_path){const {data}=await admin.storage.from("agency-meta-creative-previews").createSignedUrl(x.preview_storage_path,900);preview=data?.signedUrl||preview}return {...x,preview_url:preview}}));
      return json({ok:true,product,context:ctx,entity,runs:runs||[],matches,ads:ads||[],advertisers:advertisers||[],media:signed,analyses:analyses||[],saved:saved||[],directions:directions||[],own_ads:ownSigned,pagination:{page,limit,total:matchResult.count||0,has_more:(page+1)*limit<(matchResult.count||0)},category:category||null});
    }

    if(action==="enqueue"&&req.method==="POST"){
      const productId=clean(body.product_id,80);if(!productId)return json({ok:false,error:"product_required"},400);
      const {data,error}=await ops.rpc("enqueue_ad_radar_run",{p_product_id:productId,p_trigger:"MANUAL",p_trigger_event_id:null,p_force:true});
      if(error)throw error;return json({ok:true,run_id:data});
    }

    if(action==="manual-link"&&req.method==="POST"){
      const productId=clean(body.product_id,80),link=safeUrl(body.url);if(!productId||!link)return json({ok:false,error:"valid_product_and_url_required"},400);
      const ctx=await ensureContext(productId),external="manual-"+(await sha256(link)).slice(0,32),now=new Date().toISOString();
      const {data:ad,error:ae}=await ops.from("ad_radar_ads").upsert({provider:"MANUAL",external_ad_id:external,source_url:link,provider_url:link,ad_name:clean(body.title,220)||"Referência adicionada manualmente",first_seen_at:now,last_seen_at:now,raw_metadata:{added_by:actor}}, {onConflict:"provider,external_ad_id"}).select("*").single();
      if(ae)throw ae;
      const {data:run,error:re}=await ops.from("ad_radar_runs").insert({context_id:ctx.id,trigger_type:"MANUAL_REFERENCE",idempotency_key:"MANUAL_REFERENCE:"+crypto.randomUUID(),provider:"MANUAL",status:"AVAILABLE",run_version:ctx.context_version,completed_at:now,ads_found:1}).select("*").single();if(re)throw re;
      const category=["CONFIRMED","POSSIBLE","REGIONAL_COMPETITOR","EXECUTION_REFERENCE","OURS"].includes(String(body.category))?String(body.category):"EXECUTION_REFERENCE";
      await ops.from("ad_radar_matches").insert({run_id:run.id,context_id:ctx.id,ad_id:ad.id,category,evidence:[{type:"MANUAL_LINK",value:link}],confidence_label:"HUMAN_ADDED",decision_source:"HUMAN",decided_by:actor,decided_at:now});
      return json({ok:true,ad_id:ad.id,run_id:run.id});
    }

    if(action==="upload-reference"&&req.method==="POST"){
      const form=await req.formData(),productId=clean(form.get("product_id"),80),file=form.get("file");
      if(!productId||!(file instanceof File))return json({ok:false,error:"product_and_file_required"},400);
      const allowed=["image/","video/","application/pdf"];if(!allowed.some(x=>file.type.startsWith(x)))return json({ok:false,error:"unsupported_file_type"},415);
      if(file.size>25*1024*1024)return json({ok:false,error:"file_too_large",max_mb:25},413);
      const ctx=await ensureContext(productId),ext=(file.name.split(".").pop()||"bin").replace(/[^a-z0-9]/gi,"").slice(0,8),path=`ad-radar/manual/${ctx.client_id}/${ctx.id}/${crypto.randomUUID()}.${ext}`;
      const up=await admin.storage.from("agency-ai-private").upload(path,file,{contentType:file.type,upsert:false});if(up.error)throw up.error;
      const now=new Date().toISOString(),external="upload-"+crypto.randomUUID();
      const {data:ad,error:ae}=await ops.from("ad_radar_ads").insert({provider:"MANUAL",external_ad_id:external,ad_name:clean(file.name,220),first_seen_at:now,last_seen_at:now,raw_metadata:{added_by:actor}}).select("*").single();if(ae)throw ae;
      const type=file.type.startsWith("image/")?"IMAGE":file.type.startsWith("video/")?"VIDEO":"PDF";
      const {data:media,error:me}=await ops.from("ad_radar_media").insert({ad_id:ad.id,media_key:"manual:0",position:0,media_type:type,storage_bucket:"agency-ai-private",storage_path:path,availability:"AVAILABLE",last_verified_at:now}).select("*").single();if(me)throw me;
      const {data:run,error:re}=await ops.from("ad_radar_runs").insert({context_id:ctx.id,trigger_type:"MANUAL_REFERENCE",idempotency_key:"MANUAL_UPLOAD:"+crypto.randomUUID(),provider:"MANUAL",status:"AVAILABLE",run_version:ctx.context_version,completed_at:now,ads_found:1,media_available:1}).select("*").single();if(re)throw re;
      await ops.from("ad_radar_matches").insert({run_id:run.id,context_id:ctx.id,ad_id:ad.id,category:"EXECUTION_REFERENCE",evidence:[{type:"AUTHORIZED_UPLOAD",file_name:file.name}],confidence_label:"HUMAN_ADDED",decision_source:"HUMAN",decided_by:actor,decided_at:now});
      return json({ok:true,ad_id:ad.id,media_id:media.id});
    }

    if(action==="analyze-media"&&req.method==="POST"){
      const contextId=clean(body.context_id,80),adId=clean(body.ad_id,80),requestedMediaId=clean(body.media_id,80);
      if(!contextId||!adId)return json({ok:false,error:"context_and_ad_required"},400);
      await assertContextAd(contextId,adId);
      const [{data:ad,error:adError},{data:rows,error:mediaError}]=await Promise.all([
        ops.from("ad_radar_ads").select("id,raw_metadata").eq("id",adId).single(),
        ops.from("ad_radar_media").select("*").eq("ad_id",adId).order("position")
      ]);
      if(adError||mediaError)throw adError||mediaError;
      const all=rows||[];
      let media=requestedMediaId?all.find((m:any)=>String(m.id)===requestedMediaId):null;
      if(!media)media=all.find((m:any)=>m.media_type==="IMAGE")||all.find((m:any)=>m.media_type==="THUMBNAIL")||all[0];
      if(!media)return json({ok:false,error:"media_not_found"},404);
      if(media.media_type==="VIDEO"){
        const thumb=all.find((m:any)=>m.media_type==="THUMBNAIL");
        if(thumb)media=thumb;
      }
      if(!["IMAGE","THUMBNAIL"].includes(String(media.media_type)))return json({ok:false,error:"visual_media_required",detail:"Vídeo sem thumbnail e PDF não são descritos como análise visual completa."},422);

      let imageUrl=safeUrl(media.provider_url);
      if(media.storage_bucket&&media.storage_path){
        const {data:signed,error:signedError}=await admin.storage.from(media.storage_bucket).createSignedUrl(media.storage_path,300);
        if(signedError)throw signedError;imageUrl=safeUrl(signed?.signedUrl);
      }
      if(!imageUrl)return json({ok:false,error:"media_url_unavailable"},422);
      const reuseKey="ad-radar-vision-v1:"+String(media.id)+":"+String(media.last_verified_at||media.captured_at||"");
      const {data:existing}=await ops.from("ad_radar_analyses").select("*").eq("reuse_key",reuseKey).eq("status","COMPLETED").maybeSingle();
      if(existing)return json({ok:true,reused:true,analysis:existing});

      const sourceScope=(all.some((m:any)=>m.media_type==="VIDEO")&&media.media_type==="THUMBNAIL")?"VIDEO_THUMBNAIL":"IMAGE";
      const response=await fetch(ORIGIN+"/api/internal/ad-radar-vision",{
        method:"POST",
        headers:{Authorization:"Bearer "+service,"content-type":"application/json"},
        body:JSON.stringify({image_url:imageUrl,source_scope:sourceScope}),
        signal:AbortSignal.timeout(30000)
      });
      const vision=await response.json().catch(()=>({ok:false,error:"invalid_vision_response"}));
      const transcription=clean(ad?.raw_metadata?.full_transcription,12000)||null;
      const limitations=sourceScope==="VIDEO_THUMBNAIL"
        ?"Análise visual limitada à thumbnail; não descreve o vídeo inteiro."+ (transcription?" A transcrição veio do fornecedor e é mantida separadamente.":"")
        :"Análise limitada à imagem efetivamente processada.";
      const row={
        ad_id:adId,media_id:media.id,analysis_type:"RADAR_VISUAL",
        model_name:clean(vision?.model,200)||"@cf/meta/llama-3.2-11b-vision-instruct",
        prompt_version:clean(vision?.prompt_version,100)||"ad-radar-vision-v1",
        source_scope:sourceScope,status:response.ok&&vision?.ok?"COMPLETED":"FAILED",
        output:response.ok&&vision?.ok?{...vision.analysis,provider_transcription:transcription}: {},
        limitations:response.ok&&vision?.ok?limitations:clean(vision?.error||("vision_http_"+response.status),500),
        reuse_key:reuseKey,completed_at:new Date().toISOString()
      };
      const {data:saved,error:saveError}=await ops.from("ad_radar_analyses").upsert(row,{onConflict:"reuse_key"}).select("*").single();
      if(saveError)throw saveError;
      if(!response.ok||!vision?.ok)return json({ok:false,error:"analysis_failed",detail:saved.limitations,analysis:saved},422);
      return json({ok:true,reused:false,analysis:saved});
    }

    if(action==="feedback"&&req.method==="POST"){
      const ctx=clean(body.context_id,80),ad=clean(body.ad_id,80),category=clean(body.category,40).toUpperCase();
      if(!ctx||!ad||!["CONFIRMED","POSSIBLE","REGIONAL_COMPETITOR","EXECUTION_REFERENCE","OURS","REJECTED"].includes(category))return json({ok:false,error:"invalid_feedback"},400);
      await assertContextAd(ctx,ad);
      const now=new Date().toISOString();
      const {error}=await ops.from("ad_radar_match_overrides").upsert({context_id:ctx,ad_id:ad,category,note:clean(body.note,1000)||null,actor,updated_at:now},{onConflict:"context_id,ad_id"});if(error)throw error;
      await ops.from("ad_radar_matches").update({category,decision_source:"HUMAN",decided_by:actor,decided_at:now}).eq("context_id",ctx).eq("ad_id",ad);
      await ops.from("ad_radar_feedback").insert({context_id:ctx,ad_id:ad,feedback_type:clean(body.feedback_type,80)||category,detail:clean(body.note,1000)||null,actor});
      return json({ok:true});
    }

    if(action==="save-reference"&&req.method==="POST"){
      const ctx=clean(body.context_id,80),ad=clean(body.ad_id,80);if(!ctx||!ad)return json({ok:false,error:"context_and_ad_required"},400);await assertContextAd(ctx,ad);
      const {data,error}=await ops.from("ad_radar_saved_references").upsert({context_id:ctx,ad_id:ad,title:clean(body.title,220)||null,notes:clean(body.notes,1200)||null,saved_by:actor},{onConflict:"context_id,ad_id"}).select("*").single();if(error)throw error;return json({ok:true,reference:data});
    }

    if(action==="save-direction"&&req.method==="POST"){
      const ctx=clean(body.context_id,80);if(!ctx)return json({ok:false,error:"context_required"},400);await assertContextAccess(ctx);
      const {data:last}=await ops.from("ad_radar_directions").select("version").eq("context_id",ctx).order("version",{ascending:false}).limit(1).maybeSingle();
      const payload={context_id:ctx,version:Number(last?.version||0)+1,status:"DRAFT",audience:clean(body.audience,1000)||null,objective:clean(body.objective,1000)||null,argument:clean(body.argument,3000)||null,suggested_call:clean(body.suggested_call,1500)||null,composition:body.composition&&typeof body.composition==="object"?body.composition:{},source_materials:Array.isArray(body.source_materials)?body.source_materials:[],reference_ids:Array.isArray(body.reference_ids)?body.reference_ids:[],hypothesis:clean(body.hypothesis,2000)||null,confirmation_needed:clean(body.confirmation_needed,2000)||null,created_by:actor};
      const {data,error}=await ops.from("ad_radar_directions").insert(payload).select("*").single();if(error)throw error;return json({ok:true,direction:data});
    }

    if(action==="direction-task"&&req.method==="POST"){
      const directionId=clean(body.direction_id,80);if(!directionId)return json({ok:false,error:"direction_required"},400);await assertDirectionAccess(directionId);
      const {data,error}=await ops.rpc("ad_radar_direction_to_work_item",{p_direction_id:directionId,p_actor:actor});if(error)throw error;return json({ok:true,work_item_id:data});
    }

    if(action==="identity"&&req.method==="POST"){
      const ctx=await ensureContext(clean(body.product_id,80));
      const {data:current,error:currentError}=await ops.from("ad_radar_product_entities").select("identity_sources").eq("id",ctx.product_entity_id).single();if(currentError)throw currentError;
      const update:any={updated_at:new Date().toISOString()},sources={...(current?.identity_sources||{})};
      for(const key of ["canonical_name","city","neighborhood","address","builder","developer","phase","tower","typology","official_site_url"])if(body[key]!==undefined){update[key]=key==="official_site_url"?(safeUrl(body[key])||null):(clean(body[key],1000)||null);sources[key]="HUMAN"}
      if(Array.isArray(body.aliases)){update.aliases=body.aliases.map((x:any)=>clean(x,220)).filter(Boolean).slice(0,20);sources.aliases="HUMAN"}
      update.identity_sources=sources;
      const {data,error}=await ops.from("ad_radar_product_entities").update(update).eq("id",ctx.product_entity_id).select("*").single();if(error)throw error;return json({ok:true,entity:data});
    }

    return json({ok:false,error:"unknown_action"},404);
  }catch(e:any){const detail=clean(e?.message||e,300);console.error(e);if(detail==="radar_client_forbidden")return json({ok:false,error:"forbidden"},403);if(["radar_product_not_found","radar_context_not_found","radar_ad_not_in_context","radar_direction_not_found"].includes(detail))return json({ok:false,error:"not_found"},404);return json({ok:false,error:"internal_error",detail},500)}
});
