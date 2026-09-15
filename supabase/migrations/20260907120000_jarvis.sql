-- Jarvis: catalogo de ferramentas, acoes pendentes e rondas automaticas.
--
-- O agente nao tem permissao propria. Toda execucao de ferramenta reusa o JWT
-- do usuario logado, entao o alcance dele e exatamente o alcance da pessoa.
-- Este catalogo diz o que EXISTE; quem pode o que continua sendo decidido pela
-- edge function de destino.
--
-- Idempotente: pode rodar duas vezes sem estragar nada.

create table if not exists agency_ops.jarvis_tools (
  name            text primary key,
  description     text not null,
  input_schema    jsonb not null,
  edge_function   text not null,
  http_method     text not null default 'POST' check (http_method in ('GET','POST')),
  path_suffix     text default '',
  body_template   jsonb default '{}'::jsonb,
  mode            text not null check (mode in ('read','write')),
  requires_confirmation boolean not null default false,
  roles_allowed   text[] not null default array['MGMT','GT','CS','DESIGN','AI'],
  result_max_chars int not null default 3000,
  enabled         boolean not null default true,
  created_at      timestamptz not null default now()
);

-- Escrita sem confirmacao seria um agente com a mao solta. A regra vira
-- constraint para nao depender de disciplina de quem semeia o catalogo.
do $$ begin
  alter table agency_ops.jarvis_tools
    add constraint jarvis_tools_write_exige_confirmacao
    check (mode = 'read' or requires_confirmation);
exception when duplicate_object then null; end $$;

create table if not exists agency_ops.jarvis_pending_actions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null,
  conversation_id uuid,
  tool_name       text not null references agency_ops.jarvis_tools(name),
  arguments       jsonb not null,
  summary         text not null,
  status          text not null default 'PENDING'
                    check (status in ('PENDING','CONFIRMED','CANCELLED','EXECUTED','FAILED')),
  result          jsonb,
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);
create index if not exists jarvis_pending_actions_user_idx
  on agency_ops.jarvis_pending_actions (user_id, status, created_at desc);

create table if not exists agency_ops.jarvis_routines (
  key             text primary key,
  title           text not null,
  prompt          text not null,
  tools_allowed   text[] not null,
  notify_roles    text[] not null default array['MGMT'],
  enabled         boolean not null default true,
  last_run_at     timestamptz,
  last_result     jsonb
);

/* ------------------------------------------------------------------ RLS --- */

alter table agency_ops.jarvis_tools           enable row level security;
alter table agency_ops.jarvis_pending_actions enable row level security;
alter table agency_ops.jarvis_routines        enable row level security;

revoke all on agency_ops.jarvis_tools, agency_ops.jarvis_routines from anon, authenticated;
grant  all on agency_ops.jarvis_tools, agency_ops.jarvis_routines to service_role;
grant  all on agency_ops.jarvis_pending_actions to service_role;
grant  select, update on agency_ops.jarvis_pending_actions to authenticated;

-- O usuario ve e resolve apenas as proprias pendencias.
do $$ begin
  create policy jarvis_pending_self_select on agency_ops.jarvis_pending_actions
    for select to authenticated using (user_id = (select auth.uid()));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy jarvis_pending_self_update on agency_ops.jarvis_pending_actions
    for update to authenticated
    using (user_id = (select auth.uid()))
    with check (user_id = (select auth.uid()));
exception when duplicate_object then null; end $$;

/* -------------------------------------------------------------- catalogo --- */

create or replace function agency_ops.jarvis_tool_catalog(p_role text)
returns setof agency_ops.jarvis_tools
language sql stable security definer set search_path = '' as $$
  select * from agency_ops.jarvis_tools
  where enabled and p_role = any(roles_allowed)
  order by mode, name;
$$;

revoke execute on function agency_ops.jarvis_tool_catalog(text) from public, anon;
grant  execute on function agency_ops.jarvis_tool_catalog(text) to service_role, authenticated;

/* ------------------------------------------------------- seed do catalogo --- */
--
-- Os schemas abaixo foram derivados do codigo de cada edge function, nao
-- presumidos. Tres casos merecem registro:
--
--  * work-center-api e required-alerts-api: o POST delas e MUTACAO
--    (work-item-update / ACK). A leitura e o GET. Registrar o POST como
--    ferramenta de leitura teria dado ao agente uma escrita disfarcada.
--  * leonardo-clickup-api so aceita GET -- nao cria task. A criacao de task no
--    ClickUp acontece por work-item-create-api com create_clickup: true.

insert into agency_ops.jarvis_tools
  (name, description, input_schema, edge_function, http_method, body_template,
   mode, requires_confirmation, roles_allowed, result_max_chars)
