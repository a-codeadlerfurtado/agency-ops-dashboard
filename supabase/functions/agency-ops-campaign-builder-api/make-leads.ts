// Server-only Make integration; never expose credentials to the dashboard.
export type LeadQuestion = {key:string; label:string; type:string};
const safeKey = /^[\p{L}\p{N} _.,?!:/()\-]+$/u;
export function normalizeWhatsAppRecipient(raw: unknown): string {
  const digits = String(raw ?? "").replace(/\D/g,"");
  if (!/^55[1-9][0-9]{9,10}$/.test(digits)) throw new Error("make_recipient_invalid");
  return digits;
}
export function makeLeadExpression(key: string): string {
  if (!key || key.length > 180 || !safeKey.test(key)) throw new Error("make_form_field_invalid");
  const tick = String.fromCharCode(96);
  return "{{1.data." + tick + key + tick + "}}";
}
export function buildMakeLeadMessage(product: string, questions: LeadQuestion[]): string {
  if (!questions.length) throw new Error("make_form_questions_missing");
  const found: Record<string,string> = {};
  const extras: string[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    const type = q.type.toUpperCase(), key = q.key.trim(), label = q.label.trim();
    if (!label || seen.has(key)) throw new Error("make_form_field_invalid");
    seen.add(key);
    const token = makeLeadExpression(key);
    if (["FULL_NAME","FIRST_NAME","NAME"].includes(type) && !found.name) found.name=token;
    else if (["PHONE","PHONE_NUMBER"].includes(type) && !found.phone) found.phone=token;
    else if (type==="EMAIL" && !found.email) found.email=token;
    else extras.push(label + "\n" + token);
  }
  if (!found.name || !found.phone || !found.email) throw new Error("make_form_standard_fields_missing");
  const title = product.trim().slice(0,110).replace(/[\r\n{}]/g," ");
  if (!title) throw new Error("make_product_required");
  return ["NOVO LEAD - " + title, "NOME DO LEAD: " + found.name,
    "TELEFONE: " + found.phone, "EMAIL: " + found.email, ...extras].join("\n\n");
}
const API = "https://us1.make.com/api/v2";
async function requestMake(token:string,path:string,init:RequestInit={}):Promise<any> {
  const res=await fetch(API+path,{...init,headers:{"Authorization":"Token "+token,"content-type":"application/json",...(init.headers||{})}});
  const body=await res.json().catch(()=>null);
  if(!res.ok||body?.error) throw new Error("make_api_"+String(body?.code||body?.error?.code||res.status).slice(0,32));
  return body;
}
export type MakeProvisionInput={token:string;pageId:string;formId:string;recipient:string;
  teamId:number;facebookConnectionId:number;zapiConnectionId:number;
  clientName:string;product:string;requestId:string;questions:LeadQuestion[];
  recipients?:Array<{name:string;phone:string}>;};
