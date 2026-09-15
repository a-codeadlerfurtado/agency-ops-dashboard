-- Quem falou em cada mensagem: equipe (e quem) ou cliente.
--
-- whatsapp_messages.from_me existe mas esta' zerado nas 20.308 linhas - nunca foi
-- preenchido pela ingestao. A identificacao real sai de whatsapp_team_identities,
-- que mapeia TELEFONE e NOME para pessoa e papel. Telefone tem prioridade: e' exato.
-- O casamento por nome usa LIKE e por isso um remetente pode bater em mais de uma
-- regra - dai' o lateral com LIMIT 1, senao a mensagem aparece duplicada (testado:
-- 33.952 linhas para 20.308 mensagens antes de deduplicar).
create or replace view agency_ops.whatsapp_message_actor as
select m.id, m.chat_id, m.event_at,
       ident.canonical_name as pessoa, ident.role as papel,
       (ident.canonical_name is not null) as da_equipe
  from agency_ops.whatsapp_messages m
  left join lateral (
    select t.canonical_name, t.role from agency_ops.whatsapp_team_identities t
     where t.active
       and ( (t.identity_type = 'PHONE'
              and t.identity_value = regexp_replace(coalesce(m.sender_phone,''),'\D','','g'))
          or (t.identity_type = 'NAME'
              and lower(regexp_replace(coalesce(m.sender_name,''),'[^a-zA-Z0-9 ]','','g'))
                  like '%' || t.identity_value || '%') )
     order by case when t.identity_type = 'PHONE' then 0 else 1 end
     limit 1
  ) ident on true;

comment on view agency_ops.whatsapp_message_actor is
  'Atribui cada mensagem a uma pessoa da equipe ou ao cliente. Base do tempo de resposta.';
