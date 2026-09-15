import crypto from 'node:crypto';
import { pool, withTenantTx } from './db.js';
import { decryptSecret } from './crypto.js';
import { sendText } from './meta/client.js';

type BridgeConfig = {
  baseUrl: string;
  accountId: number;
  inboxId: number;
  inboxIdentifier: string;
};
type BridgeSecrets = { apiToken: string; webhookSecret: string };
type Bridge = { integrationId: string; config: BridgeConfig; secrets: BridgeSecrets };

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, '');
  return digits ? `+${digits}` : value;
}

async function loadBridge(tenantId: string): Promise<Bridge | null> {
  return withTenantTx({ tenantId }, async (db) => {
    const { rows } = await db.query(
      `SELECT id,config,secret_enc FROM integrations
       WHERE tenant_id=$1 AND tipo='CHATWOOT' AND provedor='chatwoot' AND ativo=true LIMIT 1`,
      [tenantId]
    );
    const row = rows[0]; if (!row?.secret_enc) return null;
    const secrets = JSON.parse(decryptSecret(row.secret_enc)) as BridgeSecrets;
    return { integrationId: row.id, config: row.config as BridgeConfig, secrets };
  });
}
async function cwJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`chatwoot_${res.status}:${text.slice(0, 300)}`);
  return payload as T;
}

async function existingLink(tenantId: string, conversationId: string) {
  return withTenantTx({ tenantId }, async (db) => {
    const { rows } = await db.query(
      `SELECT * FROM chatwoot_conversation_links WHERE tenant_id=$1 AND conversation_id=$2`,
      [tenantId, conversationId]
    );
    return rows[0] ?? null;
  });
}

async function conversationContact(tenantId: string, conversationId: string) {
  return withTenantTx({ tenantId }, async (db) => {
    const { rows } = await db.query(
      `SELECT c.id,ct.id AS contact_id,ct.nome,ct.telefone,ct.email
       FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
       WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, conversationId]);
    return rows[0] ?? null;
  });
}
export async function ensureChatwootLink(tenantId: string, conversationId: string) {
  const found = await existingLink(tenantId, conversationId);
  if (found) return found;
  const bridge = await loadBridge(tenantId); if (!bridge) return null;
  const contact = await conversationContact(tenantId, conversationId); if (!contact) return null;
  const base = bridge.config.baseUrl.replace(/\/$/, '');
  const inbox = encodeURIComponent(bridge.config.inboxIdentifier);
  const sourceId = `imobia-${contact.contact_id}`;
  let cwContact: any;
  try {
    cwContact = await cwJson<any>(`${base}/public/api/v1/inboxes/${inbox}/contacts/${encodeURIComponent(sourceId)}`);
  } catch (err: any) {
    if (!String(err?.message ?? '').startsWith('chatwoot_404:')) throw err;
    cwContact = await cwJson<any>(`${base}/public/api/v1/inboxes/${inbox}/contacts`, {
      method: 'POST', body: JSON.stringify({ source_id: sourceId, identifier: String(contact.contact_id),
        name: contact.nome ?? undefined, phone_number: normalizePhone(contact.telefone), email: contact.email ?? undefined })
    });
  }
  const conversations = await cwJson<any[]>(`${base}/public/api/v1/inboxes/${inbox}/contacts/${encodeURIComponent(sourceId)}/conversations`);
  let cwConversation = conversations.find((x:any) => x?.custom_attributes?.imobia_conversation_id === conversationId);
  if (!cwConversation) {
    cwConversation = await cwJson<any>(`${base}/public/api/v1/inboxes/${inbox}/contacts/${encodeURIComponent(sourceId)}/conversations`, {
      method: 'POST', body: JSON.stringify({ custom_attributes: { imobia_conversation_id: conversationId } })
    });
  }
  return withTenantTx({ tenantId }, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO chatwoot_conversation_links
       (tenant_id,conversation_id,chatwoot_account_id,chatwoot_inbox_id,chatwoot_conversation_id,contact_source_id,chatwoot_contact_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,conversation_id) DO UPDATE SET
         chatwoot_conversation_id=EXCLUDED.chatwoot_conversation_id,
         contact_source_id=EXCLUDED.contact_source_id,chatwoot_contact_id=EXCLUDED.chatwoot_contact_id,updated_at=now()
       RETURNING *`,
      [tenantId,conversationId,bridge.config.accountId,bridge.config.inboxId,Number(cwConversation.id),sourceId,cwContact.id ?? null]
    );
    return rows[0];
  });
}

