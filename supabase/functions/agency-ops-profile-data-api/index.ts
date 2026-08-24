import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type","access-control-allow-methods":"GET,OPTIONS","access-control-max-age":"86400"};
const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...CORS,"content-type":"application/json; charset=utf-8","cache-control":"private, max-age=120"}});

// Compatibilidade: a Home principal ja entrega identidade, GT por cliente e foco
// pessoal. Esta rota antiga repetia consultas grandes do ClickUp depois da Home.
// Gabriel usa endpoint proprio e nao passa por aqui.
Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  if(req.method!=="GET")return respond({error:"method_not_allowed"},405);
  return respond({profile:{},focus:null,stats:null,client_gt:[],deprecated:true,generated_at:new Date().toISOString()});
});