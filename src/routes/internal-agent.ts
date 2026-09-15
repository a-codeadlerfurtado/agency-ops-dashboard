import { Hono } from 'hono';
import { z } from 'zod';
import { withTenantTx } from '../db.js';
import { verifyAgentToken } from '../agent-token.js';
import { decryptSecret } from '../crypto.js';
import { sendTemplate, sendText } from '../meta/client.js';
import { resetFollowupSchedule } from '../followup.js';
import { whatsappQueue } from '../queue.js';

export const internalAgentRoutes = new Hono();

type Claims = { tenantId: string; conversationId: string; exp: number };

function claimsFrom(c: any): Claims | null {
  const auth = c.req.header('authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return null;
  return verifyAgentToken(auth.slice(7));
}

internalAgentRoutes.use('*', async (c, next) => {
  const claims = claimsFrom(c);
  if (!claims) return c.json({ error: 'invalid_agent_token' }, 401);
  c.set('agentClaims' as any, claims);
  await next();
});

function getClaims(c: any) { return c.get('agentClaims' as any) as Claims; }
internalAgentRoutes.get('/context', async (c) => {
  const claims = getClaims(c);
  const result = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    const conv = await db.query(
      `SELECT c.id,c.lead_id,c.modo,c.status,c.estado_maquina,c.resumo_ia,c.janela_expira_em,
              ct.nome AS contato_nome,ct.telefone,ct.email,
              l.operacao,l.tipo_desejado,l.cidade_desejada,l.bairros_desejados,l.quartos_min,l.vagas_min,
              l.orcamento_min,l.orcamento_max,l.status_qualificacao,l.lead_score,l.property_id
         FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
         LEFT JOIN leads l ON l.id=c.lead_id
        WHERE c.tenant_id=$1 AND c.id=$2`, [claims.tenantId, claims.conversationId]);
    if (!conv.rows[0]) return null;
    const messages = await db.query(
      `SELECT direcao,conteudo,tipo,por_ia,created_at FROM messages
        WHERE tenant_id=$1 AND conversation_id=$2 ORDER BY created_at DESC LIMIT 24`,
      [claims.tenantId, claims.conversationId]);
    const config = await db.query(`SELECT * FROM ai_config WHERE tenant_id=$1`, [claims.tenantId]);
    const essentials = await db.query(
      `SELECT id,ordem,pergunta,categoria,campo_destino,tipo_resposta,obrigatoria
         FROM essential_questions WHERE tenant_id=$1 AND ativo=true ORDER BY ordem`, [claims.tenantId]);
    const qualifying = await db.query(
      `SELECT id,ordem,pergunta,peso_score,operacao FROM qualifying_questions
        WHERE tenant_id=$1 AND ativo=true AND (operacao IS NULL OR operacao=$2) ORDER BY ordem`,
      [claims.tenantId, conv.rows[0].operacao]);
    const answers = conv.rows[0].lead_id ? await db.query(
      `SELECT question_id,origem,pergunta,resposta,respondida_em FROM lead_answers
        WHERE tenant_id=$1 AND lead_id=$2 ORDER BY respondida_em`, [claims.tenantId, conv.rows[0].lead_id]) : { rows: [] };
    const knowledge = await db.query(
      `SELECT escopo,chave,valor FROM business_knowledge WHERE tenant_id=$1 AND ativo=true ORDER BY escopo,chave LIMIT 80`,
      [claims.tenantId]);
    const departments = await db.query(
      `SELECT id,nome,descricao,telefone,email FROM departments WHERE tenant_id=$1 AND ativo=true ORDER BY nome`,
      [claims.tenantId]);
    return { conversation: conv.rows[0], messages: messages.rows.reverse(), config: config.rows[0] ?? null,
      essentialQuestions: essentials.rows, qualifyingQuestions: qualifying.rows, answers: answers.rows,
      knowledge: knowledge.rows, departments: departments.rows };
  });
  if (!result) return c.json({ error: 'conversation_not_found' }, 404);
  return c.json(result);
});
function normalizeOperation(value: unknown) {
  if (!value) return null;
  const v=String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  if (['VENDA','COMPRA','COMPRAR'].includes(v)) return 'VENDA';
  if (['LOCACAO','ALUGUEL','ALUGAR'].includes(v)) return 'LOCACAO';
  if (v==='AMBOS') return 'AMBOS';
  return null;
}
function normalizeQualification(value: unknown) {
  if (!value) return null;
  const v=String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,'_');
  return ['NOVO','EM_QUALIFICACAO','QUALIFICADO','FRIO','DESQUALIFICADO'].includes(v)?v:null;
}
const propertySearchSchema = z.object({
  operation: z.string().trim().max(30).nullable().optional(),
  type: z.string().trim().max(80).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  neighborhoods: z.array(z.string().trim().max(120)).max(12).nullable().optional(),
  neighborhood: z.string().trim().max(120).nullable().optional(),
  priceMin: z.number().nonnegative().nullable().optional(),
  priceMax: z.number().nonnegative().nullable().optional(),
  bedroomsMin: z.number().int().min(0).max(30).nullable().optional(),
  parkingMin: z.number().int().min(0).max(30).nullable().optional(),
  limit: z.number().int().min(1).max(8).default(3)
});

