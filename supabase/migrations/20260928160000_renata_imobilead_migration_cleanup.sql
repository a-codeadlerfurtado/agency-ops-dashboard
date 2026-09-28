-- Renata Fiel: limpeza das fontes Meta e preservacao exata das etapas do Imobilead.
-- Tambem tira o tenant Horizonte de fixture da lista de contas ativas reais.

-- Fonte META_ADS duplicada/orfa da Renata: nunca teve pagina nem uso.
update imobi_board.ingest_sources
set active = false
where id = '2eb27290-71d6-4a5a-87b7-a5a0be4585c9'
  and tenant_id = '200ddf3f-0fee-49cc-a643-f73f2f93dcbc'
  and page_id is null
  and last_used_at is null;

-- Imobiliaria Horizonte e o tenant seed/fixture (UUID bbbb...), nao uma conta Meta real.
update imobi_board.tenants
set status = 'INACTIVE', updated_at = now()
where id = 'bbbbbbbb-0000-4000-8000-000000000002'
  and slug = 'imobiliaria-horizonte'
  and not exists (
    select 1 from imobi_board.ingest_sources s where s.tenant_id = imobi_board.tenants.id
  );

-- Adequa o funil da Renata aos status historicos recebidos do Imobilead.
do $$
declare
  v_tenant constant uuid := '200ddf3f-0fee-49cc-a643-f73f2f93dcbc';
  v_pipe uuid;
  v_sort smallint;
begin
  select id into v_pipe
  from imobi_board.pipelines
  where tenant_id=v_tenant
  order by is_default desc, created_at
  limit 1;

  if v_pipe is null then
    raise exception 'Pipeline da Renata Fiel nao encontrado.';
  end if;

  update imobi_board.pipeline_stages
     set name='Em Atendimento', updated_at=now()
   where pipeline_id=v_pipe and kind='CONTACTED' and name='Contatado';

  update imobi_board.pipeline_stages
     set name='Visita Agendada', updated_at=now()
   where pipeline_id=v_pipe and kind='VISIT' and name='Visita';

  select coalesce(max(sort_order),-1)+1 into v_sort
  from imobi_board.pipeline_stages where pipeline_id=v_pipe;

  if not exists (
    select 1 from imobi_board.pipeline_stages
    where pipeline_id=v_pipe and lower(btrim(name))='lead sem perfil'
  ) then
    insert into imobi_board.pipeline_stages(tenant_id,pipeline_id,name,kind,sort_order)
    values(v_tenant,v_pipe,'Lead Sem Perfil','NEW',v_sort);
    v_sort := v_sort + 1;
  end if;

  if not exists (
    select 1 from imobi_board.pipeline_stages
    where pipeline_id=v_pipe and lower(btrim(name))='lead lago azul'
  ) then
    insert into imobi_board.pipeline_stages(tenant_id,pipeline_id,name,kind,sort_order)
    values(v_tenant,v_pipe,'Lead LAGO AZUL','NEW',v_sort);
    v_sort := v_sort + 1;
  end if;

  if not exists (
    select 1 from imobi_board.pipeline_stages
    where pipeline_id=v_pipe and lower(btrim(name))='testes'
  ) then
    insert into imobi_board.pipeline_stages(tenant_id,pipeline_id,name,kind,sort_order)
    values(v_tenant,v_pipe,'TESTES','NEW',v_sort);
  end if;
end $$;

