-- Restaura o título das reuniões antigas já notificadas.
-- Para alertas novos, a edge function agency-ops-google-calendar-watch grava
-- google_calendar_event_title diretamente no metadata e na descrição.
-- Idempotente: só preenche quando o título ainda não estiver presente.
with matched as (
  select p.id, s.title
  from agency_ops.platform_notifications p
  join agency_ops.google_calendar_event_state s
    on s.account_id::text = split_part(p.event_key, ':', 2)
   and s.event_id = p.metadata->>'google_calendar_event_id'
  where p.type in (
    'GOOGLE_CALENDAR_MEETING_CREATED',
    'GOOGLE_CALENDAR_MEETING_RESCHEDULED',
    'GOOGLE_CALENDAR_MEETING_CANCELLED'
  )
    and coalesce(btrim(p.metadata->>'google_calendar_event_title'), '') = ''
    and coalesce(btrim(s.title), '') <> ''
)
update agency_ops.platform_notifications p
set metadata = coalesce(p.metadata, '{}'::jsonb)
      || jsonb_build_object('google_calendar_event_title', m.title),
    description = case
      when coalesce(p.description, '') like 'Título da reunião:%' then p.description
      else 'Título da reunião: ' || m.title || E'\n' || coalesce(p.description, '')
    end
from matched m
where p.id = m.id;
