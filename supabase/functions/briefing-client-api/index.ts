import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const j = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const fail = (error: string, status = 400) => j({ error }, status);
const mapStatus = (v: unknown) => ({
  NAO_INICIADO: "NOT_STARTED", EM_ANDAMENTO: "IN_PROGRESS", COMPLETO: "COMPLETE",
  PERSONA_PENDENTE: "IN_PROGRESS", PRODUTO_PENDENTE: "IN_PROGRESS",
}[String(v || "")] || String(v || "NOT_STARTED"));
const filled = (v: unknown) => v !== null && v !== undefined &&
  (!(typeof v === "string") || v.trim() !== "") &&
  (!Array.isArray(v) || v.length > 0);
const ruleOk = (rule: any, vals: Record<string, unknown>) => {
  if (!rule) return true;
  const v = vals[rule.key];
  if (rule.notEmpty) return filled(v);
  if (Array.isArray(rule.in)) return rule.in.includes(v);
  if (Array.isArray(rule.notIn)) return !rule.notIn.includes(v);
  if (Array.isArray(rule.containsAny)) {
    const a = Array.isArray(v) ? v : [v];
    return a.some((x) => rule.containsAny.includes(x));
  }
  return true;
};
const valueOf = (a: any) => a?.value_json !== null && a?.value_json !== undefined
  ? a.value_json : a?.value_text ?? null;

