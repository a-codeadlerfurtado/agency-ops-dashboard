-- A caixa de anotacao do perfil existia so' em producao. Esta migration escreve no
-- repositorio o que ja' esta' no banco - e conserta o que faltava para ela servir
-- para o que foi pedida.
--
-- O pedido era: "escrever algumas coisas ali sobre determinado acontecimento ou
-- cliente para alimentar a base [...] e posteriormente conferir isso ou pedir para
-- o opsquestion". A segunda metade nao funcionava: agency_ops_ai_reader, o papel
-- que o OpsQuestion usa, nao tinha SELECT em ops_notes. O gestor escreveria a nota,
-- ela ficaria salva, e perguntar sobre ela devolveria "nao encontrei evidencia".
-- Uma caixa que engole e nunca devolve deixa de ser alimentada em duas semanas.

-- ---------------------------------------------------------------------------
-- 1. A tabela
-- ---------------------------------------------------------------------------
-- Tudo com IF NOT EXISTS: producao ja' tem, e esta migration precisa passar nos
-- dois estados sem reclamar.
create table if not exists agency_ops.ops_notes (
  id               bigserial primary key,
  author_user_key  text not null,
  author_name      text,
  body             text not null,
  -- client_id e' o cliente que o sistema conseguiu identificar; client_name_raw e'
  -- o que a pessoa escreveu. Guardar os dois separados e' o que permite revisar
  -- depois quando o palpite estiver errado.
  client_id        uuid references agency_ops.clients(id),
  client_name_raw  text,
  -- MANUAL   - o gestor escolheu o cliente na tela, nao ha' o que adivinhar
  -- MATCHED  - um nome so' bateu no texto
  -- AMBIGUOUS- mais de um bateu; fica sem cliente ate' alguem decidir
  -- UNMATCHED- nenhum bateu; a nota vale sozinha
  match_status     text not null default 'UNMATCHED',
  match_confidence numeric,
  candidatos       jsonb not null default '[]'::jsonb,
  sinais           jsonb not null default '[]'::jsonb,
  occurred_at      timestamptz not null default now(),
  confirmado_em    timestamptz,
  confirmado_por   text,
  created_at       timestamptz not null default now()
);

create index if not exists ops_notes_client_idx on agency_ops.ops_notes (client_id, occurred_at desc);
create index if not exists ops_notes_author_idx on agency_ops.ops_notes (author_user_key, occurred_at desc);
-- Busca em portugues no corpo: perguntar "o que falaram sobre reclamacao de prazo"
-- tem que achar a nota, nao depender de a pessoa lembrar de qual cliente era.
create index if not exists ops_notes_busca_idx on agency_ops.ops_notes using gin (to_tsvector('portuguese', body));

comment on table agency_ops.ops_notes is
  'Anotacoes livres do time sobre clientes e acontecimentos, escritas no perfil do cliente no dashboard. Fonte humana: complementa o que os coletores automaticos nao veem.';

-- ---------------------------------------------------------------------------
-- 2. A ingestao
-- ---------------------------------------------------------------------------
create or replace function agency_ops.ingest_ops_note(p jsonb)
returns jsonb language plpgsql security definer
set search_path to 'agency_ops', 'public', 'extensions'
as $function$
declare
  v_body text := btrim(coalesce(p->>'body',''));
  v_norm text; v_cli uuid; v_status text; v_conf numeric; v_cands jsonb; v_n int;
  v_sinais jsonb; v_id bigint;
