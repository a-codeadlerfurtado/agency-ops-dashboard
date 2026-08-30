create or replace function agency_ops.redact_sensitive_text(p_value text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  v text := coalesce(p_value,'');
begin
  v := regexp_replace(v, 'sk-[A-Za-z0-9_-]{20,}', '[CREDENCIAL OCULTADA]', 'g');
  v := regexp_replace(v, 'EAA[A-Za-z0-9]{30,}', '[CREDENCIAL OCULTADA]', 'g');
  v := regexp_replace(
    v,
    '(senha|password|token|api[ _-]?key|chave[[:space:]_-]*(de|da)?[[:space:]_-]*api|secret)[[:space:]]*[:=-]?[[:space:]]+[^[:space:],;]{4,255}',
    E'\\1: [CREDENCIAL OCULTADA]',
    'gi'
  );
  v := regexp_replace(
    v,
    '(login|usuario|usuário)[[:space:]]*[:=-]?[[:space:]]+[^[:space:],;]{3,200}',
    E'\\1: [ACESSO OCULTADO]',
    'gi'
  );
  v := regexp_replace(
    v,
    '([?&](access_token|token|api_key|key)=)[^&[:space:]]+',
    E'\\1[CREDENCIAL OCULTADA]',
    'gi'
  );
  return v;
end;
$$;

revoke all on function agency_ops.redact_sensitive_text(text) from public, anon, authenticated;
grant execute on function agency_ops.redact_sensitive_text(text) to service_role;