create or replace function agency_ops.sync_commercial_call_transcript()
returns trigger
language plpgsql
security definer
set search_path = agency_ops, public
as $$
begin
  if new.transcript_id is not null
     and new.transcript_id is distinct from old.transcript_id then
    update agency_ops.commercial_call_records
       set transcript_id = new.transcript_id,
           updated_at = now()
     where capture_session_id = new.id
       and transcript_id is distinct from new.transcript_id;

    update agency_ops.commercial_prospect_profiles p
       set last_transcript_id = new.transcript_id,
           updated_at = now()
      from agency_ops.commercial_call_records c
     where c.capture_session_id = new.id
       and p.lead_id = c.lead_id
       and p.last_transcript_id is distinct from new.transcript_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_commercial_call_transcript
  on agency_ops.meeting_capture_sessions;

create trigger trg_sync_commercial_call_transcript
after update of transcript_id on agency_ops.meeting_capture_sessions
for each row
execute function agency_ops.sync_commercial_call_transcript();

update agency_ops.commercial_call_records c
   set transcript_id = s.transcript_id,
       updated_at = now()
  from agency_ops.meeting_capture_sessions s
 where c.capture_session_id = s.id
   and s.transcript_id is not null
   and c.transcript_id is distinct from s.transcript_id;
update agency_ops.commercial_prospect_profiles p
   set last_transcript_id = c.transcript_id,
       updated_at = now()
  from agency_ops.commercial_call_records c
 where p.lead_id = c.lead_id
   and c.transcript_id is not null
   and p.last_transcript_id is distinct from c.transcript_id;