internalAgentRoutes.post('/properties/search', async (c) => {
  const claims = getClaims(c);
  const input = propertySearchSchema.parse(await c.req.json());
  const rows = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    const result = await db.query(
      `SELECT * FROM buscar_imoveis($1,$2::operacao,$3,$4,$5::text[],$6,$7,$8::smallint,$9::smallint,NULL,$10)`,
      [claims.tenantId,normalizeOperation(input.operation),input.type??null,input.city??null,input.neighborhoods??(input.neighborhood?[input.neighborhood]:null),
       input.priceMin??null,input.priceMax??null,input.bedroomsMin??null,input.parkingMin??null,input.limit]);
    return result.rows;
  });
  return c.json({ properties: rows });
});
const applySchema = z.object({
  lead: z.object({
    operation: z.string().trim().max(30).nullable().optional(),
    desiredType: z.string().max(100).nullable().optional(), city: z.string().max(120).nullable().optional(),
    neighborhoods: z.array(z.string().max(120)).max(12).nullable().optional(),
    bedroomsMin: z.number().int().min(0).max(30).nullable().optional(), parkingMin: z.number().int().min(0).max(30).nullable().optional(),
    budgetMin: z.number().nonnegative().nullable().optional(), budgetMax: z.number().nonnegative().nullable().optional(),
    qualificationStatus: z.enum(['NOVO','EM_QUALIFICACAO','QUALIFICADO','FRIO','DESQUALIFICADO']).optional(),
    score: z.number().int().min(0).max(100).optional(), summary: z.string().max(6000).nullable().optional()
  }).optional(),
  answers: z.array(z.object({ questionId: z.string().uuid().nullable().optional(), origin: z.enum(['ESSENCIAL','QUALIFICATORIA']).default('ESSENCIAL'),
    question: z.string().min(1).max(1000), answer: z.string().max(4000).nullable().optional() })).max(30).optional(),
  cancelFollowup: z.boolean().optional(),
  handoff: z.object({ reason: z.string().max(500), summary: z.string().max(6000), department: z.string().max(120).nullable().optional() }).optional()
});