values
  ('consultar_cliente_360',
   'Consulta a visao completa de um cliente: situacao, responsaveis, pendencias e historico.',
   '{"type":"object","properties":{"name":{"type":"string","description":"nome do cliente"},"client_id":{"type":"string","description":"id, quando conhecido"}},"required":[]}'::jsonb,
   'agency-ops-client-360-api','GET','{}'::jsonb,'read',false,array['MGMT','GT','CS'],3000),

  ('listar_trabalho_aberto',
   'Lista demandas internas abertas do Work Center, por cliente ou por responsavel.',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   'agency-ops-work-center-api','GET','{}'::jsonb,'read',false,array['MGMT','GT','CS','DESIGN'],3000),

  ('saude_dos_clientes',
   'Mostra risco, sinais de churn e quais clientes precisam de atencao agora.',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   'agency-ops-client-health','GET','{}'::jsonb,'read',false,array['MGMT','GT','CS','AI'],3000),

  ('performance_meta',
   'Traz metricas de campanhas Meta de um cliente: investimento, leads e custo por lead.',
   '{"type":"object","properties":{"client_name":{"type":"string"},"client_id":{"type":"string"}},"required":[]}'::jsonb,
   'agency-ops-meta-performance-api','GET','{}'::jsonb,'read',false,array['MGMT','GT'],3000),

  ('campanhas_cliente',
   'Lista campanhas e o status de cada uma.',
   '{"type":"object","properties":{"lifecycle":{"type":"string"},"since":{"type":"string","description":"AAAA-MM-DD"},"until":{"type":"string","description":"AAAA-MM-DD"}},"required":[]}'::jsonb,
   'agency-ops-campaigns-api','GET','{}'::jsonb,'read',false,array['MGMT','GT'],3000),

  ('onboarding_status',
   'Informa em que etapa cada onboarding esta e quais prazos correm risco.',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   'agency-ops-onboarding-overview-api','GET','{}'::jsonb,'read',false,array['MGMT','CS','GT'],3000),

  ('contratos',
   'Consulta vigencia, vencimento e renovacao de contratos.',
   '{"type":"object","properties":{"client_id":{"type":"string"}},"required":[]}'::jsonb,
   'agency-ops-contracts-api','GET','{}'::jsonb,'read',false,array['MGMT'],2500),

  ('reunioes_recentes',
   'Busca reunioes recentes e o que ficou registrado nelas.',
   '{"type":"object","properties":{"client_id":{"type":"string"},"from":{"type":"string","description":"AAAA-MM-DD"},"to":{"type":"string","description":"AAAA-MM-DD"},"q":{"type":"string","description":"termo de busca"},"limit":{"type":"integer","maximum":20}},"required":[]}'::jsonb,
   'agency-ops-meetings-api','GET','{}'::jsonb,'read',false,array['MGMT','GT','CS'],3000),

  ('alertas_obrigatorios',
   'Lista os alertas que exigem acao hoje.',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   'agency-ops-required-alerts-api','GET','{}'::jsonb,'read',false,array['MGMT','GT','CS','DESIGN'],2500),

  ('consulta_sql_leitura',
   'Ultimo recurso: responde por consulta direta quando nenhuma outra ferramenta cobre a pergunta.',
   '{"type":"object","properties":{"sql":{"type":"string","description":"um unico SELECT sobre views de agency_ops, com LIMIT"}},"required":["sql"]}'::jsonb,
   'agency-ops-run-readonly-sql','POST','{}'::jsonb,'read',false,array['MGMT'],2500),

  ('criar_demanda',
   'Abre uma demanda interna para GT, CS, Design ou Operacoes.',
   '{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"type":{"type":"string","enum":["ESCALATION","CREATIVE_REQUEST","TECHNICAL","CLIENT_FOLLOWUP","CLICKUP","FINANCE","GENERAL"]},"priority":{"type":"string","enum":["CRITICAL","HIGH","MEDIUM","LOW"]},"target_role":{"type":"string"},"target_person":{"type":"string"},"client_id":{"type":"string"},"due_at":{"type":"string"}},"required":["title"]}'::jsonb,
   'agency-ops-work-item-create-api','POST','{"source":"jarvis"}'::jsonb,'write',true,array['MGMT','GT','CS'],1500),

  ('reatribuir_demanda',
   'Troca o responsavel por uma demanda existente.',
   '{"type":"object","properties":{"work_item_id":{"type":"string"},"target_person":{"type":"string"},"reason":{"type":"string"}},"required":["work_item_id","target_person"]}'::jsonb,
   'agency-ops-work-item-reassign-api','POST','{}'::jsonb,'write',true,array['MGMT','GT','CS','DESIGN'],1500),

  ('acao_campanha',
   'Pausa ou reativa uma campanha de um cliente.',
   '{"type":"object","properties":{"client_name":{"type":"string"},"campaign_name":{"type":"string"},"account_key":{"type":"string"},"desired_status":{"type":"string","enum":["ACTIVE","PAUSED"]}},"required":["client_name","campaign_name","desired_status"]}'::jsonb,
   'agency-ops-campaign-inline-action-v2','POST','{}'::jsonb,'write',true,array['MGMT','GT'],1500),

  ('anotar_campanha',
   'Registra uma nota em uma campanha.',
   '{"type":"object","properties":{"client_name":{"type":"string"},"campaign_name":{"type":"string"},"account_key":{"type":"string"},"note":{"type":"string"}},"required":["client_name","campaign_name","note"]}'::jsonb,
   'agency-ops-campaign-notes-api','POST','{}'::jsonb,'write',true,array['MGMT','GT'],1500),

  ('criar_task_clickup',
   'Cria uma demanda que tambem vira task no ClickUp.',
   '{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string"},"target_person":{"type":"string"},"client_id":{"type":"string"},"due_at":{"type":"string"}},"required":["title"]}'::jsonb,
   'agency-ops-work-item-create-api','POST','{"source":"jarvis","create_clickup":true,"type":"CLICKUP"}'::jsonb,'write',true,array['MGMT','GT'],1500),

  ('registrar_diario',
   'Registra uma anotacao no diario operacional do dia.',
   '{"type":"object","properties":{"report_date":{"type":"string","description":"AAAA-MM-DD"},"report_text":{"type":"string"}},"required":["report_text"]}'::jsonb,
   'agency-ops-diary-api','POST','{}'::jsonb,'write',true,array['MGMT','GT','CS','DESIGN','AI'],1200),

  ('comando_onboarding',
   'Avanca ou marca uma etapa de onboarding.',
   '{"type":"object","properties":{"command":{"type":"string","description":"comando em texto, como o painel de onboarding aceita"}},"required":["command"]}'::jsonb,
   'agency-ops-onboarding-command-api','POST','{}'::jsonb,'write',true,array['MGMT','CS','GT'],1500)
