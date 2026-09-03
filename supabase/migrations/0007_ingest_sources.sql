-- Imobi-Board 0007 - ingestao de leads (spec 51 / 52 / 53 / 64)

-- Credencial por integracao: e o que permite ao endpoint publico de ingestao
-- resolver o tenant sem receber tenant_id no payload, que seria falsificavel.
create table imobi_board.ingest_sources (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references imobi_board.tenants(id) on delete cascade,
  integration  text not null check (integration in ('META_ADS','GOOGLE','SITE','WEBHOOK','CSV')),
  label        text not null,
  -- so o hash. O token em claro aparece uma unica vez, na criacao.
  token_sha256 text not null unique,
  queue_id     uuid references imobi_board.lead_queues(id) on delete set null,
  active       boolean not null default true,
  last_used_at timestamptz,
  created_at   timestamptz not null default now()
);
create index ingest_sources_tenant_idx on imobi_board.ingest_sources (tenant_id);

alter table imobi_board.ingest_sources enable row level security;
grant select on imobi_board.ingest_sources to authenticated;

-- ADMIN ve as integracoes do proprio tenant; o que ele le e o hash.
create policy ingest_sources_admin_select on imobi_board.ingest_sources
  for select to authenticated
  using (tenant_id = any ((select imobi_board_priv.admin_tenant_ids())::uuid[]));

-- Ponto unico de entrada. Roda com service role, a partir do Worker: resolve a
-- credencial, cria contato+oportunidade com deduplicacao e idempotencia, e
-- devolve a fila para o Worker disparar o Workflow de SLA.
create or replace function imobi_board.ingerir_lead(
  p_token_sha256      text,
  p_full_name         text,
  p_phone             text default null,
  p_email             text default null,
  p_attribution       jsonb default '{}'::jsonb,
  p_external_event_id text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_src      imobi_board.ingest_sources%rowtype;
  v_phone_n  text;
  v_email_n  text;
  v_contact  uuid;
  v_pipeline uuid;
  v_stage    uuid;
  v_opp      uuid;
  v_assign   uuid;
  v_novo     boolean := true;
begin
  select * into v_src from imobi_board.ingest_sources
  where token_sha256 = p_token_sha256 and active;

  if not found then
    raise exception 'Credencial de ingestao invalida.' using errcode = '42501';
  end if;

  update imobi_board.ingest_sources set last_used_at = now() where id = v_src.id;

  -- idempotencia (spec 64): a Meta reenvia o mesmo lead varias vezes
  if p_external_event_id is not null then
    select o.id into v_opp from imobi_board.opportunities o
    where o.tenant_id = v_src.tenant_id
      and o.source = v_src.integration
      and o.external_event_id = p_external_event_id;
    if v_opp is not null then
      return jsonb_build_object('opportunity_id', v_opp, 'duplicado', true);
    end if;
  end if;

  v_phone_n := imobi_board_priv.normalize_phone_br(p_phone);
  v_email_n := imobi_board_priv.normalize_email(p_email);

  if v_phone_n is not null then
    select c.id into v_contact from imobi_board.contacts c
    where c.tenant_id = v_src.tenant_id and c.phone_normalized = v_phone_n;
  end if;
  if v_contact is null and v_email_n is not null then
    select c.id into v_contact from imobi_board.contacts c
    where c.tenant_id = v_src.tenant_id and c.email_normalized = v_email_n;
  end if;

  if v_contact is null then
    insert into imobi_board.contacts
      (tenant_id, full_name, phone, phone_normalized, email, email_normalized)
    values (v_src.tenant_id, coalesce(nullif(btrim(p_full_name), ''), 'Sem nome'),
            p_phone, v_phone_n, p_email, v_email_n)
    returning id into v_contact;
    perform imobi_board_priv.emit_event(
      v_src.tenant_id, 'contact.created', 'contact', v_contact, '{}'::jsonb);
  else
    -- contato conhecido: completa lacunas sem sobrescrever o que ja havia.
    -- A oportunidade e criada de qualquer jeito (spec 17): evento novo nunca
    -- e descartado em silencio.
    v_novo := false;
    update imobi_board.contacts c
       set phone = coalesce(c.phone, p_phone),
           phone_normalized = coalesce(c.phone_normalized, v_phone_n),
           email = coalesce(c.email, p_email),
           email_normalized = coalesce(c.email_normalized, v_email_n)
     where c.id = v_contact;
  end if;

  select p.id into v_pipeline from imobi_board.pipelines p
  where p.tenant_id = v_src.tenant_id and p.is_default limit 1;

  select s.id into v_stage from imobi_board.pipeline_stages s
  where s.pipeline_id = v_pipeline order by s.sort_order limit 1;

  insert into imobi_board.opportunities (
    tenant_id, contact_id, pipeline_id, stage_id, source, source_detail,
    campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, form_id,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    external_source_id, external_event_id
  ) values (
    v_src.tenant_id, v_contact, v_pipeline, v_stage, v_src.integration, v_src.label,
    p_attribution ->> 'campaign_id',  p_attribution ->> 'campaign_name',
    p_attribution ->> 'adset_id',     p_attribution ->> 'adset_name',
    p_attribution ->> 'ad_id',        p_attribution ->> 'ad_name',
    p_attribution ->> 'form_id',
    p_attribution ->> 'utm_source',   p_attribution ->> 'utm_medium',
    p_attribution ->> 'utm_campaign', p_attribution ->> 'utm_content',
    p_attribution ->> 'utm_term',
    p_attribution ->> 'platform_lead_id', p_external_event_id
  ) returning id into v_opp;

  insert into imobi_board.activities (tenant_id, opportunity_id, type, body, created_by)
  values (v_src.tenant_id, v_opp, 'SYSTEM', 'Lead recebido por ' || v_src.label, null);

  perform imobi_board_priv.emit_event(
    v_src.tenant_id, 'opportunity.created', 'opportunity', v_opp,
    jsonb_build_object('source', v_src.integration, 'ingest_source_id', v_src.id));

  -- distribui na hora, se a credencial estiver ligada a uma fila
  if v_src.queue_id is not null then
    begin
      v_assign := imobi_board_priv.distribuir(v_opp, v_src.queue_id, 1::smallint, null);
    exception when others then
      v_assign := null;  -- fila vazia nao pode derrubar a ingestao
    end;
  end if;

  return jsonb_build_object(
    'opportunity_id', v_opp,
    'contact_id',     v_contact,
    'contato_novo',   v_novo,
    'tenant_id',      v_src.tenant_id,
    'assignment_id',  v_assign,
    'sla_segundos',   (select q.acceptance_timeout_seconds
                         from imobi_board.lead_queues q where q.id = v_src.queue_id),
    'duplicado',      false
  );
end;
$fn$;

revoke execute on function imobi_board.ingerir_lead(text, text, text, text, jsonb, text) from public;
grant execute on function imobi_board.ingerir_lead(text, text, text, text, jsonb, text) to service_role;
