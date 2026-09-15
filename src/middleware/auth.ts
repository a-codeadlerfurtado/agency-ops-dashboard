import type { MiddlewareHandler } from 'hono';
import { pool, withTenantTx } from '../db.js';

export type AuthCtx = { tenantId: string; userId: string; role: string };

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthCtx;
  }
}

// MVP: session id UUID em cookie httpOnly `session_id`.
// `sessions` pode ser lida antes do contexto; `users` tem RLS e só é consultada depois de SET LOCAL.
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const cookie = c.req.header('cookie') ?? '';
  const sessionId = /(?:^|;\s*)session_id=([^;]+)/.exec(cookie)?.[1];
  if (!sessionId) return c.json({ error: 'unauthorized' }, 401);

  const session = await pool.query(
    `SELECT user_id, tenant_id FROM sessions WHERE id = $1 AND expires_at > now()`,
    [sessionId]
  );
  const s = session.rows[0];
  if (!s) return c.json({ error: 'unauthorized' }, 401);

  const user = await withTenantTx({ tenantId: s.tenant_id, userId: s.user_id }, async (db) => {
    const { rows } = await db.query(
      `SELECT id, papel FROM users WHERE tenant_id=$1 AND id=$2 AND ativo=true`,
      [s.tenant_id, s.user_id]
    );
    return rows[0];
  });
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  c.set('auth', { tenantId: s.tenant_id, userId: s.user_id, role: user.papel });
  await next();
};
