import { Hono } from 'hono';
import { z } from 'zod';
import { withTenantTx } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const inboxRoutes = new Hono();
inboxRoutes.use('*', requireAuth);

const idSchema = z.string().uuid();

inboxRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  const status = c.req.query('status');
  const q = c.req.query('q')?.trim();
  const mine = c.req.query('mine') === '1';
  const result = await withTenantTx(auth, async (db) => {
    const params: unknown[] = [auth.tenantId];
    const where = ['c.tenant_id=$1', 'c.arquivada=false'];
    if (status) { params.push(status); where.push(`c.status=$${params.length}`); }
    if (mine) { params.push(auth.userId); where.push(`c.responsavel_id=$${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(ct.nome ILIKE $${params.length} OR ct.telefone ILIKE $${params.length})`);
    }
    const { rows } = await db.query(
      `SELECT c.id,c.status,c.modo,c.estado_maquina,c.nao_lidas,c.resumo_ia,c.sentimento,
              c.janela_expira_em,c.ultima_msg_em,c.responsavel_id,
              ct.nome AS contato_nome,ct.telefone,ct.avatar_url,
              l.status_qualificacao,l.canal,l.campanha_origem,
              u.nome AS responsavel_nome,
              lm.conteudo AS ultima_mensagem,lm.tipo AS ultima_mensagem_tipo,lm.direcao AS ultima_direcao,
              COALESCE((SELECT json_agg(json_build_object('id',lb.id,'nome',lb.nome,'cor',lb.cor) ORDER BY lb.nome)
                FROM conversation_labels cl JOIN labels lb ON lb.id=cl.label_id WHERE cl.conversation_id=c.id),'[]'::json) AS labels
         FROM conversations c
         JOIN contacts ct ON ct.id=c.contact_id
         LEFT JOIN leads l ON l.id=c.lead_id
         LEFT JOIN users u ON u.id=c.responsavel_id
         LEFT JOIN LATERAL (
           SELECT conteudo,tipo,direcao FROM messages m WHERE m.conversation_id=c.id ORDER BY m.created_at DESC LIMIT 1
         ) lm ON true
        WHERE ${where.join(' AND ')}
        ORDER BY c.ultima_msg_em DESC NULLS LAST,c.updated_at DESC
        LIMIT 100`, params);
    return rows;
  });
  return c.json({ conversations: result });
});

inboxRoutes.get('/:id', async (c) => {
  const auth = c.get('auth');
  const id = idSchema.parse(c.req.param('id'));
  const result = await withTenantTx(auth, async (db) => {
    const conv = await db.query(
      `SELECT c.*,ct.nome AS contato_nome,ct.telefone,ct.email,ct.avatar_url,
              l.status_qualificacao,l.status_crm,l.canal,l.campanha_origem,l.operacao,
              u.nome AS responsavel_nome
         FROM conversations c
         JOIN contacts ct ON ct.id=c.contact_id
         LEFT JOIN leads l ON l.id=c.lead_id
         LEFT JOIN users u ON u.id=c.responsavel_id
        WHERE c.tenant_id=$1 AND c.id=$2`, [auth.tenantId,id]);
    if (!conv.rows[0]) return null;
    const messages = await db.query(
      `SELECT m.id,m.user_id,m.direcao,m.conteudo,m.tipo,m.midia_url,m.midia_mime,m.status,
              m.por_ia,m.modelo,m.created_at,u.nome AS user_nome
         FROM messages m LEFT JOIN users u ON u.id=m.user_id
        WHERE m.tenant_id=$1 AND m.conversation_id=$2 ORDER BY m.created_at ASC LIMIT 500`,
      [auth.tenantId,id]);
    const notes = await db.query(
      `SELECT n.id,n.texto,n.created_at,n.autor_id,u.nome AS autor_nome
         FROM internal_notes n LEFT JOIN users u ON u.id=n.autor_id
        WHERE n.tenant_id=$1 AND n.conversation_id=$2 ORDER BY n.created_at ASC`, [auth.tenantId,id]);
    return { conversation: conv.rows[0], messages: messages.rows, notes: notes.rows };
  });
  if (!result) return c.json({ error: 'conversation_not_found' }, 404);
  return c.json(result);
});

inboxRoutes.post('/:id/claim', async (c) => {
  const auth = c.get('auth');
  const id = idSchema.parse(c.req.param('id'));
  const row = await withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `UPDATE conversations
          SET responsavel_id=$3,status='ABERTA',modo='MANUAL',updated_at=now()
        WHERE tenant_id=$1 AND id=$2 RETURNING id,responsavel_id,status,modo`,
      [auth.tenantId,id,auth.userId]);
    await db.query(`UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now() WHERE tenant_id=$1 AND lead_id=(SELECT lead_id FROM conversations WHERE tenant_id=$1 AND id=$2) AND status='PENDENTE' AND tipo IN ('FOLLOWUP','REENGAJAMENTO')`, [auth.tenantId,id]);
    return rows[0];
  });
  if (!row) return c.json({ error: 'conversation_not_found' }, 404);
  return c.json(row);
});

inboxRoutes.post('/:id/mode', async (c) => {
  const auth = c.get('auth');
  const id = idSchema.parse(c.req.param('id'));
  const { mode } = z.object({ mode: z.enum(['IA','MANUAL','PAUSADA']) }).parse(await c.req.json());
  const row = await withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `UPDATE conversations SET modo=$3,
         responsavel_id=CASE WHEN $3='MANUAL' AND responsavel_id IS NULL THEN $4 ELSE responsavel_id END,
         updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,modo,responsavel_id`,
      [auth.tenantId,id,mode,auth.userId]);
    if (mode !== 'IA') await db.query(`UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now() WHERE tenant_id=$1 AND lead_id=(SELECT lead_id FROM conversations WHERE tenant_id=$1 AND id=$2) AND status='PENDENTE' AND tipo IN ('FOLLOWUP','REENGAJAMENTO')`, [auth.tenantId,id]);
    return rows[0];
  });
  if (!row) return c.json({ error: 'conversation_not_found' }, 404);
  return c.json(row);
});

inboxRoutes.post('/:id/notes', async (c) => {
  const auth = c.get('auth');
  const id = idSchema.parse(c.req.param('id'));
  const { text } = z.object({ text: z.string().trim().min(1).max(4000) }).parse(await c.req.json());
  const row = await withTenantTx(auth, async (db) => {
    const exists = await db.query(`SELECT 1 FROM conversations WHERE tenant_id=$1 AND id=$2`, [auth.tenantId,id]);
    if (!exists.rows[0]) return null;
    const { rows } = await db.query(
      `INSERT INTO internal_notes (tenant_id,conversation_id,autor_id,texto)
       VALUES ($1,$2,$3,$4) RETURNING id,texto,created_at`, [auth.tenantId,id,auth.userId,text]);
    return rows[0];
  });
  if (!row) return c.json({ error: 'conversation_not_found' }, 404);
  return c.json(row, 201);
});

inboxRoutes.post('/:id/read', async (c) => {
  const auth = c.get('auth');
  const id = idSchema.parse(c.req.param('id'));
  const row = await withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `UPDATE conversations SET nao_lidas=0,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id,nao_lidas`,
      [auth.tenantId,id]);
    return rows[0];
  });
  if (!row) return c.json({ error: 'conversation_not_found' }, 404);
  return c.json(row);
});
