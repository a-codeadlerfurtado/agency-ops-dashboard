import { Hono } from 'hono';
import { z } from 'zod';
import { withTenantTx } from '../db.js';
import { verifyAgentToken } from '../agent-token.js';
import { decryptSecret } from '../crypto.js';
import { sendTemplate, sendText } from '../meta/client.js';

export const internalFollowupRoutes = new Hono();
type Claims = { tenantId: string; conversationId: string; exp: number };

internalFollowupRoutes.use('*', async (c, next) => {
  const auth = c.req.header('authorization') ?? '';
  const claims = auth.startsWith('Bearer ') ? verifyAgentToken(auth.slice(7)) : null;
  if (!claims) return c.json({ error: 'invalid_agent_token' }, 401);
  c.set('followupClaims' as any, claims);
  await next();
});

const inputSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  scheduledJobId: z.string().uuid().optional()
});

internalFollowupRoutes.post('/send', async (c) => {
  const claims = c.get('followupClaims' as any) as Claims;
  const input = inputSchema.parse(await c.req.json());
  const target = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    const { rows } = await db.query(
      `SELECT c.id,c.lead_id,c.modo,c.status,c.janela_expira_em,c.whatsapp_account_id,
              ct.telefone,wa.phone_number_id,wa.access_token_enc
         FROM conversations c
         JOIN contacts ct ON ct.id=c.contact_id
         JOIN whatsapp_accounts wa ON wa.id=c.whatsapp_account_id
        WHERE c.tenant_id=$1 AND c.id=$2`,
      [claims.tenantId, claims.conversationId]
    );
    return rows[0];
  });
  if (!target) return c.json({ error: 'conversation_not_found' }, 404);
  if (input.scheduledJobId) {
    const validJob = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
      const { rows } = await db.query(
        `SELECT id,status FROM scheduled_jobs
          WHERE tenant_id=$1 AND id=$2 AND lead_id=$3
            AND payload->>'conversationId'=$4`,
        [claims.tenantId,input.scheduledJobId,target.lead_id,claims.conversationId]
      );
      return rows[0];
    });
    if (!validJob || !['PROCESSANDO','PENDENTE'].includes(validJob.status)) {
      return c.json({ error: 'invalid_followup_job' }, 409);
    }
  }
  if (target.modo !== 'IA' || target.status === 'RESOLVIDA') {
    if (input.scheduledJobId) {
      await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
        await db.query(
          `UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now(),claimed_at=NULL,erro='conversation_not_in_ai_mode'
            WHERE tenant_id=$1 AND id=$2`,
          [claims.tenantId,input.scheduledJobId]
        );
      });
    }
    return c.json({ ok: true, skipped: 'conversation_not_in_ai_mode' });
  }

  const accessToken = decryptSecret(target.access_token_enc);
  const windowOpen = target.janela_expira_em && new Date(target.janela_expira_em) > new Date();
  let wamid: string | undefined;
  let sentType = 'text';
  let content = input.text;
  if (windowOpen) {
    const meta = await sendText(target.phone_number_id, accessToken, target.telefone, input.text);
    wamid = meta.messages?.[0]?.id;
  } else {
    const template = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
      let templateId: string | null = null;
      let components: unknown[] | undefined;
      if (input.scheduledJobId) {
        const job = await db.query(
          `SELECT payload FROM scheduled_jobs WHERE tenant_id=$1 AND id=$2 AND lead_id=$3`,
          [claims.tenantId, input.scheduledJobId, target.lead_id]
        );
        templateId = job.rows[0]?.payload?.templateId ?? null;
        components = Array.isArray(job.rows[0]?.payload?.components) ? job.rows[0].payload.components : undefined;
      }
      const query = templateId
        ? `SELECT id,nome,idioma FROM message_templates WHERE tenant_id=$1 AND whatsapp_account_id=$2 AND id=$3 AND status='APROVADO'`
        : `SELECT id,nome,idioma FROM message_templates WHERE tenant_id=$1 AND whatsapp_account_id=$2 AND status='APROVADO'
             AND finalidade IN ('followup','reengajamento') ORDER BY CASE WHEN finalidade='followup' THEN 0 ELSE 1 END,created_at DESC LIMIT 1`;
      const params = templateId
        ? [claims.tenantId, target.whatsapp_account_id, templateId]
        : [claims.tenantId, target.whatsapp_account_id];
      const result = await db.query(query, params);
      return result.rows[0] ? { ...result.rows[0], components } : null;
    });
    if (!template) return c.json({ error: 'followup_template_required' }, 409);
    const meta = await sendTemplate(target.phone_number_id, accessToken, target.telefone, {
      name: template.nome,
      language: template.idioma,
      components: template.components
    });
    wamid = meta.messages?.[0]?.id;
    sentType = 'template';
    content = `[template:${template.nome}]`;
  }

  await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    await db.query(
      `INSERT INTO messages (tenant_id,conversation_id,direcao,conteudo,tipo,wamid,status,por_ia)
       VALUES ($1,$2,'OUT',$3,$4,$5,'ENVIADA',true)`,
      [claims.tenantId, claims.conversationId, content, sentType, wamid]
    );
    await db.query(
      `UPDATE conversations SET ultima_msg_em=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2`,
      [claims.tenantId, claims.conversationId]
    );
    await db.query(
      `INSERT INTO events (tenant_id,lead_id,conversation_id,tipo,payload)
       VALUES ($1,$2,$3,'FOLLOWUP_ENVIADO',$4::jsonb)`,
      [claims.tenantId, target.lead_id, claims.conversationId,
       JSON.stringify({ scheduledJobId: input.scheduledJobId ?? null, type: sentType, wamid })]
    );
    if (input.scheduledJobId) {
      await db.query(
        `UPDATE scheduled_jobs SET status='EXECUTADO',executado_em=now(),claimed_at=NULL,erro=NULL
          WHERE tenant_id=$1 AND id=$2 AND lead_id=$3`,
        [claims.tenantId,input.scheduledJobId,target.lead_id]
      );
    }
  });

  return c.json({ ok: true, confirmed: Boolean(input.scheduledJobId), type: sentType, wamid });
});
const skipSchema = z.object({
  scheduledJobId: z.string().uuid(),
  reason: z.string().trim().max(1000).optional()
});

