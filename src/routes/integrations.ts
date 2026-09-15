import { Hono } from 'hono';
import { z } from 'zod';
import { withTenantTx } from '../db.js';
import { encryptSecret } from '../crypto.js';
import { requireAuth } from '../middleware/auth.js';
import { whatsappQueue } from '../queue.js';

export const integrationRoutes=new Hono();
integrationRoutes.use('*',requireAuth);

function canManage(role:string){return ['ADMIN','EDITOR','GESTOR'].includes(role);}
const headersSchema=z.record(z.string().min(1).max(100),z.string().max(4000)).optional();
const baseSchema=z.object({
  provider:z.string().trim().min(1).max(80).default('custom'),
  url:z.string().url(),allowHttp:z.boolean().default(false),
  headers:headersSchema
});
const xmlSchema=baseSchema.extend({
  itemPath:z.string().trim().max(300).optional(),
  intervalMinutes:z.number().int().min(15).max(10080).default(1440),
  mapping:z.record(z.string(),z.union([z.string(),z.array(z.string())])).default({})
});
const crmSchema=baseSchema.extend({
  method:z.enum(['POST','PUT','PATCH']).default('POST'),
  fieldMap:z.record(z.string(),z.string()).default({}),
  idempotencyHeader:z.string().trim().min(1).max(120).optional()
});

integrationRoutes.get('/',async(c)=>{
  const auth=c.get('auth');
  const rows=await withTenantTx(auth,async(db)=>(await db.query(`SELECT id,tipo,provedor,config,ativo,ultimo_sync,ultimo_erro,next_sync_at,created_at
    FROM integrations WHERE tenant_id=$1 ORDER BY tipo,provedor`,[auth.tenantId])).rows);
  return c.json({integrations:rows});
});
async function upsertIntegration(c:any,type:'XML'|'CRM',input:any){
  const auth=c.get('auth'); if(!canManage(auth.role))return c.json({error:'forbidden'},403);
  const config=type==='XML'
    ? {url:input.url,allowHttp:input.allowHttp,itemPath:input.itemPath,intervalMinutes:input.intervalMinutes,mapping:input.mapping}
    : {url:input.url,allowHttp:input.allowHttp,method:input.method,fieldMap:input.fieldMap,idempotencyHeader:input.idempotencyHeader};
  const secret=input.headers?encryptSecret(JSON.stringify({headers:input.headers})):null;
  const row=await withTenantTx(auth,async(db)=>{
    const {rows}=await db.query(`INSERT INTO integrations(tenant_id,tipo,provedor,config,secret_enc,ativo,next_sync_at)
      VALUES($1,$2,$3,$4::jsonb,$5,true,CASE WHEN $2='XML' THEN now() ELSE NULL END)
      ON CONFLICT(tenant_id,tipo,provedor) DO UPDATE SET config=EXCLUDED.config,
      secret_enc=COALESCE(EXCLUDED.secret_enc,integrations.secret_enc),ativo=true,
      next_sync_at=CASE WHEN EXCLUDED.tipo='XML' THEN now() ELSE integrations.next_sync_at END,ultimo_erro=NULL
      RETURNING id,tipo,provedor,config,ativo,next_sync_at`,
      [auth.tenantId,type,input.provider,JSON.stringify(config),secret]);
    return rows[0];
  });
  return c.json(row,201);
}

integrationRoutes.post('/xml',async(c)=>upsertIntegration(c,'XML',xmlSchema.parse(await c.req.json())));
integrationRoutes.post('/crm',async(c)=>upsertIntegration(c,'CRM',crmSchema.parse(await c.req.json())));

integrationRoutes.post('/:id/sync',async(c)=>{
  const auth=c.get('auth'); if(!canManage(auth.role))return c.json({error:'forbidden'},403);
  const id=z.string().uuid().parse(c.req.param('id'));
  const row=await withTenantTx(auth,async(db)=>(await db.query(`UPDATE integrations SET next_sync_at=now(),claimed_at=NULL,ultimo_erro=NULL
    WHERE tenant_id=$1 AND id=$2 AND tipo='XML' RETURNING id,next_sync_at`,[auth.tenantId,id])).rows[0]);
  if(!row)return c.json({error:'xml_integration_not_found'},404);
  return c.json({ok:true,...row});
});
integrationRoutes.post('/:id/dispatch',async(c)=>{
  const auth=c.get('auth'); if(!canManage(auth.role))return c.json({error:'forbidden'},403);
  const id=z.string().uuid().parse(c.req.param('id'));
  const {leadId}=z.object({leadId:z.string().uuid()}).parse(await c.req.json());
  const exists=await withTenantTx(auth,async(db)=>(await db.query(`SELECT 1 FROM integrations WHERE tenant_id=$1 AND id=$2 AND tipo='CRM' AND ativo=true`,[auth.tenantId,id])).rows[0]);
  if(!exists)return c.json({error:'crm_integration_not_found'},404);
  await whatsappQueue.add('crm_dispatch',{tenantId:auth.tenantId,leadId,integrationId:id},{removeOnComplete:1000,removeOnFail:1000,attempts:5,backoff:{type:'exponential',delay:5000}});
  return c.json({ok:true,queued:true,integrationId:id});
});

integrationRoutes.delete('/:id',async(c)=>{
  const auth=c.get('auth'); if(!canManage(auth.role))return c.json({error:'forbidden'},403);
  const id=z.string().uuid().parse(c.req.param('id'));
  const row=await withTenantTx(auth,async(db)=>(await db.query(`UPDATE integrations SET ativo=false,claimed_at=NULL WHERE tenant_id=$1 AND id=$2 RETURNING id,tipo,provedor,ativo`,[auth.tenantId,id])).rows[0]);
  if(!row)return c.json({error:'integration_not_found'},404);
  return c.json(row);
});
