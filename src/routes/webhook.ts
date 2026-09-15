import { Hono } from 'hono';
import { env, metaConfigured } from '../config.js';
import { verifyMetaSignature } from '../crypto.js';
import { resolveWhatsAppAccount, withTenantTx } from '../db.js';
import { whatsappQueue } from '../queue.js';
import { cancelPendingFollowups } from '../followup.js';
import { handleMetaManagementChange, recordPricingStatus } from '../meta-webhook-management.js';

export const webhookRoutes = new Hono();

webhookRoutes.get('/whatsapp', (c) => {
  if (!metaConfigured) return c.text('meta_not_configured', 503);
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN && challenge) return c.text(challenge);
  return c.text('forbidden', 403);
});

function extractText(m: any): string | null {
  if (m.type === 'text') return m.text?.body ?? null;
  if (m.type === 'button') return m.button?.text ?? null;
  if (m.type === 'interactive') {
    return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
  }
  if (m.type === 'location') return [m.location?.name, m.location?.address].filter(Boolean).join(' — ') || null;
  return m.caption ?? null;
}

function extractMedia(m: any): { mediaId?: string; mime?: string } {
  const obj = m[m.type];
  return { mediaId: obj?.id, mime: obj?.mime_type };
}

const statusMap: Record<string, string> = {
  sent: 'ENVIADA',
  delivered: 'ENTREGUE',
  read: 'LIDA',
  failed: 'FALHOU'
};

