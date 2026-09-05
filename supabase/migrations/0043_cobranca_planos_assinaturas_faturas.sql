-- Imobi-Board 0043 - cobranca mensal: planos, assinaturas e faturas
--
-- O CRM passa a cobrar a imobiliaria por mensalidade no cartao. Este arquivo e
-- so a estrutura; o comportamento (bloqueio, transicao de estado, entrada de
-- evento do provedor) vem na 0044, e a ligacao com o Asaas depois.
--
-- Tres decisoes que orientam o resto.
--
-- 1. VALOR CONGELADO NA ASSINATURA. O plano tem preco, mas a assinatura guarda
--    o valor em centavos no momento da contratacao. Reajustar o plano nao pode
--    mudar retroativamente o que um cliente antigo paga -- e cobrar valor
--    diferente do combinado e o tipo de erro que vira processo.
--
-- 2. CENTAVOS EM INTEIRO, nunca float. 0.1 + 0.2 nao da 0.3 em ponto
--    flutuante, e dinheiro nao admite esse tipo de surpresa.
--
-- 3. UMA FATURA POR MES POR IMOBILIARIA, garantido por unicidade em
--    (tenant_id, competencia). Cobranca duplicada e pior que cobranca
--    atrasada: uma some do extrato, a outra o cliente vê.
--
-- O provedor (Asaas) e referenciado por id em colunas proprias, sem nenhuma
-- chamada aqui. Quando a integracao entrar, e so preencher.

/* ------------------------------------------------------------- enums --- */

do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                 where n.nspname='imobi_board' and t.typname='assinatura_status') then
    create type imobi_board.assinatura_status as enum (
      'TESTE',      -- periodo de avaliacao, sem cobranca
      'ATIVA',      -- em dia
      'ATRASADA',   -- vencida ha menos de 5 dias; ainda acessa
      'BLOQUEADA',  -- vencida ha 5 dias ou mais; acesso negado
      'CANCELADA'
    );
  end if;

  if not exists (select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace
                 where n.nspname='imobi_board' and t.typname='fatura_status') then
    create type imobi_board.fatura_status as enum (
      'PENDENTE', 'PAGA', 'ATRASADA', 'CANCELADA', 'ESTORNADA'
    );
  end if;
end $$;

/* ------------------------------------------------------------ planos --- */