internalAgentRoutes.post('/apply', async (c) => {
  const claims = getClaims(c);
  const input = applySchema.parse(await c.req.json());
  const result = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    const { rows } = await db.query(`SELECT lead_id,modo FROM conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [claims.tenantId,claims.conversationId]);
    const conv = rows[0]; if (!conv?.lead_id) return null;
    if (input.lead) {
      const l = input.lead;
      await db.query(`UPDATE leads SET
        operacao=COALESCE($3::operacao,operacao), tipo_desejado=COALESCE($4,tipo_desejado),
        cidade_desejada=COALESCE($5,cidade_desejada), bairros_desejados=COALESCE($6::text[],bairros_desejados),
        quartos_min=COALESCE($7::smallint,quartos_min), vagas_min=COALESCE($8::smallint,vagas_min),
        orcamento_min=COALESCE($9,orcamento_min), orcamento_max=COALESCE($10,orcamento_max),
        status_qualificacao=COALESCE($11::qual_status,status_qualificacao), lead_score=COALESCE($12::smallint,lead_score),
        resumo_ia=COALESCE($13,resumo_ia), updated_at=now()
        WHERE tenant_id=$1 AND id=$2`, [claims.tenantId,conv.lead_id,l.operation??null,l.desiredType??null,l.city??null,
        l.neighborhoods??null,l.bedroomsMin??null,l.parkingMin??null,l.budgetMin??null,l.budgetMax??null,
        l.qualificationStatus??null,l.score??null,l.summary??null]);
    }
    for (const a of input.answers ?? []) {
      await db.query(`INSERT INTO lead_answers (tenant_id,lead_id,question_id,origem,pergunta,resposta)
        VALUES ($1,$2,$3,$4,$5,$6)`, [claims.tenantId,conv.lead_id,a.questionId??null,a.origin,a.question,a.answer??null]);
    }
    if (input.cancelFollowup || input.handoff) {
      await db.query(`UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now()
        WHERE tenant_id=$1 AND lead_id=$2 AND status='PENDENTE' AND tipo IN ('FOLLOWUP','REENGAJAMENTO')`,
        [claims.tenantId,conv.lead_id]);
    }
    if (input.handoff) {
      await db.query(`UPDATE conversations SET status='PENDENTE',modo='MANUAL',estado_maquina='HANDOFF',resumo_ia=$3,updated_at=now()
        WHERE tenant_id=$1 AND id=$2`, [claims.tenantId,claims.conversationId,input.handoff.summary]);
      await db.query(`INSERT INTO notifications (tenant_id,tipo,titulo,corpo,lead_id,conversation_id)
        VALUES ($1,'LEAD_PRONTO','Lead pronto para atendimento humano',$2,$3,$4)`,
        [claims.tenantId,`${input.handoff.reason}\n${input.handoff.summary}`,conv.lead_id,claims.conversationId]);
      await db.query(`INSERT INTO events (tenant_id,lead_id,conversation_id,tipo,payload)
        VALUES ($1,$2,$3,'HANDOFF_IA',$4::jsonb)`,
        [claims.tenantId,conv.lead_id,claims.conversationId,JSON.stringify(input.handoff)]);
    }
    return { leadId: conv.lead_id, mode: input.handoff ? 'MANUAL' : conv.modo };
  });
  if (!result) return c.json({ error: 'lead_not_found' }, 404);
  if (input.handoff) {
    await whatsappQueue.add('crm_dispatch',{tenantId:claims.tenantId,leadId:result.leadId},{removeOnComplete:1000,removeOnFail:1000,attempts:5,backoff:{type:'exponential',delay:5000}});
  }
  return c.json({ ok: true, ...result, crmQueued: Boolean(input.handoff) });
});
function splitMessage(text: string, max: number) {
  if (text.length <= max) return [text];
  const out: string[] = []; let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * .55) cut = rest.lastIndexOf('. ', max);
    if (cut < max * .55) cut = rest.lastIndexOf(' ', max);
    if (cut < 1) cut = max;
    out.push(rest.slice(0, cut + (rest[cut] === '.' ? 1 : 0)).trim());
    rest = rest.slice(cut + (rest[cut] === '.' ? 1 : 0)).trim();
  }
  if (rest) out.push(rest);
  return out;
}

internalAgentRoutes.post('/reply', async (c) => {
  const claims = getClaims(c);
  const { text } = z.object({ text: z.string().trim().min(1).max(8000) }).parse(await c.req.json());
  const target = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    const { rows } = await db.query(`SELECT c.id,c.lead_id,c.modo,c.janela_expira_em,c.whatsapp_account_id,ct.telefone,wa.phone_number_id,wa.access_token_enc,
      COALESCE(ai.tamanho_max_msg,500) AS max_msg FROM conversations c JOIN contacts ct ON ct.id=c.contact_id
      JOIN whatsapp_accounts wa ON wa.id=c.whatsapp_account_id LEFT JOIN ai_config ai ON ai.tenant_id=c.tenant_id
      WHERE c.tenant_id=$1 AND c.id=$2`, [claims.tenantId,claims.conversationId]); return rows[0];
  });
  if (!target) return c.json({ error: 'conversation_not_found' }, 404);
  if (target.modo !== 'IA') return c.json({ ok:true, skipped:'conversation_not_in_ai_mode' });
  if (!target.janela_expira_em || new Date(target.janela_expira_em) <= new Date()) return c.json({ error: 'window_expired' }, 409);
  const accessToken = decryptSecret(target.access_token_enc);
  const chunks = splitMessage(text, Math.max(220, Number(target.max_msg) || 500));
  const sent: Array<{ text: string; wamid?: string }> = [];
  for (const chunk of chunks) {
    const meta = await sendText(target.phone_number_id, accessToken, target.telefone, chunk);
    const wamid = meta.messages?.[0]?.id;
    const mirroredMessage = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
      const { rows } = await db.query(`INSERT INTO messages (tenant_id,conversation_id,direcao,conteudo,tipo,wamid,status,por_ia)
        VALUES ($1,$2,'OUT',$3,'text',$4,'ENVIADA',true) RETURNING id`, [claims.tenantId,claims.conversationId,chunk,wamid]);
      await db.query(`UPDATE conversations SET ultima_msg_em=now(),updated_at=now() WHERE tenant_id=$1 AND id=$2`,
        [claims.tenantId,claims.conversationId]);
      return rows[0];
    });
    if (mirroredMessage?.id) await whatsappQueue.add('chatwoot_mirror_out',{tenantId:claims.tenantId,conversationId:claims.conversationId,messageId:mirroredMessage.id},{jobId:`cw-out:${mirroredMessage.id}`,removeOnComplete:true,removeOnFail:1000,attempts:5,backoff:{type:'exponential',delay:1000}});
    sent.push({ text: chunk, wamid });
  }
  if (target.lead_id) await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    await resetFollowupSchedule(db, claims.tenantId, target.lead_id, claims.conversationId);
  });
  return c.json({ ok: true, sent: sent.length, messages: sent });
});
const handoffSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(6000),
  department: z.string().trim().max(120).nullable().optional(),
  userMessage: z.string().trim().min(1).max(1500)
});

internalAgentRoutes.post('/handoff', async (c) => {
  const claims = getClaims(c);
  const input = handoffSchema.parse(await c.req.json());
  const target = await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    const { rows } = await db.query(`SELECT c.lead_id,c.modo,c.janela_expira_em,ct.telefone,wa.phone_number_id,wa.access_token_enc
      FROM conversations c JOIN contacts ct ON ct.id=c.contact_id JOIN whatsapp_accounts wa ON wa.id=c.whatsapp_account_id
      WHERE c.tenant_id=$1 AND c.id=$2`, [claims.tenantId,claims.conversationId]); return rows[0];
  });
  if (!target?.lead_id) return c.json({ error:'conversation_not_found' },404);
  if (target.modo !== 'IA') return c.json({ ok:true, skipped:'already_manual' });
  if (target.janela_expira_em && new Date(target.janela_expira_em) > new Date()) {
    const accessToken = decryptSecret(target.access_token_enc);
    const meta = await sendText(target.phone_number_id, accessToken, target.telefone, input.userMessage);
    await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
      await db.query(`INSERT INTO messages (tenant_id,conversation_id,direcao,conteudo,tipo,wamid,status,por_ia)
        VALUES ($1,$2,'OUT',$3,'text',$4,'ENVIADA',true)`,
        [claims.tenantId,claims.conversationId,input.userMessage,meta.messages?.[0]?.id]);
    });
  }
  await withTenantTx({ tenantId: claims.tenantId }, async (db) => {
    await db.query(`UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now()
      WHERE tenant_id=$1 AND lead_id=$2 AND status='PENDENTE' AND tipo IN ('FOLLOWUP','REENGAJAMENTO')`, [claims.tenantId,target.lead_id]);
    await db.query(`UPDATE conversations SET status='PENDENTE',modo='MANUAL',estado_maquina='HANDOFF',resumo_ia=$3,updated_at=now()
      WHERE tenant_id=$1 AND id=$2`, [claims.tenantId,claims.conversationId,input.summary]);
    await db.query(`INSERT INTO notifications (tenant_id,tipo,titulo,corpo,lead_id,conversation_id)
      VALUES ($1,'LEAD_PRONTO','Lead pronto para atendimento humano',$2,$3,$4)`,
      [claims.tenantId,`${input.reason}\n${input.summary}`,target.lead_id,claims.conversationId]);
  });
  await whatsappQueue.add('crm_dispatch',{tenantId:claims.tenantId,leadId:target.lead_id},{removeOnComplete:1000,removeOnFail:1000,attempts:5,backoff:{type:'exponential',delay:5000}});
  return c.json({ ok:true, mode:'MANUAL', crmQueued:true });
});

internalAgentRoutes.post('/cancel-followup', async (c) => {
  const claims=getClaims(c); const { reason }=z.object({reason:z.string().max(1000).optional()}).parse(await c.req.json());
  const count=await withTenantTx({tenantId:claims.tenantId},async(db)=>{const q=await db.query(`UPDATE scheduled_jobs SET status='CANCELADO',executado_em=now(),erro=COALESCE($3,erro) WHERE tenant_id=$1 AND lead_id=(SELECT lead_id FROM conversations WHERE id=$2) AND status='PENDENTE' AND tipo IN ('FOLLOWUP','REENGAJAMENTO')`,[claims.tenantId,claims.conversationId,reason??null]);return q.rowCount??0;});
  return c.json({ok:true,cancelled:count});
});
const nullableText = z.union([z.string(),z.null()]).optional().transform(v=>v===''?null:v);
const nullableNumber = z.union([z.number(),z.string(),z.null()]).optional().transform(v=>v===''||v==null?null:Number(v));
const qualifySchema = z.object({
  operation: nullableText, desiredType: nullableText, city: nullableText, neighborhood: nullableText,
  bedroomsMin: nullableNumber, parkingMin: nullableNumber, budgetMin: nullableNumber, budgetMax: nullableNumber,
  qualificationStatus: nullableText, score: nullableNumber, summary: nullableText,
  question: nullableText, answer: nullableText, origin: nullableText
});

internalAgentRoutes.post('/qualify', async (c) => {
  const claims=getClaims(c); const input=qualifySchema.parse(await c.req.json());
  const row=await withTenantTx({tenantId:claims.tenantId},async(db)=>{
    const conv=await db.query(`SELECT lead_id FROM conversations WHERE tenant_id=$1 AND id=$2`,[claims.tenantId,claims.conversationId]);
    const leadId=conv.rows[0]?.lead_id; if(!leadId)return null;
    await db.query(`UPDATE leads SET operacao=COALESCE($3::operacao,operacao),tipo_desejado=COALESCE($4,tipo_desejado),cidade_desejada=COALESCE($5,cidade_desejada),bairros_desejados=CASE WHEN $6::text IS NULL THEN bairros_desejados ELSE ARRAY[$6] END,quartos_min=COALESCE($7::smallint,quartos_min),vagas_min=COALESCE($8::smallint,vagas_min),orcamento_min=COALESCE($9,orcamento_min),orcamento_max=COALESCE($10,orcamento_max),status_qualificacao=COALESCE($11::qual_status,status_qualificacao),lead_score=COALESCE($12::smallint,lead_score),resumo_ia=COALESCE($13,resumo_ia),updated_at=now() WHERE tenant_id=$1 AND id=$2`,[claims.tenantId,leadId,normalizeOperation(input.operation),input.desiredType,input.city,input.neighborhood,input.bedroomsMin,input.parkingMin,input.budgetMin,input.budgetMax,normalizeQualification(input.qualificationStatus),input.score,input.summary]);
    if(input.question) await db.query(`INSERT INTO lead_answers(tenant_id,lead_id,origem,pergunta,resposta) VALUES($1,$2,$3,$4,$5)`,[claims.tenantId,leadId,input.origin||'QUALIFICATORIA',input.question,input.answer]);
    return {leadId};
  });
  if(!row)return c.json({error:'lead_not_found'},404); return c.json({ok:true,...row});
});
