-- Central de Operacoes - AI Workspace Storage + consistencia
-- Bucket privado para anexos e trigger de consistencia das conversas.

insert into storage.buckets (id, name, public, file_size_limit)
values ('agency-ai-private', 'agency-ai-private', false, 26214400)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

-- Nenhuma policy em storage.objects para este bucket: acesso direto de anon/authenticated
-- fica negado por padrao. Upload/download devem acontecer pelo backend confiavel na Hostinger
-- usando credencial privada do Supabase, ou por URL assinada gerada pelo backend.

create or replace function agency_ops.touch_ai_conversation_from_message()
returns trigger
language plpgsql
security invoker
set search_path = agency_ops, public
as $$
begin
  update agency_ops.ai_conversations
     set updated_at = now(),
         last_message_at = greatest(last_message_at, new.created_at)
   where id = new.conversation_id;
  return new;
end;
$$;

revoke all on function agency_ops.touch_ai_conversation_from_message() from public, anon, authenticated;
grant execute on function agency_ops.touch_ai_conversation_from_message() to service_role;

drop trigger if exists ai_messages_touch_conversation on agency_ops.ai_messages;
create trigger ai_messages_touch_conversation
after insert on agency_ops.ai_messages
for each row execute function agency_ops.touch_ai_conversation_from_message();

create index if not exists ai_messages_user_time_idx
  on agency_ops.ai_messages (user_id, created_at desc)
  where user_id is not null;

create index if not exists ai_attachments_user_time_idx
  on agency_ops.ai_attachments (user_id, created_at desc);

create index if not exists ai_usage_status_time_idx
  on agency_ops.ai_usage_events (status, created_at desc);

comment on function agency_ops.touch_ai_conversation_from_message() is
  'Mantem updated_at/last_message_at da conversa sincronizados quando uma mensagem e persistida.';
