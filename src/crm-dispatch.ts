import { withTenantTx } from './db.js';
import { assertSafeRemoteUrl, getPath, secretHeaders } from './integration-utils.js';

type CrmIntegration={id:string;tenant_id:string;provedor:string|null;config:any;secret_enc:Buffer|null};

function assignPath(target:any,path:string,value:any){
  const parts=path.split('.').filter(Boolean); if(!parts.length)return;
  let cur=target; for(let i=0;i<parts.length-1;i++){cur[parts[i]]??={};cur=cur[parts[i]];}
  cur[parts.at(-1)!]=value;
}
function mapPayload(source:any,fieldMap:any){
  if(!fieldMap||typeof fieldMap!=='object'||Array.isArray(fieldMap))return source;
  const out:any={};
  for(const [dest,src] of Object.entries(fieldMap)){
    if(typeof src!=='string')continue;
    const value=getPath(source,src); if(value!==undefined)assignPath(out,dest,value);
  }
  return out;
}

export async function dispatchLeadToCrm(tenantId:string,leadId:string,integrationId?:string|null){
  const loaded=await withTenantTx({tenantId},async(db)=>{
    const integration=integrationId
      ? await db.query(`SELECT id,tenant_id,provedor,config,secret_enc FROM integrations
          WHERE tenant_id=$1 AND id=$2 AND tipo='CRM' AND ativo=true LIMIT 1`,[tenantId,integrationId])
      : await db.query(`SELECT id,tenant_id,provedor,config,secret_enc FROM integrations
          WHERE tenant_id=$1 AND tipo='CRM' AND ativo=true ORDER BY created_at ASC LIMIT 1`,[tenantId]);
    if(!integration.rows[0])return null;
    const lead=await db.query(`SELECT l.*,ct.nome AS contato_nome,ct.telefone AS contato_telefone,ct.email AS contato_email,
      c.id AS conversation_id,c.resumo_ia AS conversation_summary FROM leads l JOIN contacts ct ON ct.id=l.contact_id
      LEFT JOIN conversations c ON c.lead_id=l.id AND c.arquivada=false WHERE l.tenant_id=$1 AND l.id=$2
      ORDER BY c.updated_at DESC NULLS LAST LIMIT 1`,[tenantId,leadId]);
    return lead.rows[0]?{integration:integration.rows[0] as CrmIntegration,lead:lead.rows[0]}:null;
  });
  if(!loaded)return {ok:true,skipped:'crm_not_configured_or_lead_missing'};
  const cfg=loaded.integration.config||{};
  const url=await assertSafeRemoteUrl(String(cfg.url||''),Boolean(cfg.allowHttp));
  const source={lead:loaded.lead,contact:{name:loaded.lead.contato_nome,phone:loaded.lead.contato_telefone,email:loaded.lead.contato_email},conversation:{id:loaded.lead.conversation_id,summary:loaded.lead.conversation_summary}};
  const body=mapPayload(source,cfg.fieldMap);
  const method=String(cfg.method||'POST').toUpperCase();
  if(!['POST','PUT','PATCH'].includes(method))throw new Error('crm_method_not_allowed');
  let responseText=''; let status=0;
  try{
    const headers:Record<string,string>={'content-type':'application/json',...secretHeaders(loaded.integration.secret_enc)};
    if(typeof cfg.idempotencyHeader==='string' && cfg.idempotencyHeader.trim()) {
      headers[cfg.idempotencyHeader.trim()]=`${tenantId}:${loaded.integration.id}:${leadId}`;
    }
    const res=await fetch(url,{method,headers,body:JSON.stringify(body)});
    status=res.status; responseText=(await res.text()).slice(0,20000);
    const success=res.ok;
    await withTenantTx({tenantId},async(db)=>{
      await db.query(`INSERT INTO crm_dispatch_log(tenant_id,lead_id,http_status,request,response,sucesso)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,[tenantId,leadId,status,JSON.stringify(body),JSON.stringify({body:responseText}),success]);
      await db.query(`UPDATE leads SET status_crm=$3::crm_status,enviado_crm_em=CASE WHEN $3='ENVIADO' THEN now() ELSE enviado_crm_em END,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,[tenantId,leadId,success?'ENVIADO':'ERRO_ENVIO']);
      await db.query(`UPDATE integrations SET ultimo_erro=$3,ultimo_sync=CASE WHEN $3 IS NULL THEN now() ELSE ultimo_sync END WHERE tenant_id=$1 AND id=$2`,
        [tenantId,loaded.integration.id,success?null:`HTTP ${status}: ${responseText.slice(0,1000)}`]);
    });
    if(!success)throw new Error(`crm_http_${status}`);
    return {ok:true,status,provider:loaded.integration.provedor};
  }catch(error){
    if(status===0){
      await withTenantTx({tenantId},async(db)=>{await db.query(`UPDATE leads SET status_crm='ERRO_ENVIO',updated_at=now() WHERE tenant_id=$1 AND id=$2`,[tenantId,leadId]);});
    }
    throw error;
  }
}
