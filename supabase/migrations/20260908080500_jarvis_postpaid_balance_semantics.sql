alter table agency_ops.jarvis_client_state
  add column if not exists meta_funding_type integer,
  add column if not exists meta_funding_type_label text,
  add column if not exists meta_payment_display text,
  add column if not exists meta_balance_source text;

create or replace function agency_ops.refresh_jarvis_balance_semantics()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_count integer := 0;
begin
  if auth.uid() is not null then
    select upper(tr.role) into v_role
    from agency_ops.user_preferences up
    join agency_ops.team_roster tr on tr.person = up.collaborator_person and tr.is_former = false
    where up.user_key = auth.uid()::text limit 1;
    if coalesce(v_role,'') <> 'MGMT' then raise exception 'forbidden'; end if;
  end if;

  update agency_ops.jarvis_client_state s
  set meta_funding_type = x.funding_type,
      meta_funding_type_label = x.funding_type_label,
      meta_payment_display = x.payment_display,
      meta_balance_source = x.balance_source
  from (    select b.client_id,
      case when count(distinct b.funding_type)=1 then max(b.funding_type) else null end as funding_type,
      case when count(distinct b.funding_type_label)=1 then max(b.funding_type_label) else null end as funding_type_label,
      max(b.payment_display) as payment_display,
      case when count(distinct b.balance_source)=1 then max(b.balance_source) else null end as balance_source
    from agency_ops.client_balance_overview b
    group by b.client_id
  ) x
  where s.client_id = x.client_id;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'clients', v_count, 'updated_at', now());
end;
$$;

revoke execute on function agency_ops.refresh_jarvis_balance_semantics() from public, anon;
grant execute on function agency_ops.refresh_jarvis_balance_semantics() to authenticated, service_role;

select agency_ops.refresh_jarvis_balance_semantics();
