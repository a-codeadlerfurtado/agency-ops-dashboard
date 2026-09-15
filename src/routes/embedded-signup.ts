import { Hono } from 'hono';
import { z } from 'zod';
import { env, embeddedSignupConfigured } from '../config.js';
import { encryptSecret } from '../crypto.js';
import { withTenantTx } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  exchangeEmbeddedSignupCode,
  getPhone,
  listTemplates,
  normalizeTemplateStatus,
  registerPhone,
  subscribeWaba
} from '../meta/client.js';

export const embeddedSignupRoutes = new Hono();
embeddedSignupRoutes.use('*', requireAuth);

embeddedSignupRoutes.get('/config', (c) => {
  return c.json({
    appId: env.META_APP_ID,
    configId: env.META_EMBEDDED_SIGNUP_CONFIG_ID,
    graphVersion: env.META_GRAPH_VERSION,
    embeddedSignupConfigured,
    manualConnectionAvailable: true,
    extras: JSON.parse(env.META_EMBEDDED_SIGNUP_EXTRAS_JSON || '{}')
  });
});

const completeSchema = z.object({
  code: z.string().min(8),
  wabaId: z.string().min(2),
  phoneNumberId: z.string().min(2),
  twoStepPin: z.string().regex(/^\d{6}$/).optional()
});

const manualSchema = z.object({
  accessToken: z.string().trim().min(20).max(8192),
  wabaId: z.string().trim().regex(/^\d{5,30}$/),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/),
  twoStepPin: z.string().regex(/^\d{6}$/).optional()
});

function canManage(role: string) {
  return ['ADMIN', 'EDITOR', 'GESTOR'].includes(role);
}

async function persistConnectedAccount(
  auth: any,
  input: { wabaId: string; phoneNumberId: string },
  accessToken: string,
  tokenExpiresAt: Date | null,
  phone: Awaited<ReturnType<typeof getPhone>>,
  templates: Awaited<ReturnType<typeof listTemplates>>
) {
  return withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO whatsapp_accounts
        (tenant_id, waba_id, phone_number_id, display_phone, verified_name, access_token_enc,
         quality_rating, status, onboarded_at, token_expires_at, token_last_verified_at, token_last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ATIVO',now(),$8,now(),NULL)
       ON CONFLICT (phone_number_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id, waba_id = EXCLUDED.waba_id,
         display_phone = EXCLUDED.display_phone, verified_name = EXCLUDED.verified_name,
         access_token_enc = EXCLUDED.access_token_enc, quality_rating = EXCLUDED.quality_rating,
         status = 'ATIVO', onboarded_at = now(), token_expires_at = EXCLUDED.token_expires_at,
         token_last_verified_at = now(), token_last_error = NULL, updated_at = now()
       RETURNING id, phone_number_id, display_phone, verified_name`,
      [auth.tenantId, input.wabaId, input.phoneNumberId, phone.display_phone_number ?? input.phoneNumberId,
       phone.verified_name ?? null, encryptSecret(accessToken), phone.quality_rating ?? null, tokenExpiresAt]
    );
    const account = rows[0];
    for (const t of templates.data ?? []) {
      await db.query(
        `INSERT INTO message_templates
          (tenant_id, whatsapp_account_id, meta_template_id, nome, idioma, categoria, status, componentes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (whatsapp_account_id, nome, idioma) DO UPDATE SET
           meta_template_id=EXCLUDED.meta_template_id, categoria=EXCLUDED.categoria,
           status=EXCLUDED.status, componentes=EXCLUDED.componentes, updated_at=now()`,
        [auth.tenantId, account.id, t.id ?? null, t.name, t.language ?? 'pt_BR',
         t.category ?? 'UTILITY', normalizeTemplateStatus(t.status), JSON.stringify(t.components ?? [])]
      );
    }
    await db.query(
      `INSERT INTO events (tenant_id, tipo, payload) VALUES ($1, 'WHATSAPP_ONBOARDED', $2::jsonb)`,
      [auth.tenantId, JSON.stringify({ waba_id: input.wabaId, phone_number_id: input.phoneNumberId })]
    );
    return account;
  });
}

embeddedSignupRoutes.post('/complete', async (c) => {
  const auth = c.get('auth');
  const input = completeSchema.parse(await c.req.json());

  const tokenResult = await exchangeEmbeddedSignupCode(input.code);
  const accessToken = tokenResult.access_token;
  const tokenExpiresAt = tokenResult.expires_in
    ? new Date(Date.now() + Number(tokenResult.expires_in) * 1000)
    : null;
  await subscribeWaba(input.wabaId, accessToken);
  if (input.twoStepPin) await registerPhone(input.phoneNumberId, input.twoStepPin, accessToken);

  const phone = await getPhone(input.phoneNumberId, accessToken);
  const templatePage = await listTemplates(input.wabaId, accessToken);
  const account = await persistConnectedAccount(auth, input, accessToken, tokenExpiresAt, phone, templatePage);

  return c.json({ ok: true, account, templatesSynced: templatePage.data?.length ?? 0 });
});

embeddedSignupRoutes.post('/manual', async (c) => {
  const auth = c.get('auth');
  if (!canManage(auth.role)) return c.json({ error: 'forbidden' }, 403);
  const input = manualSchema.parse(await c.req.json());

  await subscribeWaba(input.wabaId, input.accessToken);
  if (input.twoStepPin) await registerPhone(input.phoneNumberId, input.twoStepPin, input.accessToken);
  const phone = await getPhone(input.phoneNumberId, input.accessToken);
  const templatePage = await listTemplates(input.wabaId, input.accessToken);
  const account = await persistConnectedAccount(auth, input, input.accessToken, null, phone, templatePage);

  return c.json({
    ok: true,
    mode: 'manual',
    account,
    templatesSynced: templatePage.data?.length ?? 0,
    webhook: '/webhooks/whatsapp'
  }, 201);
});
