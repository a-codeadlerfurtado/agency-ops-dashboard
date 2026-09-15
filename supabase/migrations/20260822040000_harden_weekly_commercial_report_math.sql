create or replace function agency_ops.weekly_safe_rate(p_num numeric, p_den numeric)
returns numeric language sql immutable as $$
  select case when p_num is null or p_den is null or p_den <= 0 or p_num < 0 or p_num > p_den then null else round((p_num / p_den) * 100, 1) end
$$;

create or replace function agency_ops.weekly_rate_context(p_current numeric, p_previous numeric, p_unavailable text default 'dados insuficientes para comparar')
returns text language plpgsql immutable as $$
declare v_delta numeric;
begin
  if p_current is null then return p_unavailable; end if;
  if p_previous is null then return 'sem base comparável da semana anterior'; end if;
  v_delta := round(p_current - p_previous,1);
  if abs(v_delta) < 0.1 then return 'estável em relação à semana anterior'; end if;
  return case when v_delta > 0 then 'subiu ' else 'caiu ' end || trim(to_char(abs(v_delta),'FM999990D0')) || ' p.p. em relação à semana anterior';
end;
$$;

create or replace function agency_ops.tg_weekly_report_validate_rates()
returns trigger language plpgsql security definer set search_path to 'agency_ops','pg_catalog' as $$
declare
  m jsonb := coalesce(new.metrics,'{}'::jsonb); p jsonb := coalesce(new.previous_metrics,'{}'::jsonb);
  v_leads numeric := coalesce((m->>'leads_received')::numeric,0); v_calls numeric := coalesce((m->>'calls_made')::numeric,0);
  v_answered numeric := coalesce((m->>'calls_answered')::numeric,0); v_conversations numeric := coalesce((m->>'conversations')::numeric,0);
  v_scheduled numeric := coalesce((m->>'visits_scheduled')::numeric,0); v_completed numeric := coalesce((m->>'visits_completed')::numeric,0);
  v_proposals numeric := coalesce((m->>'proposals')::numeric,0); v_sales numeric := coalesce((m->>'sales')::numeric,0);
  v_attempt_rate numeric; v_attempts_per_lead numeric; v_answer_attempt numeric; v_visit_schedule numeric; v_visit_completion numeric;
  v_proposal numeric; v_sale_proposal numeric; v_sale_lead numeric; v_contexts jsonb; v_bottleneck text; v_low_label text; v_low_value numeric;