on conflict (name) do update set
  description = excluded.description,
  input_schema = excluded.input_schema,
  edge_function = excluded.edge_function,
  http_method = excluded.http_method,
  body_template = excluded.body_template,
  mode = excluded.mode,
  requires_confirmation = excluded.requires_confirmation,
  roles_allowed = excluded.roles_allowed,
  result_max_chars = excluded.result_max_chars;

/* --------------------------------------------------------- seed de rondas --- */

insert into agency_ops.jarvis_routines (key, title, prompt, tools_allowed, notify_roles)
values
  ('leads_sem_resposta','Leads e clientes sem resposta',
   'Liste clientes com compromisso vencido ou sem resposta ha mais de 24h. No maximo 5 itens, cada um com cliente, o que esta parado e quem e o responsavel.',
   array['saude_dos_clientes','listar_trabalho_aberto','alertas_obrigatorios','campanhas_cliente','performance_meta','contratos','consulta_sql_leitura'],
   array['MGMT']),
  ('campanhas_em_risco','Campanhas em risco',
   'Aponte campanhas ativas com saldo baixo, custo por lead acima do dobro da media do cliente, ou entrega zerada nos ultimos 2 dias.',
   array['saude_dos_clientes','listar_trabalho_aberto','alertas_obrigatorios','campanhas_cliente','performance_meta','contratos','consulta_sql_leitura'],
   array['MGMT']),
  ('contratos_vencendo','Contratos vencendo',
   'Contratos com vencimento nos proximos 15 dias ou com renovacao pendente.',
   array['saude_dos_clientes','listar_trabalho_aberto','alertas_obrigatorios','campanhas_cliente','performance_meta','contratos','consulta_sql_leitura'],
   array['MGMT'])
on conflict (key) do update set
  title = excluded.title, prompt = excluded.prompt,
  tools_allowed = excluded.tools_allowed, notify_roles = excluded.notify_roles;

/* ---------------------------------------------- insercao pelo proprio dono --- */
--
-- O Worker grava a pendencia com o JWT do usuario, nao com service role: assim
-- a Jarvis continua sem permissao propria. O with check amarra a linha ao dono.

grant insert on agency_ops.jarvis_pending_actions to authenticated;

do $$ begin
  create policy jarvis_pending_self_insert on agency_ops.jarvis_pending_actions
    for insert to authenticated with check (user_id = (select auth.uid()));
exception when duplicate_object then null; end $$;