export async function mirrorIncomingToChatwoot(data: { tenantId:string; conversationId:string; messageId:string }) {
  const bridge = await loadBridge(data.tenantId); if (!bridge) return { skipped:'bridge_not_configured' };
  const link = await ensureChatwootLink(data.tenantId, data.conversationId); if (!link) return { skipped:'link_unavailable' };
  const message = await withTenantTx({ tenantId:data.tenantId }, async(db) => {
    const { rows } = await db.query(`SELECT conteudo,tipo,midia_mime FROM messages WHERE tenant_id=$1 AND id=$2`,[data.tenantId,data.messageId]);
    return rows[0];
  });
  if (!message) return { skipped:'message_not_found' };
  const text = message.conteudo || (message.tipo !== 'text' ? `[${message.tipo}]` : 'Mensagem recebida');
  const base=bridge.config.baseUrl.replace(/\/$/,''); const inbox=encodeURIComponent(bridge.config.inboxIdentifier);
  await cwJson(`${base}/public/api/v1/inboxes/${inbox}/contacts/${encodeURIComponent(link.contact_source_id)}/conversations/${link.chatwoot_conversation_id}/messages`, {
    method:'POST', body:JSON.stringify({ content:text, echo_id:`imobia-in:${data.messageId}` })
  });
  return { ok:true };
}

export async function mirrorOutgoingToChatwoot(data: { tenantId:string; conversationId:string; messageId:string }) {
  const bridge=await loadBridge(data.tenantId); if(!bridge) return {skipped:'bridge_not_configured'};
  const link=await ensureChatwootLink(data.tenantId,data.conversationId); if(!link) return {skipped:'link_unavailable'};
  const message=await withTenantTx({tenantId:data.tenantId},async(db)=>{
    const {rows}=await db.query(`SELECT conteudo,tipo,por_ia FROM messages WHERE tenant_id=$1 AND id=$2`,[data.tenantId,data.messageId]);return rows[0];
  });
  if(!message) return {skipped:'message_not_found'};
  const base=bridge.config.baseUrl.replace(/\/$/,'');
  await cwJson(`${base}/api/v1/accounts/${bridge.config.accountId}/conversations/${link.chatwoot_conversation_id}/messages`,{
    method:'POST',
    headers:{api_access_token:bridge.secrets.apiToken},
    body:JSON.stringify({content:message.conteudo||`[${message.tipo}]`,message_type:'outgoing',
      echo_id:`imobia-out:${data.messageId}`,content_attributes:{imobia_origin:message.por_ia?'ia':'system',imobia_message_id:data.messageId}})
  });
  return {ok:true};
}

