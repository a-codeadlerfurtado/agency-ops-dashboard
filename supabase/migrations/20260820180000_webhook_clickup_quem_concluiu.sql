-- O webhook do ClickUp derrubava a si mesmo, e ninguem via.
--
-- O QUE ACONTECEU (20/08/2026)
-- O gestor notou que as notificacoes de tarefa concluida pararam de mostrar quem
-- concluiu. Os numeros: 19/08, 34 de 54 com autor; 20/08, 10 de 46.
--
-- Perguntando direto a API do ClickUp, o webhook estava assim:
--   status: suspended | fail_count: 144 | suspenso em 20/08 12:32
-- O ultimo evento recebido foi 12:09. Ou seja: entre 12:09 e 12:32 o ClickUp tentou
-- entregar 144 vezes, falhou em todas, e desligou o webhook sozinho.
--
-- POR QUE FALHOU
-- O handler em clickup-sync-api gravava o evento e entao chamava a API do ClickUp
-- (getTask) e ESPERAVA a resposta antes de responder ao webhook. Quando a API deles
-- engasgava - e engasgou, o unico processing_error gravado e' exatamente
-- "clickup_task_500 ... net/http: timeout awaiting response headers" - a entrega
-- estourava o tempo e virava falha. Um laco que se morde: ClickUp lento derruba nossa
-- entrega, entrega lenta faz o ClickUp nos desligar.
--
-- POR QUE NINGUEM VIU
-- As notificacoes nao pararam. O cron de 15 minutos continuou marcando tarefas como
-- concluidas, entao elas seguiram aparecendo - so' que sem o nome de quem fechou, que
-- so' existe no evento do webhook. E as 144 falhas nao deixaram rastro no banco porque
-- aconteciam ANTES de qualquer gravacao nossa.
--
-- O conserto do handler esta' em supabase/functions/clickup-sync-api (v11): grava o
-- evento, responde na hora, e atualiza a tarefa em segundo plano com waitUntil e
-- timeout de 15s. Aqui ficam as duas partes que vivem no banco.

-- ---------------------------------------------------------------------------
-- 1. A notificacao admite quando nao sabe
-- ---------------------------------------------------------------------------
-- Sem o webhook, v_completed_by vinha nulo e a notificacao saia sem dizer nada sobre
-- quem concluiu - some do jeito que some um dado que nunca existiu. Dizer "nao
-- identificado" transforma buraco invisivel em buraco visivel.
create or replace function agency_ops.record_clickup_completion_notification()
returns trigger language plpgsql security definer
set search_path to 'agency_ops', 'public'
as $function$
declare
  v_completed_by text; v_completed_by_id text;
  v_assignee_names text; v_assignees jsonb := '[]'::jsonb;
  v_closed_at timestamptz := coalesce(new.date_closed, new.last_synced_at, now());
  v_description text;
