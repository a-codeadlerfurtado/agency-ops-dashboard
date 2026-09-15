-- "TALVEZ" no rotulo da task e' duvida declarada, nao nome de cliente.
--
-- O gestor apontou que Imperial Imoveis e' cliente novo, em onboarding, e nunca teve
-- task. O banco mostrava 40. Olhando os rotulos:
--
--   30 x [TALVEZ IMPERIAL CRED]   -> casadas com MATCHED
--    8 x [IMPERIAL CRED]          -> casadas com MATCHED
--    1 x [IMPERIAL IMOVEIS]       -> unica correta
--    1 x sem rotulo
--
-- Alguem escreveu TALVEZ justamente para sinalizar que nao sabia de quem era a
-- task. O matcher leu o texto inteiro, achou "IMPERIAL" parecido com "Imperial
-- Imoveis" e marcou vinculo confiante - invertendo o sentido do que a pessoa
-- escreveu. Duvida humana virou certeza da maquina.
--
-- Efeito pratico: um cliente em onboarding, sem nenhuma entrega feita, aparecia com
-- 40 tasks. Qualquer metrica de produtividade, de silencio ou de saude que olhasse
-- para ele estava lendo trabalho de outro.

-- 1. Desfaz os vinculos feitos sobre duvida e manda para conferencia humana.
update agency_ops.clickup_tasks
   set client_id = null, client_match_status = 'UNMATCHED'
 where name ~* '^\[\s*talvez' and client_id is not null;

insert into agency_ops.integration_match_review (system, external_id, external_name, candidates, reason)
select 'CLICKUP_TASK_PREFIX', 'talvez:' || lower(unaccent(rotulo)), rotulo, '[]'::jsonb,
       n || ' task(s) com prefixo TALVEZ — o GT marcou dúvida sobre de quem é. '
       || 'Confirmar o cliente antes de vincular; o sistema não deve decidir sozinho.'
from (select trim(substring(name from '^\[([^\]]+)\]')) rotulo, count(*) n
        from agency_ops.clickup_tasks where name ~* '^\[\s*talvez' group by 1) s
on conflict (system, external_id) do nothing;

-- 2. Impede que volte. Devolver null faz a task cair em NO_LABEL/UNMATCHED e seguir
--    para conferencia, em vez de o sistema escolher um cliente por semelhanca.
--    Cobre tambem as outras formas de marcar incerteza que o time usa.
create or replace function agency_ops.extract_clickup_client_label(p_task_name text)
returns text language sql immutable parallel safe set search_path to 'pg_catalog'
as $function$
  select case
    when trim((regexp_match(coalesce(p_task_name,''), '^\s*\[([^\]]+)\]'))[1]) ~* '^(talvez|nao sei|não sei|duvida|dúvida|verificar|confirmar)\M'
      then null
    else nullif(trim((regexp_match(coalesce(p_task_name,''), '^\s*\[([^\]]+)\]'))[1]), '')
  end;
$function$;

-- 3. Santo Amanhecer: a venda caiu. Sete dias de casa, nenhuma task, nenhuma conta
--    de anuncio. Abaixo dos 10 dias, entao o gatilho classifica como venda caida e
--    ela nao entra na media de permanencia - como combinado.
update agency_ops.clients
   set lifecycle = 'CHURNED', saida = date '2026-08-20', updated_at = now()
 where display_name = 'Santo Amanhecer' and lifecycle <> 'CHURNED';

update agency_ops.client_churn_log
   set motivo = 'Venda caiu. Cliente nunca chegou a ser atendido: 7 dias de casa, nenhuma task criada e nenhuma conta de anúncio vinculada. Informado pelo gestor em 20/08.'
 where client_id = (select id from agency_ops.clients where display_name = 'Santo Amanhecer')
   and motivo is null;

-- ---------------------------------------------------------------------------
-- 4. CLIENT_PREFIX: nome do cliente cabendo dentro do rotulo
-- ---------------------------------------------------------------------------
-- O gestor confirmou que Imperial Cred nao e' a mesma empresa que Imperial Imoveis.
-- O vinculo veio de BRACKET_CLIENT_PREFIX com confianca 0.92.
--
-- A regra tem duas direcoes, e elas nao valem o mesmo:
--
--   LABEL_PREFIX  - o rotulo cabe dentro do nome do cliente ("NEGIME" dentro de
--                   "Negime Elias"). Seguro: o GT abreviou. 53 apelidos ativos.
--   CLIENT_PREFIX - o nome do cliente cabe dentro do rotulo ("imperial" dentro de
--                   "imperial cred"). O rotulo tem palavras a mais, e palavra a
--                   mais quase sempre quer dizer outra empresa. 1 apelido ativo,
--                   e era justamente o errado.
--
-- Como "Imoveis" cai na normalizacao, "Imperial Imoveis" vira o token unico
-- "imperial" - e ai' CLIENT_PREFIX degenera em "compartilham uma palavra".
-- Exigir 2+ tokens no canonico do cliente derruba esse caso sem tocar nos 53
-- legitimos da direcao inversa.
do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'agency_ops' and p.proname = 'refresh_clickup_client_aliases';

  if v_def like '%c.canonical ~ '' '' and%' then
    raise notice 'guarda CLIENT_PREFIX ja aplicada';
    return;
  end if;

  v_novo := replace(v_def,
    'when length(coalesce(c.canonical,'''')) >= 4 and ('' '' || l.canonical || '' '') like (''% '' || c.canonical || '' %'') then 0.9200',
    'when length(coalesce(c.canonical,'''')) >= 4 and c.canonical ~ '' '' and ('' '' || l.canonical || '' '') like (''% '' || c.canonical || '' %'') then 0.9200');
  v_novo := replace(v_novo,
    'when length(coalesce(c.canonical,'''')) >= 4 and ('' '' || l.canonical || '' '') like (''% '' || c.canonical || '' %'') then ''CLIENT_PREFIX''',
    'when length(coalesce(c.canonical,'''')) >= 4 and c.canonical ~ '' '' and ('' '' || l.canonical || '' '') like (''% '' || c.canonical || '' %'') then ''CLIENT_PREFIX''');

  if v_novo = v_def then raise exception 'padrao CLIENT_PREFIX nao encontrado - revisar manualmente'; end if;
  execute v_novo;
end $do$;

update agency_ops.clickup_client_aliases set active = false, updated_at = now()
 where normalized_alias = 'imperial cred';

update agency_ops.clickup_tasks
   set client_id = null, client_match_status = 'UNMATCHED',
       client_match_source = 'BRACKET_UNMATCHED', client_match_confidence = null
 where client_label_normalized = 'imperial cred';

insert into agency_ops.integration_match_review (system, external_id, external_name, candidates, reason)
values ('CLICKUP_TASK_PREFIX','imperial cred','IMPERIAL CRED','[]'::jsonb,
        '8 tasks com rótulo IMPERIAL CRED. O gestor confirmou que não é a mesma empresa que Imperial Imóveis. Cadastrar como cliente ou marcar como interno.')
on conflict (system, external_id) do nothing;
