-- ImobiBoard mobile: dispositivos push com isolamento por tenant.
-- Tokens ficam no banco; o app autenticado registra somente o proprio aparelho.
create table if not exists imobi_board.mobile_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references imobi_board.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('android','ios')),
  push_token text not null,
  enabled boolean not null default true,
  notify_new_leads boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, push_token)
);

create index if not exists mobile_devices_user_idx
  on imobi_board.mobile_devices (user_id, tenant_id)
  where enabled;

alter table imobi_board.mobile_devices enable row level security;
grant select, delete on imobi_board.mobile_devices to authenticated;
drop policy if exists mobile_devices_select_own on imobi_board.mobile_devices;
create policy mobile_devices_select_own on imobi_board.mobile_devices
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists mobile_devices_delete_own on imobi_board.mobile_devices;
create policy mobile_devices_delete_own on imobi_board.mobile_devices
  for delete to authenticated
  using (user_id = (select auth.uid()));

create or replace function imobi_board.registrar_dispositivo_mobile(
  p_token text,
  p_plataforma text,
  p_tenant uuid
) returns uuid
language plpgsql security definer set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode='28000';
  end if;
  v_tenant := imobi_board_priv.resolve_member_tenant(p_tenant);

  -- Membership interna de Master nao vira assinatura de push de cliente.
  if not exists (
    select 1 from imobi_board.memberships m
    where m.user_id=v_uid and m.tenant_id=v_tenant
      and m.status='ACTIVE' and not m.is_internal
  ) then
    raise exception 'Acesso mobile indisponivel para membership interna.'
      using errcode='42501';
  end if;

  if lower(coalesce(p_plataforma,'')) not in ('android','ios') then
    raise exception 'Plataforma mobile invalida.' using errcode='P0001';
  end if;
  if length(btrim(coalesce(p_token,''))) < 16 then
    raise exception 'Token push invalido.' using errcode='P0001';
  end if;

  insert into imobi_board.mobile_devices
    (tenant_id,user_id,platform,push_token,enabled,last_seen_at,updated_at)
  values
    (v_tenant,v_uid,lower(p_plataforma),btrim(p_token),true,now(),now())
  on conflict (platform,push_token) do update
    set tenant_id=excluded.tenant_id,user_id=excluded.user_id,
        enabled=true,last_seen_at=now(),updated_at=now()
  returning id into v_id;

  return v_id;
end;
$function$;
create or replace function imobi_board.desregistrar_dispositivo_mobile(
  p_token text
) returns void
language sql security definer set search_path = ''
as $function$
  update imobi_board.mobile_devices
     set enabled=false,updated_at=now()
   where user_id=(select auth.uid()) and push_token=btrim(p_token);
$function$;

revoke all on function imobi_board.registrar_dispositivo_mobile(text,text,uuid)
  from public, anon;
grant execute on function imobi_board.registrar_dispositivo_mobile(text,text,uuid)
  to authenticated;
revoke all on function imobi_board.desregistrar_dispositivo_mobile(text)
  from public, anon;
grant execute on function imobi_board.desregistrar_dispositivo_mobile(text)
  to authenticated;

create or replace function imobi_board.push_payload_novo_lead(
  p_opportunity_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $function$
declare
  v_tenant uuid;
  v_assigned uuid;
  v_nome text;
  v_produto text;
  v_devices jsonb;
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
    'tenant_id',v_tenant,
    'opportunity_id',p_opportunity_id,
    'title','Novo lead: ' || coalesce(v_nome,'Sem nome'),
    'body',coalesce(v_produto,'Novo lead recebido no ImobiBoard'),
    'url','imobiboard://lead/' || p_opportunity_id::text,
    'devices',v_devices
  );
end;
$function$;

-- Somente o Worker com service role consulta os destinos de push.
revoke all on function imobi_board.push_payload_novo_lead(uuid)
  from public, anon, authenticated;
grant execute on function imobi_board.push_payload_novo_lead(uuid)
  to service_role;

comment on table imobi_board.mobile_devices is
  'Tokens de push dos apps Android/iOS; sempre vinculados a usuario e tenant ativos.';
