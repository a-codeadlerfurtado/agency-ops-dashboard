-- Radar de Anuncios: assisted review of newly produced pieces.
-- This is advisory only: no AI result approves, rejects, blocks, or publishes a creative.

create table if not exists agency_ops.ad_radar_piece_reviews (
  id uuid primary key default gen_random_uuid(),
  context_id uuid not null references agency_ops.ad_radar_product_contexts(id) on delete cascade,
  direction_id uuid references agency_ops.ad_radar_directions(id) on delete set null,
  preapproval_item_id bigint references agency_ops.creative_preapproval_items(id) on delete set null,
  storage_bucket text not null,
  storage_path text not null,
  file_name text,
  media_type text not null,
  model_name text,
  prompt_version text,
  source_scope text not null default 'PRODUCED_PIECE_IMAGE',
  visual_analysis jsonb not null default '{}'::jsonb,
  objective_checks jsonb not null default '[]'::jsonb,
  subjective_suggestions jsonb not null default '[]'::jsonb,
  status text not null default 'REVIEWED' check (status in ('REVIEWED','ANALYSIS_FAILED')),
  limitations text,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists ad_radar_piece_reviews_context_idx
  on agency_ops.ad_radar_piece_reviews(context_id, created_at desc);

create index if not exists ad_radar_piece_reviews_direction_idx
  on agency_ops.ad_radar_piece_reviews(direction_id, created_at desc);

alter table agency_ops.ad_radar_piece_reviews enable row level security;
revoke all on agency_ops.ad_radar_piece_reviews from public, anon, authenticated;
grant all on agency_ops.ad_radar_piece_reviews to service_role;
