-- Imobi-Board 0045 - planos por assento
--
-- O preco deixa de ser fixo por plano e passa a ser base + assentos extras.
-- A diferenca entre planos vira quantidade de gente, nao funcionalidade: quem
-- paga Solo ve o mesmo sistema que quem paga Imobiliaria. As descricoes
-- antigas prometiam "ranking e relatorios" so no Pro, o que era gate por
-- funcionalidade -- corrigido aqui para nao virar promessa acidental.
--
-- ASSENTO E CORRETOR, NAO USUARIO. A conta usa memberships ativos com papel
-- BROKER. O administrador nao consome assento: numa imobiliaria pequena ele e
-- o dono, nao um atendente a mais, e cobrar por ele faria o plano Solo custar
-- assento antes de existir qualquer corretor.
--
-- LIMITE DURO SEPARADO DA COBRANCA. `limite_corretores` nulo significa "nao ha
-- teto, cobra-se o extra". No Solo o teto e 1: ali o excedente nao e vendido,
-- e recusado. Sao duas politicas diferentes e ficam em colunas diferentes.

/* ------------------------------------------------ colunas de assento --- */

alter table imobi_board.planos
  add column if not exists usuarios_inclusos integer not null default 1
    check (usuarios_inclusos >= 0),
  add column if not exists valor_corretor_extra_centavos integer not null default 0
    check (valor_corretor_extra_centavos >= 0);

comment on column imobi_board.planos.usuarios_inclusos is
  'Corretores (papel BROKER) ja cobertos pelo valor base. O ADMIN nao conta.';
comment on column imobi_board.planos.valor_corretor_extra_centavos is
  'Cobrado por corretor acima dos inclusos. Zero com limite duro = plano que nao vende excedente.';
comment on column imobi_board.planos.limite_corretores is
  'Teto duro de corretores. Nulo = sem teto, o excedente e cobrado como extra. '
  'E politica de venda, nao de cobranca -- por isso separada do valor do extra.';

/* -------------------------------------------------------- os planos --- */

-- Basico e Pro saem de circulacao sem sumir: ha assinaturas que podem aponta-los,
-- e apagar a linha quebraria a chave estrangeira e o historico de quem pagou.
update imobi_board.planos set ativo = false where id in ('BASICO', 'PRO');

insert into imobi_board.planos
  (id, nome, descricao, valor_centavos, usuarios_inclusos,
   valor_corretor_extra_centavos, limite_corretores, ativo, sort_order)
values
  ('SOLO', 'Solo',
   'Para quem trabalha sozinho. Um corretor, sem assento extra.',
   7900, 1, 0, 1, true, 1),
  ('EQUIPE', 'Equipe',
   'Tres corretores inclusos. Acima disso, R$ 29 por corretor.',
   16900, 3, 2900, null, true, 2),
  ('IMOBILIARIA', 'Imobiliaria',
   'Dez corretores inclusos. Acima disso, R$ 25 por corretor.',
   39900, 10, 2500, null, true, 3)
on conflict (id) do update set
  nome        = excluded.nome,
  descricao   = excluded.descricao,
  valor_centavos = excluded.valor_centavos,
  usuarios_inclusos = excluded.usuarios_inclusos,
  valor_corretor_extra_centavos = excluded.valor_corretor_extra_centavos,
  limite_corretores = excluded.limite_corretores,
  ativo       = excluded.ativo,
  sort_order  = excluded.sort_order;

-- os planos antigos nao tem semantica de assento; deixa explicito em vez de
-- herdar o default 1 e parecer que alguem decidiu isso
update imobi_board.planos
   set usuarios_inclusos = 0, valor_corretor_extra_centavos = 0,
       descricao = descricao || ' (plano descontinuado)'
 where id in ('BASICO', 'PRO') and descricao not like '%descontinuado%';

/* --------------------------------------------------- calculo do mes --- */

/**
 * Quanto a imobiliaria paga na competencia, e por que.
 *
 * Devolve o detalhamento inteiro, nao so o total: quando o cliente perguntar
 * "por que subiu", a resposta tem que estar guardada, e nao ser recalculada
 * meses depois com um numero de corretores que ja mudou.
 */
