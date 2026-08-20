-- Pipeline de transcricoes Donnah/Google Meet: deduplicacao, processamento e sinais.
--
-- CONTEXTO ENCONTRADO
-- A tabela existia mas estava vazia. A Edge Function deduplicava pelo nome do
-- arquivo e fazia upsert do texto - e ai' estava um bug de perda de evidencia: como
-- o mesmo nome aparece com tamanhos diferentes (hbs-ckib-puj existe com 437 e com
-- 31461 bytes, porque a Donnah reescreve o arquivo enquanto a reuniao acontece),
-- dependendo da ordem de chegada a versao curta sobrescrevia a completa.
--
-- A pasta do Drive tambem e' pior que "algumas copias": o cenario 4813568 do Make
-- ("ENVIO DE TRANSCRIPTS PARA PASTA GERAL") recopia tudo a cada 90 minutos com
-- file_id novo. Um mesmo transcript aparece 8+ vezes no mesmo dia.
--
-- DECISAO DE ARQUITETURA
-- A deduplicacao vive no banco, nao na Edge Function. A funcao virou um involucro
-- fino que autentica e delega. Assim o fluxo continuo (Make) e qualquer backfill
-- usam exatamente as mesmas regras - duas implementacoes divergiriam na primeira
-- mudanca.

alter table agency_ops.meeting_transcripts
  add column if not exists content_sha256 text,
  add column if not exists source_file_ids jsonb not null default '[]'::jsonb,
  add column if not exists copies_seen integer not null default 1;

create index if not exists meeting_transcripts_sha_idx
  on agency_ops.meeting_transcripts (source_system, content_sha256);
create index if not exists meeting_transcripts_code_time_idx
  on agency_ops.meeting_transcripts (source_system, meeting_code, meeting_started_at);

-- "abc-defg-hij - 2026-08-19 09h00.txt"
create or replace function agency_ops.parse_donnah_filename(p_name text)
returns table (code text, started_at timestamptz) language sql immutable as $$
  select lower(m[1]),
         (m[2] || ' ' || lpad(m[3],2,'0') || ':' || m[4] || ':00-03')::timestamptz
  from regexp_match(coalesce(p_name,''),
       '^([a-zA-Z]{3}-[a-zA-Z]{4}-[a-zA-Z]{3})\s+-\s+(\d{4}-\d{2}-\d{2})\s+(\d{1,2})h(\d{2})') m
$$;

-- Tres camadas de deduplicacao, nesta ordem. A regra que as governa: preferir dois
-- registros separados a fundir duas reunioes diferentes.
create or replace function agency_ops.ingest_meeting_transcript(p jsonb)
returns jsonb language plpgsql security definer set search_path = agency_ops, public as $fn$
declare
  v_file_id text := nullif(trim(coalesce(p->>'file_id', p->>'id','')),'');
  v_name    text := nullif(trim(coalesce(p->>'file_name', p->>'name','')),'');
  v_text    text := coalesce(p->>'transcript_text', p->>'content', p->>'text','');
  v_code text; v_start timestamptz; v_sha text; v_key text;
  v_row agency_ops.meeting_transcripts%rowtype;
  v_acao text; v_ids jsonb; v_antes integer;
