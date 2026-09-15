create or replace function agency_ops.capture_creative_rule_candidate_from_whatsapp()
returns trigger
language plpgsql
set search_path to 'agency_ops','pg_catalog','extensions'
as $function$
declare v_client uuid; v_text text; v_signal text;
begin
  if not coalesce(new.is_group,false) or coalesce(new.from_me,false) then return new; end if;
  select client_id into v_client from agency_ops.whatsapp_chat_registry where chat_id=new.chat_id;
  if v_client is null then return new; end if;
  if exists (
    select 1 from agency_ops.team_roster
    where not is_former and agency_ops.normalize_sender_identity(person)=agency_ops.normalize_sender_identity(new.sender_name)
  ) then return new; end if;
  v_text:=btrim(coalesce(new.text_body,new.caption,''));
  if v_text='' then return new; end if;
  if lower(extensions.unaccent(v_text)) ~ '(nao gostei|nao gosto|nao use|nao coloca|nao quero|evit(e|ar)|muito texto|texto pequeno|letra pequena|fonte pequena|poluido|logo errad|cor errad|paleta|identidade visual|parece ia|cara de ia|voz de ia|refaz|ajust(e|ar))' then
    v_signal:=case
      when lower(extensions.unaccent(v_text)) ~ '(nao gostei|nao gosto|nao use|nao coloca|nao quero|evit(e|ar))' then 'RECLAMACAO_OU_RESTRICAO'
      when lower(extensions.unaccent(v_text)) ~ '(texto pequeno|letra pequena|fonte pequena|muito texto|poluido)' then 'LEGIBILIDADE'
      when lower(extensions.unaccent(v_text)) ~ '(logo errad|cor errad|paleta|identidade visual)' then 'IDENTIDADE_VISUAL'
      when lower(extensions.unaccent(v_text)) ~ '(parece ia|cara de ia|voz de ia)' then 'APARENCIA_IA'
      else 'PEDIDO_DE_AJUSTE' end;
    insert into agency_ops.creative_rule_candidates
      (client_id,candidate_kind,candidate_text,source_type,source_id,source_excerpt,source_at,confidence,metadata)
    values
      (v_client,v_signal,v_text,'WHATSAPP',new.message_id,left(v_text,1000),coalesce(new.event_at,new.received_at,now()),0.62,
       jsonb_build_object('chat_id',new.chat_id,'sender_name',new.sender_name,'automatic',true))
    on conflict (source_type,source_id) where source_id is not null do nothing;
  end if;
  return new;
end $function$;