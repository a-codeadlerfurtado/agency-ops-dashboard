-- Imobi-Board 0034 - o campo aceitava qualquer coisa como token de pagina
--
-- Aconteceu de verdade: o page_id foi colado no campo "Token de pagina" e
-- sobrescreveu o token bom. A tela continuou dizendo "token configurado",
-- porque a checagem era `is not null` -- e so descobrimos quando o primeiro
-- lead de verdade chegou e a Meta respondeu "Cannot parse access token".
--
-- Sao dois campos parecidos e proximos: o ID da pagina, que e numero, e o
-- token dela, que e uma cadeia longa. Trocar um pelo outro e o erro obvio, e
-- guardar sem conferir transforma isso num problema que so aparece muito
-- depois, longe da causa.
--
-- Token de pagina da Meta tem centenas de caracteres. Recusar o que for so
-- digito, ou curto demais, pega o caso real sem inventar formato.

create or replace function imobi_board.atualizar_fonte(
  p_id       uuid,
  p_label    text default null,
  p_queue_id uuid default null,
  p_active   boolean default null,
  p_page_access_token text default null,
  p_page_id  text default null
) returns void
language plpgsql security definer set search_path = ''
as $fn$
declare v_uid uuid := (select auth.uid()); v_tenant uuid; v_tk text;
begin
  select s.tenant_id into v_tenant from imobi_board.ingest_sources s where s.id = p_id;
  if not exists (select 1 from imobi_board.memberships m
                 where m.user_id = v_uid and m.tenant_id = v_tenant
                   and m.status='ACTIVE' and m.role='ADMIN') then
    raise exception 'Apenas o administrador altera integracoes.' using errcode = '42501';
  end if;

  if p_queue_id is not null and not exists (
    select 1 from imobi_board.lead_queues q
    where q.id = p_queue_id and q.tenant_id = v_tenant
  ) then
    raise exception 'Fila nao pertence a esta imobiliaria.' using errcode = '42501';
  end if;

  -- string vazia apaga o token; null deixa como esta; qualquer outra coisa e
  -- conferida antes de substituir um token que talvez estivesse funcionando
  v_tk := btrim(p_page_access_token);
  if p_page_access_token is not null and v_tk <> '' then
    if v_tk ~ '^\d+$' then
      raise exception
        'Isso parece o ID da pagina, nao o token dela. O ID e so numero; o token e uma cadeia longa que comeca com EAA.'
        using errcode = 'P0001';
    end if;
    if length(v_tk) < 50 then
      raise exception
        'Token de pagina curto demais (% caracteres). O token da Meta tem centenas de caracteres -- confira se copiou inteiro.', length(v_tk)
        using errcode = 'P0001';
    end if;
  end if;

  update imobi_board.ingest_sources s
     set label    = coalesce(nullif(btrim(p_label), ''), s.label),
         queue_id = coalesce(p_queue_id, s.queue_id),
         active   = coalesce(p_active, s.active),
         page_id  = coalesce(nullif(btrim(p_page_id), ''), s.page_id),
         page_access_token = case
           when p_page_access_token is null then s.page_access_token
           when v_tk = '' then null
           else v_tk
         end,
         -- token novo limpa erro antigo: senao a tela segue acusando falha
         -- que ja foi resolvida
         last_error = case when p_page_access_token is not null and v_tk <> ''
                           then null else s.last_error end,
         last_error_at = case when p_page_access_token is not null and v_tk <> ''
                              then null else s.last_error_at end
   where s.id = p_id;
end;
$fn$;

revoke execute on function imobi_board.atualizar_fonte(uuid, text, uuid, boolean, text, text) from public;
grant execute on function imobi_board.atualizar_fonte(uuid, text, uuid, boolean, text, text) to authenticated;
