-- Lista/cobertura canônica de lifecycle para o Jarvis.
-- Mantém o escopo no banco e não depende do contexto textual do workspace.
create or replace function agency_ops.jarvis_lifecycle_snapshot(p_lifecycle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_person text;
  v_role text;
  v_lifecycle text := upper(trim(coalesce(p_lifecycle, '')));
  v_clients jsonb;
  v_count integer;
begin
  if v_lifecycle not in ('ACTIVE','ONBOARDING','CHURNED','PROSPECT') then
    return jsonb_build_object('ok', false, 'error', 'invalid_lifecycle');
  end if;

  select tr.person, upper(tr.role) into v_person, v_role
  from agency_ops.user_preferences up
  join agency_ops.team_roster tr on tr.person = up.collaborator_person and tr.is_former = false
  where up.user_key = auth.uid()::text
  limit 1;

  if v_role is null then return null; end if;
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'client_id', s.client_id,
           'display_name', s.display_name,
           'lifecycle', s.lifecycle,
           'gt_owner', s.gt_owner,
           'cs_owner', s.cs_owner,
           'designer_owner', s.designer_owner
         ) order by s.display_name), '[]'::jsonb)
    into v_count, v_clients
  from agency_ops.jarvis_client_state s
  where upper(coalesce(s.lifecycle,'')) = v_lifecycle
    and (
      v_role = 'MGMT'
      or (v_role = 'GT' and s.gt_owner = v_person)
      or (v_role = 'CS' and s.cs_owner = v_person)
      or (v_role = 'DESIGN' and s.designer_owner = v_person)
    );

  return jsonb_build_object(
    'ok', true,
    'lifecycle', v_lifecycle,
    'count', coalesce(v_count,0),
    'clients', coalesce(v_clients,'[]'::jsonb),
    'updated_at', now()
  );
end;
$$;
revoke execute on function agency_ops.jarvis_lifecycle_snapshot(text) from public, anon;
grant execute on function agency_ops.jarvis_lifecycle_snapshot(text) to authenticated, service_role;
