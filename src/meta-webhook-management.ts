import { resolveWhatsAppWaba, withTenantTx, type TenantCtx } from './db.js';

function normalizedTemplateStatus(event: unknown) {
  const value = String(event ?? '').toUpperCase();
  if (value === 'APPROVED' || value === 'REINSTATED' || value === 'UNPAUSED') return 'APROVADO';
  if (value === 'REJECTED') return 'REJEITADO';
  if (['PAUSED','DISABLED','FLAGGED','LOCKED','ARCHIVED','PENDING_DELETION','DELETED'].includes(value)) return 'PAUSADO';
  return 'PENDENTE';
}

function metaEventTime(entryTime: unknown) {
  const seconds = Number(entryTime);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date();
}

export async function handleMetaManagementChange(wabaId: string, entryTime: unknown, change: any) {
  const field = String(change?.field ?? '');
  if (!['message_template_status_update','template_category_update','message_template_quality_update'].includes(field)) return false;
  const resolved = await resolveWhatsAppWaba(wabaId);
  if (!resolved) return true;
  const ctx = { tenantId: resolved.tenant_id, userId: null };
  const value = change?.value ?? {};
  const templateId = value.message_template_id ? String(value.message_template_id) : null;
  const name = value.message_template_name ? String(value.message_template_name) : null;
  const language = value.message_template_language ? String(value.message_template_language) : null;
  const at = metaEventTime(entryTime);
  await withTenantTx(ctx, async (db) => {
    if (field === 'message_template_status_update') {
      const status = normalizedTemplateStatus(value.event);
      const reason = value.reason ? String(value.reason) : null;
      const category = value.message_template_category ? String(value.message_template_category).toUpperCase() : null;
      const details = value.rejection_info ?? value.disable_info ?? value.other_info ?? null;
      await db.query(
        `UPDATE message_templates SET
           status=$1,
           motivo_rejeicao=$2,
           categoria=COALESCE($3,categoria),
           rejection_details=$4::jsonb,
           meta_event=$5,
           meta_last_event_at=$6,
           updated_at=now()
         WHERE tenant_id=$7 AND whatsapp_account_id=$8
           AND (($9::text IS NOT NULL AND meta_template_id=$9)
             OR ($10::text IS NOT NULL AND nome=$10 AND ($11::text IS NULL OR idioma=$11)))`,
        [status,reason,category,JSON.stringify(details),String(value.event ?? ''),at,
         ctx.tenantId,resolved.whatsapp_account_id,templateId,name,language]
      );
    } else if (field === 'template_category_update') {
      const category = value.new_category ? String(value.new_category).toUpperCase() : null;
      if (category) await db.query(
        `UPDATE message_templates SET categoria=$1,meta_event='CATEGORY_UPDATE',meta_last_event_at=$2,updated_at=now()
         WHERE tenant_id=$3 AND whatsapp_account_id=$4
           AND (($5::text IS NOT NULL AND meta_template_id=$5)
             OR ($6::text IS NOT NULL AND nome=$6 AND ($7::text IS NULL OR idioma=$7)))`,
        [category,at,ctx.tenantId,resolved.whatsapp_account_id,templateId,name,language]
      );
    } else {
      const quality = value.new_quality_score ? String(value.new_quality_score).toUpperCase() : null;
      if (quality) await db.query(
        `UPDATE message_templates SET quality_score=$1,meta_event='QUALITY_UPDATE',meta_last_event_at=$2,updated_at=now()
         WHERE tenant_id=$3 AND whatsapp_account_id=$4
           AND (($5::text IS NOT NULL AND meta_template_id=$5)
             OR ($6::text IS NOT NULL AND nome=$6 AND ($7::text IS NULL OR idioma=$7)))`,
        [quality,at,ctx.tenantId,resolved.whatsapp_account_id,templateId,name,language]
      );
    }
  });
  return true;
}

export async function recordPricingStatus(ctx: TenantCtx, whatsappAccountId: string, status: any) {
  const wamid = status?.id ? String(status.id) : '';
  if (!wamid) return;
  const pricing = status?.pricing ?? {};
  const tsSeconds = Number(status?.timestamp);
  const ts = Number.isFinite(tsSeconds) && tsSeconds > 0 ? new Date(tsSeconds * 1000) : new Date();
  const metaStatus = String(status?.status ?? '').toLowerCase();
  const pricingModel = pricing.pricing_model ? String(pricing.pricing_model) : null;
  const pricingCategory = pricing.category ? String(pricing.category) : null;
  const pricingType = pricing.type ? String(pricing.type) : null;
  const billable = typeof pricing.billable === 'boolean' ? pricing.billable : null;

  await withTenantTx(ctx, async (db) => {
    await db.query(
      `INSERT INTO whatsapp_billing_usage
        (tenant_id,whatsapp_account_id,message_id,wamid,recipient_id,meta_status,
         pricing_model,pricing_category,pricing_type,billable,meta_timestamp,delivered_at,read_at,raw)
       VALUES ($1,$2,(SELECT id FROM messages WHERE tenant_id=$1 AND wamid=$3 LIMIT 1),$3,$4,$5,
         $6,$7,$8,$9,$10,
         CASE WHEN $5='delivered' THEN $10 ELSE NULL END,
         CASE WHEN $5='read' THEN $10 ELSE NULL END,$11::jsonb)
       ON CONFLICT (tenant_id,wamid) DO UPDATE SET
         message_id=COALESCE(whatsapp_billing_usage.message_id,EXCLUDED.message_id),
         recipient_id=COALESCE(EXCLUDED.recipient_id,whatsapp_billing_usage.recipient_id),
         meta_status=EXCLUDED.meta_status,
         pricing_model=COALESCE(EXCLUDED.pricing_model,whatsapp_billing_usage.pricing_model),
         pricing_category=COALESCE(EXCLUDED.pricing_category,whatsapp_billing_usage.pricing_category),
         pricing_type=COALESCE(EXCLUDED.pricing_type,whatsapp_billing_usage.pricing_type),
         billable=COALESCE(EXCLUDED.billable,whatsapp_billing_usage.billable),
         meta_timestamp=EXCLUDED.meta_timestamp,
         delivered_at=COALESCE(whatsapp_billing_usage.delivered_at,EXCLUDED.delivered_at),
         read_at=COALESCE(whatsapp_billing_usage.read_at,EXCLUDED.read_at),
         raw=EXCLUDED.raw,
         updated_at=now()`,
      [ctx.tenantId,whatsappAccountId,wamid,status?.recipient_id ?? null,metaStatus,
       pricingModel,pricingCategory,pricingType,billable,ts,JSON.stringify(status)]
    );
  });
}
