create or replace function agency_ops.manager_attention_recipient_authorized()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, agency_ops, public, extensions
as $$
  select exists (
    select 1
    from agency_ops.user_preferences up
    where up.user_key::text = auth.uid()::text
      and up.collaborator_person in ('Adler Furtado','Joel Antoniete','Gustavo Lima')
  );
$$;

grant execute on function agency_ops.manager_attention_recipient_authorized() to authenticated;

drop policy if exists manager_attention_alerts_select_allowed on agency_ops.manager_attention_alerts;
create policy manager_attention_alerts_select_allowed
on agency_ops.manager_attention_alerts
for select
to authenticated
using (agency_ops.manager_attention_recipient_authorized());

create or replace function agency_ops.manager_attention_alert_action(p_id uuid,p_action text,p_note text default null,p_snoozed_until timestamptz default null)
returns agency_ops.manager_attention_alerts language plpgsql security definer set search_path = pg_catalog, agency_ops, public, extensions as $$
declare
  v_actor text;
  v_row agency_ops.manager_attention_alerts;
  v_action text := upper(trim(coalesce(p_action,'')));
begin
  if not agency_ops.manager_attention_recipient_authorized() then raise exception 'unauthorized'; end if;
  select * into v_row from agency_ops.manager_attention_alerts where id=p_id for update;
  if not found then raise exception 'alert_not_found'; end if;
  v_actor := coalesce(agency_ops.current_authenticated_collaborator_person(), auth.uid()::text);
  if v_action not in ('COBRADO','RESOLVIDO','AGUARDANDO_CLIENTE','PRAZO_COMBINADO','FALSO_POSITIVO') then raise exception 'invalid_action'; end if;
  if v_action in ('AGUARDANDO_CLIENTE','PRAZO_COMBINADO') and p_snoozed_until is null then raise exception 'snoozed_until_required'; end if;
  update agency_ops.manager_attention_alerts
  set status=v_action,action_note=nullif(trim(coalesce(p_note,'')),''),action_by=v_actor,action_at=now(),
      snoozed_until=case when v_action in ('AGUARDANDO_CLIENTE','PRAZO_COMBINADO') then p_snoozed_until else null end,updated_at=now()
  where id=p_id returning * into v_row;
  return v_row;
end; $$;

grant execute on function agency_ops.manager_attention_alert_action(uuid,text,text,timestamptz) to authenticated;