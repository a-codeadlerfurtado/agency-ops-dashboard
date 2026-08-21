-- Regra 43/44: evolui o Diario existente; nao cria uma tabela v2.
-- O historico legado permanece em agency_ops.client_adjustments.

create table if not exists agency_ops.adjustment_categories (
  code text primary key,
  label text not null unique,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  check (code ~ '^[A-Z0-9_]+$')
);

create table if not exists agency_ops.adjustment_subcategories (
  code text primary key,
  category_code text not null references agency_ops.adjustment_categories(code) on update cascade on delete restrict,
  label text not null,
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  unique (category_code,label),
  check (code ~ '^[A-Z0-9_]+$')
);

insert into agency_ops.adjustment_categories(code,label,sort_order) values
 ('CREATIVE','Criativo',10),('TRAFFIC','Tráfego',20),('CUSTOMER_SERVICE','Atendimento',30),('LANDING_PAGE','Landing Page',40),('CRM','CRM',50),('AUTOMATION','Automação',60),('COMMERCIAL_INFO','Informação comercial',70),('VISUAL_IDENTITY','Identidade visual',80),('TECHNICAL','Técnico',90),('OTHER','Outro',100)
on conflict (code) do update set label=excluded.label,sort_order=excluded.sort_order,active=true;

insert into agency_ops.adjustment_subcategories(code,category_code,label,sort_order) values
 ('CREATIVE_IMAGE_INCORRECT','CREATIVE','Imagem incorreta',10),('CREATIVE_EXCESS_INFORMATION','CREATIVE','Excesso de informação',20),('CREATIVE_VISUAL_IDENTITY','CREATIVE','Identidade visual',30),('CREATIVE_COPY','CREATIVE','Copy',40),('CREATIVE_INFORMATION_INCORRECT','CREATIVE','Informação incorreta',50),('CREATIVE_PRICE_INCORRECT','CREATIVE','Preço incorreto',60),('CREATIVE_AREA_INCORRECT','CREATIVE','Metragem incorreta',70),('CREATIVE_WRONG_PHOTO','CREATIVE','Foto errada',80),('CREATIVE_FORMAT','CREATIVE','Formato',90),('CREATIVE_OTHER','CREATIVE','Outro',100),
 ('TRAFFIC_SEGMENTATION','TRAFFIC','Segmentação',10),('TRAFFIC_CONFIGURATION','TRAFFIC','Configuração',20),('TRAFFIC_BUDGET','TRAFFIC','Orçamento',30),('TRAFFIC_CREATIVE','TRAFFIC','Criativo',40),('TRAFFIC_COMMERCIAL_REQUEST','TRAFFIC','Solicitação comercial',50),('TRAFFIC_OTHER','TRAFFIC','Outro',100),
 ('SERVICE_COMMUNICATION','CUSTOMER_SERVICE','Comunicação',10),('SERVICE_DELAY','CUSTOMER_SERVICE','Atraso',20),('SERVICE_ALIGNMENT','CUSTOMER_SERVICE','Alinhamento',30),('SERVICE_COMMERCIAL_REQUEST','CUSTOMER_SERVICE','Solicitação comercial',40),('SERVICE_OTHER','CUSTOMER_SERVICE','Outro',100),
 ('LP_COPY','LANDING_PAGE','Copy',10),('LP_INFORMATION_INCORRECT','LANDING_PAGE','Informação incorreta',20),('LP_DESIGN','LANDING_PAGE','Design',30),('LP_FORM','LANDING_PAGE','Formulário',40),('LP_TECHNICAL','LANDING_PAGE','Técnico',50),('LP_OTHER','LANDING_PAGE','Outro',100),
 ('CRM_CONFIGURATION','CRM','Configuração',10),('CRM_AUTOMATION','CRM','Automação',20),('CRM_DATA','CRM','Dados',30),('CRM_INTEGRATION','CRM','Integração',40),('CRM_OTHER','CRM','Outro',100),
 ('AUTOMATION_CONFIGURATION','AUTOMATION','Configuração',10),('AUTOMATION_INTEGRATION','AUTOMATION','Integração',20),('AUTOMATION_FLOW','AUTOMATION','Fluxo',30),('AUTOMATION_TECHNICAL','AUTOMATION','Técnico',40),('AUTOMATION_OTHER','AUTOMATION','Outro',100),
 ('COMMERCIAL_PRICE','COMMERCIAL_INFO','Preço',10),('COMMERCIAL_AREA','COMMERCIAL_INFO','Metragem',20),('COMMERCIAL_CONDITION','COMMERCIAL_INFO','Condição comercial',30),('COMMERCIAL_AVAILABILITY','COMMERCIAL_INFO','Disponibilidade',40),('COMMERCIAL_OTHER','COMMERCIAL_INFO','Outro',100),
 ('IDENTITY_COLORS','VISUAL_IDENTITY','Cores',10),('IDENTITY_LOGO','VISUAL_IDENTITY','Logo',20),('IDENTITY_TYPOGRAPHY','VISUAL_IDENTITY','Tipografia',30),('IDENTITY_DIRECTION','VISUAL_IDENTITY','Direção visual',40),('IDENTITY_OTHER','VISUAL_IDENTITY','Outro',100),
 ('TECH_BUG','TECHNICAL','Bug',10),('TECH_INTEGRATION','TECHNICAL','Integração',20),('TECH_ACCESS','TECHNICAL','Acesso',30),('TECH_DATA','TECHNICAL','Dados',40),('TECH_OTHER','TECHNICAL','Outro',100),('OTHER_OTHER','OTHER','Outro',100)
