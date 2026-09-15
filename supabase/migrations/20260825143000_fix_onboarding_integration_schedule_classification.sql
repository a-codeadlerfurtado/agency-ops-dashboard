-- Prevent generic/competing onboarding meetings from being misclassified as GT integration.
-- Root cases observed on 2026-08-25: "reunião de formulários" and an ambiguous
-- "reunião da Manu" were incorrectly promoted to INTEGRATION_MEETING.

create or replace function agency_ops.capture_integration_schedule_from_whatsapp()
returns trigger language plpgsql security definer
set search_path to 'agency_ops','pg_catalog','extensions' as $$
declare
  v_case_id bigint;
  v_current_stage text;
  v_stage_status text;
  v_text text;
  v_norm text;
  v_dt timestamptz;
  v_is_ack boolean;
  v_is_reschedule boolean;
  v_old_due timestamptz;
  v_is_team boolean;
  v_prop record;
  v_has_meeting_context boolean;
  v_is_proposal boolean;
  v_explicit_integration boolean;
  v_competing_meeting_context boolean;
  v_has_open_integration_proposal boolean;
begin
  if coalesce(new.is_group,false) is not true then return new; end if;
  v_text:=trim(coalesce(new.text_body,'')||' '||coalesce(new.caption,''));
  if length(v_text)<2 then return new; end if;
  v_norm:=lower(unaccent(v_text));

  select oc.id,oc.current_stage,s.status,s.due_at
    into v_case_id,v_current_stage,v_stage_status,v_old_due
  from agency_ops.whatsapp_chat_registry reg
  join agency_ops.onboarding_cases oc on oc.client_id=reg.client_id and oc.status='OPEN'
  join agency_ops.onboarding_stages s on s.case_id=oc.id and s.stage_code='INTEGRATION_MEETING'
  where reg.chat_id=new.chat_id
  order by oc.updated_at desc,oc.id desc
  limit 1;

  if v_case_id is null or v_stage_status='DONE' then return new; end if;

  v_explicit_integration := v_norm ~ '(integracao|integrar|reuniao com (o )?(gt|gestor)|gestor de trafego)';
  v_competing_meeting_context := v_norm ~ '(formulario|formularios|produto[ +e&]*persona|persona|apresentacao|primeira reuniao|segunda reuniao|1a reuniao|2a reuniao)';

  select exists(
    select 1
    from agency_ops.onboarding_meeting_schedule_proposals p
    where p.case_id=v_case_id
      and p.stage_code='INTEGRATION_MEETING'
      and p.status='OPEN'
      and p.proposed_at>=coalesce(new.event_at,new.received_at,now())-interval '24 hours'
  ) into v_has_open_integration_proposal;

  -- A message explicitly about another onboarding meeting must never mutate integration.
  if v_competing_meeting_context and not v_explicit_integration then return new; end if;

  -- Before the integration phase, generic "reunião" text is insufficient evidence.
  -- Explicit integration context is still allowed so the team can schedule ahead.
  -- A short acknowledgement may also resolve a previously explicit open proposal.
  if coalesce(v_current_stage,'') not in (
      'INTEGRATION_MEETING','ACCESS_VALIDATION','CREATIVE_PRODUCTION','CREATIVE_APPROVAL',
      'READY_TO_LAUNCH','CAMPAIGN_LAUNCH','COMPLETED'
    )
    and not v_explicit_integration
    and not v_has_open_integration_proposal
  then
    return new;
  end if;

  v_is_team:=agency_ops.is_team_sender(new.sender_phone,new.sender_name,new.from_me);
  v_dt:=agency_ops.extract_ptbr_meeting_datetime(v_text,coalesce(new.event_at,new.received_at,now()));
  v_has_meeting_context:=v_explicit_integration or v_norm ~ '(reuniao|videochamada|google meet|meet\.google\.com)';
  v_is_reschedule:=v_norm ~ '(remarcar|remarc|reagendar|reagend|preciso mudar|mudar essa reuniao|outro horario|outro dia)';
  v_is_proposal:=v_dt is not null and v_norm ~ '(podemos|pode ser|consegue|conseguimos|disponibilidade|que tal|vamos fazer|fazer as|ser as|seria as|as [0-2]?[0-9](h|:))';

  if v_is_reschedule then
    update agency_ops.onboarding_stages
      set status='PENDING',due_at=null,completed_at=null,
          notes=concat_ws(' | ',nullif(notes,''),'Reagendamento detectado no WhatsApp; aguardando nova data confirmada')
      where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and status<>'DONE';
    update agency_ops.onboarding_stage_meet_links
      set is_current=false,updated_at=now()
      where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and is_current;
    update agency_ops.onboarding_meeting_schedule_proposals
      set status='SUPERSEDED',updated_at=now()
      where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and status='OPEN';
    if v_dt is not null then
      insert into agency_ops.onboarding_meeting_schedule_proposals(
        case_id,chat_id,proposed_at,proposed_for,proposer_is_team,source_message_id,
        source_whatsapp_message_id,proposal_text,metadata
      ) values(
        v_case_id,new.chat_id,coalesce(new.event_at,new.received_at,now()),v_dt,v_is_team,new.id,
        new.message_id,left(v_text,1200),jsonb_build_object('reschedule_message',true)
      );
    end if;
    perform agency_ops.recalculate_onboarding_case(v_case_id);
    return new;
  end if;

  if v_dt is not null and v_has_meeting_context and not v_is_proposal then
    update agency_ops.onboarding_stages
      set status='SCHEDULED',due_at=v_dt,blocked_type=null,completed_at=null,
          notes=concat_ws(' | ',nullif(notes,''),'Data/hora explícita de integração no WhatsApp: '||to_char(v_dt at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'))
      where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and status<>'DONE';
    update agency_ops.onboarding_meeting_schedule_proposals
      set status='SUPERSEDED',updated_at=now()
      where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and status='OPEN';
    perform agency_ops.recalculate_onboarding_case(v_case_id);
    return new;
  end if;

  if v_is_proposal then
    update agency_ops.onboarding_meeting_schedule_proposals
      set status='SUPERSEDED',updated_at=now()
      where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and status='OPEN';
    insert into agency_ops.onboarding_meeting_schedule_proposals(
      case_id,chat_id,proposed_at,proposed_for,proposer_is_team,source_message_id,
      source_whatsapp_message_id,proposal_text
    ) values(
      v_case_id,new.chat_id,coalesce(new.event_at,new.received_at,now()),v_dt,v_is_team,new.id,
      new.message_id,left(v_text,1200)
    );
  end if;

  v_is_ack:=v_norm ~ '(^|[^a-z])(sim([, ]+(combinado|pode|fechado))?|combinado|pode ser|fechado|perfeito|beleza|ok[, ]*(marcado|fechado)?|marcado)([^a-z]|$)';
  if v_is_ack then
    select * into v_prop
    from agency_ops.onboarding_meeting_schedule_proposals p
    where p.case_id=v_case_id
      and p.stage_code='INTEGRATION_MEETING'
      and p.status='OPEN'
      and p.proposed_at between coalesce(new.event_at,new.received_at,now())-interval '24 hours'
                            and coalesce(new.event_at,new.received_at,now())
      and (p.proposer_is_team is distinct from v_is_team or p.proposer_is_team is null)
    order by p.proposed_at desc,p.id desc
    limit 1;

    if v_prop.id is not null then
      update agency_ops.onboarding_meeting_schedule_proposals
        set status='CONFIRMED',confirmed_at=coalesce(new.event_at,new.received_at,now()),
            confirmed_by_message_id=new.id,updated_at=now()
        where id=v_prop.id;
      update agency_ops.onboarding_stages
        set status='SCHEDULED',due_at=v_prop.proposed_for,blocked_type=null,completed_at=null,
            notes=concat_ws(' | ',nullif(notes,''),'Agendamento confirmado por sequência de conversa no WhatsApp: '||to_char(v_prop.proposed_for at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'))
        where case_id=v_case_id and stage_code='INTEGRATION_MEETING' and status<>'DONE';
      perform agency_ops.recalculate_onboarding_case(v_case_id);
    end if;
  end if;

  return new;
end $$;
