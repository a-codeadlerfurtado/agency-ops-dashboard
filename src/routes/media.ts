import { Hono } from 'hono';
import { getObject } from '../s3.js';
import { withTenantTx } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const mediaRoutes = new Hono();
mediaRoutes.use('*', requireAuth);

mediaRoutes.get('/:messageId', async (c) => {
  const auth = c.get('auth');
  const row = await withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `SELECT midia_url,midia_mime FROM messages WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId, c.req.param('messageId')]
    );
    return rows[0];
  });
  if (!row?.midia_url) return c.json({ error: 'media_not_found' }, 404);
  const object = await getObject(row.midia_url);
  if (!object) return c.json({ error: 'media_not_found' }, 404);
  c.header('Content-Type', row.midia_mime ?? object.contentType);
  c.header('Cache-Control', 'private, max-age=300');
  return c.body(object.body);
});
