import { Hono } from 'hono';
import { z } from 'zod';
import { decryptSecret } from '../crypto.js';
import { withTenantTx } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { sendTemplate, sendText } from '../meta/client.js';
import { whatsappQueue } from '../queue.js';

export const messageRoutes = new Hono();
messageRoutes.use('*', requireAuth);

async function loadConversation(auth: any, conversationId: string) {
  return withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `SELECT c.id,c.contact_id,c.janela_expira_em,c.whatsapp_account_id,
              ct.telefone,wa.phone_number_id,wa.access_token_enc
         FROM conversations c
         JOIN contacts ct ON ct.id=c.contact_id
         JOIN whatsapp_accounts wa ON wa.id=c.whatsapp_account_id
        WHERE c.tenant_id=$1 AND c.id=$2`,
      [auth.tenantId, conversationId]
    );
    return rows[0];
  });
}

messageRoutes.post('/text', async (c) => {
  const auth = c.get('auth');
  const input = z.object({ conversationId: z.string().uuid(), text: z.string().min(1).max(4096) }).parse(await c.req.json());
  const conv = await loadConversation(auth, input.conversationId);
  if (!conv) return c.json({ error: 'conversation_not_found' }, 404);
  if (!conv.janela_expira_em || new Date(conv.janela_expira_em) <= new Date()) {
    return c.json({ error: 'window_expired', requiresTemplate: true }, 409);
  }

  const meta = await sendText(conv.phone_number_id, decryptSecret(conv.access_token_enc), conv.telefone, input.text);
  const wamid = meta.messages?.[0]?.id;
  const row = await withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO messages (tenant_id,conversation_id,user_id,direcao,conteudo,tipo,wamid,status)
       VALUES ($1,$2,$3,'OUT',$4,'text',$5,'ENVIADA') RETURNING id`,
      [auth.tenantId,input.conversationId,auth.userId,input.text,wamid]
    );
    await db.query(
      `UPDATE conversations SET ultima_msg_em=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId,input.conversationId]
    );
    return rows[0];
  });
  await whatsappQueue.add('chatwoot_mirror_out',{tenantId:auth.tenantId,conversationId:input.conversationId,messageId:row.id},{jobId:`cw-out:${row.id}`,removeOnComplete:true,removeOnFail:1000,attempts:5,backoff:{type:'exponential',delay:1000}});
  return c.json({ ok: true, messageId: row.id, wamid });
});

messageRoutes.post('/template', async (c) => {
  const auth = c.get('auth');
  const input = z.object({
    conversationId: z.string().uuid(),
    templateName: z.string().min(1),
    language: z.string().default('pt_BR'),
    components: z.array(z.any()).optional()
  }).parse(await c.req.json());
  const loaded = await withTenantTx(auth, async (db) => {
    const conv = await db.query(
      `SELECT c.id,c.contact_id,c.janela_expira_em,c.whatsapp_account_id,
              ct.telefone,wa.phone_number_id,wa.access_token_enc
         FROM conversations c
         JOIN contacts ct ON ct.id=c.contact_id
         JOIN whatsapp_accounts wa ON wa.id=c.whatsapp_account_id
        WHERE c.tenant_id=$1 AND c.id=$2`,
      [auth.tenantId,input.conversationId]
    );
    if (!conv.rows[0]) return null;
    const tpl = await db.query(
      `SELECT id FROM message_templates
        WHERE tenant_id=$1 AND whatsapp_account_id=$2 AND nome=$3 AND idioma=$4 AND status='APROVADO'`,
      [auth.tenantId,conv.rows[0].whatsapp_account_id,input.templateName,input.language]
    );
    return { conv: conv.rows[0], templateId: tpl.rows[0]?.id ?? null };
  });
  if (!loaded) return c.json({ error: 'conversation_not_found' }, 404);
  if (!loaded.templateId) return c.json({ error: 'template_not_approved' }, 409);

  const meta = await sendTemplate(
    loaded.conv.phone_number_id,
    decryptSecret(loaded.conv.access_token_enc),
    loaded.conv.telefone,
    { name: input.templateName, language: input.language, components: input.components }
  );
  const wamid = meta.messages?.[0]?.id;
  const row = await withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO messages
        (tenant_id,conversation_id,user_id,direcao,conteudo,tipo,wamid,template_id,status)
       VALUES ($1,$2,$3,'OUT',$4,'template',$5,$6,'ENVIADA') RETURNING id`,
      [auth.tenantId,input.conversationId,auth.userId,`[template:${input.templateName}]`,wamid,loaded.templateId]
    );
    return rows[0];
  });
  await whatsappQueue.add('chatwoot_mirror_out',{tenantId:auth.tenantId,conversationId:input.conversationId,messageId:row.id},{jobId:`cw-out:${row.id}`,removeOnComplete:true,removeOnFail:1000,attempts:5,backoff:{type:'exponential',delay:1000}});
  return c.json({ ok: true, messageId: row.id, wamid });
});