webhookRoutes.post('/whatsapp', async (c) => {
  if (!metaConfigured) return c.json({ error: 'meta_not_configured' }, 503);
  const raw = Buffer.from(await c.req.arrayBuffer());
  if (!(await verifyMetaSignature(raw, c.req.header('x-hub-signature-256')))) {
    return c.json({ error: 'invalid_signature' }, 401);
  }

  const body = JSON.parse(raw.toString('utf8'));
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') {
        await handleMetaManagementChange(String(entry.id ?? ''), entry.time, change);
        continue;
      }
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const resolved = await resolveWhatsAppAccount(String(phoneNumberId));
      if (!resolved) continue;
      const ctx = { tenantId: resolved.tenant_id, userId: null };

      for (const st of value.statuses ?? []) {
        const mapped = statusMap[String(st.status)] ?? null;
        if (!mapped) continue;
        await withTenantTx(ctx, async (db) => {
          await db.query(
            `UPDATE messages
                SET status = $1::msg_status,
                    erro = CASE WHEN $1 = 'FALHOU' THEN $3 ELSE erro END,
                    raw = COALESCE(raw, '{}'::jsonb) || $4::jsonb
              WHERE tenant_id = $2 AND wamid = $5`,
            [
              mapped,
              ctx.tenantId,
              st.errors?.[0]?.message ?? st.errors?.[0]?.title ?? null,
              JSON.stringify({ last_status: st }),
              st.id
            ]
          );
        });
        await recordPricingStatus(ctx, resolved.whatsapp_account_id, st);
      }

      for (const m of value.messages ?? []) {
        const from = String(m.from ?? '');
        if (!from || !m.id) continue;
        const profileName = value.contacts?.find((x: any) => x.wa_id === from)?.profile?.name ?? null;
        const content = extractText(m);
        const media = extractMedia(m);

        const inserted = await withTenantTx(ctx, async (db) => {
          const contact = await db.query(
            `INSERT INTO contacts (tenant_id, nome, telefone)
             VALUES ($1,$2,$3)
             ON CONFLICT (tenant_id, telefone) DO UPDATE SET
               nome = COALESCE(EXCLUDED.nome, contacts.nome), updated_at = now()
             RETURNING id`,
            [ctx.tenantId, profileName, from]
          );
          const contactId = contact.rows[0].id;

          let conv = await db.query(
            `SELECT id, lead_id FROM conversations
              WHERE tenant_id=$1 AND contact_id=$2 AND whatsapp_account_id=$3 AND arquivada=false
              ORDER BY ultima_msg_em DESC NULLS LAST, created_at DESC LIMIT 1`,
            [ctx.tenantId, contactId, resolved.whatsapp_account_id]
          );

          let leadId: string;
          let conversationId: string;
          let newLead = false;
          if (!conv.rows[0]) {
            const lead = await db.query(
              `INSERT INTO leads (tenant_id, contact_id, canal, ultimo_contato_em)
               VALUES ($1,$2,'WhatsApp',now()) RETURNING id`,
              [ctx.tenantId, contactId]
            );
            leadId = lead.rows[0].id;
            newLead = true;
            const created = await db.query(
              `INSERT INTO conversations
                (tenant_id, contact_id, lead_id, whatsapp_account_id, status, modo, estado_maquina,
                 janela_expira_em, ultima_msg_em, nao_lidas)
               VALUES ($1,$2,$3,$4,'BOT','IA','NOVO',now()+interval '24 hours',now(),1)
               RETURNING id`,
              [ctx.tenantId, contactId, leadId, resolved.whatsapp_account_id]
            );
            conversationId = created.rows[0].id;
          } else {
            conversationId = conv.rows[0].id;
            leadId = conv.rows[0].lead_id;
            await db.query(
              `UPDATE conversations SET janela_expira_em=now()+interval '24 hours', ultima_msg_em=now(),
                 nao_lidas=nao_lidas+1, updated_at=now() WHERE id=$1`,
              [conversationId]
            );
            if (leadId) await db.query(`UPDATE leads SET ultimo_contato_em=now(), updated_at=now() WHERE id=$1`, [leadId]);
          }

          const msg = await db.query(
            `INSERT INTO messages
              (tenant_id, conversation_id, direcao, conteudo, tipo, midia_mime, wamid, status, raw)
             VALUES ($1,$2,'IN',$3,$4,$5,$6,'ENTREGUE',$7::jsonb)
             ON CONFLICT (wamid) DO NOTHING RETURNING id`,
            [ctx.tenantId, conversationId, content, m.type ?? 'text', media.mime ?? null, m.id, JSON.stringify(m)]
          );
          if (!msg.rows[0]) return null;
          if (leadId) await cancelPendingFollowups(db, ctx.tenantId, leadId);

          if (newLead) {
            await db.query(`INSERT INTO events (tenant_id, lead_id, conversation_id, tipo) VALUES ($1,$2,$3,'LEAD_CRIADO')`, [ctx.tenantId, leadId, conversationId]);
          }
          await db.query(
            `INSERT INTO events (tenant_id, lead_id, conversation_id, tipo, payload)
             VALUES ($1,$2,$3,'MENSAGEM_RECEBIDA',$4::jsonb)`,
            [ctx.tenantId, leadId, conversationId, JSON.stringify({ message_id: msg.rows[0].id, wamid: m.id, type: m.type })]
          );
          return { messageId: msg.rows[0].id, conversationId, leadId, mediaId: media.mediaId, whatsappAccountId: resolved.whatsapp_account_id };
        });

        if (inserted) {
          await whatsappQueue.add('chatwoot_mirror_in', { tenantId: ctx.tenantId, conversationId: inserted.conversationId, messageId: inserted.messageId }, { jobId: `cw-in:${inserted.messageId}`, removeOnComplete: true, removeOnFail: 1000, attempts: 5, backoff: { type: 'exponential', delay: 1000 } });
          await whatsappQueue.add('agent_turn', { tenantId: ctx.tenantId, ...inserted }, {
            jobId: `agent:${inserted.conversationId}`,
            delay: 10000,
            removeOnComplete: true,
            removeOnFail: 1000,
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 }
          });
          if (inserted.mediaId) {
            await whatsappQueue.add('download_media', { tenantId: ctx.tenantId, ...inserted }, {
              jobId: `media:${inserted.messageId}`,
              removeOnComplete: 1000,
              attempts: 5,
              backoff: { type: 'exponential', delay: 1000 }
            });
          }
        }
      }
    }
  }
  return c.json({ ok: true });
});
