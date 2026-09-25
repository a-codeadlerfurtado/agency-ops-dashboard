const EXPECTED_HASH = "7cc93c3620480e4bf242e4ee1a030d7c8b5397534708f9729e9a43ac7a5352cf";
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const schema = {
  type:"object",
  properties:{
    summary:{type:"string"},
    decisions:{type:"array",items:{type:"string"}},
    commitments:{type:"array",items:{type:"string"}},
    action_items:{type:"array",items:{type:"object",properties:{title:{type:"string"},owner:{type:"string"},due_date:{type:"string"},evidence:{type:"string"}},required:["title","owner","due_date","evidence"]}},
    summary_topics:{type:"array",items:{type:"object",properties:{title:{type:"string"},body:{type:"string"}},required:["title","body"]}},
    highlights:{type:"object",properties:{
      opportunities:{type:"array",items:{type:"string"}},
      insights:{type:"array",items:{type:"string"}},
      ideas:{type:"array",items:{type:"string"}},
      objectives:{type:"array",items:{type:"string"}},
      problems:{type:"array",items:{type:"string"}},
      lessons:{type:"array",items:{type:"string"}}
    },required:["opportunities","insights","ideas","objectives","problems","lessons"]},
    keywords:{type:"array",items:{type:"string"}},
    rewritten_notes:{type:"array",items:{type:"object",properties:{speaker:{type:"string"},timestamp:{type:"string"},original:{type:"string"},rewritten:{type:"string"}},required:["speaker","timestamp","original","rewritten"]}},
    objections:{type:"array",items:{type:"string"}},
    pain_points:{type:"array",items:{type:"string"}},
    primary_pain:{type:"string"},
    secondary_pains:{type:"array",items:{type:"string"}},
    goals:{type:"array",items:{type:"string"}},
    urgency:{type:"string"},
    decision_role:{type:"string"},
    current_structure:{type:"string"},
    marketing_investment:{type:"string"},
    broker_count:{type:"integer"},
    services_interest:{type:"array",items:{type:"string"}},
    buying_signals:{type:"array",items:{type:"string"}},
    closing_risks:{type:"array",items:{type:"string"}},
    closer_briefing:{type:"string"},
    opportunities:{type:"array",items:{type:"string"}},
    follow_up:{type:"string"}
  },
  required:["summary","decisions","commitments","action_items","summary_topics","highlights","keywords","rewritten_notes","objections","pain_points","primary_pain","secondary_pains","goals","urgency","decision_role","current_structure","marketing_investment","broker_count","services_interest","buying_signals","closing_risks","closer_briefing","opportunities","follow_up"]
};
async function sha256(value){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function out(body,status=200){
  return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff"}});
}
function parseJsonText(value){
  if(typeof value!=="string") return null;
  let cleaned=value.trim();
  if(cleaned.startsWith("```")) cleaned=cleaned.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");
  try{return JSON.parse(cleaned);}catch{return null;}
}
function findAnalysis(value,depth=0){
  if(depth>5 || value==null) return null;
  if(typeof value==="string"){
    const parsed=parseJsonText(value);
    return parsed ? findAnalysis(parsed,depth+1) : null;
  }
  if(Array.isArray(value)){
    for(const item of value){const found=findAnalysis(item,depth+1);if(found)return found;}
    return null;
  }
  if(typeof value!=="object") return null;
  if(typeof value.summary==="string" && value.summary.trim()) return value;
  for(const key of ["response","result","output","json","data","content","message","choices"]){
    if(key in value){const found=findAnalysis(value[key],depth+1);if(found)return found;}
  }
  return null;
}
function parseCandidate(result){return findAnalysis(result);}
export default {
  async fetch(request,env){
    if(request.method==="GET") return out({ok:true,service:"relato-commercial-ai",model:MODEL});
    if(request.method!=="POST") return out({ok:false,error:"method_not_allowed"},405);
    const token=request.headers.get("x-relato-commercial-secret")||"";
    if(!token || await sha256(token)!==EXPECTED_HASH) return out({ok:false,error:"unauthorized"},401);
    const body=await request.json().catch(()=>({}));
    const transcript=String(body.transcript||"").slice(0,50000).trim();
    if(!transcript) return out({ok:false,error:"transcript_required"},400);
    const system=[
      "Você analisa ligações comerciais de SDR em português do Brasil.",
      "Use SOMENTE fatos explicitamente presentes na transcrição. Nunca invente ou complete lacunas.",
      "O objetivo é preparar o closer para a reunião de fechamento.",
      "Não trate disponibilidade de agenda, horário ou reagendamento como dor comercial.",
      "Se a chamada for apenas agendamento/reagendamento, mantenha campos de qualificação vazios.",
      "Para qualquer dado ausente use string vazia, zero ou array vazio."
    ].join("\n");
    const context=[
      "SDR/RESPONSÁVEL: "+String(body.owner_person||""),
      "PROSPECT/CLIENTE: "+String(body.client_name_raw||""),
      "FONTE: "+String(body.transcript_source||""),
      "",
      "TRANSCRIÇÃO:",
      transcript
    ].join("\n");
    const started=Date.now();
    let result;
    try{
      result=await env.AI.run(MODEL,{
        messages:[{role:"system",content:system},{role:"user",content:context}],
        temperature:0.05,
        max_tokens:1400,
        response_format:{type:"json_schema",json_schema:schema}
      });
    }catch(error){
      return out({ok:false,error:"workers_ai_failed",detail:String(error?.message||error).slice(0,500)},502);
    }
    const analysis=parseCandidate(result);
    if(!analysis || !String(analysis.summary||"").trim()){
      const candidate=result?.response ?? result?.result?.response ?? result?.result?.text ?? result?.text ?? null;
      return out({ok:false,error:"empty_analysis",shape:Object.keys(result||{}),candidate_type:typeof candidate},502);
    }
    return out({ok:true,provider:"CLOUDFLARE_WORKERS_AI",model:MODEL,latency_ms:Date.now()-started,analysis});
  }
};
