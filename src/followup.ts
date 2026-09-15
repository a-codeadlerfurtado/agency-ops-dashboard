type Db = { query: (text: string, params?: unknown[]) => Promise<any> };

type Attempt = {
  apos_minutos?: number;
  after_minutes?: number;
  template_id?: string | null;
  components?: unknown[];
};

export async function cancelPendingFollowups(db: Db, tenantId: string, leadId: string) {
  const result = await db.query(
    `UPDATE scheduled_jobs
        SET status='CANCELADO', executado_em=now()
      WHERE tenant_id=$1 AND lead_id=$2 AND status='PENDENTE'
        AND tipo IN ('FOLLOWUP','REENGAJAMENTO')`,
    [tenantId, leadId]
  );
  return result.rowCount ?? 0;
}

export async function resetFollowupSchedule(
  db: Db, tenantId: string, leadId: string, conversationId: string
) {
  await cancelPendingFollowups(db, tenantId, leadId);
  const rule = await db.query(
    `SELECT r.id,r.tentativas
       FROM reengage_rules r
       JOIN leads l ON l.tenant_id=r.tenant_id AND l.id=$2
      WHERE r.tenant_id=$1 AND r.ativo=true
        AND (r.operacao IS NULL OR r.operacao=l.operacao)
      ORDER BY r.created_at ASC LIMIT 1`,
    [tenantId, leadId]
  );
  const selected = rule.rows[0];
  if (!selected || !Array.isArray(selected.tentativas)) return 0;

  let created = 0;
  for (let i = 0; i < selected.tentativas.length; i++) {
    const attempt = selected.tentativas[i] as Attempt;
    const minutes = Number(attempt.apos_minutos ?? attempt.after_minutes ?? 0);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    const payload = {
      conversationId, ruleId: selected.id, attemptIndex: i + 1,
      afterMinutes: minutes, templateId: attempt.template_id ?? null,
      components: Array.isArray(attempt.components) ? attempt.components : undefined
    };
    await db.query(
      `INSERT INTO scheduled_jobs (tenant_id,tipo,lead_id,payload,executar_em)
       VALUES ($1,'FOLLOWUP',$2,$3::jsonb,now()+($4::text || ' minutes')::interval)`,
      [tenantId, leadId, JSON.stringify(payload), String(minutes)]
    );
    created++;
  }
  return created;
}
