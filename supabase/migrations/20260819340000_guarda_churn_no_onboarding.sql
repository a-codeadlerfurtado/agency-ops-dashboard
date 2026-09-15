-- Bug que ressuscitava cliente que ja saiu.
--
-- recalculate_onboarding_case terminava com:
--
--   UPDATE agency_ops.clients c SET lifecycle = 'ACTIVE'
--     FROM agency_ops.onboarding_cases oc
--    WHERE oc.id = p_case_id AND c.id = oc.client_id;
--
-- Sem nenhuma guarda contra CHURNED. Qualquer cliente que ja saiu voltava para ativo
-- assim que o caso de onboarding dele fosse recalculado - e o motor de onboarding roda
-- a cada 2 minutos. Foi isso que fez o lifecycle do Airton oscilar entre CHURNED e
-- ACTIVE e me levou a reportar um churn de 19/08 que nao existiu.
--
-- Varredura na base: nenhum outro cliente estava com saida preenchida e lifecycle
-- diferente de CHURNED, entao o Airton foi o unico pego no meio do flip.
--
-- A correcao e' aplicada sobre a definicao viva da funcao para nao precisar reproduzir
-- o corpo inteiro aqui e arriscar divergir do que esta em producao.
do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'agency_ops' and p.proname = 'recalculate_onboarding_case';

  if v_def is null then
    raise notice 'recalculate_onboarding_case nao existe; nada a fazer';
    return;
  end if;

  if v_def ilike '%c.lifecycle <> ''CHURNED''%' then
    raise notice 'guarda ja aplicada';
    return;
  end if;

  v_novo := regexp_replace(v_def,
    $re$(SET lifecycle = 'ACTIVE',[\s\S]*?AND c\.id = oc\.client_id);$re$,
    $rp$\1
      AND c.lifecycle <> 'CHURNED';$rp$);

  if v_novo = v_def then
    raise exception 'padrao nao encontrado em recalculate_onboarding_case - revisar manualmente';
  end if;

  execute v_novo;
end $do$;
