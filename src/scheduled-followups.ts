import { env } from './config.js';
import { pool, withTenantTx } from './db.js';
import { createAgentToken } from './agent-token.js';

type JobRow = {
  id: string;
  lead_id: string;
  payload: any;
  tentativas: number;
};

async function claimDueJobs(tenantId: string): Promise<JobRow[]> {
  return withTenantTx({ tenantId }, async (db) => {
    const { rows } = await db.query(
      `WITH picked AS (
         SELECT id FROM scheduled_jobs
          WHERE tenant_id=$1 AND status='PENDENTE' AND executar_em<=now()
          ORDER BY executar_em ASC
          FOR UPDATE SKIP LOCKED LIMIT 20
       )
       UPDATE scheduled_jobs j
          SET status='PROCESSANDO',tentativas=j.tentativas+1,claimed_at=now()
         FROM picked WHERE j.id=picked.id
       RETURNING j.id,j.lead_id,j.payload,j.tentativas`,
      [tenantId]
    );
    return rows as JobRow[];
  });
}
async function resetStaleClaims(tenantId: string) {
  await withTenantTx({ tenantId }, async (db) => {
    await db.query(
      `UPDATE scheduled_jobs
          SET status=CASE WHEN tentativas>=3 THEN 'ERRO' ELSE 'PENDENTE' END,
              executar_em=CASE WHEN tentativas>=3 THEN executar_em ELSE now()+interval '5 minutes' END,
              erro=COALESCE(erro,'followup_confirmation_timeout'),claimed_at=NULL
        WHERE tenant_id=$1 AND status='PROCESSANDO'
          AND claimed_at < now()-interval '5 minutes'`,
      [tenantId]
    );
  });
}

async function markDispatchFailed(tenantId: string, job: JobRow, error: string) {
  await withTenantTx({ tenantId }, async (db) => {
    const exhausted = job.tentativas >= 3;
    await db.query(
      `UPDATE scheduled_jobs
          SET status=$3,erro=$4,claimed_at=NULL,
              executar_em=CASE WHEN $3='PENDENTE' THEN now()+interval '5 minutes' ELSE executar_em END
        WHERE tenant_id=$1 AND id=$2 AND status='PROCESSANDO'`,
      [tenantId, job.id, exhausted ? 'ERRO' : 'PENDENTE', error]
    );
    if (exhausted) {
      await db.query(
        `INSERT INTO notifications (tenant_id,tipo,titulo,corpo,lead_id)
         VALUES ($1,'FOLLOWUP_ERRO','Follow-up automático falhou',$2,$3)`,
        [tenantId, error, job.lead_id]
      );
    }
  });
}

async function processJob(tenantId: string, job: JobRow) {
  const conversationId = job.payload?.conversationId;
  if (!conversationId) return markDispatchFailed(tenantId, job, 'conversation_id_missing');

  const conversation = await withTenantTx({ tenantId }, async (db) => {
    const { rows } = await db.query(
      `SELECT id,lead_id,modo,status FROM conversations WHERE tenant_id=$1 AND id=$2`,
      [tenantId, conversationId]
    );
    return rows[0];
  });
  if (!conversation || conversation.lead_id !== job.lead_id || conversation.modo !== 'IA' || conversation.status === 'RESOLVIDA') {
    await withTenantTx({ tenantId }, async (db) => {
      await db.query(
        `UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now(),erro='conversation_not_eligible',claimed_at=NULL
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, job.id]
      );
    });
    return;
  }

  const agentToken = createAgentToken(tenantId, conversationId, 300);
  const response = await fetch(env.N8N_FOLLOWUP_WEBHOOK!, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventType: 'followup',tenantId,leadId: job.lead_id,conversationId,scheduledJobId: job.id,
      payload: job.payload,agentToken,imobiaBaseUrl: 'http://imobia-api:3001'
    })
  });
  if (!response.ok) throw new Error(`n8n_followup_${response.status}:${await response.text()}`);
  // Não marca EXECUTADO aqui. A confirmação é feita pela tool /followup/send.
}

let running = false;

async function scanScheduledFollowups() {
  if (running || !env.N8N_FOLLOWUP_WEBHOOK) return;
  running = true;
  try {
    const tenants = await pool.query(`SELECT id FROM tenants WHERE ativo=true ORDER BY created_at`);
    for (const tenant of tenants.rows) {
      await resetStaleClaims(tenant.id);
      const jobs = await claimDueJobs(tenant.id);
      for (const job of jobs) {
        try {
          await processJob(tenant.id, job);
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 1800) : String(error).slice(0, 1800);
          await markDispatchFailed(tenant.id, job, message);
        }
      }
    }
  } finally {
    running = false;
  }
}

export function startScheduledFollowupLoop() {
  if (!env.N8N_FOLLOWUP_WEBHOOK) return;
  void scanScheduledFollowups();
  setInterval(() => { void scanScheduledFollowups(); }, 30000).unref();
}
