import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const realtimeRoutes = new Hono();
realtimeRoutes.use('*', requireAuth);

function quoteChannel(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

realtimeRoutes.get('/', async (c) => {
  const auth = c.get('auth');
  const client = await pool.connect();
  const channels = [`msg:${auth.tenantId}`, `conv:${auth.tenantId}`];

  return streamSSE(c, async (stream) => {
    let closed = false;
    for (const channel of channels) await client.query(`LISTEN ${quoteChannel(channel)}`);

    const onNotification = (msg: any) => {
      if (!channels.includes(msg.channel)) return;
      void stream.writeSSE({ event: 'update', data: msg.payload ?? '{}' }).catch(() => {});
    };
    client.on('notification', onNotification);
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      client.off('notification', onNotification);
      try { await client.query('UNLISTEN *'); } catch {}
      client.release();
    };

    stream.onAbort(() => { void cleanup(); });
    await stream.writeSSE({ event: 'ready', data: JSON.stringify({ ok: true }) });

    try {
      while (!closed) {
        await stream.sleep(15000);
        if (!closed) await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
      }
    } finally {
      await cleanup();
    }
  });
});
