-- Conta de anuncio que ninguem vinculou e' conta invisivel para o alerta de saldo.
--
-- O QUE A INVESTIGACAO ACHOU
-- O token da Meta enxerga 166 contas de anuncio. O sistema coletava 74.
--
-- Nao era falha do coletor: ele percorre agency_ops.client_integrations com
-- system='META_BM' e busca o saldo de cada meta_ad_account_id ali registrado. Um
-- coletor assim nunca descobre conta nova - so' confirma o que ja' sabe. Cliente sem
-- linha nessa tabela fica invisivel para sempre, com qualquer saldo.
--
-- Flavio Novaes tinha tres contas ao alcance do token e nenhuma linha ali. Ficou 15
-- dias fora do alerta com R$195,03 de saldo real numa delas.
--
-- Provado na pratica: registradas 5 linhas, o coletor passou de 75 para 80 contas no
-- disparo seguinte, sem uma alteracao de codigo.
--
-- JA' EXISTIA A FERRAMENTA
-- A Edge Function meta-account-discovery (v6, ativa) faz exatamente a varredura
-- necessaria - casa por nome de conta E por nome do Business Manager, cruza gasto e
-- leads desde a entrada do cliente. O proprio cabecalho dela diz: "ferramenta
-- pontual de investigacao. NAO faz parte do fluxo de cron. Nao escreve nada no
-- banco." Estava construida e desligada.
--
-- Esta migration nao reescreve nada disso: so' liga o que existia, semanalmente, e
-- manda a diferenca para a fila humana.

-- ---------------------------------------------------------------------------
-- 1. Vinculos encontrados na investigacao de 20/08
-- ---------------------------------------------------------------------------
-- Flavio Novaes: BM "BM - Flavio Novaes". A conta 570462906032244 existe mas esta'
-- DESABILITADA pela Meta por atividade incomum, entao fica de fora.
-- FB Negocios Imobiliarios: confirmado pelo gestor que e' a Fernanda Bohn.
insert into agency_ops.client_integrations
 (client_id, system, external_id, external_name, meta_ad_account_id, confidence, matched_by, is_primary)
select c.id, 'META_BM', v.acc, v.nome, v.acc, 'ALTA', 'MANUAL_DISCOVERY_20260820', v.prim
from (values
  ('Flávio Novaes','747573865006705','Conta 02 · BM - Flávio Novaes', true),
  ('Flávio Novaes','1848009015895725','fhn · BM - Flávio Novaes', false),
  ('FB Negócios Imobiliários','365116886891150','Fernanda Bohn Broker · FB Fernanda Bohn Broker Page', true),
  ('FB Negócios Imobiliários','970430360809932','Fernanda · FB Fernanda Bohn Broker Page', false),
  ('FB Negócios Imobiliários','4412145049107979','CA 02 - FERNANDA · FB Fernanda Bohn Broker Page', false)
) as v(cliente, acc, nome, prim)
join agency_ops.clients c on c.display_name = v.cliente
where not exists (select 1 from agency_ops.client_integrations i
                   where i.client_id = c.id and i.meta_ad_account_id = v.acc);

-- ---------------------------------------------------------------------------
-- 2. Descoberta semanal
-- ---------------------------------------------------------------------------
create or replace function agency_ops.invoke_meta_account_discovery()
returns bigint language plpgsql security definer set search_path to 'agency_ops','pg_catalog'
as $fn$
declare v_req bigint;
begin
  select net.http_post(
    url := 'https://bfzdetibfcwihfkltbkp.supabase.co/functions/v1/meta-account-discovery',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-meta-campaign-secret', (select value #>> '{}' from agency_ops.automation_settings
                                  where key='META_CAMPAIGN_SYNC_SECRET')),
    body := jsonb_build_object('list_all', true)) into v_req;
  update agency_ops.automation_settings
     set value = coalesce(value,'{}'::jsonb) || jsonb_build_object('last_request_id', v_req, 'fired_at', now()),
         updated_at = now()
   where key = 'meta_account_discovery';
  if not found then
    insert into agency_ops.automation_settings (key, value)
    values ('meta_account_discovery', jsonb_build_object('last_request_id', v_req, 'fired_at', now()));
  end if;
  return v_req;
end $fn$;

create or replace function agency_ops.process_meta_account_discovery()
returns integer language plpgsql security definer set search_path to 'agency_ops','pg_catalog'
as $fn$
declare v_req bigint; v_body jsonb; v_novos int := 0; v_total int;
begin
  select (value->>'last_request_id')::bigint into v_req
    from agency_ops.automation_settings where key='meta_account_discovery';
  if v_req is null then return 0; end if;

  select content::jsonb into v_body from net._http_response where id = v_req and status_code = 200;
  if v_body is null then return 0; end if;
  v_total := coalesce((v_body->>'total')::int, 0);

  -- Conta visivel ao token e sem vinculo com cliente e' invisivel para o alerta de
  -- saldo. Vai para a fila humana com o nome, em vez de simplesmente nao existir.
  insert into agency_ops.integration_match_review (system, external_id, external_name, candidates, reason)
  select 'META_AD_ACCOUNT', a->>'meta_ad_account_id',
         coalesce(nullif(a->>'name',''), a->>'meta_ad_account_id'), '[]'::jsonb,
         'Conta de anúncio visível ao token e sem cliente vinculado em client_integrations. '
         || 'Enquanto não for vinculada, o alerta de saldo não a enxerga. '
         || 'Vincular ao cliente ou marcar como não-cliente.'
  from jsonb_array_elements(v_body->'accounts') a
  where not exists (select 1 from agency_ops.client_integrations i
                     where i.meta_ad_account_id = a->>'meta_ad_account_id')
  on conflict (system, external_id) do nothing;
  get diagnostics v_novos = row_count;

  update agency_ops.automation_settings
     set value = value || jsonb_build_object('processed_at', now(), 'contas_visiveis', v_total,
                                             'novas_para_revisao', v_novos),
         updated_at = now()
   where key = 'meta_account_discovery';
  return v_novos;
end $fn$;

-- Segunda-feira de manha. O processamento sai 5 minutos depois porque net.http_post
-- e' assincrono: a resposta da Meta ainda nao chegou no instante do disparo.
select cron.schedule('meta_account_discovery_weekly','0 8 * * 1',
                     $c$select agency_ops.invoke_meta_account_discovery();$c$);
select cron.schedule('meta_account_discovery_process','5 8 * * 1',
                     $c$select agency_ops.process_meta_account_discovery();$c$);
