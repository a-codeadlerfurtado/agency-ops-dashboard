-- Imobi-Board 0037 - importacao de base historica do Imobilead
--
-- Um cliente que troca de CRM chega com a base antiga na mao. Ate agora o
-- unico jeito de entrar com ela era o caminho de lead novo (ingerir_lead), e
-- ele e errado para isso: trata 1589 leads de 2025/2026 como se tivessem
-- acabado de chegar, dispara distribuicao, prazo de SLA, notificacao e
-- escalonamento. O corretor abriria o CRM com mil e quinhentos alarmes.
--
-- Esta funcao faz o oposto: grava o historico como historico. Sem fila, sem
-- prazo, sem notificacao. A data de criacao e a da origem, nao a de hoje.
--
-- Tres garantias:
--
-- 1. Tenant explicito. Recebe o uuid como argumento e confere que existe; nao
--    ha "tenant padrao" nem "primeiro tenant" em lugar nenhum do corpo.
--
-- 2. Idempotente. external_event_id e o sha256 do conteudo da linha, e a
--    unicidade (tenant, source, external_event_id) ja existe na tabela. Rodar
--    duas vezes com o mesmo arquivo nao duplica nada -- o que importa quando a
--    carga vem em lotes por HTTP e um lote pode ser reenviado.
--
-- 3. Contato resolvido por telefone OU e-mail, na ordem em que as linhas
--    chegam. `contacts` tem unicidade parcial nos dois campos, entao agrupar
--    so por um deles estoura no outro. Resolver linha a linha contra o que ja
--    esta gravado tambem faz a fusao funcionar entre lotes diferentes, e faz
--    o lead que chegar amanha pela Meta cair no mesmo contato em vez de criar
--    um segundo.
--
-- Nao cria usuario de corretor. O nome do corretor da origem fica registrado
-- na atividade de cada oportunidade; assigned_user_id fica nulo ate a
-- imobiliaria decidir quem atende o que.

create or replace function imobi_board.importar_imobilead(
  p_tenant uuid,
  p_lote   jsonb,
  p_origem text default 'Imobilead'
) returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_pipe     uuid;
  v_novo     uuid;   -- etapa NEW
  v_contato  uuid;   -- etapa CONTACTED
  r          jsonb;
  v_tel      text;
  v_mail     text;
  v_nome     text;
  v_quando   timestamptz;
  v_chave    text;
  v_cid      uuid;
  v_oid      uuid;
  v_etapa    uuid;
  n_contatos int := 0;
  n_opp      int := 0;
  n_repetida int := 0;
  n_linhas   int := 0;
