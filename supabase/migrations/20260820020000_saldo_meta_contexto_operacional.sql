-- Auditoria GT × API do saldo Meta Ads: o que a investigacao encontrou e corrigiu.
--
-- DIAGNOSTICO
-- Nao havia bug de coleta. As 75 contas estao vinculadas (zero orfas), todas as
-- sincronizacoes das ultimas 36h retornaram SUCCESS, e o alerta estava em sincronia
-- com a tabela de saldo. As divergencias tinham quatro origens distintas:
--
--   1. Horario (8 de 12 casos). O resumo saiu 08:04 sobre a coleta das 07:40; o
--      print do GT foi feito depois; o banco ja' estava mais adiante. Colocando as
--      tres leituras lado a lado, a queda e' monotonica em todos os oito. Nao e'
--      divergencia, e' saldo sendo consumido.
--   2. Recarga do cliente (Wanessa, NC Imoveis). O alerta estava certo quando saiu.
--   3. Cartao pos-pago. 20 contas gravam balance_source='not_applicable_postpaid' e
--      sao excluidas de proposito - em conta pos-paga nao existe saldo disponivel.
--      Mas sumiam em silencio.
--   4. Cliente sem conta Meta vinculada. 26 dos 92 clientes ativos de marketing.
--      Essa era a maior lacuna, e nao estava na lista de suspeitas.
--
-- Caio Montenegro nao estava duplicado: ele tem tres contas de anuncio, duas
-- cruzaram o limiar. Era o unico cliente com mais de uma conta em toda a base.
--
-- O QUE MUDA
-- O resumo passa a dizer de quando e' o numero, a distinguir cobranca de anotacao
-- do GT, a identificar a conta quando o cliente tem mais de uma, e a declarar o que
-- esta fora do seu alcance.