begin
  v_attempt_rate := case when v_leads>0 then round(v_calls/v_leads*100,1) end;
  v_attempts_per_lead := case when v_leads>0 then round(v_calls/v_leads,2) end;
  v_answer_attempt := agency_ops.weekly_safe_rate(v_answered,v_calls);
  v_visit_schedule := agency_ops.weekly_safe_rate(v_scheduled,v_conversations);
  v_visit_completion := agency_ops.weekly_safe_rate(v_completed,v_scheduled);
  v_proposal := agency_ops.weekly_safe_rate(v_proposals,v_completed);
  v_sale_proposal := agency_ops.weekly_safe_rate(v_sales,v_proposals);
  v_sale_lead := agency_ops.weekly_safe_rate(v_sales,v_leads);
  m := m || jsonb_build_object('attempt_rate',v_attempt_rate,'attempts_per_lead',v_attempts_per_lead,'answer_lead_rate',null,'answer_attempt_rate',v_answer_attempt,'conversation_answer_rate',null,'visit_schedule_rate',v_visit_schedule,'visit_completion_rate',v_visit_completion,'proposal_rate',v_proposal,'sale_proposal_rate',v_sale_proposal,'sale_lead_rate',v_sale_lead);
  new.metrics := m;
  v_contexts := jsonb_build_object(
    'attempt_rate',jsonb_build_object('label','Tentativas / leads','value',v_attempt_rate,'context',case when v_attempts_per_lead is null then 'dados insuficientes' else trim(to_char(v_attempts_per_lead,'FM999990D00'))||' tentativa(s) por lead; não representa leads únicos contatados' end),
    'answer_lead_rate',jsonb_build_object('label','Leads únicos contatados / leads','value',null,'context','não calculado: o grupo informa ligações atendidas, não leads únicos contatados'),
    'answer_attempt_rate',jsonb_build_object('label','Ligações atendidas / tentativas','value',v_answer_attempt,'context',agency_ops.weekly_rate_context(v_answer_attempt,(p->>'answer_attempt_rate')::numeric,'dados insuficientes ou contagem incompatível')),
    'conversation_answer_rate',jsonb_build_object('label','Em conversa / contatos','value',null,'context','não calculado: “em conversa” pode incluir WhatsApp e leads de períodos anteriores; a base não é a mesma de ligações atendidas'),
    'visit_schedule_rate',jsonb_build_object('label','Visitas agendadas / em conversa','value',v_visit_schedule,'context',agency_ops.weekly_rate_context(v_visit_schedule,(p->>'visit_schedule_rate')::numeric,'dados insuficientes ou volumes de períodos diferentes')),
    'visit_completion_rate',jsonb_build_object('label','Visitas realizadas / agendadas','value',v_visit_completion,'context',agency_ops.weekly_rate_context(v_visit_completion,(p->>'visit_completion_rate')::numeric,'dados insuficientes ou volumes de períodos diferentes')),
    'proposal_rate',jsonb_build_object('label','Propostas / visitas realizadas','value',v_proposal,'context',agency_ops.weekly_rate_context(v_proposal,(p->>'proposal_rate')::numeric,'dados insuficientes ou volumes de períodos diferentes')),
    'sale_proposal_rate',jsonb_build_object('label','Vendas / propostas','value',v_sale_proposal,'context',agency_ops.weekly_rate_context(v_sale_proposal,(p->>'sale_proposal_rate')::numeric,'dados insuficientes ou vendas sem proposta da mesma janela')),
    'sale_lead_rate',jsonb_build_object('label','Vendas / leads da semana','value',v_sale_lead,'context',case when v_sale_lead is null then 'dados insuficientes ou venda sem coorte semanal comprovada' else agency_ops.weekly_rate_context(v_sale_lead,(p->>'sale_lead_rate')::numeric,'sem base comparável da semana anterior; relação semanal, não atribuição individual de lead') end));
  select x.label,x.val into v_low_label,v_low_value from (values ('Visitas agendadas / em conversa',v_visit_schedule),('Visitas realizadas / agendadas',v_visit_completion),('Propostas / visitas realizadas',v_proposal),('Vendas / propostas',v_sale_proposal)) as x(label,val) where x.val is not null order by x.val asc limit 1;
  v_bottleneck := case when v_low_value is null then 'Ainda não há bases compatíveis suficientes para identificar um gargalo percentual.' else 'Menor conversão comparável: '||v_low_label||' em '||trim(to_char(v_low_value,'FM999990D0'))||'%.' end;
  new.context := coalesce(new.context,'{}'::jsonb) || jsonb_build_object('rate_contexts',v_contexts,'bottleneck',v_bottleneck,'math_policy','Somente percentuais com denominadores realmente compatíveis; volumes incompatíveis permanecem como contagens.');
  return new;
end;
$$;

drop trigger if exists weekly_report_00_validate_rates on agency_ops.weekly_commercial_reports;
create trigger weekly_report_00_validate_rates before insert or update on agency_ops.weekly_commercial_reports for each row execute function agency_ops.tg_weekly_report_validate_rates();

create or replace function agency_ops.tg_weekly_report_enrich_reporters()
returns trigger language plpgsql security definer set search_path to 'agency_ops','pg_catalog' as $$
declare
  v_enriched jsonb := '[]'::jsonb; v_item jsonb; v_name text; v_leads numeric; v_calls numeric; v_answered numeric; v_conversations numeric; v_scheduled numeric; v_completed numeric; v_proposals numeric; v_answer numeric; v_visit numeric; v_analysis text; v_action text;
