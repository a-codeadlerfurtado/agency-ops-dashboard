-- Produtividade do ClickUp por periodo.
--
-- A tela "Produtividade por periodo" (aba ClickUp) ja' existia no front e chamava
-- view=clickup-range, mas a edge function nunca implementou essa rota: a chamada caia
-- no payload de "home" e a tela mostrava zero em Hoje/Ontem/Anteontem e "Sem dados no
-- periodo selecionado" para qualquer intervalo e qualquer pessoa selecionada.
-- O calculo fica em SQL porque agregar em JS exigiria puxar a tabela inteira de tasks
-- para a funcao, e o teto de linhas do PostgREST ja' truncou essa leitura antes.
--
-- Dia = data de conclusao no fuso da operacao (America/Sao_Paulo), nao em UTC:
-- task fechada as 22h de Brasilia e' de hoje, nao de amanha.

create or replace function agency_ops.clickup_range_report(
  p_since  date,
  p_until  date,
  p_people text[] default null
)
returns jsonb
language sql
stable
security definer
set search_path = agency_ops, public
as $$
  with escopo as (
    select t.task_id,
           t.date_created,
           t.date_closed,
           t.due_date,
           a.user_id,
           coalesce(a.username, a.email) as person
      from agency_ops.clickup_tasks t
      join agency_ops.clickup_task_assignees a on a.task_id = t.task_id
     where t.is_closed
       and t.date_closed is not null
       and (t.date_closed at time zone 'America/Sao_Paulo')::date between p_since and p_until
       and (
         p_people is null
         or cardinality(p_people) = 0
         or coalesce(a.username, a.email) = any (p_people)
       )
  ),
  diario as (
    select (date_closed at time zone 'America/Sao_Paulo')::date as dia,
           count(distinct task_id) as tasks_done
      from escopo
     group by 1
  ),
  pessoa as (
    select user_id,
           person,
           count(distinct task_id) as tasks_done,
           round(avg(extract(epoch from (date_closed - date_created)) / 3600.0)::numeric, 1) as avg_cycle_hours,
           count(*) filter (where due_date is null or date_closed <= due_date)     as completed_on_time,
           count(*) filter (where due_date is not null and date_closed > due_date) as completed_late
      from escopo
     group by 1, 2
  )
  select jsonb_build_object(
    'since', p_since,
    'until', p_until,
    'daily_totals', coalesce((
      select jsonb_agg(jsonb_build_object('date', dia, 'tasks_done', tasks_done) order by dia)
        from diario
    ), '[]'::jsonb),
    'summary', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id',           user_id,
               'person',            person,
               'tasks_done',        tasks_done,
               'avg_cycle_hours',   avg_cycle_hours,
               'completed_on_time', completed_on_time,
               'completed_late',    completed_late
             ) order by tasks_done desc)
        from pessoa
    ), '[]'::jsonb)
  );
$$;

-- So' quem chama e' a edge function, com service role. PUBLIC nao precisa executar.
revoke all on function agency_ops.clickup_range_report(date, date, text[]) from public;
grant execute on function agency_ops.clickup_range_report(date, date, text[]) to service_role;
