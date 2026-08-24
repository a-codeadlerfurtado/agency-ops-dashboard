create table if not exists agency_ops.client_commercial_terms (
  client_id uuid primary key references agency_ops.clients(id) on delete cascade,
  monthly_value numeric(14,2),
  implementation_value numeric(14,2),
  term_months integer,
  implementation_payment text,
  implementation_installments numeric(14,2)[],
  notes text,
  source text not null default 'MANUAL',
  source_crm_lead_id uuid,
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint client_commercial_terms_nonnegative check ((monthly_value is null or monthly_value >= 0) and (implementation_value is null or implementation_value >= 0) and (term_months is null or term_months >= 0))
);

create index if not exists client_commercial_terms_updated_at_idx on agency_ops.client_commercial_terms(updated_at desc);

comment on table agency_ops.client_commercial_terms is 'Condições comerciais por cliente: mensalidade e implementação. Fonte manual ou CRM explicitamente vinculado; nunca usa matching fuzzy.';

create or replace function agency_ops.is_contract_viewer(p_user_key text)
returns boolean
language sql
stable
security definer
set search_path to 'agency_ops','pg_temp'
as $function$
  select exists (
    select 1
    from agency_ops.user_preferences up
    where up.user_key = p_user_key
      and up.collaborator_person in ('Adler Furtado','Leonardo Augusto')
  );
$function$;

insert into agency_ops.dashboard_view_permissions(view_key,scope_type,scope_value,allowed,note,updated_at)
values
('work','PERSON','Leonardo Augusto',false,'Central de Trabalho da direção usa área dedicada com visão de liderança',now()),
('team','PERSON','Leonardo Augusto',false,'Equipe da direção usa área dedicada com a mesma base do Adler',now())
on conflict (view_key,scope_type,scope_value) do update
set allowed=excluded.allowed,note=excluded.note,updated_at=now();
