-- ImobiBoard - confiabilidade do webhook Meta Lead Ads
-- Renovar token de pagina nao pode apagar estado de webhook ja confirmado.
-- fonte_da_pagina devolve tambem o id para o Worker atualizar o estado.

create or replace function imobi_board.fonte_da_pagina(p_page_id text)
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  select jsonb_build_object(
    'id', id,
    'token_sha256', token_sha256,
    'page_access_token', page_access_token
  )
  from imobi_board.ingest_sources
  where page_id = p_page_id and active;
$fn$;

revoke execute on function imobi_board.fonte_da_pagina(text) from public;
grant execute on function imobi_board.fonte_da_pagina(text) to service_role;

create or replace function imobi_board.salvar_paginas_da_meta(
  p_state text,
  p_paginas jsonb
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_e imobi_board.meta_estados%rowtype;
  v_n int;
  v_ok int;
begin
  select * into v_e
  from imobi_board.meta_estados
  where state=p_state and used_at is null and expires_at>now()
  for update;

  if not found then
    raise exception 'Autorizacao expirada ou ja utilizada.' using errcode='P0001';
  end if;

  update imobi_board.meta_estados set used_at=now() where state=p_state;

  insert into imobi_board.meta_paginas(
    tenant_id,page_id,page_name,page_access_token,webhook_confirmed_at,webhook_error
  )
  select
    v_e.tenant_id,
    x->>'id',
    x->>'name',
    x->>'access_token',
    case when x->>'webhook_verified'='true' then now() end,
    case
      when x->>'webhook_verified'='true' then null
      else coalesce(x->>'webhook_error','Webhook ainda nao confirmado pela Meta.')
    end
  from jsonb_array_elements(p_paginas) x
  where coalesce(x->>'id','')<>'' and coalesce(x->>'access_token','')<>''
  on conflict(tenant_id,page_id) do update
    set page_name=excluded.page_name,
        page_access_token=excluded.page_access_token,
        descoberta_em=now();
  get diagnostics v_n=row_count;

  -- Renovar token nunca apaga a confirmacao anterior. O Worker reassina
  -- leadgen imediatamente depois desta RPC e chama marcar_assinada.
  update imobi_board.ingest_sources s
     set page_access_token=p.page_access_token,
         page_name=p.page_name
  from imobi_board.meta_paginas p
  where p.tenant_id=s.tenant_id
    and p.page_id=s.page_id
    and s.tenant_id=v_e.tenant_id;

  select count(*) into v_ok
  from jsonb_array_elements(p_paginas) x
  where x->>'webhook_verified'='true';

  return jsonb_build_object(
    'tenant_id',v_e.tenant_id,
    'paginas',v_n,
    'webhooks_confirmados',v_ok,
    'webhook_subscription',
      case when v_ok=v_n and v_n>0 then 'confirmed' else 'pending' end
  );
end;
$fn$;

revoke execute on function imobi_board.salvar_paginas_da_meta(text,jsonb) from public;
grant execute on function imobi_board.salvar_paginas_da_meta(text,jsonb) to service_role;
