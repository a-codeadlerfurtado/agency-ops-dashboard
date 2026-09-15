-- Central de Operacoes - AI Workspace: indices de cobertura para FKs.
-- Apontado pelo Supabase Performance Advisor (unindexed_foreign_keys) logo apos
-- 20260820123000. Sem esses indices, o ON DELETE SET NULL das FKs message_id
-- precisa varrer a tabela filha inteira a cada mensagem removida.

create index if not exists ai_attachments_message_idx
  on agency_ops.ai_attachments (message_id)
  where message_id is not null;

create index if not exists ai_usage_events_message_idx
  on agency_ops.ai_usage_events (message_id)
  where message_id is not null;
