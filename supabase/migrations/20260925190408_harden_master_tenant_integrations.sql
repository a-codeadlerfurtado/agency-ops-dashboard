-- ImobiBoard multi-tenant hardening migration

create or replace function imobi_board_priv.resolve_admin_tenant(p_tenant uuid default null)
returns uuid
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode='28000';
  end if;

  if p_tenant is not null then
    if not exists (
      select 1
      from imobi_board.memberships m
      where m.user_id=v_uid
        and m.tenant_id=p_tenant
        and m.status='ACTIVE'
        and m.role='ADMIN'
        and (not m.is_internal or imobi_board_priv.e_master())
    ) then
      raise exception 'Voce nao tem permissao para administrar esta imobiliaria.' using errcode='42501';
    end if;
    return p_tenant;
  end if;

  select count(distinct m.tenant_id)
    into v_count
  from imobi_board.memberships m
  where m.user_id=v_uid
    and m.status='ACTIVE'
    and m.role='ADMIN'
    and not m.is_internal;

  if v_count = 1 then
    select m.tenant_id
      into v_tenant
    from imobi_board.memberships m
    where m.user_id=v_uid
      and m.status='ACTIVE'
      and m.role='ADMIN'
      and not m.is_internal
    limit 1;
    return v_tenant;
  end if;

  if imobi_board_priv.e_master() then
    raise exception 'No Modo Master, selecione explicitamente a imobiliaria.' using errcode='P0001';
  end if;

  raise exception 'Conta sem imobiliaria administrativa ativa.' using errcode='42501';
end;
$function$;

revoke all on function imobi_board_priv.resolve_admin_tenant(uuid) from public, anon, authenticated;

create or replace function imobi_board_priv.resolve_member_tenant(p_tenant uuid default null)
returns uuid
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Sessao invalida.' using errcode='28000';
  end if;

  if p_tenant is not null then
    if not exists (
      select 1 from imobi_board.memberships m
      where m.user_id=v_uid and m.tenant_id=p_tenant and m.status='ACTIVE'
        and (not m.is_internal or imobi_board_priv.e_master())
    ) then
      raise exception 'Voce nao pertence a esta imobiliaria.' using errcode='42501';
    end if;
    return p_tenant;
  end if;

  select count(distinct m.tenant_id) into v_count
  from imobi_board.memberships m
  where m.user_id=v_uid and m.status='ACTIVE' and not m.is_internal;

  if v_count = 1 then
    select m.tenant_id into v_tenant
    from imobi_board.memberships m
    where m.user_id=v_uid and m.status='ACTIVE' and not m.is_internal
    limit 1;
    return v_tenant;
  end if;

  if imobi_board_priv.e_master() then
    raise exception 'No Modo Master, selecione explicitamente a imobiliaria.' using errcode='P0001';
  end if;

  raise exception 'Conta sem imobiliaria ativa.' using errcode='42501';
end;
$function$;

revoke all on function imobi_board_priv.resolve_member_tenant(uuid) from public, anon, authenticated;

create unique index if not exists memberships_one_active_external_tenant_per_user
on imobi_board.memberships(user_id)
where status='ACTIVE' and not is_internal;

create or replace function imobi_board_priv.current_tenant_ids()
returns uuid[]
language sql
stable security definer
set search_path to ''
as $function$
  select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'ACTIVE'
    and (not m.is_internal or imobi_board_priv.e_master())
    and not exists (
      select 1 from imobi_board.assinaturas a
      where a.tenant_id = m.tenant_id and a.status = 'BLOQUEADA'
    );
$function$;

revoke all on function imobi_board_priv.current_tenant_ids() from public, anon;
grant execute on function imobi_board_priv.current_tenant_ids() to authenticated;

create or replace function imobi_board_priv.admin_tenant_ids()
returns uuid[]
language sql
stable security definer
set search_path to ''
as $function$
  select coalesce(array_agg(m.tenant_id), '{}'::uuid[])
  from imobi_board.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'ACTIVE'
    and m.role = 'ADMIN'
    and (not m.is_internal or imobi_board_priv.e_master())
    and not exists (
      select 1 from imobi_board.assinaturas a
      where a.tenant_id = m.tenant_id and a.status = 'BLOQUEADA'
    );
$function$;

revoke all on function imobi_board_priv.admin_tenant_ids() from public, anon;
grant execute on function imobi_board_priv.admin_tenant_ids() to authenticated;