begin
  for v_item in select value from jsonb_array_elements(coalesce(new.reporters,'[]'::jsonb)) loop
    v_name := coalesce(v_item->>'reporter','Não identificado'); v_leads := coalesce((v_item->>'leads_received')::numeric,0); v_calls := coalesce((v_item->>'calls_made')::numeric,0); v_answered := coalesce((v_item->>'calls_answered')::numeric,0); v_conversations := coalesce((v_item->>'conversations')::numeric,0); v_scheduled := coalesce((v_item->>'visits_scheduled')::numeric,0); v_completed := coalesce((v_item->>'visits_completed')::numeric,0); v_proposals := coalesce((v_item->>'proposals')::numeric,0); v_answer := agency_ops.weekly_safe_rate(v_answered,v_calls); v_visit := agency_ops.weekly_safe_rate(v_scheduled,v_conversations);
    if v_leads>0 and v_calls=0 then v_analysis := format('%s lead(s) reportado(s) e nenhuma ligação efetuada.',v_leads::int); v_action := 'Prioridade: iniciar as tentativas de contato dos leads recebidos.';
    elsif v_calls>0 and v_answer is not null and v_answer<50 then v_analysis := format('%s ligação(ões) para %s lead(s); %s%% das tentativas foram atendidas.',v_calls::int,v_leads::int,trim(to_char(v_answer,'FM999990D0'))); v_action := 'Prioridade: revisar horário, velocidade e insistência das tentativas de contato.';
    elsif v_conversations>0 and v_visit is not null and v_visit<20 then v_analysis := format('%s lead(s) em conversa e %s visita(s) agendada(s) (%s%%).',v_conversations::int,v_scheduled::int,trim(to_char(v_visit,'FM999990D0'))); v_action := 'Prioridade: conduzir melhor os leads já engajados para um compromisso de visita.';
    elsif v_completed>0 and v_proposals=0 then v_analysis := format('%s visita(s) realizada(s) e nenhuma proposta reportada.',v_completed::int); v_action := 'Prioridade: trabalhar o avanço pós-visita e a emissão de proposta.';
    elsif v_proposals>0 then v_analysis := format('%s proposta(s) reportada(s) após %s visita(s) realizada(s).',v_proposals::int,v_completed::int); v_action := 'Manter o ritmo e acompanhar os follow-ups das propostas abertas.';
    elsif v_calls>0 then v_analysis := format('%s ligação(ões) para %s lead(s) no período. Isso equivale a %s tentativa(s) por lead, não a %s leads únicos contatados.',v_calls::int,v_leads::int,case when v_leads>0 then trim(to_char(v_calls/v_leads,'FM999990D00')) else '—' end,v_calls::int); v_action := 'Manter o acompanhamento e melhorar a completude do reporte para permitir análise de conversão por lead único.';
    else v_analysis := 'Sem gargalo individual conclusivo com os dados reportados nesta semana.'; v_action := 'Melhorar a completude do reporte para a próxima análise.'; end if;
    v_enriched := v_enriched || jsonb_build_array(v_item || jsonb_build_object('analysis',v_analysis,'action',v_action));
  end loop;
  new.reporters := v_enriched; return new;
end;
$$;

create or replace function agency_ops.tg_weekly_report_finalize_message()
returns trigger language plpgsql security definer set search_path to 'agency_ops','pg_catalog' as $$
declare
  m jsonb := coalesce(new.metrics,'{}'::jsonb); ctx jsonb := coalesce(new.context->'rate_contexts','{}'::jsonb); r jsonb; v_message text; v_actions text := '';
  v_fmt_start text := to_char(new.week_start,'DD/MM/YYYY'); v_fmt_end text := to_char(new.week_end,'DD/MM/YYYY');
  v_leads int := coalesce((m->>'leads_received')::int,0); v_calls int := coalesce((m->>'calls_made')::int,0); v_answered int := coalesce((m->>'calls_answered')::int,0); v_conversations int := coalesce((m->>'conversations')::int,0); v_scheduled int := coalesce((m->>'visits_scheduled')::int,0); v_completed int := coalesce((m->>'visits_completed')::int,0); v_proposals int := coalesce((m->>'proposals')::int,0); v_sales int := coalesce((m->>'sales')::int,0);
  v_attempts numeric := (m->>'attempts_per_lead')::numeric; v_answer_rate numeric := (m->>'answer_attempt_rate')::numeric; v_visit_rate numeric := (m->>'visit_schedule_rate')::numeric; v_complete_rate numeric := (m->>'visit_completion_rate')::numeric; v_proposal_rate numeric := (m->>'proposal_rate')::numeric; v_sale_prop numeric := (m->>'sale_proposal_rate')::numeric; v_sale_lead numeric := (m->>'sale_lead_rate')::numeric;
