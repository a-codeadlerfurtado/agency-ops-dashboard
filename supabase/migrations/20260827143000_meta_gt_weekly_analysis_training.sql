create table if not exists agency_ops.meta_gt_weekly_submissions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agency_ops.meta_performance_runs(id) on delete cascade,
  gt_person text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','SUBMITTED','REVISION_REQUESTED','REVIEWED')),
  portfolio_summary text,
  top_opportunities text,
  top_problems text,
  patterns_recognized text,
  forecast_next_week text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text,
  review_score numeric(4,2) check (review_score is null or (review_score >= 0 and review_score <= 10)),
  review_comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, gt_person)
);

create table if not exists agency_ops.meta_gt_client_analyses (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references agency_ops.meta_performance_runs(id) on delete cascade,
  gt_person text not null,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  evidence text,
  diagnosis text,
  hypothesis text,
  decision text,
  decision_reason text,
  expected_result text,
  risk_blocker text,
  next_validation text,
  lead_quality_consulted boolean,
  lead_quality_rating text check (lead_quality_rating is null or lead_quality_rating in ('EXCELLENT','GOOD','MIXED','POOR','VERY_POOR','UNSURE')),
  lead_quality_notes text,
  lead_quality_checked_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(run_id, gt_person, client_id)
);

create index if not exists idx_meta_gt_submissions_run_status on agency_ops.meta_gt_weekly_submissions(run_id,status,gt_person);
create index if not exists idx_meta_gt_client_analyses_run_gt on agency_ops.meta_gt_client_analyses(run_id,gt_person,client_id);

create or replace function agency_ops.touch_meta_gt_analysis_updated_at()
returns trigger
language plpgsql
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_meta_gt_weekly_submissions on agency_ops.meta_gt_weekly_submissions;
create trigger trg_touch_meta_gt_weekly_submissions
before update on agency_ops.meta_gt_weekly_submissions
for each row execute function agency_ops.touch_meta_gt_analysis_updated_at();

drop trigger if exists trg_touch_meta_gt_client_analyses on agency_ops.meta_gt_client_analyses;
create trigger trg_touch_meta_gt_client_analyses
before update on agency_ops.meta_gt_client_analyses
for each row execute function agency_ops.touch_meta_gt_analysis_updated_at();

alter table agency_ops.meta_gt_weekly_submissions enable row level security;
alter table agency_ops.meta_gt_client_analyses enable row level security;
revoke all on agency_ops.meta_gt_weekly_submissions from anon, authenticated;
revoke all on agency_ops.meta_gt_client_analyses from anon, authenticated;
grant all on agency_ops.meta_gt_weekly_submissions to service_role;
grant all on agency_ops.meta_gt_client_analyses to service_role;

create or replace function agency_ops.seed_meta_gt_weekly_analysis(p_run_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
declare
  v_run record;
  v_gt record;
  v_count integer := 0;
  v_clients integer := 0;
begin
  select id,snapshot_date,window_end,status into v_run
  from agency_ops.meta_performance_runs
  where id = p_run_id;
  if v_run.id is null then raise exception 'META_RUN_NOT_FOUND'; end if;
  if v_run.status not in ('COMPLETED','COMPLETED_WITH_ERRORS') then return 0; end if;

  for v_gt in
    select s.gt_owner as person, count(distinct s.client_id)::int as client_count
    from agency_ops.meta_performance_snapshots s
    join agency_ops.team_roster tr on tr.person = s.gt_owner and tr.role = 'GT' and tr.is_former = false
    where s.run_id = p_run_id and s.period_days = 7 and nullif(btrim(coalesce(s.gt_owner,'')),'') is not null
    group by s.gt_owner order by s.gt_owner
  loop
    insert into agency_ops.meta_gt_weekly_submissions(run_id,gt_person,status)
    values(p_run_id,v_gt.person,'DRAFT')
    on conflict(run_id,gt_person) do nothing;
    get diagnostics v_clients = row_count;
    v_count := v_count + v_clients;

    if not exists (select 1 from agency_ops.work_items wi where wi.source='meta_gt_analysis' and wi.source_id=(p_run_id::text || ':' || v_gt.person)) then
      insert into agency_ops.work_items(type,status,priority,title,description,source,source_id,created_by_person,target_role,target_person,metadata)
      values('GENERAL','OPEN','MEDIUM','Entregar análise Meta semanal',
        'Revise os snapshots de 3, 7, 14 e 30 dias da sua carteira, registre evidência, diagnóstico, hipótese, decisão, expectativa, riscos, próxima validação e a consulta de qualidade dos leads com o cliente. Finalize também a leitura geral da carteira e entregue pelo módulo de Análise Meta.',
        'meta_gt_analysis',p_run_id::text || ':' || v_gt.person,'Sistema','GT',v_gt.person,
        jsonb_build_object('meta_performance_run_id',p_run_id,'snapshot_date',v_run.snapshot_date,'route','/meta-analysis?run='||p_run_id::text,'required_clients',v_gt.client_count));
    end if;

    insert into agency_ops.platform_notifications(event_key,type,level,title,description,source,actor,occurred_at,metadata)
    values('meta_gt_analysis_required:'||p_run_id::text||':'||v_gt.person,'META_GT_ANALYSIS_REQUIRED','INFO','Análise Meta semanal disponível',
      v_gt.client_count::text || ' clientes da sua carteira estão prontos para análise. Registre sua leitura e entregue a rodada semanal.',
      'meta_gt_analysis','Sistema',now(),jsonb_build_object('private_to_person',true,'target_person',v_gt.person,'target_role','GT','meta_performance_run_id',p_run_id,'route','/meta-analysis?run='||p_run_id::text,'button_label','Fazer análise'))
    on conflict(event_key) do nothing;
  end loop;
  return v_count;
end;
$$;

create or replace function agency_ops.seed_meta_gt_weekly_analysis_on_run_complete()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog','agency_ops','public','extensions'
as $$
begin
  if new.status in ('COMPLETED','COMPLETED_WITH_ERRORS') and old.status is distinct from new.status then
    perform agency_ops.seed_meta_gt_weekly_analysis(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_seed_meta_gt_analysis_on_run_complete on agency_ops.meta_performance_runs;
create trigger trg_seed_meta_gt_analysis_on_run_complete
after update of status on agency_ops.meta_performance_runs
for each row execute function agency_ops.seed_meta_gt_weekly_analysis_on_run_complete();

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note)
values('meta_analysis','ROLE','GT',true,'Análise semanal de Performance Meta da própria carteira')
on conflict(view_key,scope_type,scope_value) do update set allowed=excluded.allowed,note=excluded.note;

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note)
values('meta_analysis','PERSON','Adler Furtado',true,'Revisão e download das análises Meta semanais dos GTs')
on conflict(view_key,scope_type,scope_value) do update set allowed=excluded.allowed,note=excluded.note;
