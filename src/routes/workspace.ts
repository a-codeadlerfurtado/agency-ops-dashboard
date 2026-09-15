import { Hono } from 'hono';
import { withTenantTx } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

export const workspaceRoutes = new Hono();
workspaceRoutes.use('*', requireAuth);

workspaceRoutes.get('/overview', async (c) => {
  const auth = c.get('auth');
  const data = await withTenantTx(auth, async (db) => {
    const [conversations, leads, properties, followups, channels] = await Promise.all([
      db.query(`SELECT count(*)::int total,
        count(*) FILTER (WHERE status <> 'RESOLVIDA')::int abertas,
        count(*) FILTER (WHERE modo='IA')::int ia,
        count(*) FILTER (WHERE modo='MANUAL')::int humanas,
        coalesce(sum(nao_lidas),0)::int nao_lidas FROM conversations WHERE tenant_id=$1 AND arquivada=false`, [auth.tenantId]),
      db.query(`SELECT count(*)::int total,
        count(*) FILTER (WHERE status_qualificacao='QUALIFICADO')::int qualificados,
        count(*) FILTER (WHERE created_at >= now()-interval '7 days')::int novos_7d FROM leads WHERE tenant_id=$1`, [auth.tenantId]),
      db.query(`SELECT count(*)::int total,
        count(*) FILTER (WHERE status='DISPONIVEL')::int disponiveis FROM properties WHERE tenant_id=$1`, [auth.tenantId]),
      db.query(`SELECT count(*) FILTER (WHERE status IN ('PENDENTE','PROCESSANDO'))::int pendentes FROM scheduled_jobs WHERE tenant_id=$1 AND tipo='FOLLOWUP'`, [auth.tenantId]),
      db.query(`SELECT count(*) FILTER (WHERE status='ATIVO')::int ativos FROM whatsapp_accounts WHERE tenant_id=$1`, [auth.tenantId])
    ]);
    return { conversations: conversations.rows[0], leads: leads.rows[0], properties: properties.rows[0], followups: followups.rows[0], channels: channels.rows[0] };
  });
  return c.json(data);
});
workspaceRoutes.get('/leads', async (c) => {
  const auth = c.get('auth');
  const rows = await withTenantTx(auth, async (db) => (await db.query(
    `SELECT l.id,l.status_qualificacao,l.status_crm,l.canal,l.operacao,l.tipo_desejado,
            l.cidade_desejada,l.orcamento_min,l.orcamento_max,l.lead_score,l.created_at,l.ultimo_contato_em,
            ct.nome,ct.telefone,ct.email,u.nome AS responsavel_nome
       FROM leads l JOIN contacts ct ON ct.id=l.contact_id
       LEFT JOIN users u ON u.id=l.responsavel_id
      WHERE l.tenant_id=$1 ORDER BY l.created_at DESC LIMIT 100`, [auth.tenantId]
  )).rows);
  return c.json({ leads: rows });
});

workspaceRoutes.get('/properties', async (c) => {
  const auth = c.get('auth');
  const rows = await withTenantTx(auth, async (db) => (await db.query(
    `SELECT id,codigo_externo,titulo,tipo,operacao,status,preco,preco_locacao,quartos,vagas,bairro,cidade,uf,destaque,updated_at
       FROM properties WHERE tenant_id=$1 ORDER BY destaque DESC,updated_at DESC LIMIT 100`, [auth.tenantId]
  )).rows);
  return c.json({ properties: rows });
});
workspaceRoutes.get('/followups', async (c) => {
  const auth = c.get('auth');
  const rows = await withTenantTx(auth, async (db) => (await db.query(
    `SELECT j.id,j.status,j.executar_em,j.executado_em,j.tentativas,j.erro,j.payload,
            l.id AS lead_id,ct.nome,ct.telefone
       FROM scheduled_jobs j LEFT JOIN leads l ON l.id=j.lead_id
       LEFT JOIN contacts ct ON ct.id=l.contact_id
      WHERE j.tenant_id=$1 AND j.tipo='FOLLOWUP'
      ORDER BY COALESCE(j.executar_em,j.executado_em) DESC LIMIT 100`, [auth.tenantId]
  )).rows);
  return c.json({ followups: rows });
});

workspaceRoutes.get('/settings', async (c) => {
  const auth = c.get('auth');
  const data = await withTenantTx(auth, async (db) => {
    const tenant = (await db.query(`SELECT id,nome,slug,timezone,plano FROM tenants WHERE id=$1`, [auth.tenantId])).rows[0];
    const ai = (await db.query(`SELECT persona_nome,tom_voz,usar_emoji,exibir_nome_atendente,tamanho_max_msg,modelo,llm_provider FROM ai_config WHERE tenant_id=$1`, [auth.tenantId])).rows[0] ?? null;
    const users = (await db.query(`SELECT count(*)::int total FROM users WHERE tenant_id=$1 AND ativo=true`, [auth.tenantId])).rows[0];
    const channels = (await db.query(`SELECT count(*)::int total,count(*) FILTER (WHERE status='ATIVO')::int ativos FROM whatsapp_accounts WHERE tenant_id=$1`, [auth.tenantId])).rows[0];
    return { tenant, ai, users, channels };
  });
  return c.json(data);
});
