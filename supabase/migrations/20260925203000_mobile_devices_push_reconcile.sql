-- Reconciliacao das duas primeiras iteracoes mobile: uma unica RPC publica
-- autenticada, colunas completas e RLS sem atalho para memberships internas.
alter table imobi_board.mobile_devices
  add column if not exists app_version text,
  add column if not exists device_label text,
  add column if not exists notify_new_leads boolean not null default true;

revoke all on table imobi_board.mobile_devices from anon;
revoke insert, update on table imobi_board.mobile_devices from authenticated;
grant select, delete on table imobi_board.mobile_devices to authenticated;

drop policy if exists mobile_devices_select_own on imobi_board.mobile_devices;
create policy mobile_devices_select_own on imobi_board.mobile_devices
for select to authenticated using (
  user_id=(select auth.uid())
  and exists (
    select 1 from imobi_board.memberships m
    where m.user_id=(select auth.uid())
      and m.tenant_id=mobile_devices.tenant_id
      and m.status='ACTIVE' and not m.is_internal
  )
);
drop policy if exists mobile_devices_update_own on imobi_board.mobile_devices;
drop policy if exists mobile_devices_delete_own on imobi_board.mobile_devices;
create policy mobile_devices_delete_own on imobi_board.mobile_devices
for delete to authenticated using (
  user_id=(select auth.uid())
  and exists (
    select 1 from imobi_board.memberships m
    where m.user_id=(select auth.uid())
      and m.tenant_id=mobile_devices.tenant_id
      and m.status='ACTIVE' and not m.is_internal
  )
);

drop function if exists imobi_board.registrar_dispositivo_mobile(text,text,uuid);
drop function if exists imobi_board.registrar_dispositivo_mobile(text,text,uuid,text,text);
drop function if exists imobi_board.desregistrar_dispositivo_mobile(text);

create function imobi_board.registrar_dispositivo_mobile(
  p_token text,
  p_plataforma text,
  p_tenant uuid,
  p_app_version text,
  p_device_label text
) returns uuid
language plpgsql security definer set search_path=''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Sessao obrigatoria.' using errcode='42501';
  end if;
  v_tenant := imobi_board_priv.resolve_member_tenant(p_tenant);
  if not exists (
    select 1 from imobi_board.memberships m
    where m.user_id=v_uid and m.tenant_id=v_tenant
      and m.status='ACTIVE' and not m.is_internal
  ) then
    raise exception 'Membership interna nao registra push de cliente.'
      using errcode='42501';
  end if;
  if lower(coalesce(p_plataforma,'')) not in ('ios','android') then
    raise exception 'Plataforma invalida.' using errcode='22023';
  end if;
  if length(btrim(coalesce(p_token,''))) < 16 then
    raise exception 'Token push invalido.' using errcode='22023';
  end if;

  insert into imobi_board.mobile_devices(
    user_id,tenant_id,platform,push_token,app_version,device_label,
    enabled,last_seen_at,updated_at
  ) values (
    v_uid,v_tenant,lower(p_plataforma),btrim(p_token),
    nullif(btrim(p_app_version),''),
    nullif(btrim(p_device_label),''),
    true,now(),now()
  )
  on conflict (platform,push_token) do update set
    user_id=excluded.user_id,tenant_id=excluded.tenant_id,
    app_version=excluded.app_version,device_label=excluded.device_label,
    enabled=true,last_seen_at=now(),updated_at=now()
  returning id into v_id;
  return v_id;
end;
$function$;

revoke all on function imobi_board.registrar_dispositivo_mobile(text,text,uuid,text,text)
  from public, anon, service_role;
grant execute on function imobi_board.registrar_dispositivo_mobile(text,text,uuid,text,text)
  to authenticated;

revoke all on function imobi_board.desativar_dispositivo_mobile(text,text)
  from public, anon, service_role;
grant execute on function imobi_board.desativar_dispositivo_mobile(text,text)
  to authenticated;
create or replace function imobi_board.push_payload_novo_lead(
  p_opportunity_id uuid
) returns jsonb
language plpgsql stable security definer set search_path=''
as $function$
declare
  v_tenant uuid; v_assigned uuid; v_nome text; v_produto text; v_devices jsonb;
begin
  select o.tenant_id,o.assigned_user_id,c.full_name,
         coalesce(o.source_detail,o.campaign_name,'Lead imobiliario')
    into v_tenant,v_assigned,v_nome,v_produto
  from imobi_board.opportunities o
  join imobi_board.contacts c on c.id=o.contact_id
  where o.id=p_opportunity_id;
  if v_tenant is null then
    raise exception 'Lead nao encontrado.' using errcode='P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'token',d.push_token,'platform',d.platform,'user_id',d.user_id
  ) order by d.created_at),'[]'::jsonb)
  into v_devices
  from imobi_board.mobile_devices d
  join imobi_board.memberships m
    on m.tenant_id=d.tenant_id and m.user_id=d.user_id
  where d.tenant_id=v_tenant and d.enabled and d.notify_new_leads
    and m.status='ACTIVE' and not m.is_internal
    and (m.role='ADMIN' or d.user_id=v_assigned);

  return jsonb_build_object(
    'tenant_id',v_tenant,'opportunity_id',p_opportunity_id,
    'title','Novo lead: ' || coalesce(v_nome,'Sem nome'),
    'body',coalesce(v_produto,'Novo lead recebido no ImobiBoard'),
    'url','imobiboard://lead/' || p_opportunity_id::text,
    'devices',v_devices
  );
end;
$function$;

revoke all on function imobi_board.push_payload_novo_lead(uuid)
  from public, anon, authenticated;
grant execute on function imobi_board.push_payload_novo_lead(uuid)
  to service_role;
