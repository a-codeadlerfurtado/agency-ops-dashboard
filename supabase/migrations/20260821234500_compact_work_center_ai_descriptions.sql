-- Mantém a rastreabilidade completa das demandas geradas pela IA,
-- mas entrega à Central de Trabalho uma descrição operacional curta e legível.

create or replace function agency_ops.ai_work_item_section(
  p_text text,
  p_start text,
  p_end text default null
)
returns text
language plpgsql
immutable
as $$
declare
  v_rest text;
  v_end integer;
begin
  if coalesce(p_text, '') = '' or coalesce(p_start, '') = '' or strpos(p_text, p_start) = 0 then
    return null;
  end if;

  v_rest := substr(p_text, strpos(p_text, p_start) + char_length(p_start));
  if p_end is not null and strpos(v_rest, p_end) > 0 then
    v_end := strpos(v_rest, p_end);
    v_rest := left(v_rest, v_end - 1);
  end if;

  return nullif(btrim(v_rest), '');
end;
$$;

create or replace function agency_ops.ai_work_item_clean_text(
  p_text text,
  p_limit integer default 400
)
returns text
language sql
immutable
as $$
  select case
    when nullif(btrim(coalesce(p_text, '')), '') is null then null
    else left(
      btrim(
        regexp_replace(
          regexp_replace(coalesce(p_text, ''), '[[:space:]]+', ' ', 'g'),
          '(^|[[:space:]])-[[:space:]]+',
          '\1',
          'g'
        )
      ),
      greatest(coalesce(p_limit, 400), 1)
    )
  end;
$$;

create or replace function agency_ops.compact_ai_work_item_description(
  p_description text,
  p_metadata jsonb
)
returns text
language plpgsql
immutable
as $$
declare
  v_action text;
  v_context text;
  v_completion text;
  v_conflicts text;
  v_evidence text;
  v_requester text;
  v_group text;
  v_origin text;
  v_parts text[] := array[]::text[];
begin
  if nullif(btrim(coalesce(p_description, '')), '') is null then
    return p_description;
  end if;

  v_action := agency_ops.ai_work_item_section(
    p_description,
    '📌 O QUE PRECISA SER FEITO',
    '👤 QUEM PEDIU / ORIGEM DO PEDIDO'
  );
  v_context := agency_ops.ai_work_item_section(
    p_description,
    '🧠 CONTEXTO OPERACIONAL DO CLIENTE',
    '📊 CONFIGURAÇÃO DO CLIENTE'
  );
  v_conflicts := agency_ops.ai_work_item_section(
    p_description,
    '⚠️ DIVERGÊNCIAS / PONTOS A CONFIRMAR',
    '✅ CRITÉRIOS DE CONCLUSÃO'
  );
  v_completion := agency_ops.ai_work_item_section(
    p_description,
    '✅ CRITÉRIOS DE CONCLUSÃO',
    '🔎 FONTES CONSULTADAS'
  );

  -- Compatibilidade com descrições antigas do Task Engine.
  if v_action is null then
    v_action := split_part(p_description, E'\n\n', 1);
  end if;

  v_action := agency_ops.ai_work_item_clean_text(v_action, 430);
  v_context := agency_ops.ai_work_item_clean_text(v_context, 330);
  v_completion := agency_ops.ai_work_item_clean_text(v_completion, 300);
  v_conflicts := agency_ops.ai_work_item_clean_text(v_conflicts, 240);
  v_evidence := agency_ops.ai_work_item_clean_text(p_metadata ->> 'evidence', 260);
  v_requester := agency_ops.ai_work_item_clean_text(p_metadata ->> 'requester_name', 120);
  v_group := agency_ops.ai_work_item_clean_text(p_metadata ->> 'source_group_name', 140);

  if v_conflicts ~* 'nenhuma diverg[eê]ncia|nenhum conflito|nenhum ponto' then
    v_conflicts := null;
  end if;

  if v_requester is not null or v_group is not null then
    v_origin := concat_ws(' · ', v_requester, case when v_group is not null then 'grupo ' || v_group end);
  end if;

  if v_action is not null then
    v_parts := array_append(v_parts, 'AÇÃO — ' || v_action);
  end if;
  if v_context is not null then
    v_parts := array_append(v_parts, 'CONTEXTO — ' || v_context);
  end if;
  if v_evidence is not null then
    v_parts := array_append(v_parts, 'PEDIDO — “' || v_evidence || '”');
  end if;
  if v_origin is not null then
    v_parts := array_append(v_parts, 'ORIGEM — ' || v_origin);
  end if;
  if v_completion is not null then
    v_parts := array_append(v_parts, 'CONCLUIR QUANDO — ' || v_completion);
  end if;
  if v_conflicts is not null then
    v_parts := array_append(v_parts, 'CONFIRMAR — ' || v_conflicts);
  end if;

  return left(array_to_string(v_parts, '  •  '), 1800);
end;
$$;

create or replace function agency_ops.compact_task_engine_work_item_before_write()
returns trigger
language plpgsql
as $$
begin
  if new.source = 'task_engine_ai'
     and coalesce(new.metadata ->> 'ai_generated', 'false') = 'true'
     and coalesce(new.metadata ->> 'compact_description_version', '') <> 'v1'
     and nullif(btrim(coalesce(new.description, '')), '') is not null then

    new.metadata := coalesce(new.metadata, '{}'::jsonb)
      || jsonb_build_object(
        'rich_description', new.description,
        'compact_description_version', 'v1'
      );

    new.description := agency_ops.compact_ai_work_item_description(new.description, new.metadata);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_compact_task_engine_work_item on agency_ops.work_items;
create trigger trg_compact_task_engine_work_item
before insert or update of description
on agency_ops.work_items
for each row
execute function agency_ops.compact_task_engine_work_item_before_write();

-- Aplica a nova leitura aos cards de IA que já existem.
-- O trigger preserva a versão completa em metadata.rich_description antes de compactar.
update agency_ops.work_items
set description = description
where source = 'task_engine_ai'
  and coalesce(metadata ->> 'ai_generated', 'false') = 'true'
  and coalesce(metadata ->> 'compact_description_version', '') <> 'v1';
