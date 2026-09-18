create table if not exists agency_ops.daily_lead_alert_explanations (
  notification_id uuid not null references agency_ops.platform_notifications(id) on delete cascade,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  alert_date date not null,
  gt_owner text not null,
  leads_count integer not null default 0 check (leads_count >= 0),
  reason_code text not null check (reason_code = any (array[
    'CLIENT_NO_RESPONSE'::text,
    'WAITING_AD_BALANCE'::text,
    'CLIENT_PAYMENT_PENDING'::text,
    'CLIENT_REQUESTED_PAUSE'::text,
    'NO_ACTIVE_CAMPAIGN'::text,
    'CAMPAIGN_REVIEW_OR_BLOCK'::text,
    'CAMPAIGN_DELIVERY_ISSUE'::text,
    'NEW_CAMPAIGN_LEARNING'::text,
    'TRACKING_OR_INTEGRATION'::text,
    'LOW_BUDGET'::text,
    'OTHER'::text
  ])),
  reason_detail text,
  action_taken text,
  follow_up_on date,
  submitted_by text not null,
  submitted_by_user_key text,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (notification_id),
  unique (client_id, alert_date)
);

create index if not exists daily_lead_alert_explanations_alert_date_idx
  on agency_ops.daily_lead_alert_explanations (alert_date desc);

create index if not exists daily_lead_alert_explanations_gt_owner_idx
  on agency_ops.daily_lead_alert_explanations (gt_owner, alert_date desc);

alter table agency_ops.daily_lead_alert_explanations enable row level security;

comment on table agency_ops.daily_lead_alert_explanations is
  'Justificativas estruturadas dos GTs para alertas diarios de zero/baixo volume de leads. Escrita ocorre pela Edge Function com service role; leitura direta de clientes fica bloqueada por RLS.';
