create table if not exists agency_ops.daily_reflections (
  id uuid primary key default gen_random_uuid(),
  quote_text text not null check (char_length(quote_text) between 3 and 420),
  author text not null check (char_length(author) between 2 and 120),
  source_reference text,
  source_url text,
  category text not null check (category in (
    'FILOSOFIA','BIBLIA','LIDERANCA_NEGOCIOS','CIENCIA_CRIATIVIDADE','LITERATURA_HISTORIA','CULTURA_BRASILEIRA'
  )),
  verified boolean not null default false,
  active boolean not null default true,
  scheduled_date date,
  recurs_annually boolean not null default false,
  target_roles text[] not null default '{}'::text[],
  target_people text[] not null default '{}'::text[],
  priority smallint not null default 100 check (priority between 0 and 1000),
  notes text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint daily_reflections_quote_author_uniq unique (quote_text, author)
);

comment on table agency_ops.daily_reflections is
'Banco curado da Reflexão do dia. Leitura/escrita somente via Edge Function autenticada; verified controla elegibilidade para exibição.';

alter table agency_ops.daily_reflections enable row level security;
revoke all on table agency_ops.daily_reflections from anon, authenticated;
grant all on table agency_ops.daily_reflections to service_role;

create index if not exists daily_reflections_rotation_idx
  on agency_ops.daily_reflections (active, verified, category, priority)
  where deleted_at is null;

create index if not exists daily_reflections_schedule_idx
  on agency_ops.daily_reflections (scheduled_date)
  where active = true and verified = true and deleted_at is null;

insert into agency_ops.daily_reflections
(quote_text, author, source_reference, source_url, category, verified, active, scheduled_date, priority, notes)
values
('Não é porque as coisas são difíceis que não ousamos; é porque não ousamos que elas são difíceis.','Sêneca','Cartas a Lucílio, 104.26 (tradução livre)','https://openscriptorium.com/read/seneca/104-letter-104','FILOSOFIA',true,true,date '2026-09-28',1,'Programada para o lançamento da Reflexão do dia.'),
('Algumas coisas dependem de nós; outras, não.','Epicteto','Enchiridion, 1 (tradução livre)','https://classics.mit.edu/Epictetus/epicench.html','FILOSOFIA',true,true,null,100,null),
('Sofremos mais vezes na imaginação do que na realidade.','Sêneca','Cartas a Lucílio, 13.4 (tradução livre)','https://romanletters.org/letters/seneca/13/','FILOSOFIA',true,true,null,100,null),
('O mundo é mudança; a vida é opinião.','Marco Aurélio','Meditações, 4.3 (tradução livre)','https://marcusaurelius-meditations.org/en/quotecheck/kosmos-alloiosis/','FILOSOFIA',true,true,null,100,null),
('Bem feito é melhor do que bem dito.','Benjamin Franklin','Poor Richard''s Almanack, 1737 (tradução livre)','https://fi.edu/en/science-and-education/benjamin-franklin/famous-quotes','LIDERANCA_NEGOCIOS',true,true,null,100,null),
('O tempo perdido nunca é encontrado novamente.','Benjamin Franklin','The Way to Wealth / Poor Richard, 1758 (tradução livre)','https://usinfo.org/enus/government/overview/bf1758.html','LIDERANCA_NEGOCIOS',true,true,null,100,null),
('Se enxerguei mais longe, foi por estar sobre os ombros de gigantes.','Isaac Newton','Carta a Robert Hooke, 5 fev. 1675 (tradução livre)','https://www.newtonproject.ox.ac.uk/view/texts/diplomatic/OTHE00018','CIENCIA_CRIATIVIDADE',true,true,null,100,null),
('Há um tempo para cada coisa e um tempo para cada propósito debaixo do céu.','Bíblia','Eclesiastes 3:1 (tradução livre)','https://www.biblegateway.com/verse/en/Ecclesiastes%203%3A1','BIBLIA',true,true,null,100,null),
('O coração planeja o seu caminho, mas o Senhor dirige os seus passos.','Bíblia','Provérbios 16:9 (tradução livre)','https://www.biblegateway.com/verse/en/Proverbs%2016%3A9','BIBLIA',true,true,null,100,null),
('Tudo vale a pena se a alma não é pequena.','Fernando Pessoa','Mensagem — Mar Português','https://pt.wikisource.org/wiki/Mensagem/Mar_Portugu%C3%AAs','LITERATURA_HISTORIA',true,true,null,100,null),
('Mudam-se os tempos, mudam-se as vontades.','Luís de Camões','Soneto: Mudam-se os tempos, mudam-se as vontades','https://pt.wikisource.org/wiki/Mudam-se_os_tempos,_mudam-se_as_vontades','LITERATURA_HISTORIA',true,true,null,100,null),
('Deus quer, o homem sonha, a obra nasce.','Fernando Pessoa','Mensagem — O Infante','https://pt.wikisource.org/wiki/Mensagem/O_Infante','LITERATURA_HISTORIA',true,true,null,100,null),
('Tão certo é que a paisagem depende do ponto de vista.','Machado de Assis','Quincas Borba, capítulo XVIII','https://pt.wikisource.org/wiki/Quincas_Borba/XVIII','CULTURA_BRASILEIRA',true,true,null,100,null)
on conflict (quote_text, author) do update
set source_reference = excluded.source_reference,
    source_url = excluded.source_url,
    category = excluded.category,
    verified = excluded.verified,
    active = excluded.active,
    scheduled_date = excluded.scheduled_date,
    priority = excluded.priority,
    notes = excluded.notes,
    updated_at = now();
