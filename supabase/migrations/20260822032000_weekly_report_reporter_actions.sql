create or replace function agency_ops.tg_weekly_report_enrich_reporters()
returns trigger
language plpgsql
security definer
set search_path to 'agency_ops','pg_catalog'
as $$
declare
  v_enriched jsonb := '[]'::jsonb;
  v_item jsonb;
  v_name text;
  v_leads numeric;
  v_calls numeric;
  v_answered numeric;
  v_conversations numeric;
  v_scheduled numeric;
  v_completed numeric;
  v_proposals numeric;
  v_attempt numeric;
  v_answer numeric;
  v_visit numeric;
  v_proposal_rate numeric;
  v_analysis text;
  v_action text;
  v_actions text := '';
begin
  for v_item in select value from jsonb_array_elements(coalesce(new.reporters,'[]'::jsonb)) loop
    v_name := coalesce(v_item->>'reporter','Não identificado');
    v_leads := coalesce((v_item->>'leads_received')::numeric,0);
    v_calls := coalesce((v_item->>'calls_made')::numeric,0);
    v_answered := coalesce((v_item->>'calls_answered')::numeric,0);
    v_conversations := coalesce((v_item->>'conversations')::numeric,0);
    v_scheduled := coalesce((v_item->>'visits_scheduled')::numeric,0);
    v_completed := coalesce((v_item->>'visits_completed')::numeric,0);
    v_proposals := coalesce((v_item->>'proposals')::numeric,0);
    v_attempt := case when v_leads>0 then round(v_calls/v_leads*100,1) end;
    v_answer := case when v_calls>0 then round(v_answered/v_calls*100,1) end;
    v_visit := case when v_conversations>0 then round(v_scheduled/v_conversations*100,1) end;
    v_proposal_rate := case when v_completed>0 then round(v_proposals/v_completed*100,1) end;

    if v_leads>0 and v_calls<v_leads then
      v_analysis := format('%s de %s leads possuem tentativa registrada (%s%%).',v_calls::int,v_leads::int,coalesce(v_attempt::text,'0'));
      v_action := 'Prioridade: aumentar a cobertura de primeiro contato dos leads recebidos.';
    elsif v_calls>0 and coalesce(v_answer,0)<50 then
      v_analysis := format('%s%% das tentativas resultaram em contato atendido.',coalesce(v_answer::text,'0'));
      v_action := 'Prioridade: revisar velocidade, insistência e distribuição das tentativas de contato.';
    elsif v_conversations>0 and coalesce(v_visit,0)<20 then
      v_analysis := format('%s%% dos leads em conversa avançaram para visita agendada.',coalesce(v_visit::text,'0'));
      v_action := 'Prioridade: conduzir melhor os leads já engajados para um compromisso de visita.';
    elsif v_completed>0 and v_proposals=0 then
      v_analysis := format('%s visita(s) realizada(s) e nenhuma proposta reportada.',v_completed::int);
      v_action := 'Prioridade: trabalhar o avanço pós-visita e a emissão de proposta.';
    elsif v_proposals>0 then
      v_analysis := format('%s proposta(s) a partir de %s visita(s) realizada(s) (%s%%).',v_proposals::int,v_completed::int,coalesce(v_proposal_rate::text,'—'));
      v_action := 'Manter o ritmo e acompanhar os follow-ups das propostas abertas.';
    else
      v_analysis := 'Sem gargalo individual conclusivo com os dados reportados nesta semana.';
      v_action := 'Manter o acompanhamento e melhorar a completude do reporte para a próxima análise.';
    end if;

    v_enriched := v_enriched || jsonb_build_array(v_item || jsonb_build_object('analysis',v_analysis,'action',v_action));
    v_actions := v_actions || E'\n• ' || v_name || ': ' || v_analysis || ' ' || v_action;
  end loop;
  new.reporters := v_enriched;
  if length(v_actions)>0 then
    new.client_message := coalesce(new.client_message,'') || E'\n\nPontos de ação por corretor:' || v_actions;
  end if;
  return new;
end;
$$;

drop trigger if exists weekly_report_enrich_reporters on agency_ops.weekly_commercial_reports;
create trigger weekly_report_enrich_reporters
before insert or update on agency_ops.weekly_commercial_reports
for each row execute function agency_ops.tg_weekly_report_enrich_reporters();