internalFollowupRoutes.post('/skip', async (c) => {
  const claims = c.get('followupClaims' as any) as Claims;
  const input = skipSchema.parse(await c.req.json());
  const result = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    const job = await db.query(
      `SELECT id,lead_id,payload,status FROM scheduled_jobs
        WHERE tenant_id=$1 AND id=$2`,
      [claims.tenantId,input.scheduledJobId]
    );
    const row = job.rows[0];
    if (!row || row.payload?.conversationId !== claims.conversationId) return null;
    await db.query(
      `UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now(),claimed_at=NULL,erro=$3
        WHERE tenant_id=$1 AND id=$2`,
      [claims.tenantId,input.scheduledJobId,input.reason ?? 'followup_skipped_by_agent']
    );
    await db.query(
      `UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now(),erro='sequence_cancelled_after_skip'
        WHERE tenant_id=$1 AND lead_id=$2 AND status='PENDENTE' AND tipo IN ('FOLLOWUP','REENGAJAMENTO')`,
      [claims.tenantId,row.lead_id]
    );    await db.query(
      `INSERT INTO events (tenant_id,lead_id,conversation_id,tipo,payload)
       VALUES ($1,$2,$3,'FOLLOWUP_CANCELADO',$4::jsonb)`,
      [claims.tenantId,row.lead_id,claims.conversationId,
       JSON.stringify({ scheduledJobId: input.scheduledJobId, reason: input.reason ?? null })]
    );
    return { leadId: row.lead_id };
  });
  if (!result) return c.json({ error: 'invalid_followup_job' }, 404);
  return c.json({ ok: true, skipped: true, ...result });
});