begin
  if v_file_id is null or v_name is null or length(btrim(v_text)) = 0 then
    return jsonb_build_object('ok', false, 'error','missing_fields',
                              'required', jsonb_build_array('file_id','file_name','transcript_text'));
  end if;

  select f.code, f.started_at into v_code, v_start from agency_ops.parse_donnah_filename(v_name) f;
  v_code  := coalesce(nullif(p->>'meeting_code',''), v_code);
  v_start := coalesce((nullif(p->>'meeting_started_at',''))::timestamptz, v_start);
  v_sha   := encode(sha256(convert_to(v_text,'UTF8')),'hex');

  -- CAMADA 1: conteudo identico (SHA-256). Restrita a mesmo codigo ou texto longo,
  -- porque stubs curtos ("sem transcricao disponivel") sao byte-a-byte identicos
  -- entre reunioes diferentes e uni-los fundiria reunioes distintas.
  select * into v_row from agency_ops.meeting_transcripts
   where source_system='DONNAH' and content_sha256 = v_sha
     and (length(v_text) > 1000 or meeting_code is not distinct from v_code)
   limit 1;

  -- CAMADA 2: mesmo codigo de Meet com inicio a ate 10 minutos. Resolve o caso
  -- "14h00" vs "14h01" do mesmo encontro. Dez minutos e' curto o bastante para nao
  -- fundir duas reunioes reais que reusaram o mesmo link.
  if v_row.id is null and v_code is not null and v_start is not null then
    select * into v_row from agency_ops.meeting_transcripts
     where source_system='DONNAH' and meeting_code = v_code
       and meeting_started_at between v_start - interval '10 minutes'
                                  and v_start + interval '10 minutes'
     order by abs(extract(epoch from (meeting_started_at - v_start))) limit 1;
  end if;

  -- CAMADA 3: mesmo nome de arquivo - as copias periodicas do Drive.
  if v_row.id is null then
    select * into v_row from agency_ops.meeting_transcripts
     where source_system='DONNAH'
       and lower(regexp_replace(coalesce(source_file_name,''),'\.txt$','','i')) =
           lower(regexp_replace(v_name,'\.txt$','','i'))
     limit 1;
  end if;

  if v_row.id is not null then
    v_antes := length(coalesce(v_row.transcript_text,''));
    v_ids := case when v_row.source_file_ids @> to_jsonb(array[v_file_id])
                  then v_row.source_file_ids
                  else v_row.source_file_ids || to_jsonb(array[v_file_id]) end;
    -- Uma versao curta nunca apaga uma completa. O bruto e' evidencia.
    update agency_ops.meeting_transcripts set
      transcript_text = case when length(v_text) > v_antes then v_text else transcript_text end,
      content_sha256  = case when length(v_text) > v_antes then v_sha else content_sha256 end,
      processed_at    = case when length(v_text) > v_antes then null else processed_at end,
      source_file_ids = v_ids,
      copies_seen     = jsonb_array_length(v_ids),
      source_updated_at = greatest(coalesce(source_updated_at,'-infinity'::timestamptz),
                                   coalesce((nullif(p->>'source_updated_at',''))::timestamptz,'-infinity'::timestamptz)),
      updated_at = now()
    where id = v_row.id returning * into v_row;
    v_acao := case when length(v_text) > v_antes then 'atualizado' else 'duplicado_ignorado' end;
  else
    v_key := coalesce(v_code || ':' || to_char(v_start,'YYYY-MM-DD HH24hMI'),
                      lower(regexp_replace(v_name,'\.txt$','','i')));
    insert into agency_ops.meeting_transcripts
      (source_system, source_file_id, source_file_name, source_folder_id, source_url,
       meeting_key, meeting_code, meeting_started_at, transcript_text,
       content_sha256, source_file_ids, copies_seen, client_id, client_name_raw,
       match_status, match_confidence, participants, source_created_at, source_updated_at, metadata)
    values ('DONNAH', v_file_id, v_name,
            coalesce(p->>'folder_id','1Si4wvb1PP_UtOSSpapSNVrWgRSqJRfpm'),
            coalesce(p->>'source_url', p->>'url'),
            v_key, v_code, v_start, v_text, v_sha,
            to_jsonb(array[v_file_id]), 1,
            (nullif(p->>'client_id',''))::uuid, nullif(p->>'client_name_raw',''),
            case when nullif(p->>'client_id','') is not null then 'MANUAL' else 'UNMATCHED' end,
            case when nullif(p->>'client_id','') is not null then 1 else null end,
            coalesce(p->'participants','[]'::jsonb),
            (nullif(p->>'source_created_at',''))::timestamptz,
            (nullif(p->>'source_updated_at',''))::timestamptz,
            jsonb_build_object('transport', coalesce(p->>'transport','MAKE_GOOGLE_DRIVE'),
                               'mime_type', coalesce(p->>'mime_type','text/plain'),
                               'size', p->>'size'))
    returning * into v_row;
    v_acao := 'criado';
  end if;

  return jsonb_build_object('ok', true, 'acao', v_acao, 'id', v_row.id,
    'meeting_key', v_row.meeting_key, 'meeting_code', v_row.meeting_code,
    'meeting_started_at', v_row.meeting_started_at, 'transcript_chars', v_row.transcript_chars,
    'copies_seen', v_row.copies_seen, 'match_status', v_row.match_status);