create table if not exists imobi_board.planos (
  id                text primary key,          -- 'BASICO', 'PRO'
  nome              text not null,
  descricao         text,
  valor_centavos    integer not null check (valor_centavos >= 0),
  limite_corretores integer check (limite_corretores is null or limite_corretores > 0),
  ativo             boolean not null default true,
  sort_order        smallint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column imobi_board.planos.limite_corretores is
  'Nulo = sem limite. O limite e informativo por enquanto: nada o aplica ainda, '
  'e aplicar sem avisar quem ja passou do numero quebraria a operacao de um cliente.';

insert into imobi_board.planos (id, nome, descricao, valor_centavos, limite_corretores, sort_order)
values
  ('BASICO', 'Basico',
   'Funil, leads, distribuicao e integracao com a Meta.', 19700, 5, 1),
  ('PRO', 'Pro',
   'Tudo do Basico, sem limite de corretores, com ranking e relatorios.', 39700, null, 2)
on conflict (id) do nothing;

/* ------------------------------------------------------- assinaturas --- */

create table if not exists imobi_board.assinaturas (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null unique references imobi_board.tenants(id) on delete cascade,
  plano_id      text not null references imobi_board.planos(id),
  status        imobi_board.assinatura_status not null default 'TESTE',

  -- congelado na contratacao; reajuste de plano nao mexe em quem ja assinou
  valor_centavos  integer not null check (valor_centavos >= 0),
  dia_vencimento  smallint not null default 10
    check (dia_vencimento between 1 and 28),   -- 28 evita fevereiro

  -- dias de tolerancia antes do bloqueio. Coluna, e nao constante no codigo:
  -- um cliente grande pode negociar prazo, e mudar isso nao deve exigir deploy.
  dias_de_tolerancia smallint not null default 5 check (dias_de_tolerancia >= 0),

  provedor                 text not null default 'ASAAS',
  provedor_customer_id     text,
  provedor_subscription_id text,

  iniciada_em   timestamptz not null default now(),
  teste_ate     date,
  cancelada_em  timestamptz,
  bloqueada_em  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table imobi_board.assinaturas is
  'Uma assinatura por imobiliaria. A ausencia de linha significa "nao cobrado" '
  '-- e o que mantem as imobiliarias de demonstracao e as anteriores a cobranca '
  'funcionando sem excecao no codigo.';

create index if not exists assinaturas_status_idx
  on imobi_board.assinaturas (status) where status in ('ATRASADA', 'BLOQUEADA');

/* ----------------------------------------------------------- faturas --- */

create table if not exists imobi_board.faturas (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references imobi_board.tenants(id) on delete cascade,
  assinatura_id  uuid not null references imobi_board.assinaturas(id) on delete cascade,

  competencia    date not null,          -- primeiro dia do mes de referencia
  valor_centavos integer not null check (valor_centavos >= 0),
  vence_em       date not null,
  status         imobi_board.fatura_status not null default 'PENDENTE',
  pago_em        timestamptz,

  provedor            text not null default 'ASAAS',
  provedor_payment_id text,
  link_pagamento      text,

  -- ultimo evento cru do provedor: quando a conciliacao diverge, a resposta
  -- esta aqui e nao no que a gente achou que o provedor tinha dito
  payload        jsonb,
  ultimo_erro    text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint faturas_uma_por_competencia unique (tenant_id, competencia)
);

create unique index if not exists faturas_provedor_uq
  on imobi_board.faturas (provedor, provedor_payment_id)
  where provedor_payment_id is not null;

create index if not exists faturas_em_aberto_idx
  on imobi_board.faturas (vence_em)
  where status in ('PENDENTE', 'ATRASADA');

create index if not exists faturas_do_tenant_idx
  on imobi_board.faturas (tenant_id, competencia desc);

/* ------------------------------------------------- toque de updated_at --- */

do $$
begin
  if not exists (select 1 from pg_trigger where tgname='planos_touch') then
    create trigger planos_touch before update on imobi_board.planos
      for each row execute function imobi_board_priv.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname='assinaturas_touch') then
    create trigger assinaturas_touch before update on imobi_board.assinaturas
      for each row execute function imobi_board_priv.touch_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname='faturas_touch') then
    create trigger faturas_touch before update on imobi_board.faturas
      for each row execute function imobi_board_priv.touch_updated_at();
  end if;
end $$;

/* --------------------------------------------------------------- RLS --- */
/*
   Dinheiro nao passa pelo PostgREST. As tres tabelas ficam com RLS ligada e
   SEM policy de escrita: quem grava e a chave de servico, pelo webhook do
   provedor e pelo console.

   Leitura tambem nao vem por policy. Quando a imobiliaria estiver BLOQUEADA,
   os helpers de RLS passam a devolver vazio para ela (0044) -- entao uma
   policy baseada neles esconderia a fatura justamente de quem precisa
   paga-la. A tela de cobranca le por funcao SECURITY DEFINER, por fora.

   `planos` e a excecao: e tabela de precos, nao tem nada de sensivel, e a tela
   de contratacao precisa dela antes de existir assinatura.
*/

alter table imobi_board.planos      enable row level security;
alter table imobi_board.assinaturas enable row level security;
alter table imobi_board.faturas     enable row level security;

drop policy if exists planos_leitura on imobi_board.planos;
create policy planos_leitura on imobi_board.planos
  for select to authenticated using (ativo);

grant select on imobi_board.planos to authenticated;
