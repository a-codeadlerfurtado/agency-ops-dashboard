import { Hono } from 'hono';
import { z } from 'zod';
import { decryptSecret } from '../crypto.js';
import { withTenantTx } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { createTemplate, deleteTemplate, listTemplates, normalizeTemplateStatus } from '../meta/client.js';

export const templateRoutes = new Hono();
templateRoutes.use('*', requireAuth);

async function loadAccount(auth: any, id: string) {
  return withTenantTx(auth, async (db) => {
    const { rows } = await db.query(
      `SELECT id,waba_id,access_token_enc FROM whatsapp_accounts WHERE tenant_id=$1 AND id=$2`,
      [auth.tenantId, id]
    );
    return rows[0];
  });
}

templateRoutes.post('/sync/:accountId', async (c) => {
  const auth = c.get('auth');
  const accountId = z.string().uuid().parse(c.req.param('accountId'));
  const wa = await loadAccount(auth, accountId);
  if (!wa) return c.json({ error: 'account_not_found' }, 404);
  const page = await listTemplates(wa.waba_id, decryptSecret(wa.access_token_enc));
  const count = await withTenantTx(auth, async (db) => {
    for (const t of page.data ?? []) {
      await db.query(
        `INSERT INTO message_templates
          (tenant_id,whatsapp_account_id,meta_template_id,nome,idioma,categoria,status,componentes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (whatsapp_account_id,nome,idioma) DO UPDATE SET
          meta_template_id=EXCLUDED.meta_template_id,categoria=EXCLUDED.categoria,
          status=EXCLUDED.status,componentes=EXCLUDED.componentes,updated_at=now()`,
        [auth.tenantId,accountId,t.id??null,t.name,t.language??'pt_BR',t.category??'UTILITY',
         normalizeTemplateStatus(t.status),JSON.stringify(t.components??[])]
      );
    }
    return page.data?.length ?? 0;
  });
  return c.json({ ok: true, synced: count });
});

const createSchema = z.object({
  accountId: z.string().uuid(),
  name: z.string().regex(/^[a-z0-9_]+$/),
  language: z.string().default('pt_BR'),
  category: z.enum(['MARKETING','UTILITY','AUTHENTICATION']),
  components: z.array(z.any())
});

templateRoutes.post('/', async (c) => {
  const auth = c.get('auth');
  const input = createSchema.parse(await c.req.json());
  const wa = await loadAccount(auth, input.accountId);
  if (!wa) return c.json({ error: 'account_not_found' }, 404);
  const meta = await createTemplate(wa.waba_id, decryptSecret(wa.access_token_enc), {
    name: input.name,
    language: input.language,
    category: input.category,
    components: input.components
  });
  await withTenantTx(auth, async (db) => {
    await db.query(
      `INSERT INTO message_templates
        (tenant_id,whatsapp_account_id,meta_template_id,nome,idioma,categoria,status,componentes)
       VALUES ($1,$2,$3,$4,$5,$6,'PENDENTE',$7)
       ON CONFLICT (whatsapp_account_id,nome,idioma) DO UPDATE SET
         meta_template_id=EXCLUDED.meta_template_id,categoria=EXCLUDED.categoria,
         componentes=EXCLUDED.componentes,status='PENDENTE',updated_at=now()`,
      [auth.tenantId,input.accountId,meta.id??null,input.name,input.language,input.category,JSON.stringify(input.components)]
    );
  });
  return c.json({ ok: true, meta });
});

templateRoutes.delete('/:accountId/:name', async (c) => {
  const auth = c.get('auth');
  const accountId = z.string().uuid().parse(c.req.param('accountId'));
  const name = c.req.param('name');
  const wa = await loadAccount(auth, accountId);
  if (!wa) return c.json({ error: 'account_not_found' }, 404);
  await deleteTemplate(wa.waba_id, decryptSecret(wa.access_token_enc), name);
  await withTenantTx(auth, async (db) => {
    await db.query(
      `DELETE FROM message_templates WHERE tenant_id=$1 AND whatsapp_account_id=$2 AND nome=$3`,
      [auth.tenantId, accountId, name]
    );
  });
  return c.json({ ok: true });
});