end; $fn$;

-- Transcript entra na cadeia de evidencia de IA que ja existia, na camada
-- "reuniao/promessa comercial" - abaixo de infraestrutura e de task tecnica.
alter table agency_ops.client_ai_evidence drop constraint if exists client_ai_evidence_evidence_type_check;
alter table agency_ops.client_ai_evidence add constraint client_ai_evidence_evidence_type_check
  check (evidence_type = any (array['N8N_INFRA','AI_PLATFORM_BRIEFING','CLICKUP_AI_TASK','COMMERCIAL_PROMISE',
                                    'WHATSAPP_AI','AIRYS_MIGRATION','EXTERNAL_PROVIDER','MANUAL','LEGACY_SERVICE',
                                    'DONNAH_TRANSCRIPT']));

-- Padroes em tabela, nao no codigo: a equipe ajusta sem migration e cada sinal fica
-- auditavel junto com a linha do transcript que o disparou.
create table if not exists agency_ops.transcript_signal_patterns (
  id bigserial primary key,
  categoria text not null,
  rotulo text not null,
  padrao text not null,
  peso numeric not null default 0.5,
  ai_owner_hint text,
  ai_stage_hint text,
  provider_hint text,
  ativo boolean not null default true,
  nota text,
  created_at timestamptz not null default now(),
  unique (categoria, rotulo)
);

insert into agency_ops.transcript_signal_patterns (categoria, rotulo, padrao, peso, ai_owner_hint, ai_stage_hint, provider_hint, nota) values
 ('tipo_reuniao','onboarding','\m(onboarding|reuni[aã]o de boas[- ]vindas|primeira reuni[aã]o)\M',0.8,null,null,null,null),
 ('tipo_reuniao','integracao','\m(reuni[aã]o de integra[cç][aã]o|pegar o acesso|acesso do seu facebook|business manager|gerenciador de neg[oó]cios)\M',0.8,null,null,null,null),
 ('tipo_reuniao','formulario','\m(formul[aá]rio de (satisfa[cç][aã]o|briefing|onboarding))\M',0.8,null,null,null,null),
 ('tipo_reuniao','treinamento_comercial','\m(treinamento|capacita[cç][aã]o|script de atendimento|abordagem comercial)\M',0.7,null,null,null,null),
 ('tipo_reuniao','alinhamento_campanha','\m(campanha (no ar|publicada|ativa)|subir a campanha|colocar no ar)\M',0.7,null,null,null,null),
 ('risco','pedido_cancelamento','\m(cancelar|encerrar o contrato|n[aã]o quero mais|vou parar|suspender)\M',0.9,null,null,null,'Sinal forte de churn'),
 ('risco','insatisfacao','\m(insatisfeito|decepcionad|p[eé]ssimo|n[aã]o est[aá] funcionando|nenhum resultado|sem retorno)\M',0.8,null,null,null,null),
 ('risco','sem_leads','\m(poucos leads|nenhum lead|lead ruim|sem lead|volume (muito )?baixo)\M',0.7,null,null,null,null),
 ('risco','custo','\m(muito caro|n[aã]o tenho como investir|sem verba|sem caixa|reduzir o investimento)\M',0.7,null,null,null,null),
 ('satisfacao','elogio','\m(muito bom|excelente|adorei|gostei muito|parab[eé]ns|ficou [oó]timo)\M',0.6,null,null,null,null),
 ('crm','necessidade_crm','\m(crm|kommo|pipedrive|rd station|funil de vendas)\M',0.5,null,null,null,null),
 ('ia','agente_ia','\m(agente de i\.?a|agente de intelig[eê]ncia artificial|rob[oô] de atendimento|chatbot|secret[aá]ria virtual)\M',0.7,'OURS','PROMISED',null,'Mencao a agente: promessa/reuniao, nao prova de implantacao'),
 ('ia','infra_ia','\m(n8n|chatwoot|supabase|rag|vector store|base de conhecimento)\M',0.8,'OURS','BUILDING',null,'Infra citada em reuniao ainda e mais fraca que infra observada'),
 ('ia','openai_ycloud','\m(openai|open a\.?i|ycloud|y cloud)\M',0.8,'OURS','BUILDING',null,null),
 ('ia','airys','\m(airys|la[ií]s)\M',0.7,'EXTERNAL','UNKNOWN','Airys/Lais','Fornecedor anterior ou externo; confirmar antes de concluir'),
 ('ia','fornecedor_externo','\m(viver de i\.?a|outra empresa de i\.?a|j[aá] tenho um rob[oô])\M',0.7,'EXTERNAL','UNKNOWN','EXTERNO - A CONFIRMAR',null),
 ('ia','implantacao','\m(ativar o agente|agente (j[aá] )?est[aá] no ar|colocar a i\.?a no ar|agente ativo)\M',0.85,'OURS','ACTIVE',null,null),
 ('ia','desativacao','\m(desativar o agente|desligar a i\.?a|pausar o agente)\M',0.85,'OURS','DISABLED',null,null)