-- ---------------------------------------------------------------------------
-- 1. Anotacao operacional do GT
-- ---------------------------------------------------------------------------
-- Convive com o saldo da Meta: nunca sobrescreve o numero, so' decide o que fazer
-- com ele. Sem isso, "R$0,00 no juridico" e "R$0,00 e ninguem cobrou" geram a mesma
-- cobranca diaria.
create table if not exists agency_ops.client_billing_notes (
  id bigserial primary key,
  client_id uuid not null references agency_ops.clients(id) on delete cascade,
  account_key text,
  kind text not null check (kind in
    ('COBRADO','NAO_COBRAR','PAGAMENTO_PROGRAMADO','ERRO_PAGAMENTO','SEM_RESPOSTA','OBSERVACAO')),
  note text,
  reference_date date,
  valid_until date,
  created_by text not null default 'GT',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists client_billing_notes_client_idx
  on agency_ops.client_billing_notes (client_id, kind, valid_until);

create or replace function agency_ops.billing_note_ativa(p_valid_until date)
returns boolean language sql immutable as $$
  select p_valid_until is null or p_valid_until >= (now() at time zone 'America/Sao_Paulo')::date
$$;

-- Silencia a cobranca? So' 'nao cobrar' e pagamento ainda por vencer. 'Cobrado' e
-- 'erro ao gerar' continuam visiveis - so' mudam de secao.
create or replace function agency_ops.billing_note_silencia(p_kind text, p_valid_until date)
returns boolean language sql immutable as $$
  select p_kind in ('NAO_COBRAR','PAGAMENTO_PROGRAMADO') and agency_ops.billing_note_ativa(p_valid_until)
$$;

-- Semente com o levantamento manual dos GTs de 20/08 (prints do Felipe e do Yuri).
insert into agency_ops.client_billing_notes (client_id, kind, note, reference_date, valid_until, created_by)
select c.id, e.kind, e.note, e.ref, e.ate, 'GT · levantamento 20/08'
from (values
  ('Coutinho Imóveis',      'PAGAMENTO_PROGRAMADO','Cliente só vai pagar dia 31',   date '2026-08-31', date '2026-08-30'),
  ('HC Imóveis',            'NAO_COBRAR',          'Orientação do GT: não cobrar',   null::date,        null::date),
  ('Beto',                  'NAO_COBRAR',          'Cliente no jurídico',            null,              null),
  ('Plá Imobiliária',       'NAO_COBRAR',          'Cliente no jurídico',            null,              null),
  ('K2S',                   'ERRO_PAGAMENTO',      'Erro ao gerar a cobrança',       date '2026-08-20', date '2026-08-22'),
  ('Davi Emanuel',          'ERRO_PAGAMENTO',      'Pix não gerou',                  date '2026-08-20', date '2026-08-22'),
  ('Cristal – Remax',       'SEM_RESPOSTA',        'Cobrado em 18/08, sem resposta', date '2026-08-18', date '2026-08-22'),
  ('Samy Corretora',        'OBSERVACAO',          'GT vai cobrar amanhã',           date '2026-08-21', date '2026-08-21'),
  ('Caio Montenegro',       'COBRADO',             'Cobrado em 19/08',               date '2026-08-19', date '2026-08-21'),
  ('Century 21',            'COBRADO',             'Cobrado em 20/08',               date '2026-08-20', date '2026-08-22'),
  ('Débora Direcional',     'COBRADO',             'Cobrado em 19/08',               date '2026-08-19', date '2026-08-21'),
  ('Jean Knoll',            'COBRADO',             'Cobrado em 19/08',               date '2026-08-19', date '2026-08-21'),
  ('NC Imóveis',            'COBRADO',             'Cobrado em 20/08',               date '2026-08-20', date '2026-08-22'),
  ('PHD Imóveis',           'COBRADO',             'Cobrado em 19/08',               date '2026-08-19', date '2026-08-21'),
  ('Remax SJC',             'COBRADO',             'Cobrado em 19/08',               date '2026-08-19', date '2026-08-21'),
  ('Terra Concreto Imóveis','COBRADO',             'Cobrado em 20/08',               date '2026-08-20', date '2026-08-22'),
  ('Cida Sampaio',          'COBRADO',             'Cobrado em 19/08',               date '2026-08-19', date '2026-08-21'),
  ('Ricardo Araújo – RA Imobiliária','COBRADO',    'Cobrado em 19/08',               date '2026-08-19', date '2026-08-21')
) as e(nome, kind, note, ref, ate)
join agency_ops.clients c on lower(unaccent(c.display_name)) = lower(unaccent(e.nome))
where not exists (
  select 1 from agency_ops.client_billing_notes bn
   where bn.client_id = c.id and bn.created_by = 'GT · levantamento 20/08');

-- ---------------------------------------------------------------------------
-- 2. Cobertura: o que o alerta nao alcanca
-- ---------------------------------------------------------------------------
-- O resumo dizia "35 contas precisando de atencao" e passava a impressao de cobrir a
-- carteira. Cobria 66 de 92 clientes de marketing. Esta view existe para que a
-- lacuna deixe de ser invisivel.
create or replace view agency_ops.meta_balance_coverage as
select 'SEM_CONTA_VINCULADA' as motivo,
       c.id as client_id, c.display_name, c.gt_owner, null::text as account_key,
       null::numeric as valor, null::text as tipo_conta,
       (current_date - c.entrada) as dias_casa,
       exists (select 1 from agency_ops.clickup_tasks t
                where t.client_id = c.id and t.date_created > now() - interval '7 days') as trabalhado_semana
from agency_ops.clients c
where c.lifecycle in ('ACTIVE','ONBOARDING') and coalesce(c.service,'') <> 'ia'
  and not exists (select 1 from agency_ops.account_ad_balances b where b.client_id = c.id)
union all
select 'CARTAO_POS_PAGO', c.id, c.display_name, c.gt_owner, b.account_key,
       b.balance, b.funding_type_label,
       (current_date - c.entrada),
       exists (select 1 from agency_ops.clickup_tasks t
                where t.client_id = c.id and t.date_created > now() - interval '7 days')
from agency_ops.account_ad_balances b
join agency_ops.clients c on c.id = b.client_id
where b.balance_source = 'not_applicable_postpaid'
  and c.lifecycle in ('ACTIVE','ONBOARDING');

-- ---------------------------------------------------------------------------
-- 3. Montagem do resumo, separada do envio
-- ---------------------------------------------------------------------------
-- Separar montagem de envio permite pre-visualizar o texto sem disparar mensagem
-- para o grupo da equipe - e garante uma fonte so' para o conteudo.
create or replace function agency_ops.build_meta_balance_digest()
returns jsonb language plpgsql security definer set search_path to 'agency_ops','pg_catalog'
as $function$
declare
  v_critical text := ''; v_low text := ''; v_friday text := '';
  v_tratado text := ''; v_fora text := ''; v_erro text := '';
  v_n_critical int := 0; v_n_low int := 0; v_n_friday int := 0;
  v_n_tratado int := 0; v_n_fora int := 0; v_n_erro int := 0;
  v_message text; v_severity text; v_line text;
  r record; v_idx int := 0; v_cobranca int := 0; v_coletado timestamptz;
  v_sem_conta int; v_sem_conta_ativos int; v_cartao int;
begin
  select max((a.metadata->>'checked_at')::timestamptz) into v_coletado
  from agency_ops.operational_alerts a where a.type='META_BALANCE_LOW' and a.status='OPEN';

  for r in
    select c.display_name, c.id as client_id, a.metadata,
           (select count(*) from agency_ops.account_ad_balances b where b.client_id=c.id) as n_contas,
           n.kind as nota_kind, n.note as nota_txt, n.valid_until as nota_ate
    from agency_ops.operational_alerts a
    join agency_ops.clients c on c.id = a.client_id
    left join lateral (
      select bn.* from agency_ops.client_billing_notes bn
       where bn.client_id=c.id and agency_ops.billing_note_ativa(bn.valid_until)
       order by case bn.kind when 'NAO_COBRAR' then 1 when 'PAGAMENTO_PROGRAMADO' then 2
                             when 'ERRO_PAGAMENTO' then 3 else 4 end, bn.created_at desc
       limit 1) n on true
    where a.type='META_BALANCE_LOW' and a.status='OPEN'
    order by case when (a.metadata->>'friday_risk')::boolean then -1 else (a.metadata->>'tier')::int end desc nulls last,
             (a.metadata->>'available_balance')::numeric asc
  loop
    v_idx := v_idx + 1;
    v_line := r.display_name || ' — R$' || agency_ops.fmt_brl((r.metadata->>'available_balance')::numeric)
      -- Cliente com mais de uma conta precisa dizer qual e' qual. Caio Montenegro
      -- tem tres; sem isso o nome dele aparecia duas vezes sem contexto.
      || case when r.n_contas > 1 then ' [conta: ' || coalesce(r.metadata->>'account_key','?') || ']' else '' end
      || case when r.metadata->>'days_remaining' is not null
              then ' (~' || replace(r.metadata->>'days_remaining','.',',') || ' dia(s))' else '' end
      || ' — ' || coalesce('Gestor: ' || (r.metadata->>'gt_owner'), 'sem gestor atribuído');

    if agency_ops.billing_note_silencia(r.nota_kind, r.nota_ate) then
      v_n_fora := v_n_fora + 1;
      v_fora := v_fora || '• ' || v_line || ' — _' || coalesce(r.nota_txt,'sem cobrança') || '_' || E'\n';
    elsif r.nota_kind = 'ERRO_PAGAMENTO' then
      v_n_erro := v_n_erro + 1;
      v_erro := v_erro || '• ' || v_line || ' — _' || coalesce(r.nota_txt,'falha') || '_' || E'\n';
    elsif r.nota_kind is not null then
      v_n_tratado := v_n_tratado + 1;
      v_tratado := v_tratado || '• ' || v_line || ' — _' || coalesce(r.nota_txt,'tratado') || '_' || E'\n';
    elsif (r.metadata->>'friday_risk')::boolean then
      v_n_friday := v_n_friday+1; v_cobranca := v_cobranca+1;
      v_friday := v_friday || v_cobranca || ') ' || v_line || E'\n';
    elsif (r.metadata->>'tier')::int >= 3 then
      v_n_critical := v_n_critical+1; v_cobranca := v_cobranca+1;
      v_critical := v_critical || v_cobranca || ') ' || v_line || E'\n';
    else
      v_n_low := v_n_low+1; v_cobranca := v_cobranca+1;
      v_low := v_low || v_cobranca || ') ' || v_line || E'\n';
    end if;
  end loop;

  if v_idx = 0 then return jsonb_build_object('vazio', true); end if;

  select count(*) filter (where motivo='SEM_CONTA_VINCULADA'),
         count(*) filter (where motivo='SEM_CONTA_VINCULADA' and trabalhado_semana),
         count(*) filter (where motivo='CARTAO_POS_PAGO')
    into v_sem_conta, v_sem_conta_ativos, v_cartao from agency_ops.meta_balance_coverage;

  v_message := '📋 *RESUMO DIÁRIO — SALDO META ADS*' || E'\n'
    || '_Saldo consultado em ' || to_char(v_coletado at time zone 'America/Sao_Paulo','DD/MM')
    || ' às ' || to_char(v_coletado at time zone 'America/Sao_Paulo','HH24:MI') || '._' || E'\n'
    || '*' || v_cobranca || '* conta(s) para cobrar · *' || (v_n_tratado+v_n_fora+v_n_erro) || '* com anotação do GT.' || E'\n';
  if v_n_critical > 0 then v_message := v_message || E'\n🔴 *Zerado / crítico (' || v_n_critical || ')*' || E'\n' || v_critical; end if;
  if v_n_low > 0 then v_message := v_message || E'\n🟠 *Saldo baixo (' || v_n_low || ')*' || E'\n' || v_low; end if;
  if v_n_friday > 0 then v_message := v_message || E'\n🟡 *Risco pro fim de semana (' || v_n_friday || ')*' || E'\n' || v_friday; end if;
  if v_n_erro > 0 then v_message := v_message || E'\n⚠️ *Falha na cobrança (' || v_n_erro || ')* — problema técnico, não inadimplência' || E'\n' || v_erro; end if;
  if v_n_tratado > 0 then v_message := v_message || E'\n✅ *Já tratado pelo GT (' || v_n_tratado || ')*' || E'\n' || v_tratado; end if;
  if v_n_fora > 0 then v_message := v_message || E'\n⏸️ *Fora da cobrança (' || v_n_fora || ')*' || E'\n' || v_fora; end if;
  v_message := v_message || E'\n👁️ *Fora do alcance deste alerta*' || E'\n'
    || '• ' || v_sem_conta || ' cliente(s) ativo(s) sem conta Meta vinculada'
    || case when v_sem_conta_ativos>0 then ' — ' || v_sem_conta_ativos || ' com task esta semana' else '' end || E'\n'
    || '• ' || v_cartao || ' conta(s) em cartão pós-pago — saldo não se aplica' || E'\n';

  v_severity := case when v_n_critical>0 then 'CRITICAL' when (v_n_low+v_n_friday)>0 then 'WARNING' else 'INFO' end;
  return jsonb_build_object('message', v_message, 'severity', v_severity,
    'para_cobrar', v_cobranca, 'criticos', v_n_critical, 'baixos', v_n_low, 'risco_sexta', v_n_friday,
    'com_nota', v_n_tratado+v_n_fora+v_n_erro, 'sem_conta_vinculada', v_sem_conta,
    'cartao_pos_pago', v_cartao, 'saldo_coletado_em', v_coletado);
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Envio
-- ---------------------------------------------------------------------------
create or replace function agency_ops.notify_meta_balance_whatsapp_digest()
returns integer language plpgsql security definer set search_path to 'agency_ops','pg_catalog'
as $function$
declare
  v_destination text;
  v_key text := 'meta_balance_digest:' || to_char(now() at time zone 'America/Sao_Paulo','YYYYMMDD');
  v_d jsonb;
begin
  select destination_id into v_destination from agency_ops.notification_destinations
   where destination_key='OPS_INTERNAL' and enabled;
  if v_destination is null then return 0; end if;
  if exists (select 1 from agency_ops.notification_outbox where notification_key = v_key) then return 0; end if;

  v_d := agency_ops.build_meta_balance_digest();
  if coalesce((v_d->>'vazio')::boolean, false) then return 0; end if;

  insert into agency_ops.notification_outbox
    (notification_key, category, event_type, severity, title, message, destination_id, metadata)
  values (v_key, 'META_BALANCE', 'BALANCE_DAILY_DIGEST', v_d->>'severity',
          'Resumo diário de saldo — Meta Ads', v_d->>'message', v_destination, v_d - 'message');
  return 1;
end;
$function$;