-- Meta / lead integrations: Master must always supply the selected tenant.
create or replace function imobi_board.fontes_de_lead(p_tenant_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_tenant uuid := imobi_board_priv.resolve_admin_tenant(p_tenant_id);
  v_r jsonb;
begin
  select coalesce(jsonb_agg(x order by x->>'created_at'), '[]'::jsonb)
    into v_r
  from (
    select jsonb_build_object(
      'id', s.id,
      'integration', s.integration,
      'label', s.label,
      'queue_id', s.queue_id,
      'queue_nome', q.name,
      'active', s.active,
      'last_used_at', s.last_used_at,
      'created_at', s.created_at,
      'last_error', s.last_error,
      'last_error_at', s.last_error_at,
      'page_id', s.page_id,
      'tem_token_da_pagina', s.page_access_token is not null,
      'leads', (
        select count(*) from imobi_board.opportunities o
        where o.tenant_id=s.tenant_id
          and o.source=s.integration
          and o.source_detail=s.label
      )
    ) x
    from imobi_board.ingest_sources s
    left join imobi_board.lead_queues q on q.id=s.queue_id
    where s.tenant_id=v_tenant
  ) z;
  return v_r;
end;
$function$;

create or replace function imobi_board.fontes_de_lead()
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  select imobi_board.fontes_de_lead(imobi_board_priv.resolve_admin_tenant(null));
$function$;

create or replace function imobi_board.criar_fonte(
  p_tenant_id uuid,
  p_integration text,
  p_label text,
  p_queue_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid := imobi_board_priv.resolve_admin_tenant(p_tenant_id);
  v_token text;
  v_id uuid;
begin
  if p_integration not in ('META_ADS','GOOGLE_ADS','SITE','WEBHOOK') then
    raise exception 'Integracao nao suportada.' using errcode='P0001';
  end if;
  if coalesce(btrim(p_label),'')='' then
    raise exception 'De um nome para a conexao.' using errcode='P0001';
  end if;
  if p_queue_id is not null and not exists (
    select 1 from imobi_board.lead_queues q
    where q.id=p_queue_id and q.tenant_id=v_tenant
  ) then
    raise exception 'Fila nao pertence a esta imobiliaria.' using errcode='42501';
  end if;

  v_token := encode(extensions.gen_random_bytes(24),'hex');
  insert into imobi_board.ingest_sources
    (tenant_id,integration,label,token_sha256,queue_id)
  values
    (v_tenant,p_integration,btrim(p_label),
     encode(extensions.digest(v_token,'sha256'),'hex'),p_queue_id)
  returning id into v_id;

  perform imobi_board_priv.emit_event(
    v_tenant,'ingest_source.created','ingest_source',v_id,
    jsonb_build_object('integration',p_integration,'label',p_label)
  );
  return jsonb_build_object('id',v_id,'token',v_token);
end;
$function$;

create or replace function imobi_board.criar_fonte(
  p_integration text, p_label text, p_queue_id uuid default null
)
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select imobi_board.criar_fonte(
    imobi_board_priv.resolve_admin_tenant(null),
    p_integration,p_label,p_queue_id
  );
$function$;

create or replace function imobi_board.iniciar_conexao_meta(
  p_tenant_id uuid,
  p_finalidade text default 'CONECTAR',
  p_ref_id uuid default null
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid := imobi_board_priv.resolve_admin_tenant(p_tenant_id);
  v_state text;
begin
  v_state := encode(extensions.gen_random_bytes(24),'hex');
  insert into imobi_board.meta_estados(state,tenant_id,user_id,finalidade,ref_id)
  values(v_state,v_tenant,v_uid,p_finalidade,p_ref_id);
  return v_state;
end;
$function$;

create or replace function imobi_board.iniciar_conexao_meta(
  p_finalidade text default 'CONECTAR',
  p_ref_id uuid default null
)
returns text
language sql
security definer
set search_path to ''
as $function$
  select imobi_board.iniciar_conexao_meta(
    imobi_board_priv.resolve_admin_tenant(null),
    p_finalidade,p_ref_id
  );
$function$;

create or replace function imobi_board.paginas_da_meta(p_tenant_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_tenant uuid := imobi_board_priv.resolve_admin_tenant(p_tenant_id);
  v_r jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'page_id',p.page_id,
    'page_name',p.page_name,
    'descoberta_em',p.descoberta_em
  ) order by p.page_name),'[]'::jsonb)
  into v_r
  from imobi_board.meta_paginas p
  where p.tenant_id=v_tenant;
  return v_r;
end;
$function$;

create or replace function imobi_board.paginas_da_meta()
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  select imobi_board.paginas_da_meta(imobi_board_priv.resolve_admin_tenant(null));
$function$;

create or replace function imobi_board.situacao_do_token_de_sistema(p_tenant_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_tenant uuid := imobi_board_priv.resolve_admin_tenant(p_tenant_id);
  v_out jsonb;
begin
  select coalesce(
    (
      select jsonb_build_object('tem',true,'atualizado_em',t.atualizado_em)
      from imobi_board.meta_tokens_de_sistema t
      where t.tenant_id=v_tenant
      limit 1
    ),
    jsonb_build_object('tem',false)
  ) into v_out;
  return v_out;
end;
$function$;

create or replace function imobi_board.situacao_do_token_de_sistema()
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  select imobi_board.situacao_do_token_de_sistema(
    imobi_board_priv.resolve_admin_tenant(null)
  );
$function$;

create or replace function imobi_board.salvar_token_de_sistema(
  p_tenant_id uuid,
  p_token text
)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid := imobi_board_priv.resolve_admin_tenant(p_tenant_id);
  v_state text;
begin
  if coalesce(btrim(p_token),'')='' then
    raise exception 'Token vazio.' using errcode='P0001';
  end if;

  insert into imobi_board.meta_tokens_de_sistema(tenant_id,token,atualizado_por)
  values(v_tenant,btrim(p_token),v_uid)
  on conflict(tenant_id) do update
    set token=excluded.token,
        atualizado_em=now(),
        atualizado_por=excluded.atualizado_por;

  v_state := encode(extensions.gen_random_bytes(24),'hex');
  insert into imobi_board.meta_estados(state,tenant_id,user_id,finalidade)
  values(v_state,v_tenant,v_uid,'SISTEMA');
  return v_state;
end;
$function$;

create or replace function imobi_board.salvar_token_de_sistema(p_token text)
returns text
language sql
security definer
set search_path to ''
as $function$
  select imobi_board.salvar_token_de_sistema(
    imobi_board_priv.resolve_admin_tenant(null),p_token
  );
$function$;

create or replace function imobi_board.conectar_pagina(
  p_tenant_id uuid,
  p_page_id text,
  p_label text default null,
  p_queue_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid := imobi_board_priv.resolve_admin_tenant(p_tenant_id);
  v_p imobi_board.meta_paginas%rowtype;
  v_id uuid;
  v_token text;
  v_nonce text;
begin
  select * into v_p
  from imobi_board.meta_paginas
  where tenant_id=v_tenant and page_id=p_page_id;

  if not found then
    raise exception 'Pagina nao encontrada. Refaca a conexao com o Facebook.' using errcode='P0002';
  end if;

  if p_queue_id is not null and not exists(
    select 1 from imobi_board.lead_queues q
    where q.id=p_queue_id and q.tenant_id=v_tenant
  ) then
    raise exception 'Fila nao pertence a esta imobiliaria.' using errcode='42501';
  end if;
  select id into v_id
  from imobi_board.ingest_sources
  where tenant_id=v_tenant and page_id=p_page_id
  limit 1;

  if v_id is null then
    v_token := encode(extensions.gen_random_bytes(24),'hex');
    insert into imobi_board.ingest_sources
      (tenant_id,integration,label,token_sha256,queue_id,page_id,page_name,page_access_token)
    values
      (v_tenant,'META_ADS',coalesce(nullif(btrim(p_label),''),v_p.page_name),
       encode(extensions.digest(v_token,'sha256'),'hex'),p_queue_id,
       v_p.page_id,v_p.page_name,v_p.page_access_token)
    returning id into v_id;
  else
    update imobi_board.ingest_sources
       set label=coalesce(nullif(btrim(p_label),''),label),
           queue_id=coalesce(p_queue_id,queue_id),
           page_access_token=v_p.page_access_token,
           page_name=v_p.page_name,
           active=true,last_error=null,last_error_at=null
     where id=v_id and tenant_id=v_tenant;
  end if;

  v_nonce := encode(extensions.gen_random_bytes(24),'hex');
  insert into imobi_board.meta_estados(state,tenant_id,user_id,finalidade,ref_id)
  values(v_nonce,v_tenant,v_uid,'ASSINAR',v_id);
  perform imobi_board_priv.emit_event(
    v_tenant,'ingest_source.connected','ingest_source',v_id,
    jsonb_build_object('page_id',v_p.page_id,'page_name',v_p.page_name)
  );

  return jsonb_build_object('id',v_id,'nonce',v_nonce,'page_name',v_p.page_name);
end;
$function$;

create or replace function imobi_board.conectar_pagina(
  p_page_id text,
  p_label text default null,
  p_queue_id uuid default null
)
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select imobi_board.conectar_pagina(
    imobi_board_priv.resolve_admin_tenant(null),
    p_page_id,p_label,p_queue_id
  );
$function$;

-- Global tenant administration is Master-only at the backend.
create or replace function imobi_board.imobiliarias()
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare v_r jsonb;
begin
  if not imobi_board_priv.e_master() then
    raise exception 'Acesso exclusivo do Master.' using errcode='42501';
  end if;

  select coalesce(jsonb_agg(x order by x->>'criada_em' desc),'[]'::jsonb)
  into v_r
  from (
    select jsonb_build_object(
      'id',t.id,'nome',t.name,'slug',t.slug,'criada_em',t.created_at,
      'membros',(
        select count(*) from imobi_board.memberships m
        where m.tenant_id=t.id and m.status='ACTIVE' and not m.is_internal
      ),
      'leads',(select count(*) from imobi_board.opportunities o where o.tenant_id=t.id),
      'filas',(select count(*) from imobi_board.lead_queues q where q.tenant_id=t.id),
      'convites_pendentes',(
        select count(*) from imobi_board.invites i
        where i.tenant_id=t.id and i.accepted_at is null and i.revoked_at is null
      )
    ) x
    from imobi_board.tenants t
  ) s;
  return v_r;
end;
$function$;

create or replace function imobi_board.criar_imobiliaria(
  p_nome text,
  p_email_admin text,
  p_slug text default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_slug text;
  v_base text;
  v_n int := 1;
  v_tenant uuid;
  v_pipe uuid;
  v_fila uuid;
  v_email text := imobi_board_priv.normalize_email(p_email_admin);
  v_token text;
begin
  if not imobi_board_priv.e_master() then
    raise exception 'Acesso exclusivo do Master.' using errcode='42501';
  end if;
  if coalesce(btrim(p_nome),'')='' then
    raise exception 'Informe o nome da imobiliaria.' using errcode='P0001';
  end if;
  if v_email is null or v_email !~ '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' then
    raise exception 'E-mail do administrador invalido.' using errcode='P0001';
  end if;

  v_base := coalesce(nullif(btrim(p_slug), ''), btrim(p_nome));
  v_base := lower(translate(
    v_base,
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'
  ));
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
  v_base := trim(both '-' from v_base);
  if v_base = '' then v_base := 'imobiliaria'; end if;

  v_slug := v_base;
  while exists (select 1 from imobi_board.tenants t where t.slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;

  insert into imobi_board.tenants (name, slug)
  values (btrim(p_nome), v_slug)
  returning id into v_tenant;

  insert into imobi_board.pipelines (tenant_id, name, is_default)
  values (v_tenant, 'Funil padrao', true)
  returning id into v_pipe;

  insert into imobi_board.pipeline_stages
    (tenant_id, pipeline_id, name, kind, sort_order)
  values
    (v_tenant, v_pipe, 'Novo',        'NEW',        0),
    (v_tenant, v_pipe, 'Contatado',   'CONTACTED',  1),
    (v_tenant, v_pipe, 'Qualificado', 'QUALIFIED',  2),
    (v_tenant, v_pipe, 'Visita',      'VISIT',      3),
    (v_tenant, v_pipe, 'Proposta',    'PROPOSAL',   4),
    (v_tenant, v_pipe, 'Venda',       'WON',        5);

  insert into imobi_board.lead_queues
    (tenant_id, name, status, acceptance_timeout_seconds, timezone)
  values (v_tenant, 'Atendimento', 'ACTIVE', 300, 'America/Sao_Paulo')
  returning id into v_fila;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into imobi_board.invites
    (tenant_id, email, role, token, created_by)
  values (v_tenant, v_email, 'ADMIN', v_token, v_uid);

  perform imobi_board_priv.emit_event(
    v_tenant, 'tenant.created', 'tenant', v_tenant,
    jsonb_build_object('nome', p_nome, 'slug', v_slug, 'admin', v_email)
  );

  return jsonb_build_object(
    'tenant_id', v_tenant, 'nome', btrim(p_nome), 'slug', v_slug,
    'email', v_email, 'token', v_token
  );
end;
$function$;

-- Invitations also receive the selected tenant explicitly in Master mode.
create or replace function imobi_board.convidar_membro(
  p_email text,
  p_role imobi_board.member_role default 'BROKER'::imobi_board.member_role,
  p_tenant_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid;
  v_email text := imobi_board_priv.normalize_email(p_email);
  v_token text;
begin
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-mail invalido.' using errcode='P0001';
  end if;

  v_tenant := imobi_board_priv.resolve_admin_tenant(p_tenant_id);

  if exists (
    select 1 from imobi_board.memberships m
    join auth.users u on u.id=m.user_id
    where m.tenant_id=v_tenant and lower(u.email)=v_email
  ) then
    raise exception 'Essa pessoa ja esta na equipe.' using errcode='P0001';
  end if;

  delete from imobi_board.invites
   where tenant_id=v_tenant and email=v_email
     and accepted_at is null and revoked_at is null;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into imobi_board.invites (tenant_id,email,role,token,created_by)
  values (v_tenant,v_email,p_role,v_token,v_uid);

  perform imobi_board_priv.emit_event(
    v_tenant,'invite.created','invite',v_uid,
    jsonb_build_object('email',v_email,'role',p_role)
  );

  return jsonb_build_object('token',v_token,'email',v_email,'role',p_role);
end;
$function$;

-- Member-readable RPCs keep broker compatibility, while Master must scope explicitly.
create or replace function imobi_board.templates_whatsapp(p_tenant_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_tenant uuid := imobi_board_priv.resolve_member_tenant(p_tenant_id);
  v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',w.id,'tenant_id',w.tenant_id,'name',w.name,'body',w.body,
    'is_default',w.is_default,'active',w.active,'updated_at',w.updated_at
  ) order by w.is_default desc,w.name),'[]'::jsonb)
  into v_out
  from imobi_board.whatsapp_templates w
  where w.tenant_id=v_tenant and w.active;
  return v_out;
end;
$function$;

create or replace function imobi_board.templates_whatsapp()
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  select imobi_board.templates_whatsapp(
    imobi_board_priv.resolve_member_tenant(null)
  );
$function$;

create or replace function imobi_board.campos_dos_formularios(
  p_tenant_id uuid,
  p_form_id text default null
)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_tenant uuid := imobi_board_priv.resolve_member_tenant(p_tenant_id);
  v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',r.id,
    'form_id',nullif(r.form_id,'__SEM_FORM_ID__'),
    'question_key',r.question_key,
    'label',r.label,
    'detected_category',r.detected_category,
    'category',coalesce(r.category_override,r.detected_category),
    'category_override',r.category_override,
    'seen_count',r.seen_count,
    'sample_values',r.sample_values,
    'last_seen_at',r.last_seen_at
  ) order by r.form_id,r.last_seen_at desc),'[]'::jsonb)
  into v_out
  from imobi_board.form_question_registry r
  where r.tenant_id=v_tenant
    and (
      p_form_id is null
      or r.form_id=coalesce(nullif(btrim(p_form_id),''),'__SEM_FORM_ID__')
    );
  return v_out;
end;
$function$;

create or replace function imobi_board.campos_dos_formularios(p_form_id text default null)
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  select imobi_board.campos_dos_formularios(
    imobi_board_priv.resolve_member_tenant(null),p_form_id
  );
$function$;

create or replace function imobi_board.minha_cobranca(p_tenant_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_tenant uuid := imobi_board_priv.resolve_member_tenant(p_tenant_id);
  v_out jsonb;
begin
  select coalesce(jsonb_agg(x),'[]'::jsonb)
  into v_out
  from (
    select jsonb_build_object(
      'tenant_id',t.id,'imobiliaria',t.name,'meu_papel',m.role,
      'assinatura',case when a.id is null then null else jsonb_build_object(
        'status',a.status,'bloqueada',a.status='BLOQUEADA',
        'bloqueada_em',a.bloqueada_em,'plano',p.nome,'plano_id',p.id,
        'dia_vencimento',a.dia_vencimento,
        'dias_de_tolerancia',a.dias_de_tolerancia,'teste_ate',a.teste_ate
      ) end,
      'proxima_cobranca',imobi_board_priv.calcular_mensalidade(t.id),
      'faturas_em_aberto',(
        select coalesce(jsonb_agg(jsonb_build_object(
          'id',f.id,'competencia',f.competencia,'vence_em',f.vence_em,
          'valor_centavos',f.valor_centavos,'status',f.status,
          'dias_de_atraso',greatest(current_date-f.vence_em,0),
          'detalhamento',f.payload->'detalhamento',
          'link',f.link_pagamento
        ) order by f.vence_em),'[]'::jsonb)
        from imobi_board.faturas f
        where f.tenant_id=t.id and f.status in ('PENDENTE','ATRASADA')
      )
    ) as x
    from imobi_board.memberships m
    join imobi_board.tenants t on t.id=m.tenant_id
    left join imobi_board.assinaturas a on a.tenant_id=t.id
    left join imobi_board.planos p on p.id=a.plano_id
    where m.user_id=(select auth.uid())
      and m.status='ACTIVE'
      and m.tenant_id=v_tenant
      and (not m.is_internal or imobi_board_priv.e_master())
  ) s;
  return v_out;
end;
$function$;

create or replace function imobi_board.minha_cobranca()
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  select imobi_board.minha_cobranca(
    imobi_board_priv.resolve_member_tenant(null)
  );
$function$;

create or replace function imobi_board.salvar_template_whatsapp(
  p_tenant_id uuid,
  p_name text,
  p_body text,
  p_id uuid default null,
  p_is_default boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_tenant uuid := imobi_board_priv.resolve_admin_tenant(p_tenant_id);
  v_id uuid;
begin
  if length(btrim(coalesce(p_name,'')))<1 then
    raise exception 'Nome obrigatorio.';
  end if;
  if length(btrim(coalesce(p_body,'')))<1 then
    raise exception 'Mensagem obrigatoria.';
  end if;

  if p_is_default then
    update imobi_board.whatsapp_templates
       set is_default=false,updated_at=now(),updated_by=v_uid
     where tenant_id=v_tenant and is_default=true
       and (p_id is null or id<>p_id);
  end if;

  if p_id is null then
    insert into imobi_board.whatsapp_templates
      (tenant_id,name,body,is_default,created_by,updated_by)
    values(v_tenant,btrim(p_name),p_body,p_is_default,v_uid,v_uid)
    returning id into v_id;
  else
    update imobi_board.whatsapp_templates
       set name=btrim(p_name),body=p_body,is_default=p_is_default,
           active=true,updated_by=v_uid,updated_at=now()
     where id=p_id and tenant_id=v_tenant
    returning id into v_id;

    if v_id is null then
      raise exception 'Template nao encontrado.' using errcode='P0002';
    end if;
  end if;

  if not exists(
    select 1 from imobi_board.whatsapp_templates
    where tenant_id=v_tenant and active and is_default
  ) then
    update imobi_board.whatsapp_templates set is_default=true where id=v_id;
  end if;

  return (
    select jsonb_build_object(
      'id',id,'name',name,'body',body,'is_default',is_default
    )
    from imobi_board.whatsapp_templates
    where id=v_id
  );
end;
$function$;

create or replace function imobi_board.salvar_template_whatsapp(
  p_name text,
  p_body text,
  p_id uuid default null,
  p_is_default boolean default false
)
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select imobi_board.salvar_template_whatsapp(
    imobi_board_priv.resolve_admin_tenant(null),
    p_name,p_body,p_id,p_is_default
  );
$function$;

-- Explicit execution ACLs for client-callable SECURITY DEFINER functions.
revoke all on function imobi_board.fontes_de_lead(uuid) from public, anon;
grant execute on function imobi_board.fontes_de_lead(uuid) to authenticated;
revoke all on function imobi_board.fontes_de_lead() from public, anon;
grant execute on function imobi_board.fontes_de_lead() to authenticated;

revoke all on function imobi_board.criar_fonte(uuid,text,text,uuid) from public, anon;
grant execute on function imobi_board.criar_fonte(uuid,text,text,uuid) to authenticated;
revoke all on function imobi_board.criar_fonte(text,text,uuid) from public, anon;
grant execute on function imobi_board.criar_fonte(text,text,uuid) to authenticated;

revoke all on function imobi_board.iniciar_conexao_meta(uuid,text,uuid) from public, anon;
grant execute on function imobi_board.iniciar_conexao_meta(uuid,text,uuid) to authenticated;
revoke all on function imobi_board.iniciar_conexao_meta(text,uuid) from public, anon;
grant execute on function imobi_board.iniciar_conexao_meta(text,uuid) to authenticated;

revoke all on function imobi_board.paginas_da_meta(uuid) from public, anon;
grant execute on function imobi_board.paginas_da_meta(uuid) to authenticated;
revoke all on function imobi_board.paginas_da_meta() from public, anon;
grant execute on function imobi_board.paginas_da_meta() to authenticated;

revoke all on function imobi_board.situacao_do_token_de_sistema(uuid) from public, anon;
grant execute on function imobi_board.situacao_do_token_de_sistema(uuid) to authenticated;
revoke all on function imobi_board.situacao_do_token_de_sistema() from public, anon;
grant execute on function imobi_board.situacao_do_token_de_sistema() to authenticated;

revoke all on function imobi_board.salvar_token_de_sistema(uuid,text) from public, anon;
grant execute on function imobi_board.salvar_token_de_sistema(uuid,text) to authenticated;
revoke all on function imobi_board.salvar_token_de_sistema(text) from public, anon;
grant execute on function imobi_board.salvar_token_de_sistema(text) to authenticated;

revoke all on function imobi_board.conectar_pagina(uuid,text,text,uuid) from public, anon;
grant execute on function imobi_board.conectar_pagina(uuid,text,text,uuid) to authenticated;
revoke all on function imobi_board.conectar_pagina(text,text,uuid) from public, anon;
grant execute on function imobi_board.conectar_pagina(text,text,uuid) to authenticated;

revoke all on function imobi_board.imobiliarias() from public, anon;
grant execute on function imobi_board.imobiliarias() to authenticated;
revoke all on function imobi_board.criar_imobiliaria(text,text,text) from public, anon;
grant execute on function imobi_board.criar_imobiliaria(text,text,text) to authenticated;
revoke all on function imobi_board.convidar_membro(text,imobi_board.member_role,uuid) from public, anon;
grant execute on function imobi_board.convidar_membro(text,imobi_board.member_role,uuid) to authenticated;

revoke all on function imobi_board.templates_whatsapp(uuid) from public, anon;
grant execute on function imobi_board.templates_whatsapp(uuid) to authenticated;
revoke all on function imobi_board.templates_whatsapp() from public, anon;
grant execute on function imobi_board.templates_whatsapp() to authenticated;

revoke all on function imobi_board.campos_dos_formularios(uuid,text) from public, anon;
grant execute on function imobi_board.campos_dos_formularios(uuid,text) to authenticated;
revoke all on function imobi_board.campos_dos_formularios(text) from public, anon;
grant execute on function imobi_board.campos_dos_formularios(text) to authenticated;

revoke all on function imobi_board.minha_cobranca(uuid) from public, anon;
grant execute on function imobi_board.minha_cobranca(uuid) to authenticated;
revoke all on function imobi_board.minha_cobranca() from public, anon;
grant execute on function imobi_board.minha_cobranca() to authenticated;

revoke all on function imobi_board.salvar_template_whatsapp(uuid,text,text,uuid,boolean) from public, anon;
grant execute on function imobi_board.salvar_template_whatsapp(uuid,text,text,uuid,boolean) to authenticated;
revoke all on function imobi_board.salvar_template_whatsapp(text,text,uuid,boolean) from public, anon;
grant execute on function imobi_board.salvar_template_whatsapp(text,text,uuid,boolean) to authenticated;

revoke execute on function imobi_board.definir_categoria_campo_formulario(uuid,text) from public;
revoke execute on function imobi_board.excluir_template_whatsapp(uuid) from public;
revoke execute on function imobi_board.respostas_do_lead(uuid) from public;
revoke execute on function imobi_board.whatsapp_para_lead(uuid,uuid) from public;

alter table imobi_board.meta_lead_enrichment_log enable row level security;
