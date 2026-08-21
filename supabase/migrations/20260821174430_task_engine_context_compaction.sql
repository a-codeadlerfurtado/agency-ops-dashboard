-- Mantem busca no corpus inteiro do WhatsApp, mas entrega ao modelo somente o
-- contexto mais relevante. Evita timeout sem perder a capacidade de cruzar todo
-- o historico do cliente.

create or replace function agency_ops.task_engine_context_v2(
  p_client_id uuid,
  p_chat_id text,
  p_excerpt text,
  p_event_created_at timestamptz default now()
)
returns jsonb
language sql
stable
set search_path to 'pg_catalog', 'agency_ops', 'public', 'extensions'
as $$
with
cliente as (
  select c.id, c.display_name, c.lifecycle, c.service, c.cs_owner, c.gt_owner, c.designer_owner,
         c.entrada, c.metadata
  from agency_ops.clients c
  where c.id = p_client_id
),
chats as (
  select p_chat_id as chat_id where p_chat_id is not null
  union
  select ci.external_id
  from agency_ops.client_integrations ci
  where ci.client_id = p_client_id
    and ci.system ilike 'WHATSAPP%'
    and ci.external_id is not null
  union
  select cs.chat_id
  from agency_ops.conversation_state cs
  where cs.client_id = p_client_id
),
raw_terms as (
  select distinct w as term
  from regexp_split_to_table(lower(extensions.unaccent(coalesce(p_excerpt,''))), '[^a-z0-9]+') w
  where length(w) >= 4
    and w not in ('para','pela','pelo','pelos','pelas','como','mais','isso','essa','esse','esta','este','aqui','ali','onde','quando','entao','tambem','cliente','grupo','time','equipe','agencia','pode','precisa','precisamos','favor')
  limit 24
),
query_text as (
  select string_agg(term || ':*', ' | ') as q from raw_terms
),
query_obj as (
  select case when q is null or q = '' then null else to_tsquery('simple', q) end as q
  from query_text
),
recent_msgs as (
  select wm.id, wm.message_id, wm.chat_id, wm.chat_name, wm.sender_name, wm.sender_phone,
         wm.from_me, coalesce(nullif(wm.text_body,''), nullif(wm.caption,'')) as body,
         coalesce(wm.event_at, wm.received_at) as occurred_at
  from agency_ops.whatsapp_messages wm
  join chats c on c.chat_id = wm.chat_id
  where coalesce(nullif(wm.text_body,''), nullif(wm.caption,'')) is not null
  order by coalesce(wm.event_at, wm.received_at) desc
  limit 20
),
event_msgs as (
  select wm.id, wm.message_id, wm.chat_id, wm.chat_name, wm.sender_name, wm.sender_phone,
         wm.from_me, coalesce(nullif(wm.text_body,''), nullif(wm.caption,'')) as body,
         coalesce(wm.event_at, wm.received_at) as occurred_at
  from agency_ops.whatsapp_messages wm
  where wm.chat_id = p_chat_id
    and coalesce(nullif(wm.text_body,''), nullif(wm.caption,'')) is not null
    and coalesce(wm.event_at, wm.received_at)
        between p_event_created_at - interval '20 minutes' and p_event_created_at + interval '20 minutes'
  order by coalesce(wm.event_at, wm.received_at) asc
  limit 80
),
relevant_msgs as (
  select x.*
  from (
    select wm.id, wm.message_id, wm.chat_id, wm.chat_name, wm.sender_name, wm.sender_phone,
           wm.from_me, coalesce(nullif(wm.text_body,''), nullif(wm.caption,'')) as body,
           coalesce(wm.event_at, wm.received_at) as occurred_at,
           case when qo.q is null then 0::real
                else ts_rank_cd(
                  to_tsvector('simple', extensions.unaccent(coalesce(wm.text_body,'') || ' ' || coalesce(wm.caption,''))),
                  qo.q
                ) end as relevance
    from agency_ops.whatsapp_messages wm
    join chats c on c.chat_id = wm.chat_id
    cross join query_obj qo
    where coalesce(nullif(wm.text_body,''), nullif(wm.caption,'')) is not null
      and (
        qo.q is null
        or to_tsvector('simple', extensions.unaccent(coalesce(wm.text_body,'') || ' ' || coalesce(wm.caption,''))) @@ qo.q
      )
    order by relevance desc, coalesce(wm.event_at, wm.received_at) desc
    limit 20
  ) x
),
briefing as (
  select n.notion_page_id, n.title, n.page_url, n.notion_last_edited_at, n.last_fetched_at,
         n.extracted_profile,
         left(coalesce(n.content_markdown,''), 8000) as content_markdown
  from agency_ops.notion_briefing_pages n
  where n.client_id = p_client_id
  order by n.notion_last_edited_at desc nulls last, n.updated_at desc
  limit 1
),
semantic as (
  select s.current_subject, s.today_summary, s.client_requests, s.team_actions, s.deliveries,
         s.decisions, s.approvals, s.pending_items, s.next_steps, s.blockers, s.complaints,
         s.promises, s.confidence, s.processed_at
  from agency_ops.conversation_semantic_state s
  where (p_chat_id is not null and s.chat_id = p_chat_id) or s.client_id = p_client_id
  order by s.processed_at desc
  limit 1
),
state as (
  select cs.chat_id, cs.last_client_message_at, cs.last_team_message_at, cs.waiting_for_agency,
         cs.waiting_for_client, cs.open_question, cs.conversation_status, cs.sla_level,
         cs.last_intent, cs.last_summary, cs.updated_at
  from agency_ops.conversation_state cs
  where (p_chat_id is not null and cs.chat_id = p_chat_id) or cs.client_id = p_client_id
  order by cs.updated_at desc
  limit 1
),
integracoes as (
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'system', ci.system,
    'external_id', ci.external_id,
    'external_name', ci.external_name,
    'is_primary', ci.is_primary,
    'confidence', ci.confidence,
    'metadata', ci.metadata,
    'created_at', ci.created_at
  )) order by ci.is_primary desc nulls last, ci.created_at desc) as items
  from agency_ops.client_integrations ci
  where ci.client_id = p_client_id
),
open_tasks as (
  select jsonb_agg(jsonb_build_object(
    'task_id', k.task_id,
    'name', k.name,
    'status', k.status,
    'assignees', k.assignee_names,
    'due_date', k.due_date,
    'date_created', k.date_created
  ) order by k.date_created desc) as items
  from (
    select *
    from agency_ops.clickup_tasks k2
    where k2.client_id = p_client_id and not coalesce(k2.is_closed,false)
    order by k2.date_created desc
    limit 15
  ) k
)
select jsonb_strip_nulls(jsonb_build_object(
  'cliente', (select to_jsonb(cliente) from cliente),
  'briefing_notion', (select to_jsonb(briefing) from briefing),
  'integracoes', (select items from integracoes),
  'conversa_semantica', (select to_jsonb(semantic) from semantic),
  'estado_conversa', (select to_jsonb(state) from state),
  'tasks_abertas', (select items from open_tasks),
  'mensagens_evento', (select coalesce(jsonb_agg(to_jsonb(event_msgs) order by occurred_at asc), '[]'::jsonb) from event_msgs),
  'mensagens_relevantes_historico', (select coalesce(jsonb_agg(to_jsonb(relevant_msgs) order by relevance desc, occurred_at desc), '[]'::jsonb) from relevant_msgs),
  'mensagens_recentes', (select coalesce(jsonb_agg(to_jsonb(recent_msgs) order by occurred_at desc), '[]'::jsonb) from recent_msgs),
  'historico_search', jsonb_build_object(
    'scope', 'todos_os_grupos_whatsapp_vinculados_ao_cliente',
    'strategy', 'busca_no_corpus_inteiro_com_recuperacao_dos_20_trechos_mais_relevantes_e_20_mais_recentes',
    'query_excerpt', left(coalesce(p_excerpt,''), 2000),
    'terms', (select coalesce(jsonb_agg(term), '[]'::jsonb) from raw_terms)
  )
));
$$;

revoke all on function agency_ops.task_engine_context_v2(uuid,text,text,timestamptz) from public, anon, authenticated;