on conflict (code) do update set category_code=excluded.category_code,label=excluded.label,sort_order=excluded.sort_order,active=true;

alter table agency_ops.client_adjustments
  add column if not exists author_user_id uuid references auth.users(id) on delete set null,
  add column if not exists author_name_snapshot text,
  add column if not exists category_code text references agency_ops.adjustment_categories(code) on update cascade on delete restrict,
  add column if not exists subcategory_code text references agency_ops.adjustment_subcategories(code) on update cascade on delete restrict,
  add column if not exists reason text,
  add column if not exists request_origin text,
  add column if not exists requested_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists responsible_area text,
  add column if not exists status text,
  add column if not exists severity text,
  add column if not exists resolution text,
  add column if not exists is_recurrent boolean not null default false,
  add column if not exists parent_adjustment_id bigint references agency_ops.client_adjustments(id) on delete set null,
  add column if not exists created_at timestamptz,
  add column if not exists updated_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_by uuid references auth.users(id) on delete set null,
  add column if not exists clickup_task_id text,
  add column if not exists campaign_id text,
  add column if not exists creative_id text,
  add column if not exists request_id text,
  add column if not exists tasklog_id text references agency_ops.task_log_entries(id) on delete set null;

-- Autoria legada so e convertida quando o UUID guardado no metadata existe de fato em auth.users.
update agency_ops.client_adjustments ca
set author_user_id=au.id,
    created_by=coalesce(ca.created_by,au.id),
    author_name_snapshot=coalesce(ca.author_name_snapshot,nullif(ca.metadata->>'author_name',''))
from auth.users au
where ca.author_user_id is null
  and ca.metadata ? 'author_user_key'
  and au.id::text=ca.metadata->>'author_user_key';

update agency_ops.client_adjustments
set author_name_snapshot=coalesce(author_name_snapshot,nullif(metadata->>'author_name',''),responsible_person)
where author_name_snapshot is null;

-- Classifica legado apenas quando o proprio tipo existente fornece evidencia direta.
update agency_ops.client_adjustments
set category_code=case
  when lower(coalesce(tipo,'')) like '%atendimento%' then 'CUSTOMER_SERVICE'
  when lower(coalesce(tipo,'')) like '%criativ%' or lower(coalesce(tipo,'')) like '%arte%' then 'CREATIVE'
  when lower(coalesce(tipo,'')) like '%campanh%' or lower(coalesce(tipo,'')) like '%tráfego%' or lower(coalesce(tipo,'')) like '%trafego%' then 'TRAFFIC'
  when lower(coalesce(tipo,'')) like '%landing%' then 'LANDING_PAGE'
  when lower(coalesce(tipo,'')) like '%crm%' then 'CRM'
  when lower(coalesce(tipo,'')) like '%automa%' then 'AUTOMATION'
  when lower(coalesce(tipo,'')) like '%identidade%' then 'VISUAL_IDENTITY'
  when lower(coalesce(tipo,'')) like '%técnic%' or lower(coalesce(tipo,'')) like '%tecnic%' then 'TECHNICAL'
  else category_code end
where category_code is null;

-- Nao inventa data de registro/status historico de registros antigos.
update agency_ops.client_adjustments set status='LEGACY_UNKNOWN' where status is null;
alter table agency_ops.client_adjustments alter column status set default 'OPEN';
alter table agency_ops.client_adjustments alter column status set not null;
alter table agency_ops.client_adjustments alter column created_at set default now();
alter table agency_ops.client_adjustments alter column updated_at set default now();

alter table agency_ops.client_adjustments drop constraint if exists client_adjustments_status_check;
alter table agency_ops.client_adjustments add constraint client_adjustments_status_check check(status in ('OPEN','IN_PROGRESS','RESOLVED','DISCARDED','LEGACY_UNKNOWN'));
alter table agency_ops.client_adjustments drop constraint if exists client_adjustments_severity_check;
alter table agency_ops.client_adjustments add constraint client_adjustments_severity_check check(severity is null or severity in ('LOW','MEDIUM','HIGH','CRITICAL'));
alter table agency_ops.client_adjustments drop constraint if exists client_adjustments_origin_check;
alter table agency_ops.client_adjustments add constraint client_adjustments_origin_check check(request_origin is null or request_origin in ('CLIENT','CS','GT','DESIGN','OPS','COMMERCIAL','INTERNAL_AUDIT','OTHER'));
alter table agency_ops.client_adjustments drop constraint if exists client_adjustments_area_check;
alter table agency_ops.client_adjustments add constraint client_adjustments_area_check check(responsible_area is null or responsible_area in ('DESIGN','TRAFFIC','CS','OPS','COMMERCIAL','DEVELOPMENT','CLIENT','EXTERNAL'));

create index if not exists idx_client_adjustments_author_occurred on agency_ops.client_adjustments(author_user_id,occurred_at desc);
create index if not exists idx_client_adjustments_client_occurred on agency_ops.client_adjustments(client_id,occurred_at desc);
create index if not exists idx_client_adjustments_category on agency_ops.client_adjustments(category_code,subcategory_code);
create index if not exists idx_client_adjustments_status on agency_ops.client_adjustments(status,occurred_at desc);

alter table agency_ops.task_log_entries add column if not exists author_user_id uuid references auth.users(id) on delete set null;
update agency_ops.task_log_entries tle set author_user_id=au.id from auth.users au where tle.author_user_id is null and au.id::text=tle.user_key;
create index if not exists idx_task_log_author_date on agency_ops.task_log_entries(author_user_id,task_date desc);
