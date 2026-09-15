create table if not exists agency_ops.daily_user_greetings (
  user_key text not null,
  greeting_date date not null,
  person text,
  role text,
  shown_at timestamptz not null default now(),
  is_monday boolean not null default false,
  audio_expected boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  primary key (user_key, greeting_date)
);

alter table agency_ops.daily_user_greetings enable row level security;

create index if not exists daily_user_greetings_shown_at_idx
  on agency_ops.daily_user_greetings(shown_at desc);

comment on table agency_ops.daily_user_greetings is
  'Registro idempotente do bom dia diário do OpsQuestion por usuário e data em America/Sao_Paulo.';