const profileQuestions = [
  { question_key:"brand.instagram",section_name:"Marca",position:10,label:"Instagram principal",help_what:"Informe o perfil principal da empresa/corretor.",help_why:"Pode ser reaproveitado em produtos e pesquisa de contexto.",example_text:"@suaimobiliaria",input_type:"TEXT",options:[],required:0,allow_files:0 },
  { question_key:"brand.website",section_name:"Marca",position:20,label:"Site principal",help_what:"Informe o site oficial, se houver.",help_why:"Ajuda a equipe a encontrar informações institucionais confiáveis.",example_text:"https://...",input_type:"URL",options:[],required:0,allow_files:0 },
  { question_key:"brand.identity_notes",section_name:"Marca",position:30,label:"Como devemos tratar a identidade visual da sua marca?",help_what:"Descreva paleta, estilo, logo e regras permanentes.",help_why:"Isso evita repetir a mesma orientação em cada produto.",example_text:"Usar azul-marinho e branco; logo na versão horizontal.",input_type:"TEXTAREA",options:[],required:0,allow_files:1 },
  { question_key:"brand.communication_restrictions",section_name:"Marca",position:40,label:"Existem regras permanentes do que não podemos mostrar, escrever ou alterar?",help_what:"Registre restrições que valem para a marca como um todo.",help_why:"Regras permanentes reduzem retrabalho.",example_text:"Não alterar logo; evitar preto; não usar a palavra luxo.",input_type:"TEXTAREA",options:[],required:0,allow_files:1 },
  { question_key:"market.references",section_name:"Mercado",position:10,label:"Quais perfis, imobiliárias, corretores ou marcas você considera boas referências de marketing?",help_what:"Pode informar Instagrams ou nomes.",help_why:"Essa lista alimenta pesquisa competitiva.",example_text:"@perfil1, @perfil2",input_type:"TEXTAREA",options:[],required:0,allow_files:0 },
  { question_key:"market.notes",section_name:"Mercado",position:20,label:"Existe alguma particularidade do seu mercado/região que a equipe deveria conhecer?",help_what:"Conte algo recorrente sobre compradores, concorrência ou comportamento regional.",help_why:"Conhecimento local complementa a pesquisa da agência.",example_text:"Compradores costumam vir de cidades vizinhas.",input_type:"TEXTAREA",options:[],required:0,allow_files:0 },
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return j({ ok: true });
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return fail("unauthorized", 401);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const sb = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await sb.auth.getUser(auth.slice(7));
  if (userError || !userData.user) return fail("unauthorized", 401);
  const userId = userData.user.id;

  const { data: membership, error: memberError } = await sb
    .from("briefing_client_users").select("client_id").eq("user_id", userId).eq("is_active", true).limit(1).maybeSingle();
  if (memberError || !membership?.client_id) return fail("client_not_linked", 403);
  const clientId = membership.client_id as string;

  const u = new URL(req.url);
  // O runtime recebe o caminho completo /functions/v1/briefing-client-api/... em produção.
  // Aceitamos também /briefing-client-api/... para manter compatibilidade com preview/local.
  const path = u.pathname
    .replace(/^\/functions\/v1\/briefing-client-api/, "")
    .replace(/^\/briefing-client-api/, "");
  let body: any = {};
  if (!["GET", "HEAD"].includes(req.method)) {
    try { body = await req.json(); } catch { return fail("invalid_json"); }
  }

  const entityRow = async (type: string, id: string) => {
    const table = type === "PRODUCT" ? "briefing_products" : type === "PERSONA" ? "briefing_personas" : "";
    if (!table || !id) return null;
    const { data } = await sb.from(table).select("*").eq("id", id).eq("client_id", clientId).maybeSingle();
    return data;
  };
  const questionsFor = async (templateId: string) => {
    const { data, error } = await sb.from("briefing_form_questions")
      .select("*,section:briefing_form_sections(title,position)")
      .eq("template_id", templateId).eq("visibility", "SHARED").order("position");
    if (error) throw error;
    return (data || []).map((q: any) => ({
      question_key:q.question_key, section_name:q.section?.title || "Informações",
      position:q.position, label:q.label, help_text:q.help_text,
      input_type:String(q.input_type || "text").toUpperCase(), required:q.is_required ? 1 : 0,
      options:q.options || [], help_what:q.help_what, help_why:q.help_why,
      example_text:q.example_text, common_mistake:q.common_mistake,
      visibility_hint:q.visibility_hint, show_when:q.show_when_json,
      required_when:q.required_when_json, allow_unknown:q.allow_unknown ? 1 : 0,
      allow_files:q.allow_files ? 1 : 0, file_mode:q.file_mode,
    }));
  };
  const progressFor = async (type: string, entity: any, qs?: any[], ans?: any[], flags?: any[]) => {
    const questions = qs || await questionsFor(entity.template_id);
    let answers = ans;
    if (!answers) {
      const { data } = await sb.from("briefing_answers").select("*")
        .eq("entity_type", type).eq("entity_id", entity.id).eq("visibility", "SHARED");
      answers = data || [];
    }
    let reviewFlags = flags;
    if (!reviewFlags) {
      const { data } = await sb.from("briefing_review_flags").select("*")
        .eq("entity_type", type).eq("entity_id", entity.id).eq("review_needed", true);
      reviewFlags = data || [];
    }
    const vals: Record<string, unknown> = {};
    for (const a of answers || []) vals[a.question_key] = valueOf(a);
    const flagSet = new Set((reviewFlags || []).map((x: any) => x.question_key));
    const relevant = questions.filter((q: any) => ruleOk(q.show_when, vals));
    const required = relevant.filter((q: any) => q.required === 1 || (q.required_when && ruleOk(q.required_when, vals)));
    const answered = required.filter((q: any) => filled(vals[q.question_key]) || flagSet.has(q.question_key)).length;
    const percent = required.length ? Math.round(answered * 100 / required.length) : 100;
    const { data: saved } = await sb.from("briefing_progress").select("*")
      .eq("entity_type", type).eq("entity_id", entity.id).maybeSingle();
    return {
      progress: { ...(saved || {}), percent },
      stats: { required: required.length, answered, percent },
      flags: reviewFlags || [],
      missing: required.filter((q: any) => !filled(vals[q.question_key]) && !flagSet.has(q.question_key)),
    };
  };

  try {
    if (path === "/overview" && req.method === "GET") {
      const [{ data: products }, { data: personas }, { data: links }, { data: answers }, { data: client }] = await Promise.all([
        sb.from("briefing_products").select("*").eq("client_id", clientId).is("archived_at", null).order("updated_at", { ascending:false }),
        sb.from("briefing_personas").select("*").eq("client_id", clientId).is("archived_at", null).order("updated_at", { ascending:false }),
        sb.from("briefing_product_personas").select("*"),
        sb.from("briefing_answers").select("*").eq("client_id", clientId).eq("visibility", "SHARED"),
        sb.schema("agency_ops").from("clients").select("display_name").eq("id", clientId).maybeSingle(),
      ]);
      const all = [...(products || []), ...(personas || [])];
      const templateIds = [...new Set(all.map((x: any) => x.template_id))];
      const { data: rawQuestions } = templateIds.length
        ? await sb.from("briefing_form_questions").select("*,section:briefing_form_sections(title,position)").in("template_id", templateIds).eq("visibility","SHARED")
        : { data: [] as any[] };
      const qsBy = new Map<string, any[]>();
      for (const q of rawQuestions || []) {
        const x = { question_key:q.question_key,section_name:q.section?.title||"Informações",position:q.position,label:q.label,
          help_text:q.help_text,input_type:String(q.input_type||"text").toUpperCase(),required:q.is_required?1:0,options:q.options||[],
          help_what:q.help_what,help_why:q.help_why,example_text:q.example_text,common_mistake:q.common_mistake,
          visibility_hint:q.visibility_hint,show_when:q.show_when_json,required_when:q.required_when_json,
          allow_unknown:q.allow_unknown?1:0,allow_files:q.allow_files?1:0,file_mode:q.file_mode };
        if (!qsBy.has(q.template_id)) qsBy.set(q.template_id, []);
        qsBy.get(q.template_id)!.push(x);
      }
      for (const list of qsBy.values()) list.sort((a,b)=>(a.position||0)-(b.position||0));
      const ansBy = new Map<string, any[]>();
      for (const a of answers || []) {
        const k = a.entity_type + ":" + a.entity_id;
        if (!ansBy.has(k)) ansBy.set(k, []);
        ansBy.get(k)!.push(a);
      }
      const productOut = [];
      for (const p of products || []) {
        const pr = await progressFor("PRODUCT", p, qsBy.get(p.template_id)||[], ansBy.get("PRODUCT:"+p.id)||[]);
        productOut.push({ ...p, status:mapStatus(p.completion_status), briefing_status:mapStatus(p.briefing_status),
          progress:pr.stats, personas:(links||[]).filter((l:any)=>l.product_id===p.id).map((l:any)=>{
            const pe=(personas||[]).find((x:any)=>x.id===l.persona_id); return pe?{id:pe.id,name:pe.name,status:mapStatus(pe.completion_status)}:null;
          }).filter(Boolean) });
      }
      const personaOut = [];
      for (const p of personas || []) {
        const pr = await progressFor("PERSONA", p, qsBy.get(p.template_id)||[], ansBy.get("PERSONA:"+p.id)||[]);
        const intent = valueOf((ansBy.get("PERSONA:"+p.id)||[]).find((a:any)=>a.question_key==="persona.intent"));
        personaOut.push({ ...p, status:mapStatus(p.completion_status), progress:pr.stats,
          product_count:(links||[]).filter((l:any)=>l.persona_id===p.id).length, intent });
      }
      return j({ products:productOut, personas:personaOut, user:{ client_name:client?.display_name || "" } });
    }

    if (path === "/entity" && req.method === "GET") {
      const type = String(u.searchParams.get("type") || "").toUpperCase();
      const id = String(u.searchParams.get("id") || "");
      const entity = await entityRow(type,id);
      if (!entity) return fail("not_found",404);
      const [questions, ansResult, linkResult] = await Promise.all([
        questionsFor(entity.template_id),
        sb.from("briefing_answers").select("*").eq("entity_type",type).eq("entity_id",id).eq("visibility","SHARED"),
        type==="PRODUCT" ? sb.from("briefing_product_personas").select("persona_id,position").eq("product_id",id).order("position") : Promise.resolve({data:[]}),
      ]);
      const answers: Record<string, unknown> = {};
      for (const a of ansResult.data || []) answers[a.question_key]={value:valueOf(a),updated_by_name:a.updated_by_name,updated_at:a.updated_at};
      let links:any[]=[];
      const personaIds=(linkResult.data||[]).map((x:any)=>x.persona_id);
      if(personaIds.length){
        const {data}=await sb.from("briefing_personas").select("id,name,completion_status").in("id",personaIds);
        links=(data||[]).map((x:any)=>({id:x.id,name:x.name,status:mapStatus(x.completion_status)}));
      }
      return j({entity:{...entity,status:mapStatus(entity.completion_status)},questions,answers,links});
    }

    if (path === "/answer" && req.method === "PUT") {
      const type=String(body.type||"").toUpperCase(), id=String(body.id||""), key=String(body.key||"");
      const entity=await entityRow(type,id); if(!entity) return fail("not_found",404);
      const {data,error}=await sb.rpc("briefing_save_answers",{p_entity_type:type,p_entity_id:id,p_answers:{[key]:body.value},p_reason:body.note||null});
      if(error) return fail(error.message,400);
      if((type==="PRODUCT"&&key==="product.name")||(type==="PERSONA"&&key==="persona.name")){
        const table=type==="PRODUCT"?"briefing_products":"briefing_personas";
        await sb.from(table).update({name:String(body.value||"").trim()}).eq("id",id);
      }
      await sb.from("briefing_review_flags").delete().eq("entity_type",type).eq("entity_id",id).eq("question_key",key);
      return j({ok:true,status:mapStatus(data?.status)});
    }

    if (path === "/history" && req.method === "GET") {
      const type=String(u.searchParams.get("type")||"").toUpperCase(), id=String(u.searchParams.get("id")||"");
      if(!await entityRow(type,id)) return fail("not_found",404);
      const {data,error}=await sb.from("briefing_answer_history").select("*").eq("entity_type",type).eq("entity_id",id).order("changed_at",{ascending:false}).limit(500);
      if(error) throw error;
      return j({history:(data||[]).map((x:any)=>({...x,old_value:x.old_value_json??x.old_value_text,new_value:x.new_value_json??x.new_value_text}))});
    }

    if ((path === "/products" || path === "/personas") && req.method === "POST") {
      const type=path==="/products"?"PRODUCT":"PERSONA", name=String(body.name||"").trim();
      if(!name) return fail("name_required");
      const {data:tpl,error:te}=await sb.from("briefing_form_templates").select("id").eq("entity_type",type).eq("is_active",true).order("version",{ascending:false}).limit(1).maybeSingle();
      if(te||!tpl) return fail("template_not_found",500);
      const table=type==="PRODUCT"?"briefing_products":"briefing_personas";
      const payload:any={client_id:clientId,template_id:tpl.id,name,completion_status:"NAO_INICIADO",created_by:userId,updated_by:userId,updated_by_type:"CLIENT"};
      if(type==="PRODUCT") payload.briefing_status="NAO_INICIADO";
      const {data,error}=await sb.from(table).insert(payload).select("id").single();
      if(error) throw error;
      return j({ok:true,id:data.id});
    }

    if (path === "/link-persona" && req.method === "POST") {
      const product=await entityRow("PRODUCT",String(body.product_id||"")), persona=await entityRow("PERSONA",String(body.persona_id||""));
      if(!product||!persona||product.client_id!==persona.client_id) return fail("forbidden",403);
      const {count}=await sb.from("briefing_product_personas").select("*",{count:"exact",head:true}).eq("product_id",product.id);
      const {error}=await sb.from("briefing_product_personas").upsert({product_id:product.id,persona_id:persona.id,position:count||0,created_by:userId},{onConflict:"product_id,persona_id"});
      if(error) throw error; return j({ok:true});
    }

    if (path === "/duplicate-persona" && req.method === "POST") {
      const src=await entityRow("PERSONA",String(body.persona_id||"")); if(!src)return fail("not_found",404);
      const name=String(body.name||src.name+" — cópia").trim();
      const {data:created,error}=await sb.from("briefing_personas").insert({client_id:clientId,template_id:src.template_id,name,completion_status:"NAO_INICIADO",created_by:userId,updated_by:userId,updated_by_type:"CLIENT"}).select("id").single();
      if(error)throw error;
      const {data:answers}=await sb.from("briefing_answers").select("question_key,value_text,value_json,visibility").eq("entity_type","PERSONA").eq("entity_id",src.id).eq("visibility","SHARED");
      if(answers?.length){
        for(const a of answers) await sb.rpc("briefing_save_answers",{p_entity_type:"PERSONA",p_entity_id:created.id,p_answers:{[a.question_key]:valueOf(a)},p_reason:"Persona duplicada"});
      }
      return j({ok:true,id:created.id,name});
    }

    if (path === "/context") {
      const product=await entityRow("PRODUCT",String(req.method==="GET"?u.searchParams.get("product_id"):body.product_id));
      const persona=await entityRow("PERSONA",String(req.method==="GET"?u.searchParams.get("persona_id"):body.persona_id));
      if(!product||!persona||product.client_id!==persona.client_id)return fail("forbidden",403);
      if(req.method==="GET"){
        const {data}=await sb.from("briefing_product_persona_context").select("*").eq("product_id",product.id).eq("persona_id",persona.id).maybeSingle();
        return j({x:data||{product_id:product.id,persona_id:persona.id}});
      }
      const field=String(body.field||"");
      if(!["fit_reason","transition_benefit","strongest_angle","specific_objection"].includes(field))return fail("bad_field");
      const payload:any={product_id:product.id,persona_id:persona.id,client_id:clientId,updated_by:userId,updated_by_type:"CLIENT"};
      payload[field]=String(body.value??"");
      const {error}=await sb.from("briefing_product_persona_context").upsert(payload,{onConflict:"product_id,persona_id"});
      if(error)throw error; return j({ok:true});
    }

    if (path === "/progress") {
      const type=String(req.method==="GET"?u.searchParams.get("type"):body.type||"").toUpperCase();
      const id=String(req.method==="GET"?u.searchParams.get("id"):body.id||"");
      const entity=await entityRow(type,id); if(!entity)return fail("not_found",404);
      if(req.method==="PUT"){
        const payload={client_id:clientId,entity_type:type,entity_id:id,fill_mode:body.fill_mode||null,current_section:body.current_section||null,current_question_key:body.current_question_key||null,current_step:Number(body.current_step||0),updated_at:new Date().toISOString()};
        const {error}=await sb.from("briefing_progress").upsert(payload,{onConflict:"entity_type,entity_id"}); if(error)throw error;
      }
      const p=await progressFor(type,entity); return j({progress:p.progress,stats:p.stats,flags:p.flags});
    }

    if (path === "/review-flag" && req.method === "PUT") {
      const type=String(body.type||"").toUpperCase(),id=String(body.id||""),key=String(body.key||body.question_key||"");
      if(!await entityRow(type,id))return fail("not_found",404);
      if(body.review_needed===false) await sb.from("briefing_review_flags").delete().eq("entity_type",type).eq("entity_id",id).eq("question_key",key);
      else {
        const {error}=await sb.from("briefing_review_flags").upsert({client_id:clientId,entity_type:type,entity_id:id,question_key:key,review_needed:true,note:String(body.note||""),updated_by:userId},{onConflict:"entity_type,entity_id,question_key"});
        if(error)throw error;
      }
      return j({ok:true});
    }

    if (path === "/review" && req.method === "GET") {
      const type=String(u.searchParams.get("type")||"").toUpperCase(),id=String(u.searchParams.get("id")||"");
      const entity=await entityRow(type,id); if(!entity)return fail("not_found",404);
      const p=await progressFor(type,entity);
      return j({missing:p.missing,review_flags:p.flags,stats:p.stats});
    }

    if (path === "/submit" && req.method === "POST") {
      const type=String(body.type||"").toUpperCase(),id=String(body.id||"");
      const entity=await entityRow(type,id); if(!entity)return fail("not_found",404);
      const p=await progressFor(type,entity); if(p.missing.length)return fail("required_missing",409);
      const at=new Date().toISOString();
      const {error}=await sb.from("briefing_progress").upsert({client_id:clientId,entity_type:type,entity_id:id,submitted_at:at,submitted_by:userId,updated_at:at},{onConflict:"entity_type,entity_id"});
      if(error)throw error;
      const table=type==="PRODUCT"?"briefing_products":"briefing_personas";
      await sb.from(table).update({completion_status:"COMPLETO",completed_at:at,updated_by:userId,updated_by_type:"CLIENT"}).eq("id",id);
      await sb.from("briefing_events").insert({client_id:clientId,event_type:"BRIEFING_SUBMITTED",product_id:type==="PRODUCT"?id:null,persona_id:type==="PERSONA"?id:null,title:"Briefing enviado",payload:{entity_type:type}});
      return j({ok:true,submitted_at:at});
    }

    if (path === "/account") {
      const {data:client}=await sb.schema("agency_ops").from("clients").select("id,display_name").eq("id",clientId).maybeSingle();
      if(req.method==="GET"){
        const {data:profile}=await sb.from("briefing_client_profile").select("*").eq("client_id",clientId).maybeSingle();
        const values=profile?.metadata?.portal_answers||{};
        const answers:Record<string,unknown>={}; for(const [k,v] of Object.entries(values))answers[k]={value:v,updated_at:profile?.updated_at};
        return j({client:{id:clientId,name:client?.display_name||""},questions:profileQuestions,answers});
      }
      const key=String(body.key||""); if(!profileQuestions.some(q=>q.question_key===key))return fail("bad_question");
      const {data:old}=await sb.from("briefing_client_profile").select("metadata").eq("client_id",clientId).maybeSingle();
      const metadata={...(old?.metadata||{}),portal_answers:{...(old?.metadata?.portal_answers||{}),[key]:body.value}};
      const {error}=await sb.from("briefing_client_profile").upsert({client_id:clientId,metadata,visibility:"SHARED",updated_by:userId,updated_by_type:"CLIENT",updated_at:new Date().toISOString()},{onConflict:"client_id"});
      if(error)throw error; return j({ok:true});
    }

    if (path === "/portal-history" && req.method === "GET") {
      const {data,error}=await sb.from("briefing_events").select("*").eq("client_id",clientId).order("occurred_at",{ascending:false}).limit(100);
      if(error)throw error;
      return j({events:(data||[]).map((x:any)=>({event_type:x.event_type,payload:x.payload,actor_name:null,created_at:x.occurred_at,title:x.title}))});
    }

    return fail("not_found",404);
  } catch (e) {
    console.error(e);
    return fail("internal_error",500);
  }
});