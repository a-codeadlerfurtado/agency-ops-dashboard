-- Customers Success -> lembretes compartilhados no Dashboard (Adler + Joel + Gustavo)
-- Mensagens com sinal de pendencia/acao viram work_items compartilhados com CS.

create or replace function agency_ops.normalize_followup_match_text(p_text text)
returns text language sql immutable set search_path to 'pg_catalog' as $$
  select trim(regexp_replace(
    translate(lower(coalesce(p_text,'')),
      'áàãâäéèêëíìîïóòõôöúùûüçñ',
      'aaaaaeeeeiiiiooooouuuucn'),
    '[^a-z0-9]+',' ','g'));
$$;

create or replace function agency_ops.is_customers_success_followup(p_text text)
returns boolean language plpgsql immutable set search_path to 'pg_catalog' as $$
declare t text := agency_ops.normalize_followup_match_text(p_text);
begin
  if t = '' or length(t) < 12 then return false; end if;
  if t ~ '(tipo de lembrete|exemplo de lembrete|teste de lembrete|dash regist|dashboard regist|como funciona o lembrete)' then return false; end if;
  return t ~ '(precisamos|acompanhar|acompanhamento|ficar em cima|cobrar|lembra|lembrete|ninguem|pendente|faltou|falta|ainda nao|retornar|retorno|ligar|entrar em contato|reuniao|agendar|marcar|confirmar|verificar|checar|prometeu|combinado|ficou de|nao esquecer|atencao)';
end;
$$;

create or replace function agency_ops.match_client_from_followup(p_text text)
returns uuid language plpgsql stable set search_path to 'agency_ops','pg_catalog' as $$
declare
  msg text := agency_ops.normalize_followup_match_text(p_text);
  r record; token text; first_token text; score integer;
  best_score integer := 0; best_id uuid := null; tied boolean := false;
begin
  for r in select id,display_name from agency_ops.clients where lifecycle in ('ACTIVE','ONBOARDING') loop
    score := 0; first_token := null;
    for token in select x from regexp_split_to_table(agency_ops.normalize_followup_match_text(r.display_name),' +') x where x<>'' loop
      if first_token is null then first_token := token; end if;
      if token in ('imoveis','imovel','imobiliaria','incorporadora','construtora','corretora','residencial','residence','empreendimentos','empreendimento') then continue; end if;
      if length(token)>=4 and (' '||msg||' ') like '% '||token||' %' then score := score+2;
      elsif length(token)=3 and (' '||msg||' ') like '% '||token||' %' then score := score+1; end if;
    end loop;
    if first_token is not null and length(first_token) between 2 and 3 and (' '||msg||' ') like '% '||first_token||' %' then score := score+3; end if;
    if score>best_score then best_score:=score; best_id:=r.id; tied:=false;
    elsif score>0 and score=best_score then tied:=true; end if;
  end loop;
  if best_score<=0 or tied then return null; end if;
  return best_id;
end;
$$;

create or replace function agency_ops.capture_customers_success_followup()
returns trigger language plpgsql security definer set search_path to 'agency_ops','pg_catalog','public' as $$
declare
  v_text text; v_person text; v_user_key text; v_client_id uuid; v_client_name text;
  v_priority text; v_title text; v_source_id text;
begin
  if new.chat_id is distinct from '120363430973184382-group' then return new; end if;
  if coalesce(new.is_edit,false) then return new; end if;
  if coalesce(new.event_at,new.received_at,now()) < now()-interval '48 hours' then return new; end if;
  v_text := btrim(coalesce(new.text_body,new.caption,''));
  if not agency_ops.is_customers_success_followup(v_text) then return new; end if;

  select person,auth_user_id::text into v_person,v_user_key
  from agency_ops.team_identity_map
  where regexp_replace(coalesce(whatsapp_phone,''),'\D','','g')=regexp_replace(coalesce(new.sender_phone,''),'\D','','g')
    and person in ('Adler Furtado','Joel Antoniete','Gustavo Lima') limit 1;
  if v_person is null then return new; end if;

  v_source_id := 'whatsapp:'||coalesce(nullif(new.message_id,''),new.id::text);
  if exists(select 1 from agency_ops.work_items where source='customers_success_group' and source_id=v_source_id) then return new; end if;

  v_client_id := agency_ops.match_client_from_followup(v_text);
  if v_client_id is not null then select display_name into v_client_name from agency_ops.clients where id=v_client_id; end if;
  v_priority := case when agency_ops.normalize_followup_match_text(v_text) ~ '(urgente|ninguem|ainda nao|atras|precisamos ficar em cima|nao fez|nao fizeram|nao ligou|nao responder)' then 'HIGH' else 'MEDIUM' end;
  v_title := case when v_client_name is not null then '['||upper(v_client_name)||'] - Acompanhamento CS' else 'Acompanhamento CS - '||left(regexp_replace(v_text,'\s+',' ','g'),110) end;

  insert into agency_ops.work_items(client_id,type,status,priority,title,description,source,source_id,created_by_user_key,created_by_person,target_role,target_person,due_at,metadata)
  values(v_client_id,'CLIENT_FOLLOWUP','OPEN',v_priority,left(v_title,240),v_text,'customers_success_group',v_source_id,v_user_key,v_person,'CS',null,null,
    jsonb_build_object('origin','WHATSAPP_CUSTOMERS_SUCCESS','chat_id',new.chat_id,'chat_name',new.chat_name,'message_id',new.message_id,'sender_phone',new.sender_phone,'sender_name',new.sender_name,'message_at',coalesce(new.event_at,new.received_at,now()),'shared_with',jsonb_build_array('Adler Furtado','Joel Antoniete','Gustavo Lima'),'client_match',case when v_client_id is null then 'UNMATCHED' else 'DETERMINISTIC' end));
  return new;