begin
  if not exists (select 1 from imobi_board.tenants t where t.id = p_tenant) then
    raise exception 'Imobiliaria % nao existe.', p_tenant using errcode = 'P0001';
  end if;

  select p.id into v_pipe
    from imobi_board.pipelines p
   where p.tenant_id = p_tenant
   order by p.is_default desc, p.created_at
   limit 1;
  if v_pipe is null then
    raise exception 'A imobiliaria nao tem funil. Provisione antes de importar.'
      using errcode = 'P0001';
  end if;

  select s.id into v_novo from imobi_board.pipeline_stages s
   where s.pipeline_id = v_pipe and s.kind = 'NEW' order by s.sort_order limit 1;
  select s.id into v_contato from imobi_board.pipeline_stages s
   where s.pipeline_id = v_pipe and s.kind = 'CONTACTED' order by s.sort_order limit 1;
  if v_novo is null then
    raise exception 'Funil sem etapa inicial.' using errcode = 'P0001';
  end if;

  for r in select * from jsonb_array_elements(p_lote)
  loop
    n_linhas := n_linhas + 1;

    v_tel  := imobi_board_priv.normalize_phone_br(r->>'telefone');
    v_mail := imobi_board_priv.normalize_email(r->>'email');
    v_nome := nullif(btrim(coalesce(r->>'nome', '')), '');

    -- sem nome na origem: o local-part do e-mail identifica melhor do que
    -- "sem nome" repetido mil vezes na lista
    if v_nome is null then
      v_nome := coalesce(nullif(split_part(coalesce(v_mail, ''), '@', 1), ''), 'Contato sem nome');
    end if;

    -- A data e a da origem, e o fuso e o da casa. Cast direto de texto sem
    -- fuso para timestamp e depois `at time zone`: to_timestamp() devolveria
    -- timestamptz ja interpretado no fuso da sessao, e o resultado passaria a
    -- depender de como a conexao esta configurada.
    v_quando := case
      when nullif(btrim(coalesce(r->>'criado', '')), '') is null then now()
      else (btrim(r->>'criado')::timestamp) at time zone 'America/Sao_Paulo'
    end;

    /* ------------------------------------------------ contato -------- */
    v_cid := null;
    if v_tel is not null or v_mail is not null then
      select c.id into v_cid
        from imobi_board.contacts c
       where c.tenant_id = p_tenant
         and ( (v_tel  is not null and c.phone_normalized = v_tel)
            or (v_mail is not null and c.email_normalized = v_mail) )
       order by c.created_at
       limit 1;
    end if;

    if v_cid is null then
      insert into imobi_board.contacts
        (tenant_id, full_name, phone, phone_normalized, email, email_normalized, created_at)
      values
        (p_tenant, v_nome, nullif(btrim(coalesce(r->>'telefone','')), ''), v_tel,
         nullif(btrim(coalesce(r->>'email','')), ''), v_mail, v_quando)
      returning id into v_cid;
      n_contatos := n_contatos + 1;
    end if;

    /* -------------------------------------------- oportunidade ------- */
    -- chave derivada do conteudo: reenviar o mesmo lote nao duplica
    v_chave := left(encode(extensions.digest(concat_ws('|',
        coalesce(v_tel, btrim(coalesce(r->>'telefone',''))),
        coalesce(v_mail, ''),
        coalesce(r->>'criado', ''),
        coalesce(r->>'produto', ''),
        coalesce(r->>'campanha', '')
      ), 'sha256'), 'hex'), 24);

    -- Comparacao exata, nao `like '%em atendimento%'`: "Sem Atendimento"
    -- CONTEM "em atendimento" como substring, e o lead que ninguem tocou
    -- entrava no funil ja como Contatado.
    v_etapa := case
      when btrim(lower(coalesce(r->>'status',''))) = 'em atendimento'
           and v_contato is not null
        then v_contato
      else v_novo
    end;

    insert into imobi_board.opportunities
      (tenant_id, contact_id, pipeline_id, stage_id, status,
       source, source_detail, campaign_name,
       external_source_id, external_event_id,
       created_at, updated_at, last_interaction_at)
    values
      (p_tenant, v_cid, v_pipe, v_etapa, 'OPEN',
       'IMOBILEAD', nullif(btrim(coalesce(r->>'produto','')), ''),
       nullif(btrim(coalesce(r->>'campanha','')), ''),
       p_origem, v_chave,
       v_quando, v_quando, v_quando)
    -- o indice de unicidade e parcial (where external_event_id is not null);
    -- ON CONFLICT so o reconhece se repetir o predicado dele
    on conflict (tenant_id, source, external_event_id)
      where external_event_id is not null
    do nothing
    returning id into v_oid;

    if v_oid is null then
      n_repetida := n_repetida + 1;
      continue;                      -- ja importada antes; nao repete a nota
    end if;
    n_opp := n_opp + 1;

    /* ------------------------------------------------ procedencia ---- */
    -- o corretor da origem nao vira usuario: vira registro. Quem atendia o
    -- lead no Imobilead fica legivel sem inventar conta nem senha.
    insert into imobi_board.activities
      (tenant_id, opportunity_id, type, body, created_at)
    values
      (p_tenant, v_oid, 'SYSTEM',
       concat_ws(' | ',
         'Importado de ' || p_origem,
         nullif('corretor na origem: ' || nullif(btrim(coalesce(r->>'corretor','')), ''), 'corretor na origem: '),
         nullif('situacao na origem: ' || nullif(btrim(coalesce(r->>'status','')), ''), 'situacao na origem: '),
         nullif('produto: ' || nullif(btrim(coalesce(r->>'produto','')), ''), 'produto: '),
         nullif('categoria: ' || nullif(btrim(coalesce(r->>'categoria','')), ''), 'categoria: ')
       ),
       v_quando);
  end loop;

  return jsonb_build_object(
    'tenant_id',        p_tenant,
    'linhas_recebidas', n_linhas,
    'contatos_criados', n_contatos,
    'oportunidades_criadas', n_opp,
    'ja_existiam',      n_repetida
  );
end;
$fn$;

-- so a chave de servico importa base. Nem o admin da imobiliaria, nem o
-- operador: e uma operacao de migracao, feita por script, com o arquivo na
-- mao -- nao uma acao de tela.
revoke execute on function imobi_board.importar_imobilead(uuid, jsonb, text) from public;
revoke execute on function imobi_board.importar_imobilead(uuid, jsonb, text) from authenticated;
grant  execute on function imobi_board.importar_imobilead(uuid, jsonb, text) to service_role;

comment on function imobi_board.importar_imobilead(uuid, jsonb, text) is
  'Carga de base historica. Idempotente por sha256 do conteudo da linha. '
  'Nao dispara distribuicao, SLA nem notificacao: historico entra como historico.';
