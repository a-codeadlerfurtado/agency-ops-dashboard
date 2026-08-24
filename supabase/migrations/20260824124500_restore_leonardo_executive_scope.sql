-- Leonardo usa a Direcao Comercial em modo executivo.
-- Contratos, financeiro e condicoes administrativas continuam exclusivos do Adler.

create or replace function agency_ops.is_contract_viewer(p_user_key text)
returns boolean
language sql
stable
security definer
set search_path to 'agency_ops','pg_temp'
as $function$
  select exists (
    select 1
    from agency_ops.user_preferences up
    where up.user_key = p_user_key
      and up.collaborator_person = 'Adler Furtado'
  );
$function$;

comment on function agency_ops.is_contract_viewer(text) is
  'Autoriza a area privada de contratos exclusivamente para Adler Furtado.';

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note,updated_at)
values
  ('finance','PERSON','Leonardo Augusto',false,'Financeiro e condicoes administrativas permanecem exclusivos do Adler',now()),
  ('contracts','PERSON','Leonardo Augusto',false,'Contratos permanecem exclusivos do Adler',now())
on conflict (view_key,scope_type,scope_value) do update
set allowed=excluded.allowed,note=excluded.note,updated_at=now();