-- Import historico: primeiro tenta a etapa com o MESMO nome do status da origem.
-- Se nao existir, cai para a semantica generica do stage_kind.
create or replace function imobi_board.importar_imobilead(
  p_tenant uuid,
  p_lote   jsonb,
  p_origem text default 'Imobilead'
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_pipe uuid;
  v_novo uuid;
  r jsonb;
  v_tel text;
  v_mail text;
  v_nome text;
  v_quando timestamptz;
  v_chave text;
  v_cid uuid;
  v_oid uuid;
  v_etapa uuid;
  v_status_norm text;
  v_kind imobi_board.stage_kind;
  n_contatos int := 0;
  n_opp int := 0;
  n_repetida int := 0;
  n_linhas int := 0;
begin
  if not exists (select 1 from imobi_board.tenants t where t.id=p_tenant) then
    raise exception 'Imobiliaria % nao existe.', p_tenant using errcode='P0001';
  end if;

  select p.id into v_pipe
  from imobi_board.pipelines p
  where p.tenant_id=p_tenant
  order by p.is_default desc,p.created_at
  limit 1;
  if v_pipe is null then
    raise exception 'A imobiliaria nao tem funil. Provisione antes de importar.' using errcode='P0001';
  end if;

  select s.id into v_novo
  from imobi_board.pipeline_stages s
  where s.pipeline_id=v_pipe and s.kind='NEW'
  order by s.sort_order
  limit 1;
  if v_novo is null then
    raise exception 'Funil sem etapa inicial.' using errcode='P0001';
  end if;

  for r in select * from jsonb_array_elements(p_lote)
  loop
    n_linhas := n_linhas + 1;
    v_tel := imobi_board_priv.normalize_phone_br(r->>'telefone');
    v_mail := imobi_board_priv.normalize_email(r->>'email');
    v_nome := nullif(btrim(coalesce(r->>'nome','')),'');
    if v_nome is null then
      v_nome := coalesce(nullif(split_part(coalesce(v_mail,''),'@',1),''),'Contato sem nome');
    end if;

    v_quando := case
      when nullif(btrim(coalesce(r->>'criado','')),'') is null then now()
      else (btrim(r->>'criado')::timestamp) at time zone 'America/Sao_Paulo'
    end;

    v_cid := null;
    if v_tel is not null or v_mail is not null then
      select c.id into v_cid
      from imobi_board.contacts c
      where c.tenant_id=p_tenant
        and ((v_tel is not null and c.phone_normalized=v_tel)
          or (v_mail is not null and c.email_normalized=v_mail))
      order by c.created_at
      limit 1;
    end if;

    if v_cid is null then
      insert into imobi_board.contacts
        (tenant_id,full_name,phone,phone_normalized,email,email_normalized,created_at)
      values
        (p_tenant,v_nome,nullif(btrim(coalesce(r->>'telefone','')),''),v_tel,
         nullif(btrim(coalesce(r->>'email','')),''),v_mail,v_quando)
      returning id into v_cid;
      n_contatos := n_contatos + 1;
    end if;

    v_chave := left(encode(extensions.digest(concat_ws('|',
      coalesce(v_tel,btrim(coalesce(r->>'telefone',''))),
      coalesce(v_mail,''),
      coalesce(r->>'criado',''),
      coalesce(r->>'produto',''),
      coalesce(r->>'campanha','')
    ),'sha256'),'hex'),24);

    v_status_norm := btrim(lower(coalesce(r->>'status','')));
    v_etapa := null;

    if v_status_norm <> '' then
      select s.id into v_etapa
      from imobi_board.pipeline_stages s
      where s.pipeline_id=v_pipe and lower(btrim(s.name))=v_status_norm
      order by s.sort_order
      limit 1;
    end if;

    if v_etapa is null then
      v_kind := case v_status_norm
        when 'em atendimento' then 'CONTACTED'::imobi_board.stage_kind
        when 'contatado' then 'CONTACTED'::imobi_board.stage_kind
        when 'qualificado' then 'QUALIFIED'::imobi_board.stage_kind
        when 'visita' then 'VISIT'::imobi_board.stage_kind
        when 'visita agendada' then 'VISIT'::imobi_board.stage_kind
        when 'proposta' then 'PROPOSAL'::imobi_board.stage_kind
        when 'venda' then 'WON'::imobi_board.stage_kind
        when 'ganho' then 'WON'::imobi_board.stage_kind
        when 'perdido' then 'LOST'::imobi_board.stage_kind
        else 'NEW'::imobi_board.stage_kind
      end;

      select s.id into v_etapa
      from imobi_board.pipeline_stages s
      where s.pipeline_id=v_pipe and s.kind=v_kind
      order by s.sort_order
      limit 1;
    end if;

    v_etapa := coalesce(v_etapa,v_novo);

    insert into imobi_board.opportunities
      (tenant_id,contact_id,pipeline_id,stage_id,status,
       source,source_detail,campaign_name,
       external_source_id,external_event_id,
       created_at,updated_at,last_interaction_at)
    values
      (p_tenant,v_cid,v_pipe,v_etapa,'OPEN',
       'IMOBILEAD',nullif(btrim(coalesce(r->>'produto','')),''),
       nullif(btrim(coalesce(r->>'campanha','')),''),
       p_origem,v_chave,
       v_quando,v_quando,v_quando)
    on conflict (tenant_id,source,external_event_id)
      where external_event_id is not null
    do nothing
    returning id into v_oid;

    if v_oid is null then
      n_repetida := n_repetida + 1;
      continue;
    end if;
    n_opp := n_opp + 1;

    insert into imobi_board.activities
      (tenant_id,opportunity_id,type,body,created_at)
    values
      (p_tenant,v_oid,'SYSTEM',
       concat_ws(' | ',
         'Importado de '||p_origem,
         nullif('corretor na origem: '||nullif(btrim(coalesce(r->>'corretor','')),''),'corretor na origem: '),
         nullif('situacao na origem: '||nullif(btrim(coalesce(r->>'status','')),''),'situacao na origem: '),
         nullif('produto: '||nullif(btrim(coalesce(r->>'produto','')),''),'produto: '),
         nullif('categoria: '||nullif(btrim(coalesce(r->>'categoria','')),''),'categoria: ')
       ),
       v_quando);
  end loop;

  return jsonb_build_object(
    'tenant_id',p_tenant,
    'linhas_recebidas',n_linhas,
    'contatos_criados',n_contatos,
    'oportunidades_criadas',n_opp,
    'ja_existiam',n_repetida
  );
end;
$fn$;

revoke execute on function imobi_board.importar_imobilead(uuid,jsonb,text) from public;
revoke execute on function imobi_board.importar_imobilead(uuid,jsonb,text) from authenticated;
grant execute on function imobi_board.importar_imobilead(uuid,jsonb,text) to service_role;