export async function provisionMakeLeads(i:MakeProvisionInput) {
  const recipients=Array.isArray(i.recipients) && i.recipients.length>0
    ? i.recipients.map((r)=>({name:String(r.name||"").trim().slice(0,80),
        phone:normalizeWhatsAppRecipient(r.phone)}))
    : [{name:"Destinatário",phone:normalizeWhatsAppRecipient(i.recipient)}];
  if(recipients.length>25||recipients.some(r=>r.name.length<2)||
     new Set(recipients.map(r=>r.phone)).size!==recipients.length)
    throw new Error("make_roleta_recipients_invalid");
  const recipient=recipients[0].phone;
  const message=buildMakeLeadMessage(i.product,i.questions);
  if (!/^\d{5,30}$/.test(i.pageId)||!/^\d{5,30}$/.test(i.formId)||
    !Number.isInteger(i.facebookConnectionId)||i.facebookConnectionId<=0||
    !Number.isInteger(i.zapiConnectionId)||i.zapiConnectionId<=0)
    throw new Error("make_configuration_invalid");
  const name="[CB] "+i.clientName.slice(0,30)+" - "+i.product.slice(0,30)+" - "+i.formId+" - "+i.requestId.slice(0,8);
  let hookId=0,scenarioId=0,dataStoreId=0;
  try {
    // An existing live Make webhook for this exact form must not be cloned:
    // duplicate subscriptions would deliver every lead more than once.
    const listing=await requestMake(i.token,"/hooks?teamId="+i.teamId+
      "&typeName=facebook-lead-ads-new-event");
    const occupied=(listing?.hooks||[]).some((h:any)=>
      String(h?.data?.formId||h?.data?.form_id||"")===i.formId &&
      Number(h?.scenarioId||0)>0);
    if(occupied) throw new Error("make_form_already_connected");
    const hook=await requestMake(i.token,"/hooks",{method:"POST",body:JSON.stringify({
      name:"CB "+i.clientName.slice(0,40)+" "+i.formId,teamId:String(i.teamId),
      typeName:"facebook-lead-ads-new-event",method:false,headers:false,stringify:false,
      __IMTCONN__:i.facebookConnectionId,formId:i.formId,pageId:i.pageId
    })});
    hookId=Number(hook?.hook?.id||0);
    if (!hookId) throw new Error("make_hook_create_unverified");
    const detail=await requestMake(i.token,"/hooks/"+hookId);
    const data=detail?.hook?.data||{};
    const actualForm=String(data.formId||data.form_id||"");
    const actualPage=String(data.pageId||data.page_id||"");
    if(actualForm!==i.formId || (actualPage && actualPage!==i.pageId))
      throw new Error("make_hook_form_mismatch");
    const flow:any[]=[{id:1,module:"facebook-lead-ads:NewLeadMultiple",version:2,
      parameters:{v:"2",fields:[],__IMTHOOK__:hookId},
      mapper:{},metadata:{designer:{x:0,y:0}}}];
    if(recipients.length===1){
      flow.push({id:6,module:"z-api:sendTextMessage",version:1,
        parameters:{__IMTCONN__:i.zapiConnectionId},
        mapper:{phone:recipient,message},metadata:{designer:{x:300,y:0}}});
    }else{
      const structure=await requestMake(i.token,"/data-structures",{method:"POST",
        body:JSON.stringify({teamId:i.teamId,name:"CB Roleta "+i.formId,strict:true,
          spec:[{type:"text",name:"ultimo_corretor",label:"Último corretor",required:true}]})});
      const structureId=Number(structure?.dataStructure?.id||0);
      if(!structureId) throw new Error("make_roleta_structure_create_failed");
      const store=await requestMake(i.token,"/data-stores",{method:"POST",
        body:JSON.stringify({name:"CB Roleta "+i.clientName.slice(0,40)+" "+i.formId,
          teamId:i.teamId,datastructureId:structureId,maxSizeMB:1})});
      dataStoreId=Number(store?.dataStore?.id||0);
      if(!dataStoreId) throw new Error("make_roleta_store_create_failed");
      await requestMake(i.token,"/data-stores/"+dataStoreId+"/data",{method:"POST",
        body:JSON.stringify({key:"roleta",data:{ultimo_corretor:String(recipients.length-1)}})});
      flow.push({id:3,module:"datastore:GetRecord",version:1,
        parameters:{datastore:dataStoreId},
        mapper:{key:"roleta",returnWrapped:false},metadata:{designer:{x:300,y:0}}});
      const routes:any[]=[];
      for(let index=0;index<recipients.length;index++){
        const current=recipients[index],sendId=20+2*index,updateId=sendId+1;
        const previous=String((index+recipients.length-1)%recipients.length);
        routes.push({flow:[
          {id:sendId,module:"z-api:sendTextMessage",version:1,
            filter:{name:"Enviar para "+current.name,
              conditions:[[{a:"{{3.ultimo_corretor}}",b:previous,o:"text:equal"}]]},
            parameters:{__IMTCONN__:i.zapiConnectionId},
            mapper:{phone:current.phone,message},
            metadata:{designer:{x:900,y:index*220}}},
          {id:updateId,module:"datastore:UpdateRecord",version:1,
            parameters:{datastore:dataStoreId},
            mapper:{key:"roleta",data:{ultimo_corretor:String(index)},
              upsert:true,overwriteArrays:false},
            metadata:{designer:{x:1200,y:index*220}}}
        ]});
      }
      flow.push({id:4,module:"builtin:BasicRouter",version:1,routes,
        metadata:{designer:{x:600,y:0}}});
    }
    const blueprint={name,flow,metadata:{version:1,
      scenario:{roundtrips:1,maxErrors:3,autoCommit:true,autoCommitTriggerLast:true,
        sequential:recipients.length>1,confidential:false,dataloss:false,dlq:false,
        freshVariables:false},designer:{orphans:[]}}};
    const created=await requestMake(i.token,"/scenarios",{method:"POST",body:JSON.stringify({
      teamId:i.teamId,scheduling:JSON.stringify({type:"immediately"}),blueprint:JSON.stringify(blueprint)
    })});
    scenarioId=Number(created?.scenario?.id||0);
    if (!scenarioId) throw new Error("make_scenario_create_unverified");
    const fetched=await requestMake(i.token,"/scenarios/"+scenarioId+"/blueprint");
    const raw=fetched?.blueprint;
    const saved=typeof raw==="string"?JSON.parse(raw):raw;
    const fb=saved?.flow?.find((m:any)=>m.module==="facebook-lead-ads:NewLeadMultiple");
    const receivers=recipients.length===1
      ? saved?.flow?.filter((m:any)=>m.module==="z-api:sendTextMessage")
      : saved?.flow?.find((m:any)=>m.module==="builtin:BasicRouter")?.routes
        ?.flatMap((r:any)=>r.flow.filter((m:any)=>m.module==="z-api:sendTextMessage"));
    if(Number(fb?.parameters?.__IMTHOOK__)!==hookId ||
       !Array.isArray(receivers)||receivers.length!==recipients.length||
       receivers.some((m:any,j:number)=>
         Number(m?.parameters?.__IMTCONN__)!==i.zapiConnectionId||
         m?.mapper?.phone!==recipients[j].phone||m?.mapper?.message!==message))
      throw new Error("make_scenario_blueprint_mismatch");
    await requestMake(i.token,"/scenarios/"+scenarioId+"/start",{method:"POST"});
    const state=await requestMake(i.token,"/scenarios/"+scenarioId);
    if(state?.scenario?.isActive!==true) throw new Error("make_scenario_not_active");
    return {scenarioId,hookId,formId:i.formId,pageId:i.pageId,recipient,
      recipients:recipients.map(r=>({name:r.name,phone:r.phone})),dataStoreId};
  }catch(e){
    if(scenarioId) await requestMake(i.token,"/scenarios/"+scenarioId+"/stop",{method:"POST"}).catch(()=>{});
    const err=new Error((e as Error).message);
    (err as any).scenarioId=scenarioId||null;
    (err as any).hookId=hookId||null;
    (err as any).dataStoreId=dataStoreId||null;
    throw err;
  }
}