function validWebhookSignature(raw: Buffer, timestamp: string | null, signature: string | null, secret: string) {
  if (!timestamp || !signature?.startsWith('sha256=')) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now()/1000)-ts) > 600) return false;
  const received = signature.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  const expected = crypto.createHmac('sha256',secret).update(`${timestamp}.${raw.toString('utf8')}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(received,'hex'),Buffer.from(expected,'hex'));
}

async function markChatwootMessage(bridge: Bridge, conversationId: number, messageId: number, status: 'sent'|'failed', error?: string) {
  const base=bridge.config.baseUrl.replace(/\/$/,'');
  await cwJson(`${base}/api/v1/accounts/${bridge.config.accountId}/conversations/${conversationId}/messages/${messageId}`,{
    method:'PATCH',headers:{api_access_token:bridge.secrets.apiToken},
    body:JSON.stringify({status,external_error:error?.slice(0,500)})
  });
}

async function reserveDelivery(tenantId:string, deliveryId:string, event:string, messageId:number|null) {
  return withTenantTx({tenantId},async(db)=>{
    const {rows}=await db.query(`INSERT INTO chatwoot_webhook_deliveries(tenant_id,delivery_id,event,chatwoot_message_id)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING delivery_id`,[tenantId,deliveryId,event,messageId]);
    return Boolean(rows[0]);
  });
}

export async function handleChatwootWebhook(raw:Buffer, headers:Headers) {
  let payload:any; try { payload=JSON.parse(raw.toString('utf8')); } catch { return {status:400,body:{error:'invalid_json'}}; }
  const accountId=Number(payload?.account?.id);
  const inboxId=Number(payload?.inbox?.id ?? payload?.conversation?.inbox_id);
  if(!Number.isFinite(accountId)||!Number.isFinite(inboxId)) return {status:202,body:{ok:true,skipped:'unresolved_bridge'}};
  const resolved=await pool.query(`SELECT * FROM resolve_chatwoot_bridge($1,$2)`,[accountId,inboxId]);
  const tenantId=resolved.rows[0]?.tenant_id as string|undefined;
  if(!tenantId) return {status:202,body:{ok:true,skipped:'bridge_not_configured'}};
  const bridge=await loadBridge(tenantId); if(!bridge) return {status:202,body:{ok:true,skipped:'bridge_not_configured'}};
  if(!validWebhookSignature(raw,headers.get('x-chatwoot-timestamp'),headers.get('x-chatwoot-signature'),bridge.secrets.webhookSecret))
    return {status:401,body:{error:'invalid_chatwoot_signature'}};
  const event=String(payload?.event??'');
  const messageId=Number(payload?.id);
  const deliveryId=headers.get('x-chatwoot-delivery') || `${event}:${accountId}:${inboxId}:${messageId||'na'}:${payload?.created_at??''}`;
  if(!(await reserveDelivery(tenantId,deliveryId,event,Number.isFinite(messageId)?messageId:null)))
    return {status:200,body:{ok:true,duplicate:true}};
  if(event!=='message_created'||payload?.private===true||String(payload?.message_type)!=='outgoing')
    return {status:200,body:{ok:true,skipped:'event_not_human_outgoing'}};
  if(payload?.content_attributes?.imobia_origin)
    return {status:200,body:{ok:true,skipped:'imobia_echo'}};
  const cwConversationId=Number(payload?.conversation?.id);
  if(!Number.isFinite(cwConversationId)||!String(payload?.content??'').trim())
    return {status:200,body:{ok:true,skipped:'empty_or_unlinked'}};
  const target=await withTenantTx({tenantId},async(db)=>{
    const {rows}=await db.query(`SELECT c.id,c.lead_id,c.janela_expira_em,ct.telefone,wa.phone_number_id,wa.access_token_enc
      FROM chatwoot_conversation_links l JOIN conversations c ON c.id=l.conversation_id
      JOIN contacts ct ON ct.id=c.contact_id JOIN whatsapp_accounts wa ON wa.id=c.whatsapp_account_id
      WHERE l.tenant_id=$1 AND l.chatwoot_conversation_id=$2`,[tenantId,cwConversationId]);
    return rows[0]??null;
  });
  if(!target) return {status:200,body:{ok:true,skipped:'conversation_not_linked'}};
  if(!target.janela_expira_em||new Date(target.janela_expira_em)<=new Date()) {
    await markChatwootMessage(bridge,cwConversationId,messageId,'failed','Janela de 24h da Meta expirada');
    return {status:409,body:{error:'window_expired'}};
  }
  try {
    const token=decryptSecret(target.access_token_enc);
    const sent=await sendText(target.phone_number_id,token,target.telefone,String(payload.content).trim());
    const wamid=sent.messages?.[0]?.id;
    await withTenantTx({tenantId},async(db)=>{
      await db.query(`INSERT INTO messages(tenant_id,conversation_id,direcao,conteudo,tipo,wamid,status,por_ia,raw)
        VALUES($1,$2,'OUT',$3,'text',$4,'ENVIADA',false,$5::jsonb)`,[tenantId,target.id,String(payload.content).trim(),wamid,JSON.stringify({chatwoot_message_id:messageId,delivery_id:deliveryId})]);
      await db.query(`UPDATE conversations SET modo='MANUAL',status='PENDENTE',estado_maquina='HUMANO',ultima_msg_em=now(),updated_at=now()
        WHERE tenant_id=$1 AND id=$2`,[tenantId,target.id]);
      if(target.lead_id) await db.query(`UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now()
        WHERE tenant_id=$1 AND lead_id=$2 AND status='PENDENTE' AND tipo IN ('FOLLOWUP','REENGAJAMENTO')`,[tenantId,target.lead_id]);
    });
    await markChatwootMessage(bridge,cwConversationId,messageId,'sent');
    return {status:200,body:{ok:true,sent:true}};
  } catch(err:any) {
    const detail=String(err?.message??err).slice(0,500);
    try { await markChatwootMessage(bridge,cwConversationId,messageId,'failed',detail); } catch {}
    return {status:502,body:{error:'human_send_failed'}};
  }
}
