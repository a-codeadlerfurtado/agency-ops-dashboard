import { Hono } from 'hono';
import { z } from 'zod';
import { withTenantTx } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const billingRoutes = new Hono();
billingRoutes.use('*', requireAuth);

const dateSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

function defaultRange() {
  const now = new Date();
  return {
    from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    to: now
  };
}

billingRoutes.get('/summary', async (c) => {
  const auth = c.get('auth');
  const input = dateSchema.parse({ from: c.req.query('from'), to: c.req.query('to') });
  const defaults = defaultRange();
  const from = input.from ? new Date(input.from) : defaults.from;
  const to = input.to ? new Date(input.to) : defaults.to;
  const result = await withTenantTx(auth, async (db) => {
    const totals = await db.query(
      `SELECT count(*)::int AS messages,
              count(*) FILTER (WHERE billable IS TRUE)::int AS billable,
              count(*) FILTER (WHERE billable IS FALSE)::int AS non_billable
         FROM whatsapp_billing_usage
        WHERE tenant_id=$1
          AND COALESCE(delivered_at,meta_timestamp,updated_at) >= $2
          AND COALESCE(delivered_at,meta_timestamp,updated_at) < $3`,
      [auth.tenantId, from, to]
    );
    const groups = await db.query(
      `SELECT COALESCE(pricing_category,'unknown') AS category,
              COALESCE(pricing_model,'unknown') AS pricing_model,
              COALESCE(pricing_type,'unknown') AS pricing_type,
              count(*)::int AS messages,
              count(*) FILTER (WHERE billable IS TRUE)::int AS billable
         FROM whatsapp_billing_usage
        WHERE tenant_id=$1
          AND COALESCE(delivered_at,meta_timestamp,updated_at) >= $2
          AND COALESCE(delivered_at,meta_timestamp,updated_at) < $3
        GROUP BY 1,2,3 ORDER BY 1,2,3`,
      [auth.tenantId, from, to]
    );
    return { totals: totals.rows[0], groups: groups.rows };
  });

  return c.json({
    ok: true,
    period: { from: from.toISOString(), to: to.toISOString() },
    ...result,
    monetaryAmount: null,
    monetarySource: 'meta_invoice_or_pricing_analytics',
    note: 'Billable/category/model come from Meta status webhooks; exact currency amount must be reconciled with Meta billing analytics/invoice.'
  });
});
