import pg from 'pg';
import { env } from './config.js';

const { Pool } = pg;
export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 20 });

export type TenantCtx = { tenantId: string; userId?: string | null };

export async function withTenantTx<T>(ctx: TenantCtx, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.tenantId]);
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId ?? '']);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function resolveWhatsAppAccount(phoneNumberId: string) {
  const { rows } = await pool.query(
    `SELECT tenant_id, whatsapp_account_id FROM resolve_whatsapp_account($1)`,
    [phoneNumberId]
  );
  return rows[0] as { tenant_id: string; whatsapp_account_id: string } | undefined;
}

export async function resolveWhatsAppWaba(wabaId: string) {
  const { rows } = await pool.query(
    `SELECT tenant_id, whatsapp_account_id FROM resolve_whatsapp_waba($1)`,
    [wabaId]
  );
  return rows[0] as { tenant_id: string; whatsapp_account_id: string } | undefined;
}
