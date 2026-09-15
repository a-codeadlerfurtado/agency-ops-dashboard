create table if not exists agency_ops.platform_notification_resolutions (
  notification_id uuid not null references agency_ops.platform_notifications(id) on delete cascade,
  user_key text not null,
  resolved_at timestamptz not null default now(),
  resolved_by text null,
  resolution_note text null,
  primary key (notification_id, user_key)
);

create index if not exists platform_notification_resolutions_user_idx
  on agency_ops.platform_notification_resolutions(user_key, resolved_at desc);

comment on table agency_ops.platform_notification_resolutions is
  'Per-user resolution state for dashboard notifications. Resolved items leave the bell queue but remain available in notification history.';