end;
$$;

drop trigger if exists trg_customers_success_followup on agency_ops.whatsapp_messages;
create trigger trg_customers_success_followup after insert on agency_ops.whatsapp_messages for each row execute function agency_ops.capture_customers_success_followup();

create or replace function agency_ops.scope_customers_success_work_notifications()
returns trigger language plpgsql security definer set search_path to 'agency_ops','pg_catalog','public' as $$
declare
  v_event_key text; v_suffix text; v_target text; v_base agency_ops.platform_notifications%rowtype;
begin
  if new.source is distinct from 'customers_success_group' then return new; end if;
  if tg_op='INSERT' then v_event_key:='work-item-created:'||new.id::text;
  elsif tg_op='UPDATE' and old.status is distinct from new.status and new.status='COMPLETED' then v_event_key:='work-item-completed:'||new.id::text;
  else return new; end if;

  select * into v_base from agency_ops.platform_notifications where event_key=v_event_key limit 1;
  if v_base.id is null then return new; end if;

  update agency_ops.platform_notifications
  set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('private_to_person',true,'target_person','Adler Furtado','customers_success_reminder',true,'origin_chat','Customers Success')
  where id=v_base.id;

  foreach v_target in array array['Joel Antoniete','Gustavo Lima'] loop
    v_suffix:=case v_target when 'Joel Antoniete' then 'joel' else 'gustavo' end;
    insert into agency_ops.platform_notifications(event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,read_at,metadata)
    values(v_event_key||':'||v_suffix,v_base.type,v_base.level,v_base.title,v_base.description,v_base.client_id,v_base.task_id,v_base.source,v_base.actor,v_base.occurred_at,null,
      coalesce(v_base.metadata,'{}'::jsonb)||jsonb_build_object('private_to_person',true,'target_person',v_target,'customers_success_reminder',true,'origin_chat','Customers Success'))
    on conflict(event_key) do nothing;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_zz_customers_success_work_insert on agency_ops.work_items;
create trigger trg_zz_customers_success_work_insert after insert on agency_ops.work_items for each row execute function agency_ops.scope_customers_success_work_notifications();
drop trigger if exists trg_zz_customers_success_work_update on agency_ops.work_items;
create trigger trg_zz_customers_success_work_update after update of status on agency_ops.work_items for each row execute function agency_ops.scope_customers_success_work_notifications();

-- Backfill apenas mensagens recentes que passam pelo mesmo filtro.
insert into agency_ops.work_items(client_id,type,status,priority,title,description,source,source_id,created_by_user_key,created_by_person,target_role,target_person,due_at,metadata)
select m.client_id,'CLIENT_FOLLOWUP','OPEN',m.priority,m.title,m.text_body,'customers_success_group',m.source_id,m.auth_user_id,m.person,'CS',null,null,
  jsonb_build_object('origin','WHATSAPP_CUSTOMERS_SUCCESS','chat_id',m.chat_id,'chat_name',m.chat_name,'message_id',m.message_id,'sender_phone',m.sender_phone,'sender_name',m.sender_name,'message_at',m.event_at,'shared_with',jsonb_build_array('Adler Furtado','Joel Antoniete','Gustavo Lima'),'client_match',case when m.client_id is null then 'UNMATCHED' else 'DETERMINISTIC' end)
from (
  select w.*,tim.person,tim.auth_user_id::text as auth_user_id,agency_ops.match_client_from_followup(w.text_body) as client_id,
    case when agency_ops.normalize_followup_match_text(w.text_body) ~ '(urgente|ninguem|ainda nao|atras|precisamos ficar em cima|nao fez|nao fizeram|nao ligou|nao responder)' then 'HIGH' else 'MEDIUM' end as priority,
    'whatsapp:'||coalesce(nullif(w.message_id,''),w.id::text) as source_id,
    case when agency_ops.match_client_from_followup(w.text_body) is not null then '['||upper((select c.display_name from agency_ops.clients c where c.id=agency_ops.match_client_from_followup(w.text_body)))||'] - Acompanhamento CS' else 'Acompanhamento CS - '||left(regexp_replace(w.text_body,'\s+',' ','g'),110) end as title
  from agency_ops.whatsapp_messages w
  join agency_ops.team_identity_map tim on regexp_replace(coalesce(tim.whatsapp_phone,''),'\D','','g')=regexp_replace(coalesce(w.sender_phone,''),'\D','','g') and tim.person in ('Adler Furtado','Joel Antoniete','Gustavo Lima')
  where w.chat_id='120363430973184382-group' and coalesce(w.is_edit,false)=false and w.event_at>=now()-interval '48 hours' and agency_ops.is_customers_success_followup(w.text_body)
) m
where not exists(select 1 from agency_ops.work_items wi where wi.source='customers_success_group' and wi.source_id=m.source_id);