begin
  if length(v_body) < 3 then
    return jsonb_build_object('ok', false, 'error', 'texto_vazio');
  end if;
  v_norm := lower(extensions.unaccent(v_body));

  -- Cliente informado na mão vence o palpite. Se não veio, tenta achar no texto.
  v_cli := (nullif(p->>'client_id',''))::uuid;
  if v_cli is not null then
    v_status := 'MANUAL'; v_conf := 1; v_cands := '[]'::jsonb;
  else
    with cand as (
      select c.id, c.display_name, lower(extensions.unaccent(c.display_name)) nome
      from agency_ops.clients c
      where length(lower(extensions.unaccent(c.display_name))) >= 4
      union
      select a.client_id, c2.display_name, a.alias_normalized
      from agency_ops.client_name_aliases a join agency_ops.clients c2 on c2.id = a.client_id
      where length(coalesce(a.alias_normalized,'')) >= 4
    ), hit as (
      -- \m e \M sao limite de palavra: sem isso "Ana" casaria dentro de "Fernanda".
      select distinct on (id) id, display_name, nome
      from cand
      where v_norm ~ ('\m' || regexp_replace(nome,'([.*+?^${}()|\[\]\\])','\\\1','g') || '\M')
      order by id, length(nome) desc
    )
    select count(*), (array_agg(id order by length(nome) desc))[1],
           jsonb_agg(jsonb_build_object('client_id', id, 'nome', display_name))
      into v_n, v_cli, v_cands from hit;

    -- Dois nomes no texto nao viram escolha do sistema. Vira pergunta na tela.
    if v_n = 1 then v_status := 'MATCHED'; v_conf := 0.85;
    elsif v_n > 1 then v_status := 'AMBIGUOUS'; v_conf := null; v_cli := null;
    else v_status := 'UNMATCHED'; v_conf := null; v_cli := null; end if;
  end if;

  -- Mesmos padrões que leem as transcrições: risco, satisfação, CRM, IA.
  select coalesce(jsonb_agg(jsonb_build_object('categoria', pt.categoria, 'sinal', pt.rotulo)), '[]'::jsonb)
    into v_sinais
  from agency_ops.transcript_signal_patterns pt
  where pt.ativo and lower(extensions.unaccent(v_body)) ~ pt.padrao;

  insert into agency_ops.ops_notes
    (author_user_key, author_name, body, client_id, client_name_raw,
     match_status, match_confidence, candidatos, sinais, occurred_at)
  values (coalesce(nullif(p->>'author_user_key',''),'desconhecido'), nullif(p->>'author_name',''),
          v_body, v_cli, nullif(p->>'client_name_raw',''), v_status, v_conf,
          coalesce(v_cands,'[]'::jsonb), v_sinais,
          coalesce((nullif(p->>'occurred_at',''))::timestamptz, now()))
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id, 'match_status', v_status,
    'client_id', v_cli, 'candidatos', coalesce(v_cands,'[]'::jsonb), 'sinais', v_sinais);
end $function$;

-- ---------------------------------------------------------------------------
-- 3. O OpsQuestion passa a enxergar as notas
-- ---------------------------------------------------------------------------
-- Esta era a metade que faltava. agency_ops_ai_reader so' tem SELECT, em objeto
-- nenhum alem dos que recebem grant explicito - por isso ops_notes, criada depois
-- do papel, ficou de fora sem ninguem notar.
grant select on agency_ops.ops_notes to agency_ops_ai_reader;

-- Nota sem cliente definido e' pergunta em aberto, nao dado perdido. Quem escreveu
-- sabe a resposta; a fila e' o que faz a pergunta chegar de volta nele.
create or replace view agency_ops.ops_notes_pendentes as
select n.id, n.author_name, n.author_user_key, n.body, n.client_name_raw,
       n.match_status, n.candidatos, n.sinais, n.occurred_at,
       round(extract(epoch from (now() - n.occurred_at)) / 86400.0, 1) as dias_esperando
from agency_ops.ops_notes n
where n.client_id is null
  and n.match_status in ('AMBIGUOUS','UNMATCHED')
  and n.confirmado_em is null
order by n.occurred_at desc;

comment on view agency_ops.ops_notes_pendentes is
  'Anotacoes que o sistema nao conseguiu ligar a um cliente. Aguardam confirmacao humana - o sistema nao deve escolher sozinho entre candidatos.';

grant select on agency_ops.ops_notes_pendentes to agency_ops_ai_reader;
