-- Imobi-Board 0032 - lead que entra e nao distribui deixava de contar por que
--
-- ingerir_lead engolia qualquer erro da distribuicao para nao derrubar a
-- ingestao -- o que esta certo: perder o lead e pior do que ele ficar sem
-- dono. O problema e que o motivo sumia junto. Na pratica: o lead aparecia
-- na lista sem corretor e sem prazo, e nao havia onde olhar.
--
-- Agora o motivo vai para ingest_sources.last_error, que a tela de
-- Integracoes ja mostra. O lead continua entrando.
--
-- Foi esta mudanca que revelou a causa da 0033.

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
  v_expira   timestamptz;
  v_erro     text;
begin
  select * into v_src from imobi_board.ingest_sources
  where token_sha256 = p_token_sha256 and active;
  if not found then
    raise exception 'Credencial de ingestao invalida.' using errcode = '42501';
  end if;

  update imobi_board.ingest_sources set last_used_at = now() where id = v_src.id;

  if p_external_event_id is not null then
    select o.id into v_opp from imobi_board.opportunities o
    where o.tenant_id = v_src.tenant_id and o.source = v_src.integration
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

  if v_src.queue_id is not null then
    begin
      v_assign := imobi_board_priv.distribuir(v_opp, v_src.queue_id, 1::smallint, null);
      select expires_at into v_expira
      from imobi_board.lead_assignments where id = v_assign;
      -- distribuiu: limpa erro antigo para a tela nao mentir
      update imobi_board.ingest_sources
         set last_error = null, last_error_at = null where id = v_src.id;
    exception when others then
      -- O lead JA esta salvo. Falhar aqui nao pode desfazer isso -- perder o
      -- lead e pior do que ele ficar sem dono. Mas o motivo passa a ficar
      -- registrado, em vez de sumir.
      v_assign := null;
      v_erro := sqlerrm;
      update imobi_board.ingest_sources
         set last_error = 'Lead entrou mas nao foi distribuido: ' || left(v_erro, 300),
             last_error_at = now()
       where id = v_src.id;
    end;
  else
    update imobi_board.ingest_sources
       set last_error = 'Lead entrou sem fila: fica na lista sem corretor e sem prazo.',
           last_error_at = now()
     where id = v_src.id;
  end if;

  return jsonb_build_object(
    'opportunity_id', v_opp,
    'contact_id',     v_contact,
    'contato_novo',   v_novo,
    'tenant_id',      v_src.tenant_id,
    'assignment_id',  v_assign,
    'sla_expira_em',  v_expira,
    'distribuicao_falhou', v_erro,
    'sla_segundos',   case when v_expira is not null
                           then greatest(ceil(extract(epoch from (v_expira - now())))::int, 30)
                      end,
    'duplicado',      false
  );
end;
$fn$;

revoke execute on function imobi_board.ingerir_lead(text, text, text, text, jsonb, text) from public;
grant execute on function imobi_board.ingerir_lead(text, text, text, text, jsonb, text) to service_role;
