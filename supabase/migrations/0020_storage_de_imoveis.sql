-- Imobi-Board 0020 - fotos de imovel (spec 39)
--
-- Bucket PRIVADO e exclusivo. O projeto ja tem 18 buckets de outros sistemas;
-- todas as policies abaixo sao escopadas por bucket_id, entao nada do que ja
-- existe muda de comportamento.
--
-- Convencao de caminho:  {tenant_id}/{property_id}/{arquivo}
-- O primeiro segmento e o que a policy usa para decidir de quem e o arquivo -
-- por isso ele nao pode ser escolhido pelo cliente sem passar pela RLS.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imobi-board-imoveis', 'imobi-board-imoveis', false,
  8388608,   -- 8 MB: foto de portal, nao arquivo de camera
  array['image/jpeg','image/png','image/webp','image/avif']
)
on conflict (id) do nothing;

-- ve quem pertence ao tenant dono da pasta
create policy "imobi_board imoveis leitura"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'imobi-board-imoveis'
    and ((storage.foldername(name))[1])::uuid
        = any ((select imobi_board_priv.current_tenant_ids())::uuid[])
  );

-- so ADMIN envia e apaga, igual ao cadastro do imovel
create policy "imobi_board imoveis escrita"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'imobi-board-imoveis'
    and ((storage.foldername(name))[1])::uuid
        = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
  );

create policy "imobi_board imoveis remocao"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'imobi-board-imoveis'
    and ((storage.foldername(name))[1])::uuid
        = any ((select imobi_board_priv.admin_tenant_ids())::uuid[])
  );

-- Registra a foto e devolve a linha. Feito por RPC para garantir que o
-- tenant_id gravado seja o DONO do imovel, e nao o que o cliente mandar.
create or replace function imobi_board.registrar_foto(
  p_property_id  uuid,
  p_storage_path text,
  p_media_type   text default 'image'
) returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_tenant uuid;
  v_ordem  smallint;
  v_id     uuid;
begin
  select tenant_id into v_tenant from imobi_board.properties where id = p_property_id;
  if v_tenant is null then
    raise exception 'Imovel nao encontrado.' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from imobi_board.memberships m
    where m.user_id = v_uid and m.tenant_id = v_tenant
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) then
    raise exception 'Apenas o administrador altera o portfolio.' using errcode = '42501';
  end if;

  select coalesce(max(sort_order) + 1, 0) into v_ordem
  from imobi_board.property_media where property_id = p_property_id;

  insert into imobi_board.property_media
    (tenant_id, property_id, storage_path, media_type, sort_order)
  values (v_tenant, p_property_id, p_storage_path, p_media_type, v_ordem)
  returning id into v_id;

  return v_id;
end;
$fn$;

create or replace function imobi_board.remover_foto(p_media_id uuid)
returns text
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_m    imobi_board.property_media%rowtype;
begin
  select * into v_m from imobi_board.property_media where id = p_media_id;
  if not found then
    raise exception 'Foto nao encontrada.' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from imobi_board.memberships m
    where m.user_id = v_uid and m.tenant_id = v_m.tenant_id
      and m.status = 'ACTIVE' and m.role = 'ADMIN'
  ) then
    raise exception 'Apenas o administrador altera o portfolio.' using errcode = '42501';
  end if;

  delete from imobi_board.property_media where id = p_media_id;
  -- devolve o caminho para o cliente apagar o binario no Storage
  return v_m.storage_path;
end;
$fn$;

revoke execute on function imobi_board.registrar_foto(uuid, text, text) from public;
revoke execute on function imobi_board.remover_foto(uuid) from public;
grant execute on function imobi_board.registrar_foto(uuid, text, text) to authenticated;
grant execute on function imobi_board.remover_foto(uuid) to authenticated;