create or replace function imobi_board_priv.calcular_mensalidade(p_tenant uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_a      imobi_board.assinaturas%rowtype;
  v_p      imobi_board.planos%rowtype;
  v_ativos int;
  v_extras int;
  v_total  int;
begin
  select * into v_a from imobi_board.assinaturas where tenant_id = p_tenant;
  if not found then return null; end if;
  select * into v_p from imobi_board.planos where id = v_a.plano_id;

  select count(*) into v_ativos
    from imobi_board.memberships m
   where m.tenant_id = p_tenant and m.status = 'ACTIVE' and m.role = 'BROKER';

  v_extras := greatest(0, v_ativos - v_p.usuarios_inclusos);
  -- base congelada na assinatura; o extra vem do plano, que e o preco de hoje
  v_total  := v_a.valor_centavos + v_extras * v_p.valor_corretor_extra_centavos;

  return jsonb_build_object(
    'plano_id',            v_p.id,
    'plano',               v_p.nome,
    'base_centavos',       v_a.valor_centavos,
    'usuarios_inclusos',   v_p.usuarios_inclusos,
    'corretores_ativos',   v_ativos,
    'corretores_extras',   v_extras,
    'valor_extra_unitario_centavos', v_p.valor_corretor_extra_centavos,
    'valor_extras_centavos', v_extras * v_p.valor_corretor_extra_centavos,
    'total_centavos',      v_total,
    'limite_corretores',   v_p.limite_corretores,
    'apurado_em',          now()
  );
end;
$fn$;

/**
 * Fecha a competencia e grava a fatura.
 *
 * Idempotente pela unicidade (tenant_id, competencia): rodar duas vezes no
 * mesmo mes nao gera segunda cobranca. Essa garantia e o que torna seguro
 * chamar isto de um agendador -- sem ela, uma reexecucao cobraria de novo.
 */
create or replace function imobi_board.fechar_competencia(
  p_tenant uuid,
  p_competencia date default date_trunc('month', current_date)::date
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_a     imobi_board.assinaturas%rowtype;
  v_calc  jsonb;
  v_vence date;
  v_id    uuid;
begin
  select * into v_a from imobi_board.assinaturas where tenant_id = p_tenant;
  if not found then
    raise exception 'Imobiliaria sem assinatura.' using errcode = 'P0001';
  end if;
  if v_a.status = 'CANCELADA' then
    return jsonb_build_object('resultado', 'assinatura_cancelada');
  end if;

  v_calc  := imobi_board_priv.calcular_mensalidade(p_tenant);
  v_vence := (date_trunc('month', p_competencia) + make_interval(days => v_a.dia_vencimento - 1))::date;

  insert into imobi_board.faturas
    (tenant_id, assinatura_id, competencia, valor_centavos, vence_em, status, payload)
  values
    (p_tenant, v_a.id, date_trunc('month', p_competencia)::date,
     (v_calc->>'total_centavos')::int, v_vence, 'PENDENTE',
     jsonb_build_object('detalhamento', v_calc))
  on conflict (tenant_id, competencia) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('resultado', 'ja_existia',
      'competencia', date_trunc('month', p_competencia)::date);
  end if;

  perform imobi_board_priv.emit_event(
    p_tenant, 'fatura.gerada', 'fatura', v_id, v_calc);

  return jsonb_build_object('resultado', 'gerada', 'fatura_id', v_id,
    'vence_em', v_vence, 'detalhamento', v_calc);
end;
$fn$;

revoke execute on function imobi_board.fechar_competencia(uuid, date) from public, authenticated;
grant  execute on function imobi_board.fechar_competencia(uuid, date) to service_role;

/* ------------------------------------------ tela de assinatura ------- */

create or replace function imobi_board.minha_cobranca()
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  select coalesce(jsonb_agg(x), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'tenant_id',   t.id,
      'imobiliaria', t.name,
      'meu_papel',   m.role,
      'assinatura', case when a.id is null then null else jsonb_build_object(
        'status',            a.status,
        'bloqueada',         a.status = 'BLOQUEADA',
        'bloqueada_em',      a.bloqueada_em,
        'plano',             p.nome,
        'plano_id',          p.id,
        'dia_vencimento',    a.dia_vencimento,
        'dias_de_tolerancia', a.dias_de_tolerancia,
        'teste_ate',         a.teste_ate
      ) end,
      -- plano, inclusos, ativos, extras e proximo valor, ja apurados
      'proxima_cobranca', imobi_board_priv.calcular_mensalidade(t.id),
      'faturas_em_aberto', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', f.id, 'competencia', f.competencia, 'vence_em', f.vence_em,
          'valor_centavos', f.valor_centavos, 'status', f.status,
          'dias_de_atraso', greatest(current_date - f.vence_em, 0),
          'detalhamento', f.payload -> 'detalhamento',
          'link', f.link_pagamento) order by f.vence_em), '[]'::jsonb)
        from imobi_board.faturas f
        where f.tenant_id = t.id and f.status in ('PENDENTE', 'ATRASADA')
      )
    ) as x
    from imobi_board.memberships m
    join imobi_board.tenants t on t.id = m.tenant_id
    left join imobi_board.assinaturas a on a.tenant_id = t.id
    left join imobi_board.planos p on p.id = a.plano_id
    where m.user_id = (select auth.uid()) and m.status = 'ACTIVE'
  ) s;
$fn$;

revoke execute on function imobi_board.minha_cobranca() from public;
grant  execute on function imobi_board.minha_cobranca() to authenticated;
