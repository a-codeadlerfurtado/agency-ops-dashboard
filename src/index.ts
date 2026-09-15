import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './config.js';
import { embeddedSignupRoutes } from './routes/embedded-signup.js';
import { messageRoutes } from './routes/messages.js';
import { templateRoutes } from './routes/templates.js';
import { webhookRoutes } from './routes/webhook.js';
import { inboxRoutes } from './routes/inbox.js';
import { authRoutes } from './routes/auth.js';
import { mediaRoutes } from './routes/media.js';
import { internalAgentRoutes } from './routes/internal-agent.js';
import { realtimeRoutes } from './routes/realtime.js';
import { internalFollowupRoutes } from './routes/internal-followup.js';
import { integrationRoutes } from './routes/integrations.js';
import { workspaceRoutes } from './routes/workspace.js';
import { chatwootWebhookRoutes } from './routes/chatwoot-webhook.js';
import { billingRoutes } from './routes/billing.js';
import { pool } from './db.js';
import { metaConfigured, embeddedSignupConfigured } from './config.js';
import { renderedHtml } from './ui/home.js';
import { authGateHtml } from './ui/auth-gate.js';

const app = new Hono();
app.get('/', (c) => c.html(renderedHtml.replace('</body>', authGateHtml + '</body>')));
app.get('/health', async (c) => {
  let database='down';
  try { await pool.query('SELECT 1'); database='ok'; } catch {}
  return c.json({ ok: database==='ok', product:'ImoBia', database, metaConfigured, embeddedSignupConfigured });
});
app.route('/webhooks', webhookRoutes);
app.route('/webhooks/chatwoot', chatwootWebhookRoutes);
app.route('/v1/whatsapp/embedded-signup', embeddedSignupRoutes);
app.route('/v1/whatsapp/messages', messageRoutes);
app.route('/v1/whatsapp/templates', templateRoutes);
app.route('/v1/whatsapp/billing', billingRoutes);
app.route('/v1/inbox', inboxRoutes);
app.route('/v1/realtime/inbox', realtimeRoutes);
app.route('/v1/auth', authRoutes);
app.route('/v1/media', mediaRoutes);
app.route('/v1/internal', internalAgentRoutes);
app.route('/v1/internal/followup', internalFollowupRoutes);
app.route('/v1/integrations', integrationRoutes);
app.route('/v1/workspace', workspaceRoutes);

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
});

serve({ fetch: app.fetch, port: env.PORT });
console.log(`api listening on :${env.PORT}`);

