-- Already applied to imobi-pro. Rejects associations that cross client ownership.
CREATE OR REPLACE FUNCTION public.briefing_prevent_cross_client_product_persona()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_product_client uuid; v_persona_client uuid;
begin
  select client_id into v_product_client from public.briefing_products where id=new.product_id;
  select client_id into v_persona_client from public.briefing_personas where id=new.persona_id;
  if v_product_client is null or v_persona_client is null
     or v_product_client is distinct from v_persona_client then
    raise check_violation using message='Product and persona must belong to the same client';
  end if;
  return new;
end;$function$
;
revoke all on function public.briefing_prevent_cross_client_product_persona() from public,anon,authenticated;
drop trigger if exists tg_briefing_prevent_cross_client_product_persona on public.briefing_product_personas;
create trigger tg_briefing_prevent_cross_client_product_persona before insert or update of product_id,persona_id on public.briefing_product_personas for each row execute function public.briefing_prevent_cross_client_product_persona();
