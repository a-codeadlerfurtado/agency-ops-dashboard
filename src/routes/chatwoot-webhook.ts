import { Hono } from 'hono';
import { handleChatwootWebhook } from '../chatwoot-bridge.js';

export const chatwootWebhookRoutes = new Hono();

chatwootWebhookRoutes.post('/', async (c) => {
  const raw = Buffer.from(await c.req.arrayBuffer());
  const result = await handleChatwootWebhook(raw, c.req.raw.headers);
  return c.json(result.body, result.status as any);
});
