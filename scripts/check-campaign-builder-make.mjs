import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source=fs.readFileSync("supabase/functions/agency-ops-campaign-builder-api/make-leads.ts","utf8");
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};
const calls=[];
let storedBlueprint=null,occupied=false,failScenario=false;
const fakeFetch=async (url,init={})=>{
 const u=new URL(url),path=u.pathname.replace("/api/v2","");
 const body=init.body?JSON.parse(init.body):null;
 calls.push({path,method:init.method||"GET",body});
 let payload={};
 if(path==="/hooks"&&(!init.method||init.method==="GET")) payload={hooks:occupied?[{id:17,scenarioId:22,data:{formId:"1234567890"}}]:[]};
 else if(path==="/hooks"&&init.method==="POST") payload={hook:{id:291}};
 else if(path==="/hooks/291") payload={hook:{data:{formId:"1234567890",pageId:"12345678901"}}};
 else if(path==="/data-structures") payload={dataStructure:{id:540}};
 else if(path==="/data-stores") payload={dataStore:{id:550}};
 else if(path==="/data-stores/550/data") payload={key:"roleta"};
 else if(path==="/scenarios"&&init.method==="POST"){if(failScenario) return {ok:false,status:400,json:async()=>({code:"IM005",message:"bad"})};storedBlueprint=JSON.parse(body.blueprint);payload={scenario:{id:994}};}
 else if(init.method==="DELETE") payload={};
 else if(path==="/scenarios/994/blueprint") payload={blueprint:storedBlueprint};
 else if(path==="/scenarios/994/start") payload={scenario:{id:994,isActive:true}};
 else if(path==="/scenarios/994") payload={scenario:{id:994,isActive:true}};
 else throw Error("Unexpected mock Make request: "+path+" "+(init.method||"GET"));
 return {ok:true,json:async()=>payload};
};
vm.runInNewContext(js,{exports,fetch:fakeFetch,URL,Set,Map,console});
const {normalizeWhatsAppRecipient,makeLeadExpression,buildMakeLeadMessage,provisionMakeLeads}=exports;
assert.equal(normalizeWhatsAppRecipient("+55 (11) 99999-9999"),"5511999999999");
assert.throws(()=>normalizeWhatsAppRecipient("11999999999"),/make_recipient_invalid/);
const questions=[
 {key:"full_name",type:"FULL_NAME",label:"Nome completo"},
 {key:"phone_number",type:"PHONE",label:"Telefone"},
 {key:"email",type:"EMAIL",label:"Email"},
 {key:"qual_é_sua_faixa_de_renda?",type:"CUSTOM",label:"Qual é sua faixa de renda?"},
 {key:"você_pretende_comprar_quando?",type:"CUSTOM",label:"Você pretende comprar quando?"}
];
const message=buildMakeLeadMessage("AP MARTIM",questions);
assert.ok(message.includes("NOVO LEAD - AP MARTIM"));
assert.ok(message.includes(makeLeadExpression("phone_number")));
assert.ok(message.includes(makeLeadExpression("qual_é_sua_faixa_de_renda?")));
assert.ok(message.includes("Você pretende comprar quando?"));
assert.equal(message.split('{{1.data.').length-1,5);
const noEmail=buildMakeLeadMessage("AP MARTIM",questions.filter(q=>q.type!=="EMAIL"));
assert.ok(noEmail.includes("EMAIL: não solicitado no formulário"));
assert.throws(()=>buildMakeLeadMessage("AP MARTIM",questions.filter(q=>q.type!=="PHONE")),/make_form_standard_fields_missing/);
const base={token:"fake-token",teamId:600315,pageId:"12345678901",formId:"1234567890",
 recipient:"5511999999999",facebookConnectionId:333,zapiConnectionId:4651755,
 clientName:"Teste",product:"AP MARTIM",requestId:"abc-def-1",questions};
calls.length=0;
const single=await provisionMakeLeads(base);
assert.equal(single.scenarioId,994);
// O trigger tem de pedir field_data a Meta, senao o bundle nao traz `data`
// e a mensagem chega em branco (como nos cenarios 4656349 e 4856012).
const trigger=storedBlueprint.flow.find(m=>m.module==="facebook-lead-ads:NewLeadMultiple");
assert.ok(trigger.parameters.fields.includes("field_data"));
assert.equal(trigger.parameters.fields.length,17);
assert.equal(trigger.parameters.v,"2");
assert.equal(storedBlueprint.metadata.instant,true);
assert.equal(single.recipients.length,1);
assert.equal(storedBlueprint.flow.length,2);
assert.equal(storedBlueprint.flow[1].mapper.phone,"5511999999999");
assert.ok(!calls.some(c=>c.path==="/data-stores"));
calls.length=0;
const rot=await provisionMakeLeads({...base,recipients:[
 {name:"Corretor Um",phone:"5511999999999"},
 {name:"Corretor Dois",phone:"5521999999999"},
 {name:"Corretor Três",phone:"5531999999999"}
]});
assert.equal(rot.recipients.length,3);
assert.equal(rot.dataStoreId,550);
assert.equal(storedBlueprint.metadata.scenario.sequential,true);
const router=storedBlueprint.flow.find(m=>m.module==="builtin:BasicRouter");
assert.equal(router.routes.length,3);
assert.equal(router.routes[0].flow[0].filter.conditions[0][0].b,"2");
assert.equal(router.routes[1].flow[0].filter.conditions[0][0].b,"0");
assert.equal(router.routes[2].flow[0].filter.conditions[0][0].b,"1");
assert.equal(router.routes[2].flow[1].mapper.data.ultimo_corretor,"2");
assert.ok(calls.some(c=>c.path==="/data-stores/550/data"&&c.body.data.ultimo_corretor==="2"));
calls.length=0;
failScenario=true;
await assert.rejects(()=>provisionMakeLeads({...base,recipients:[
 {name:"Corretor Um",phone:"5511999999999"},{name:"Corretor Dois",phone:"5521999999999"}]}),
 (err)=>err.message==="make_api_IM005"&&err.scenarioId===null&&err.hookId===null&&err.dataStoreId===null&&
   err.cleanup.hook===true&&err.cleanup.dataStore===true&&err.cleanup.structure===true&&err.cleanup.scenario===null);
assert.ok(calls.some(c=>c.method==="DELETE"&&c.path==="/hooks/291"));
assert.ok(calls.some(c=>c.method==="DELETE"&&c.path==="/data-stores"&&c.body.ids[0]===550));
assert.ok(calls.some(c=>c.method==="DELETE"&&c.path==="/data-structures/540"));
failScenario=false;
occupied=true;
calls.length=0;
await assert.rejects(()=>provisionMakeLeads(base),/make_form_already_connected/);
assert.ok(!calls.some(c=>c.method==="DELETE"),"nothing to clean when the duplicate guard fires first");
assert.ok(!calls.some(c=>c.path==="/scenarios/994/start"&&c.method==="DELETE"));
console.log("Campaign Builder Make: one recipient, 3-way sequential roulette, dynamic form fields, duplicate guard, failure cleanup OK");
