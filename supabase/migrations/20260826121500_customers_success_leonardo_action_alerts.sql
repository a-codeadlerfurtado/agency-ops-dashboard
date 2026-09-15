create or replace function agency_ops.customers_success_mentions_leonardo_action(p_text text)
returns boolean
language plpgsql
immutable
set search_path to 'pg_catalog'
as $$
declare
  t text := agency_ops.normalize_followup_match_text(p_text);
begin
  if t = '' or position('leonardo' in t)=0 then return false; end if;
  if t !~ '(^|[^a-z0-9])leonardo([^a-z0-9]|$)' then return false; end if;
  return
    t ~ 'leonardo.{0,110}(ira|vai|deve|precisa|ficou de|prometeu|combinou|entrar em contato|ligar|marcar|agendar|realizar|fazer|conduzir|participar|treinar|reuniao|treinamento)'
    or t ~ '(ira|vai|deve|precisa|ficou de|prometeu|combinou).{0,55}leonardo'
    or t ~ '(responsavel|depende).{0,45}leonardo';
end;
$$;

create or replace function agency_ops.scope_customers_success_work_notifications()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops', 'pg_catalog', 'public'
as $$
declare
  v_event_key text;
  v_suffix text;
  v_target text;
  v_base agency_ops.platform_notifications%rowtype;
  v_leonardo_action boolean := false;
  v_targets text[] := array['Joel Antoniete','Gustavo Lima'];
begin
  if new.source is distinct from 'customers_success_group' then return new; end if;

  if tg_op='INSERT' then
    v_event_key := 'work-item-created:'||new.id::text;
  elsif tg_op='UPDATE' and old.status is distinct from new.status and new.status='COMPLETED' then
    v_event_key := 'work-item-completed:'||new.id::text;
  else
    return new;
  end if;

  select * into v_base from agency_ops.platform_notifications where event_key=v_event_key limit 1;
  if v_base.id is null then return new; end if;

  v_leonardo_action := agency_ops.customers_success_mentions_leonardo_action(coalesce(new.description,''));
  if v_leonardo_action then
    v_targets := array_append(v_targets,'Leonardo Augusto');
    update agency_ops.work_items
      set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
        'leonardo_action',true,
        'shared_with',jsonb_build_array('Adler Furtado','Joel Antoniete','Gustavo Lima','Leonardo Augusto')
      )
    where id=new.id and coalesce((metadata->>'leonardo_action')::boolean,false)=false;
  end if;

  update agency_ops.platform_notifications
  set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
      'private_to_person',true,
      'target_person','Adler Furtado',
      'customers_success_reminder',true,
      'origin_chat','Customers Success',
      'leonardo_action',v_leonardo_action
    )
  where id=v_base.id;

  foreach v_target in array v_targets loop
    v_suffix := case v_target
      when 'Joel Antoniete' then 'joel'
      when 'Gustavo Lima' then 'gustavo'
      when 'Leonardo Augusto' then 'leonardo'
      else lower(regexp_replace(v_target,'[^a-zA-Z0-9]+','','g'))
    end;
    insert into agency_ops.platform_notifications(
      event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,read_at,metadata
    ) values (
      v_event_key||':'||v_suffix,
      v_base.type,
      case when v_target='Leonardo Augusto' and tg_op='INSERT' then 'ATTENTION' else v_base.level end,
      case
        when v_target='Leonardo Augusto' and tg_op='INSERT' then 'Ação depende de você: ' || regexp_replace(v_base.title,'^Nova demanda:\s*','','i')
        else v_base.title
      end,
      v_base.description,v_base.client_id,v_base.task_id,
      v_base.source,v_base.actor,v_base.occurred_at,null,
      coalesce(v_base.metadata,'{}'::jsonb) || jsonb_build_object(
        'private_to_person',true,
        'target_person',v_target,
        'customers_success_reminder',true,
        'origin_chat','Customers Success',
        'leonardo_action',v_leonardo_action
      )
    ) on conflict (event_key) do nothing;
  end loop;
  return new;
end;
$$;

-- Backfill do lembrete que motivou a regra.
do $$
declare
  w agency_ops.work_items%rowtype;
  b agency_ops.platform_notifications%rowtype;
begin
  select * into w
  from agency_ops.work_items
  where source='customers_success_group'
    and source_id='whatsapp:3EB0DDFF7373EFCC5017CB'
  limit 1;

  if w.id is not null and agency_ops.customers_success_mentions_leonardo_action(coalesce(w.description,'')) then
    update agency_ops.work_items
    set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object(
      'leonardo_action',true,
      'shared_with',jsonb_build_array('Adler Furtado','Joel Antoniete','Gustavo Lima','Leonardo Augusto')
    ) where id=w.id;

    select * into b from agency_ops.platform_notifications
    where event_key='work-item-created:'||w.id::text limit 1;

    if b.id is not null then
      insert into agency_ops.platform_notifications(
        event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,read_at,metadata
      ) values (
        'work-item-created:'||w.id::text||':leonardo',b.type,'ATTENTION',
        'Ação depende de você: '||regexp_replace(b.title,'^Nova demanda:\s*','','i'),
        b.description,b.client_id,b.task_id,b.source,b.actor,b.occurred_at,null,
        coalesce(b.metadata,'{}'::jsonb)||jsonb_build_object(
          'private_to_person',true,'target_person','Leonardo Augusto',
          'customers_success_reminder',true,'origin_chat','Customers Success','leonardo_action',true
        )
      ) on conflict(event_key) do nothing;
    end if;
  end if;
end $$;