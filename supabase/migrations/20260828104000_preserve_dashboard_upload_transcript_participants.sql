create or replace function agency_ops.preserve_dashboard_upload_participants()
returns trigger
language plpgsql
as $$
begin
  if old.source_system = 'DASHBOARD_UPLOAD'
     and jsonb_typeof(coalesce(old.participants, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(old.participants, '[]'::jsonb)) > 0
     and (
       jsonb_typeof(coalesce(new.participants, '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(new.participants, '[]'::jsonb)) = 0
     ) then
    new.participants := old.participants;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_preserve_dashboard_upload_participants on agency_ops.meeting_transcripts;
create trigger trg_preserve_dashboard_upload_participants
before update of participants on agency_ops.meeting_transcripts
for each row
execute function agency_ops.preserve_dashboard_upload_participants();