begin
  if new.is_closed and (tg_op = 'INSERT' or not coalesce(old.is_closed,false)) then
    select e.actor_name, e.actor_id into v_completed_by, v_completed_by_id
    from agency_ops.clickup_task_events e
    where e.task_id = new.task_id
      and lower(coalesce(e.after_value->>'type','')) = 'closed'
      and e.event_at between v_closed_at - interval '10 minutes' and v_closed_at + interval '10 minutes'
    order by abs(extract(epoch from (e.event_at - v_closed_at))), e.id desc limit 1;

    select string_agg(coalesce(a.username,a.email,a.user_id), ', ' order by coalesce(a.username,a.email,a.user_id)),
           coalesce(jsonb_agg(jsonb_build_object('user_id',a.user_id,'username',a.username,'email',a.email)
                    order by coalesce(a.username,a.email,a.user_id)), '[]'::jsonb)
      into v_assignee_names, v_assignees
    from agency_ops.clickup_task_assignees a where a.task_id = new.task_id;

    v_description := new.name;
    if v_assignee_names is not null and btrim(v_assignee_names) <> '' then
      v_description := v_description || ' · Responsável pela task: ' || v_assignee_names;
    end if;
    if v_completed_by is null then
      v_description := v_description || ' · Quem concluiu: não identificado (webhook do ClickUp sem evento)';
    end if;

    insert into agency_ops.platform_notifications(
      event_key,type,level,title,description,client_id,task_id,source,actor,occurred_at,metadata)
    values ('clickup:closed:'||new.task_id||':'||coalesce(new.date_closed::text,new.last_synced_at::text),
      'TASK_COMPLETED','SUCCESS','Tarefa concluída',v_description,new.client_id,new.task_id,'ClickUp',v_completed_by,
      v_closed_at,
      jsonb_build_object('url',new.url,'status',new.status,'list',new.list_name,'task_name',new.name,
        'completed_by',v_completed_by,'completed_by_id',v_completed_by_id,
        'completion_actor_source',case when v_completed_by is not null then 'CLICKUP_STATUS_EVENT' else 'NOT_IDENTIFIED' end,
        'assignee_names',v_assignee_names,'assignees',v_assignees))
    on conflict (event_key) do nothing;
  end if;
  return new;
end $function$;

-- ---------------------------------------------------------------------------
-- 2. Alerta quando o webhook emudece COM tarefa fechando
-- ---------------------------------------------------------------------------
-- As duas condicoes juntas de proposito: fim de semana sem tarefa concluida nao e'
-- webhook quebrado, e alertar nisso treina o time a ignorar o sino.
create or replace function agency_ops.notify_clickup_webhook_mudo()
returns integer language plpgsql security definer
set search_path to 'agency_ops', 'pg_catalog'
as $fn$
declare v_ultimo timestamptz; v_horas numeric; v_sem int; v_total int;
begin
  select max(event_at) into v_ultimo from agency_ops.clickup_task_events;
  select count(*) filter (where actor is null), count(*) into v_sem, v_total
  from agency_ops.platform_notifications
  where type='TASK_COMPLETED' and occurred_at > now() - interval '12 hours';
  v_horas := round(extract(epoch from (now() - coalesce(v_ultimo, now() - interval '99 days')))/3600.0);

  if v_total = 0 or v_horas < 6 then
    update agency_ops.platform_notifications set read_at = now()
     where event_key='alerta:clickup_webhook_mudo' and read_at is null;
    return 0;
  end if;

  insert into agency_ops.platform_notifications
    (event_key,type,level,title,description,source,occurred_at,metadata)
  values ('alerta:clickup_webhook_mudo','OPERATIONAL_ALERT','ATTENTION',
    'Não dá mais para saber quem concluiu as tarefas',
    'O webhook do ClickUp está sem enviar eventos há ' || v_horas || 'h, mas ' || v_total
    || ' tarefa(s) foram concluídas nesse período — ' || v_sem || ' delas sem autor identificado. '
    || 'As notificações continuam saindo, só que sem o nome de quem fechou, porque esse dado '
    || 'só existe no evento do webhook (o cron de 15min enxerga a tarefa fechada, não quem fechou). '
    || 'Conserto: aba ClickUp no dashboard, botão "Ativar tempo real" — ele registra o webhook de novo. '
    || 'O ClickUp suspende webhook sozinho depois de algumas falhas seguidas de entrega.',
    'agency_ops.clickup_task_events', now(),
    jsonb_build_object('horas_sem_evento',v_horas,'concluidas_12h',v_total,'sem_autor',v_sem,
                       'ultimo_evento',v_ultimo))
  on conflict (event_key) do update
    set level=excluded.level, title=excluded.title, description=excluded.description,
        metadata=excluded.metadata, occurred_at=now(), read_at=null;
  return v_sem;
end $fn$;

select cron.schedule('notify_clickup_webhook_mudo','40 */3 * * *',
                     $c$select agency_ops.notify_clickup_webhook_mudo();$c$);
