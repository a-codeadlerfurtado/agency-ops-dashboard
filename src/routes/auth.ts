import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { pool, withTenantTx } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const scrypt = promisify(scryptCb);
export const authRoutes = new Hono();

async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string | null) {
  if (!stored?.startsWith('scrypt$')) return false;
  const [, salt64, hash64] = stored.split('$');
  const expected = Buffer.from(hash64, 'base64');
  const derived = await scrypt(password, Buffer.from(salt64, 'base64'), expected.length) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

function sessionCookie(id: string, maxAge = 60 * 60 * 24 * 30) {
  return `session_id=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}
authRoutes.get('/status', async (c) => {
  const { rows } = await pool.query(`SELECT EXISTS(SELECT 1 FROM tenants) AS configured`);
  return c.json({ configured: Boolean(rows[0]?.configured) });
});

authRoutes.post('/setup', async (c) => {
  const input = z.object({
    company: z.string().trim().min(2).max(120),
    name: z.string().trim().min(2).max(120),
    email: z.string().email().max(180),
    password: z.string().min(10).max(200)
  }).parse(await c.req.json());

  const exists = await pool.query(`SELECT EXISTS(SELECT 1 FROM tenants) AS configured`);
  if (exists.rows[0]?.configured) return c.json({ error: 'already_configured' }, 409);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query(
      `INSERT INTO tenants (nome,slug,plano) VALUES ($1,$2,'internal') RETURNING id`,
      [input.company, input.company.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')]
    );
    const tenantId = tenant.rows[0].id;
    await client.query(`SELECT set_config('app.tenant_id',$1,true)`, [tenantId]);
    const user = await client.query(
      `INSERT INTO users (tenant_id,nome,email,senha_hash,papel) VALUES ($1,$2,$3,$4,'ADMIN') RETURNING id`,
      [tenantId,input.name,input.email.toLowerCase(),await hashPassword(input.password)]
    );
    const session = await client.query(
      `INSERT INTO sessions (user_id,tenant_id,expires_at,user_agent,ip) VALUES ($1,$2,now()+interval '30 days',$3,$4) RETURNING id`,
      [user.rows[0].id,tenantId,c.req.header('user-agent') ?? null,c.req.header('cf-connecting-ip') ?? null]
    );
    await client.query('COMMIT');
    c.header('Set-Cookie', sessionCookie(session.rows[0].id));
    return c.json({ ok: true, tenantId, userId: user.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
});
authRoutes.post('/login', async (c) => {
  const input = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(await c.req.json());
  const tenantRows = await pool.query(`SELECT id FROM tenants WHERE ativo=true ORDER BY created_at ASC`);
  for (const tenant of tenantRows.rows) {
    const user = await withTenantTx({ tenantId: tenant.id }, async (db) => {
      const { rows } = await db.query(
        `SELECT id,tenant_id,nome,email,senha_hash,papel FROM users WHERE lower(email)=lower($1) AND ativo=true LIMIT 1`,
        [input.email]
      );
      return rows[0];
    });
    if (!user || !(await verifyPassword(input.password, user.senha_hash))) continue;
    const session = await pool.query(
      `INSERT INTO sessions (user_id,tenant_id,expires_at,user_agent,ip) VALUES ($1,$2,now()+interval '30 days',$3,$4) RETURNING id`,
      [user.id,user.tenant_id,c.req.header('user-agent') ?? null,c.req.header('cf-connecting-ip') ?? null]
    );
    c.header('Set-Cookie', sessionCookie(session.rows[0].id));
    return c.json({ ok: true, user: { id:user.id,name:user.nome,email:user.email,role:user.papel } });
  }
  return c.json({ error: 'invalid_credentials' }, 401);
});

authRoutes.post('/logout', async (c) => {
  const cookie = c.req.header('cookie') ?? '';
  const sessionId = /(?:^|;\s*)session_id=([^;]+)/.exec(cookie)?.[1];
  if (sessionId) await pool.query(`DELETE FROM sessions WHERE id=$1`, [sessionId]);
  c.header('Set-Cookie', sessionCookie('', 0));
  return c.json({ ok: true });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const auth = c.get('auth');
  const user = await withTenantTx(auth, async (db) => {
    const { rows } = await db.query(`SELECT id,nome,email,papel,avatar_url FROM users WHERE id=$1`, [auth.userId]);
    return rows[0];
  });
  return c.json({ user });
});