on conflict (categoria, rotulo) do nothing;

-- Processamento pos-ingestao. Nenhuma conclusao sem citacao: cada sinal carrega a
-- linha literal do transcript que o disparou, e o bruto nunca e' descartado.
create or replace function agency_ops.process_meeting_transcript(p_id bigint)
returns jsonb language plpgsql security definer
set search_path = agency_ops, public, extensions as $fn$
declare
  t agency_ops.meeting_transcripts%rowtype;
  v_norm text; v_part jsonb; v_sinais jsonb := '[]'::jsonb; v_ia jsonb := '[]'::jsonb;
  v_cli uuid; v_status text; v_conf numeric; v_cands jsonb; v_n integer;
  v_tipo text; v_resumo text;
begin
  select * into t from agency_ops.meeting_transcripts where id = p_id;
  if t.id is null then return jsonb_build_object('ok',false,'error','not_found'); end if;
  v_norm := lower(extensions.unaccent(coalesce(t.transcript_text,'')));

  -- Participantes: a Donnah marca cada fala como "**Nome**:".
  select coalesce(jsonb_agg(distinct nome), '[]'::jsonb) into v_part
  from (select trim(m[1]) nome
        from regexp_matches(coalesce(t.transcript_text,''), '\*\*([^*]{2,60})\*\*\s*:', 'g') m
        where trim(m[1]) !~* '^(t[ií]tulo|data|hor[aá]rio|dura[cç][aã]o|plataforma|url|participantes)') s;

  -- Matching de cliente. Exige limite de palavra e nome com 5+ caracteres, senao
  -- nomes curtos casam por acaso dentro de outras palavras.
  with cand as (
    select c.id, c.display_name, lower(extensions.unaccent(c.display_name)) nome
    from agency_ops.clients c
    where length(lower(extensions.unaccent(c.display_name))) >= 5
    union
    select a.client_id, c2.display_name, a.alias_normalized
    from agency_ops.client_name_aliases a join agency_ops.clients c2 on c2.id = a.client_id
    where length(coalesce(a.alias_normalized,'')) >= 5
  ), hit as (
    select distinct on (id) id, display_name, nome,
           (length(v_norm) - length(replace(v_norm, nome, ''))) / greatest(length(nome),1) ocorrencias
    from cand where v_norm ~ ('\m' || regexp_replace(nome, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '\M')
    order by id, length(nome) desc
  )
  select count(*), (array_agg(id order by ocorrencias desc, length(nome) desc))[1],
         jsonb_agg(jsonb_build_object('client_id',id,'nome',display_name,'ocorrencias',ocorrencias)
                   order by ocorrencias desc)
  into v_n, v_cli, v_cands from hit;

  if v_n = 1 then v_status := 'MATCHED'; v_conf := 0.85;
  elsif v_n > 1 then
    -- Dois ou mais candidatos: nao escolher pelo parecido. Fica ambiguo, a menos que
    -- um domine a conversa com folga.
    v_status := 'AMBIGUOUS'; v_conf := null;
    if (v_cands->0->>'ocorrencias')::int >= 3 * greatest((v_cands->1->>'ocorrencias')::int,1) then
      v_status := 'MATCHED'; v_conf := 0.7;
    else v_cli := null; end if;
  else v_status := 'UNMATCHED'; v_conf := null; v_cli := null;
  end if;

  -- Heranca por codigo do Meet: se a mesma sala ja foi vinculada antes, vale como
  -- reforco - mas so quando o texto nao apontou outro cliente.
  if v_cli is null and t.meeting_code is not null then
    select client_id into v_cli from agency_ops.meeting_transcripts
     where meeting_code = t.meeting_code and client_id is not null and id <> t.id
     order by meeting_started_at desc limit 1;
    if v_cli is not null then v_status := 'MATCHED'; v_conf := 0.6; end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'categoria',p.categoria,'sinal',p.rotulo,'peso',p.peso,'evidencia',ev.linha)), '[]'::jsonb)
    into v_sinais
  from agency_ops.transcript_signal_patterns p
  cross join lateral (
    select left(trim(l.linha),300) linha from regexp_split_to_table(coalesce(t.transcript_text,''), E'\n') l(linha)
     where lower(extensions.unaccent(l.linha)) ~ p.padrao limit 1) ev
  where p.ativo;

  select coalesce(jsonb_agg(s), '[]'::jsonb) into v_ia
  from jsonb_array_elements(v_sinais) s where s->>'categoria' = 'ia';

  v_tipo := (select s->>'sinal' from jsonb_array_elements(v_sinais) s
              where s->>'categoria'='tipo_reuniao' order by (s->>'peso')::numeric desc limit 1);

  v_resumo := coalesce('Reunião de ' || v_tipo || '. ', '')
    || jsonb_array_length(v_part) || ' participante(s). '
    || (select count(*) from jsonb_array_elements(v_sinais) s where s->>'categoria'='risco') || ' sinal(is) de risco, '
    || jsonb_array_length(v_ia) || ' de IA. '
    || 'Transcript de ' || coalesce(t.transcript_chars,0) || ' caracteres preservado como evidência.';

  update agency_ops.meeting_transcripts set
    client_id = v_cli, match_status = case when match_status='MANUAL' then 'MANUAL' else v_status end,
    match_confidence = v_conf, participants = v_part, ai_signals = v_ia, summary = v_resumo,
    metadata = metadata || jsonb_build_object('tipo_reuniao', v_tipo, 'sinais', v_sinais,
                                              'candidatos_cliente', coalesce(v_cands,'[]'::jsonb)),
    processed_at = now(), updated_at = now()
  where id = p_id;

  -- Evidencia de IA so entra quando ha cliente vinculado E citacao. Reuniao fica na
  -- camada de promessa (confianca limitada a 0.6) - nunca sobrepoe infra observada.
  if v_cli is not null and jsonb_array_length(v_ia) > 0 then
    insert into agency_ops.client_ai_evidence
      (client_id, client_name_raw, evidence_type, source_system, source_record_id, source_reference,
       evidence_text, observed_at, ai_owner_hint, ai_stage_hint, provider_hint, confidence, metadata)
    select v_cli, t.client_name_raw, 'DONNAH_TRANSCRIPT', 'DONNAH', t.id::text, t.source_file_name,
           string_agg(s->>'evidencia', E'\n'), coalesce(t.meeting_started_at, t.ingested_at),
           (select p.ai_owner_hint from agency_ops.transcript_signal_patterns p
             where p.categoria='ia' and p.rotulo = (v_ia->0->>'sinal')),
           (select p.ai_stage_hint from agency_ops.transcript_signal_patterns p
             where p.categoria='ia' and p.rotulo = (v_ia->0->>'sinal')),
           (select p.provider_hint from agency_ops.transcript_signal_patterns p
             where p.categoria='ia' and p.rotulo = (v_ia->0->>'sinal')),
           least(0.6, max((s->>'peso')::numeric)),
           jsonb_build_object('meeting_key', t.meeting_key, 'sinais', v_ia)
    from jsonb_array_elements(v_ia) s
    on conflict (source_system, source_record_id, evidence_type) do update
      set evidence_text = excluded.evidence_text, updated_at = now();
  end if;

  return jsonb_build_object('ok',true,'id',p_id,'match_status',v_status,'client_id',v_cli,
    'tipo_reuniao',v_tipo,'participantes',v_part,'sinais',v_sinais);
