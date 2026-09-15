import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from './config.js';
import { withTenantTx } from './db.js';
import { decryptSecret } from './crypto.js';
import { getMedia } from './meta/client.js';
import { createAgentToken } from './agent-token.js';
import { startScheduledFollowupLoop } from './scheduled-followups.js';
import { startXmlSyncLoop } from './xml-sync.js';
import { dispatchLeadToCrm } from './crm-dispatch.js';
import { startMetaHealthLoop } from './meta-health.js';
import { ensureBucket, putObject } from './s3.js';
import { mirrorIncomingToChatwoot, mirrorOutgoingToChatwoot } from './chatwoot-bridge.js';

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
await ensureBucket();

async function agentTurn(data: any) {
  if (!env.N8N_AGENT_WEBHOOK) return;
  const conversation = await withTenantTx({ tenantId: data.tenantId }, async (db) => {
    const { rows } = await db.query(`SELECT modo,status FROM conversations WHERE tenant_id=$1 AND id=$2`, [data.tenantId,data.conversationId]);
    return rows[0];
  });
  if (!conversation || conversation.modo !== 'IA' || conversation.status === 'RESOLVIDA') return;
  const agentToken = createAgentToken(data.tenantId, data.conversationId, 300);
  const payload = { ...data, agentToken, imobiaBaseUrl: 'http://imobia-api:3001' };
  const res = await fetch(env.N8N_AGENT_WEBHOOK, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`n8n ${res.status}: ${await res.text()}`);
}
async function downloadMedia(data: any) {
  if (!data.mediaId || !data.whatsappAccountId) return;
  const account = await withTenantTx({ tenantId: data.tenantId }, async (db) => {
    const { rows } = await db.query(
      `SELECT access_token_enc FROM whatsapp_accounts WHERE tenant_id=$1 AND id=$2`,
      [data.tenantId, data.whatsappAccountId]
    );
    return rows[0];
  });
  if (!account) throw new Error('whatsapp_account_not_found');
  const token = decryptSecret(account.access_token_enc);
  const meta = await getMedia(data.mediaId, token);
  const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!file.ok) throw new Error(`media_download_${file.status}`);
  const bytes = Buffer.from(await file.arrayBuffer());
  const key = `${data.tenantId}/${data.conversationId}/${data.messageId}`;
  await putObject(key, bytes, meta.mime_type ?? file.headers.get('content-type') ?? 'application/octet-stream');
  await withTenantTx({ tenantId: data.tenantId }, async (db) => {
    await db.query(
      `UPDATE messages SET midia_url=$3,midia_mime=COALESCE($4,midia_mime) WHERE tenant_id=$1 AND id=$2`,
      [data.tenantId, data.messageId, key, meta.mime_type ?? null]
    );
  });
}

new Worker('whatsapp-ingress', async (job) => {
  if (job.name === 'agent_turn') return agentTurn(job.data);
  if (job.name === 'download_media') return downloadMedia(job.data);
  if (job.name === 'crm_dispatch') return dispatchLeadToCrm(job.data.tenantId, job.data.leadId, job.data.integrationId ?? null);
  if (job.name === 'chatwoot_mirror_in') return mirrorIncomingToChatwoot(job.data);
  if (job.name === 'chatwoot_mirror_out') return mirrorOutgoingToChatwoot(job.data);
}, { connection, concurrency: 20 });

startScheduledFollowupLoop();
startXmlSyncLoop();
startMetaHealthLoop();
console.log('ImoBia worker online');