begin
  v_message := 'Pessoal, passando com o fechamento comercial da semana de '||v_fmt_start||' a '||v_fmt_end||'.'||E'\n';
  if new.meta_cross_status='MATCH' then v_message := v_message||'O Meta registrou '||coalesce(new.meta_leads,0)||' leads no período e esse volume confere com o total reportado pelo comercial.'||E'\n\n'; else v_message := v_message||'Nos dados comerciais disponíveis, foram reportados '||v_leads||' leads no período.'||E'\n\n'; end if;
  v_message := v_message||'• Ligações efetuadas: '||v_calls||case when v_attempts is null then '.' else ' — '||trim(to_char(v_attempts,'FM999990D00'))||' tentativa(s) por lead reportado; isso não representa leads únicos contatados.' end||E'\n';
  v_message := v_message||'• Ligações atendidas: '||v_answered||case when v_answer_rate is null then ' — taxa não calculada por falta de base compatível.' else ' — '||trim(to_char(v_answer_rate,'FM999990D0'))||'% das tentativas; '||coalesce(ctx->'answer_attempt_rate'->>'context','sem comparação anterior')||'.' end||E'\n';
  v_message := v_message||'• Em conversa: '||v_conversations||' — mantido como volume, sem dividir por ligações atendidas, porque pode incluir WhatsApp e leads de períodos anteriores.'||E'\n';
  v_message := v_message||'• Visitas agendadas: '||v_scheduled||case when v_visit_rate is null then ' — conversão não calculada por falta de base compatível.' else ' — '||trim(to_char(v_visit_rate,'FM999990D0'))||'% dos leads reportados como “em conversa”; '||coalesce(ctx->'visit_schedule_rate'->>'context','sem comparação anterior')||'.' end||E'\n';
  v_message := v_message||'• Visitas realizadas: '||v_completed||case when v_complete_rate is null then ' — conversão não calculada por falta de base compatível.' else ' — '||trim(to_char(v_complete_rate,'FM999990D0'))||'% das visitas agendadas; '||coalesce(ctx->'visit_completion_rate'->>'context','sem comparação anterior')||'.' end||E'\n';
  v_message := v_message||'• Propostas: '||v_proposals||case when v_proposal_rate is null then ' — conversão não calculada por falta de base compatível.' else ' — '||trim(to_char(v_proposal_rate,'FM999990D0'))||'% das visitas realizadas; '||coalesce(ctx->'proposal_rate'->>'context','sem comparação anterior')||'.' end||E'\n';
  if v_sales>0 or v_proposals>0 then v_message := v_message||'• Vendas identificadas: '||v_sales||case when v_sale_prop is null then ' — sem base compatível para taxa sobre propostas.' else ' — '||trim(to_char(v_sale_prop,'FM999990D0'))||'% das propostas.' end||case when v_sale_lead is null then '' else ' Relação semanal: '||trim(to_char(v_sale_lead,'FM999990D0'))||'% sobre os leads reportados; isso não prova que a venda veio da mesma coorte.' end||E'\n'; end if;
  v_message := v_message||E'\n'||coalesce(new.context->>'bottleneck','Ainda não há base suficiente para identificar gargalo percentual.')||E'\n';
  if jsonb_array_length(coalesce(new.reporters,'[]'::jsonb))>0 then v_message := v_message||E'\nResumo por corretor:'||E'\n'; for r in select value from jsonb_array_elements(new.reporters) loop v_message := v_message||'• '||coalesce(r->>'reporter','Não identificado')||': '||coalesce(r->>'leads_received','0')||' leads; '||coalesce(r->>'calls_made','0')||' ligações; '||coalesce(r->>'calls_answered','0')||' atendidas; '||coalesce(r->>'conversations','0')||' em conversa; '||coalesce(r->>'visits_scheduled','0')||' visitas agendadas; '||coalesce(r->>'visits_completed','0')||' realizadas; '||coalesce(r->>'proposals','0')||' propostas.'||E'\n'; v_actions := v_actions||'• '||coalesce(r->>'reporter','Não identificado')||': '||coalesce(r->>'analysis','Sem análise conclusiva.')||' '||coalesce(r->>'action','')||E'\n'; end loop; end if;
  if length(v_actions)>0 then v_message := v_message||E'\nPontos de ação por corretor:'||E'\n'||v_actions; end if;
  v_message := v_message||E'\nNa próxima semana, vamos acompanhar a evolução das bases comparáveis e manter separados os volumes que não representam a mesma etapa do funil.';
  new.client_message := v_message; return new;
end;
$$;

drop trigger if exists weekly_report_z_finalize_message on agency_ops.weekly_commercial_reports;
create trigger weekly_report_z_finalize_message before insert or update on agency_ops.weekly_commercial_reports for each row execute function agency_ops.tg_weekly_report_finalize_message();