end; $fn$;

create or replace function agency_ops.process_pending_transcripts(p_limite integer default 50)
returns integer language plpgsql security definer set search_path = agency_ops, public as $fn$
declare r record; n integer := 0;
begin
  for r in select id from agency_ops.meeting_transcripts
            where processed_at is null order by ingested_at limit p_limite loop
    perform agency_ops.process_meeting_transcript(r.id);
    n := n + 1;
  end loop;
  return n;
end; $fn$;

-- As 8 colunas originais sao preservadas na mesma ordem: CREATE OR REPLACE VIEW so
-- permite acrescentar no fim, e ha consumidores da versao antiga.
create or replace view agency_ops.donnah_transcript_health as
select
  (select count(*) from agency_ops.meeting_transcript_actions) as derived_actions,
  (select count(distinct source_task_id) from agency_ops.meeting_transcript_actions) as unique_derived_actions,
  (select max(source_created_at) from agency_ops.meeting_transcript_actions) as latest_derived_action_at,
  (select count(*) from agency_ops.meeting_transcripts) as raw_transcripts,
  (select count(distinct meeting_key) from agency_ops.meeting_transcripts where meeting_key is not null) as unique_raw_meetings,
  (select max(meeting_started_at) from agency_ops.meeting_transcripts) as latest_raw_transcript_at,
  coalesce((select value->>'backend_status' from agency_ops.automation_settings where key='donnah_transcript_source'),'UNKNOWN') as raw_sync_status,
  coalesce((select value->'primary_folder'->>'name' from agency_ops.automation_settings where key='donnah_transcript_source'),'UNKNOWN') as primary_folder,
  coalesce((select value->>'make_bridge_connected' from agency_ops.automation_settings where key='donnah_transcript_source'),'false') as ponte_make,
  (select value->>'last_ingest_at' from agency_ops.automation_settings where key='donnah_transcript_source') as ultima_ingestao,
  (select value->>'last_file_name' from agency_ops.automation_settings where key='donnah_transcript_source') as ultimo_arquivo,
  (select coalesce(sum(copies_seen),0) from agency_ops.meeting_transcripts) as arquivos_absorvidos,
  (select count(*) from agency_ops.meeting_transcripts where ingested_at::date = current_date) as ingeridas_hoje,
  (select count(*) from agency_ops.meeting_transcripts where match_status='MATCHED') as vinculadas,
  (select count(*) from agency_ops.meeting_transcripts where match_status='UNMATCHED') as nao_vinculadas,
  (select count(*) from agency_ops.meeting_transcripts where match_status='AMBIGUOUS') as ambiguas,
  (select count(*) from agency_ops.meeting_transcripts where processed_at is null) as aguardando_processamento,
  (select min(meeting_started_at) from agency_ops.meeting_transcripts) as reuniao_mais_antiga,
  (select count(distinct client_id) from agency_ops.client_ai_evidence where evidence_type='DONNAH_TRANSCRIPT') as clientes_com_sinal_ia,
  case
    when coalesce((select value->>'make_bridge_connected' from agency_ops.automation_settings where key='donnah_transcript_source'),'false') <> 'true' then 'AGUARDANDO_MAKE'
    when (select max(ingested_at) from agency_ops.meeting_transcripts) < now() - interval '48 hours' then 'SEM_INGESTAO_RECENTE'
    when (select count(*) from agency_ops.meeting_transcripts where processed_at is null) > 20 then 'FILA_ACUMULADA'
    else 'OK' end as status;

select cron.schedule('agency_ops_transcript_processing','*/10 * * * *',
                     $c$select agency_ops.process_pending_transcripts(50);$c$);
