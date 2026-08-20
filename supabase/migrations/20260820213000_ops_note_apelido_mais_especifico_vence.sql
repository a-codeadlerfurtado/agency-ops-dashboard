-- "aurelio coutinho pediu X" virava AMBIGUOUS: o texto casa com "aurelio
-- coutinho" (Aurelio Coutinho) e tambem com "coutinho" (Coutinho Imoveis), que
-- sao clientes diferentes. Mas "coutinho" so apareceu porque esta dentro de
-- "aurelio coutinho" - nao e uma segunda citacao, e a mesma citacao contada
-- duas vezes. Perguntar "qual dos dois?" ali e ruido.
--
-- Se os dois clientes forem citados de verdade ("aurelio coutinho e coutinho
-- imoveis"), nenhum contem o outro e a pergunta continua sendo feita.

create or replace function agency_ops.ingest_ops_note(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'agency_ops', 'public', 'extensions'
as $function$
declare
  v_body text := btrim(coalesce(p->>'body',''));
  v_norm text; v_cli uuid; v_status text; v_conf numeric; v_cands jsonb; v_n int;
  v_sinais jsonb; v_id bigint;
  -- Palavras correntes do portugues que tambem sao nome de cliente. Sozinhas
  -- nao identificam ninguem: "precisamos de mais leads" nao cita a Mais Imoveis.
  -- O apelido de duas palavras ("mais imoveis") continua valendo.
  v_comuns text[] := array[
    'mais','real','nova','novo','casa','lar','grupo','centro','vida','sol','arte',
    'forte','bela','ativo','meta','banco','prime','top','master','norte','sul','alpha'
  ];
begin
  if length(v_body) < 3 then
    return jsonb_build_object('ok', false, 'error', 'texto_vazio');
  end if;
  v_norm := lower(extensions.unaccent(v_body));

  -- Cliente informado na mao vence o palpite. Se nao veio, tenta achar no texto.
  v_cli := (nullif(p->>'client_id',''))::uuid;
  if v_cli is not null then
    v_status := 'MANUAL'; v_conf := 1; v_cands := '[]'::jsonb;
  else
    with cand as (
      select c.id, c.display_name, lower(extensions.unaccent(c.display_name)) as chave, 1.00::numeric as conf
      from agency_ops.clients c
      where length(lower(extensions.unaccent(c.display_name))) >= 3

      union all
      select a.client_id, c.display_name, a.alias_normalized, 0.90
      from agency_ops.client_name_aliases a
      join agency_ops.clients c on c.id = a.client_id
      where length(coalesce(a.alias_normalized,'')) >= 3

      union all
      -- Apelidos ja' curados pelo pipeline do ClickUp.
      select a.client_id, c.display_name, a.normalized_alias, a.confidence
      from agency_ops.clickup_client_aliases a
      join agency_ops.clients c on c.id = a.client_id
      where a.active
        and length(coalesce(a.normalized_alias,'')) >= 2
        -- Sigla de duas letras so' entra se for apelido curado com alta confianca.
        and (length(a.normalized_alias) >= 4 or a.confidence >= 0.90)
    ),
    filtrado as (
      select * from cand
      where chave is not null
        and not (chave = any(v_comuns) and chave !~ '\s')
    ),
    hit as (
      -- Um cliente entra uma vez so', pelo apelido mais confiavel e mais especifico.
      select distinct on (id) id, display_name, chave, conf
      from filtrado
      where v_norm ~ ('\m' || regexp_replace(chave,'([.*+?^${}()|\[\]\\])','\\\1','g') || '\M')
      order by id, conf desc, length(chave) desc
    ),
    vencedor as (
      -- Apelido contido dentro de outro apelido maior que tambem casou perde:
      -- "coutinho" so apareceu porque esta dentro de "aurelio coutinho".
      select h.*
      from hit h
      where not exists (
        select 1 from hit o
        where o.id <> h.id
          and length(o.chave) > length(h.chave)
          and o.chave ~ ('\m' || regexp_replace(h.chave,'([.*+?^${}()|\[\]\\])','\\\1','g') || '\M')
      )
    )
    select count(*),
           (array_agg(id order by conf desc, length(chave) desc))[1],
           (array_agg(conf order by conf desc, length(chave) desc))[1],
           jsonb_agg(jsonb_build_object('client_id', id, 'nome', display_name, 'apelido', chave)
                     order by conf desc, length(chave) desc)
      into v_n, v_cli, v_conf, v_cands
      from vencedor;

    if v_n = 1 then
      v_status := 'MATCHED';
    elsif v_n > 1 then
      -- Mais de um cliente citado: quem escreveu decide. Palpite silencioso aqui
      -- gravaria a nota no cliente errado sem ninguem perceber.
      v_status := 'AMBIGUOUS'; v_conf := null; v_cli := null;
    else
      v_status := 'UNMATCHED'; v_conf := null; v_cli := null;
    end if;
  end if;

  -- Mesmos padroes que leem as transcricoes: risco, satisfacao, CRM, IA.
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
