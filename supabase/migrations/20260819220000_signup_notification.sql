-- Todo cadastro novo avisa no sino. Sem isso, alguem que se cadastra sem vinculo
-- valido fica travado sem ver nada (ver walletSet vazio na Edge Function) e sem
-- ninguem saber que existe.
--
-- Roda em user_preferences e nao em auth.users para nao interferir no gatilho de
-- provisionamento (handle_new_user_provision). Envolvido em exception para que uma
-- falha aqui jamais quebre o cadastro: notificacao e' efeito colateral.
create or replace function agency_ops.user_signup_notify()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
begin
  begin
    if new.collaborator_person is not null then
      insert into agency_ops.platform_notifications
        (event_key, type, level, title, description, source, actor, occurred_at, metadata)
      values ('signup:' || new.user_key, 'USER_SIGNUP', 'INFO',
        'Novo acesso: ' || new.collaborator_person,
        coalesce(new.email,'sem e-mail') || ' entrou como ' || coalesce(new.role,'Colaborador') || '.',
        'dashboard', new.collaborator_person, now(),
        jsonb_build_object('user_key',new.user_key,'email',new.email,
                           'collaborator_person',new.collaborator_person,'linked',true))
      on conflict (event_key) do nothing;
    else
      insert into agency_ops.platform_notifications
        (event_key, type, level, title, description, source, actor, occurred_at, metadata)
      values ('signup:' || new.user_key, 'USER_SIGNUP_UNLINKED', 'ATTENTION',
        'Cadastro sem vínculo: ' || coalesce(new.email,new.user_key),
        'Criou conta mas nao escolheu um colaborador valido. Esta sem acesso a nenhum dado ate ser vinculado em Configuracoes.',
        'dashboard', null, now(),
        jsonb_build_object('user_key',new.user_key,'email',new.email,'linked',false))
      on conflict (event_key) do nothing;
    end if;
  exception when others then
    null;
  end;
  return new;
end;
$$;

drop trigger if exists user_signup_notify_trg on agency_ops.user_preferences;
create trigger user_signup_notify_trg
after insert on agency_ops.user_preferences
for each row execute function agency_ops.user_signup_notify();
