-- =====================================================================
-- PLATAFORMA DE IA PARA IMOBILIARIAS
-- Migration 001 - Schema base
-- Postgres 16 + pgvector
-- =====================================================================
-- Multi-tenant por tenant_id com RLS.
-- A API deve executar, no inicio de CADA transacao:
--     SET LOCAL app.tenant_id = '<uuid>';
--     SET LOCAL app.user_id   = '<uuid>';
-- Sem isso, as policies retornam zero linhas.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ---------------------------------------------------------------------
-- HELPERS
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------

CREATE TYPE user_role       AS ENUM ('ADMIN','EDITOR','GESTOR','ATENDENTE','MEMBRO');
CREATE TYPE operacao        AS ENUM ('VENDA','LOCACAO','AMBOS');
CREATE TYPE property_status AS ENUM ('DISPONIVEL','RESERVADO','VENDIDO','ALUGADO','SUSPENSO');
CREATE TYPE conv_status     AS ENUM ('BOT','ABERTA','PENDENTE','RESOLVIDA');
CREATE TYPE conv_mode       AS ENUM ('IA','MANUAL','PAUSADA');
CREATE TYPE msg_direction   AS ENUM ('IN','OUT','NOTA');
CREATE TYPE msg_status      AS ENUM ('PENDENTE','ENVIADA','ENTREGUE','LIDA','FALHOU');
CREATE TYPE crm_status      AS ENUM ('NAO_PRONTO','PRONTO','ENVIADO','ERRO_ENVIO');
CREATE TYPE qual_status     AS ENUM ('NOVO','EM_QUALIFICACAO','QUALIFICADO','FRIO','DESQUALIFICADO');
CREATE TYPE visit_status    AS ENUM ('SOLICITADA','AGENDADA','CONFIRMADA','REALIZADA','CANCELADA','NO_SHOW');
CREATE TYPE broadcast_kind  AS ENUM ('REMARKETING','ATUALIZACAO_ANUNCIO','NUTRICAO','EVENTO');
CREATE TYPE broadcast_state AS ENUM ('RASCUNHO','AGENDADO','ENVIANDO','ENVIADO','CANCELADO','ERRO');

-- =====================================================================
-- 1. ORGANIZACAO
-- =====================================================================

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          text NOT NULL,
  slug          text UNIQUE NOT NULL,
  cnpj          text,
  timezone      text NOT NULL DEFAULT 'America/Sao_Paulo',
  plano         text NOT NULL DEFAULT 'trial',
  ativo         boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome          text NOT NULL,
  distribuicao  text NOT NULL DEFAULT 'ROLETA',  -- ROLETA | CARGA | CRM | MANUAL
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id       uuid REFERENCES teams(id) ON DELETE SET NULL,
  nome          text NOT NULL,
  email         citext NOT NULL,
  telefone      text,
  senha_hash    text,
  papel         user_role NOT NULL DEFAULT 'MEMBRO',
  avatar_url    text,
  ativo         boolean NOT NULL DEFAULT true,
  ultimo_login  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at    timestamptz NOT NULL,
  user_agent    text,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id);
CREATE INDEX ON sessions (expires_at);

-- =====================================================================
-- 2. CANAL WHATSAPP (Tech Provider / Cloud API)
-- =====================================================================

CREATE TABLE whatsapp_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  waba_id             text NOT NULL,
  phone_number_id     text NOT NULL,
  display_phone       text NOT NULL,
  verified_name       text,
  business_id         text,
  access_token_enc    bytea NOT NULL,   -- criptografado pela API, nunca em texto puro
  quality_rating      text,
  messaging_limit     text,
  status              text NOT NULL DEFAULT 'ATIVO',
  onboarded_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone_number_id)
);
CREATE INDEX ON whatsapp_accounts (tenant_id);

CREATE TABLE message_templates (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  whatsapp_account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  meta_template_id    text,
  nome                text NOT NULL,
  idioma              text NOT NULL DEFAULT 'pt_BR',
  categoria           text NOT NULL,           -- MARKETING | UTILITY | AUTHENTICATION
  status              text NOT NULL DEFAULT 'PENDENTE',  -- PENDENTE|APROVADO|REJEITADO|PAUSADO
  motivo_rejeicao     text,
  componentes         jsonb NOT NULL,
  variaveis           text[] DEFAULT '{}',
  finalidade          text,                    -- uso interno: primeiro_contato|reengajamento|...
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (whatsapp_account_id, nome, idioma)
);
CREATE INDEX ON message_templates (tenant_id, status);

-- =====================================================================
-- 3. ESTOQUE DE IMOVEIS
-- =====================================================================

CREATE TABLE owners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome          text,
  telefone      text,
  email         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON owners (tenant_id, telefone);

CREATE TABLE properties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id          uuid REFERENCES owners(id) ON DELETE SET NULL,
  codigo_externo    text NOT NULL,
  operacao          operacao NOT NULL,
  tipo              text NOT NULL,            -- Apartamento, Casa, Terreno, Comercial...
  subtipo           text,
  status            property_status NOT NULL DEFAULT 'DISPONIVEL',
  preco             numeric(14,2),
  preco_locacao     numeric(14,2),
  condominio        numeric(14,2),
  iptu              numeric(14,2),
  quartos           smallint,
  suites            smallint,
  banheiros         smallint,
  vagas             smallint,
  area_util         numeric(10,2),
  area_total        numeric(10,2),
  bairro            text,
  cidade            text,
  uf                char(2),
  cep               text,
  logradouro        text,
  numero            text,
  complemento       text,
  latitude          numeric(10,7),
  longitude         numeric(10,7),
  titulo            text,
  descricao         text,
  caracteristicas   text[] DEFAULT '{}',
  fotos             jsonb NOT NULL DEFAULT '[]',
  url_anuncio       text,
  destaque          boolean NOT NULL DEFAULT false,
  content_hash      text NOT NULL,            -- sync incremental do XML
  fonte             text NOT NULL DEFAULT 'XML',
  sincronizado_em   timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, codigo_externo)
);
CREATE INDEX ON properties (tenant_id, status, operacao);
CREATE INDEX ON properties (tenant_id, cidade, bairro);
CREATE INDEX ON properties (tenant_id, tipo, quartos);
CREATE INDEX ON properties (tenant_id, preco);
CREATE INDEX ON properties USING gin (to_tsvector('portuguese', coalesce(titulo,'') || ' ' || coalesce(descricao,'')));

CREATE TABLE property_embeddings (
  property_id   uuid PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  embedding     vector(1536) NOT NULL,
  texto         text NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON property_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE developments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome              text NOT NULL,
  codigo            text,
  construtora       text,
  site              text,
  entrega_prevista  date,
  endereco          text,
  bairro            text,
  cidade            text,
  tipologias        jsonb NOT NULL DEFAULT '[]',
  tabela_precos     jsonb NOT NULL DEFAULT '{}',
  diferenciais      text,
  documentos        jsonb NOT NULL DEFAULT '[]',
  ativo             boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON developments (tenant_id, ativo);

-- =====================================================================
-- 4. CONTATOS, LEADS E CONVERSAS
-- =====================================================================

CREATE TABLE contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome              text,
  telefone          text NOT NULL,          -- E.164
  email             text,
  cpf               text,
  avatar_url        text,
  atributos         jsonb NOT NULL DEFAULT '{}',
  bloqueado         boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, telefone)
);
CREATE INDEX ON contacts (tenant_id, nome);

CREATE TABLE leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  responsavel_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  team_id             uuid REFERENCES teams(id) ON DELETE SET NULL,
  canal               text,                  -- ImovelWeb, Zap, Meta, Site, WhatsApp...
  campanha_origem     text,
  adset_origem        text,
  anuncio_origem      text,
  utm                 jsonb NOT NULL DEFAULT '{}',
  operacao            operacao,
  tipo_desejado       text,
  cidade_desejada     text,
  bairros_desejados   text[] DEFAULT '{}',
  quartos_min         smallint,
  vagas_min           smallint,
  orcamento_min       numeric(14,2),
  orcamento_max       numeric(14,2),
  property_id         uuid REFERENCES properties(id) ON DELETE SET NULL,
  status_crm          crm_status NOT NULL DEFAULT 'NAO_PRONTO',
  status_qualificacao qual_status NOT NULL DEFAULT 'NOVO',
  lead_score          smallint NOT NULL DEFAULT 0,
  resumo_ia           text,
  primeiro_contato_em timestamptz NOT NULL DEFAULT now(),
  ultimo_contato_em   timestamptz,
  enviado_crm_em      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON leads (tenant_id, status_crm);
CREATE INDEX ON leads (tenant_id, status_qualificacao);
CREATE INDEX ON leads (tenant_id, primeiro_contato_em DESC);
CREATE INDEX ON leads (tenant_id, campanha_origem);
CREATE INDEX ON leads (contact_id);

CREATE TABLE conversations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lead_id             uuid REFERENCES leads(id) ON DELETE SET NULL,
  whatsapp_account_id uuid REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
  responsavel_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  team_id             uuid REFERENCES teams(id) ON DELETE SET NULL,
  status              conv_status NOT NULL DEFAULT 'BOT',
  modo                conv_mode   NOT NULL DEFAULT 'IA',
  estado_maquina      text NOT NULL DEFAULT 'NOVO',
  coluna_kanban       text,
  nao_lidas           integer NOT NULL DEFAULT 0,
  resumo_ia           text,
  sentimento          text,
  arquivada           boolean NOT NULL DEFAULT false,
  janela_expira_em    timestamptz,           -- janela de 24h da Meta
  ultima_msg_em       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON conversations (tenant_id, status, ultima_msg_em DESC);
CREATE INDEX ON conversations (tenant_id, responsavel_id);
CREATE INDEX ON conversations (contact_id);

CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  direcao           msg_direction NOT NULL,
  conteudo          text,
  tipo              text NOT NULL DEFAULT 'text',   -- text|image|audio|video|document|template|location
  midia_url         text,
  midia_mime        text,
  wamid             text,                            -- id da mensagem na Meta
  template_id       uuid REFERENCES message_templates(id) ON DELETE SET NULL,
  status            msg_status NOT NULL DEFAULT 'PENDENTE',
  erro              text,
  por_ia            boolean NOT NULL DEFAULT false,
  modelo            text,
  tokens_in         integer,
  tokens_out        integer,
  custo_usd         numeric(10,6),
  raw               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, created_at DESC);
CREATE INDEX ON messages (tenant_id, created_at DESC);
CREATE UNIQUE INDEX ON messages (wamid) WHERE wamid IS NOT NULL;

CREATE TABLE labels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  cor         text NOT NULL DEFAULT '#6366f1',
  UNIQUE (tenant_id, nome)
);

CREATE TABLE conversation_labels (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id        uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, label_id)
);

CREATE TABLE internal_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  autor_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  texto           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON internal_notes (conversation_id, created_at DESC);

-- =====================================================================
-- 5. VISITAS
-- =====================================================================

CREATE TABLE availability_rules (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  dia_semana             smallint NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio            time NOT NULL,
  hora_fim               time NOT NULL,
  ativo                  boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, dia_semana)
);

CREATE TABLE visit_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ativo                  boolean NOT NULL DEFAULT true,
  exigir_cpf             boolean NOT NULL DEFAULT false,
  antecedencia_min_horas smallint NOT NULL DEFAULT 0,
  antecedencia_max_dias  smallint NOT NULL DEFAULT 3,
  duracao_minutos        smallint NOT NULL DEFAULT 60,
  max_opcoes_sugeridas   smallint NOT NULL DEFAULT 3
);

CREATE TABLE visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id     uuid REFERENCES properties(id) ON DELETE SET NULL,
  corretor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  status          visit_status NOT NULL DEFAULT 'SOLICITADA',
  datas_sugeridas jsonb NOT NULL DEFAULT '[]',
  data_confirmada timestamptz,
  cpf             text,
  observacoes     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON visits (tenant_id, status, data_confirmada);
CREATE INDEX ON visits (lead_id);

-- =====================================================================
-- 6. CONFIGURACAO DA IA (por tenant, sem tocar em codigo)
-- =====================================================================

CREATE TABLE ai_config (
  tenant_id           uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  persona_nome        text NOT NULL DEFAULT 'Assistente',
  tom_voz             text NOT NULL DEFAULT 'cordial e objetivo',
  assinatura          text,
  usar_emoji          boolean NOT NULL DEFAULT false,
  exibir_nome_atendente boolean NOT NULL DEFAULT true,
  tamanho_max_msg     smallint NOT NULL DEFAULT 500,
  delay_min_ms        integer NOT NULL DEFAULT 1200,
  delay_max_ms        integer NOT NULL DEFAULT 4000,
  horario_comercial   jsonb NOT NULL DEFAULT '{}',
  recesso             jsonb NOT NULL DEFAULT '{}',
  modelo              text NOT NULL DEFAULT 'gpt-4o',
  llm_provider        text NOT NULL DEFAULT 'openai',
  llm_key_enc         bytea,                 -- chave por cliente, criptografada
  limite_mensal_usd   numeric(10,2),
  prompt_extra        text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE essential_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ordem         smallint NOT NULL,
  pergunta      text NOT NULL,
  categoria     text NOT NULL,        -- INFO_LEAD|LOCALIZACAO|CARACTERISTICAS|FINANCEIRO|PRAZO
  campo_destino text NOT NULL,        -- coluna de leads que recebe a resposta
  tipo_resposta text NOT NULL DEFAULT 'texto',
  obrigatoria   boolean NOT NULL DEFAULT false,  -- bloqueia envio ao CRM se nao respondida
  ativo         boolean NOT NULL DEFAULT true
);
CREATE INDEX ON essential_questions (tenant_id, ordem);

CREATE TABLE qualifying_questions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operacao      operacao,
  ordem         smallint NOT NULL,
  pergunta      text NOT NULL,
  peso_score    smallint NOT NULL DEFAULT 10,
  ativo         boolean NOT NULL DEFAULT true
);
CREATE INDEX ON qualifying_questions (tenant_id, operacao, ordem);

CREATE TABLE lead_answers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  question_id   uuid,
  origem        text NOT NULL DEFAULT 'ESSENCIAL',  -- ESSENCIAL | QUALIFICATORIA
  pergunta      text NOT NULL,
  resposta      text,
  respondida_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lead_answers (lead_id);

CREATE TABLE business_knowledge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  escopo      text NOT NULL DEFAULT 'GERAL',   -- GERAL|VENDAS|LOCACAO|ADMINISTRATIVO
  chave       text NOT NULL,
  valor       text NOT NULL,
  embedding   vector(1536),
  ativo       boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, escopo, chave)
);
CREATE INDEX ON business_knowledge USING hnsw (embedding vector_cosine_ops);

CREATE TABLE guarantees (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo        text NOT NULL,   -- CAUCAO|SEGURO_FIANCA|FIADOR|TITULO_CAPITALIZACAO|OUTRAS
  aceito      boolean NOT NULL DEFAULT false,
  config      jsonb NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, tipo)
);

CREATE TABLE required_documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operacao    operacao NOT NULL,
  categoria   text NOT NULL,   -- PESSOAIS|RENDA|ENDERECO
  itens       text[] NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, operacao, categoria)
);

-- Roteamento por setor: a IA entrega o contato em vez de transferir
CREATE TABLE departments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  descricao   text NOT NULL,      -- a IA usa isso pra decidir quando indicar
  telefone    text,
  email       text,
  ativo       boolean NOT NULL DEFAULT true
);
CREATE INDEX ON departments (tenant_id, ativo);

-- =====================================================================
-- 7. AUTOMACOES
-- =====================================================================

CREATE TABLE reengage_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome        text NOT NULL,
  operacao    operacao,
  ativo       boolean NOT NULL DEFAULT false,
  aplica_nunca_respondeu boolean NOT NULL DEFAULT true,
  tentativas  jsonb NOT NULL DEFAULT '[]',   -- [{apos_minutos, template_id, mensagem}]
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo          text NOT NULL,      -- REENGAJAMENTO|FOLLOWUP|ATUALIZACAO_ANUNCIO
  lead_id       uuid REFERENCES leads(id) ON DELETE CASCADE,
  payload       jsonb NOT NULL DEFAULT '{}',
  executar_em   timestamptz NOT NULL,
  executado_em  timestamptz,
  tentativas    smallint NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'PENDENTE',
  erro          text
);
CREATE INDEX ON scheduled_jobs (status, executar_em) WHERE status = 'PENDENTE';

CREATE TABLE broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  criado_por      uuid REFERENCES users(id) ON DELETE SET NULL,
  nome            text,
  descricao       text,
  tipo            broadcast_kind NOT NULL,
  status          broadcast_state NOT NULL DEFAULT 'RASCUNHO',
  template_id     uuid REFERENCES message_templates(id) ON DELETE SET NULL,
  filtros         jsonb NOT NULL DEFAULT '{}',
  agendado_para   timestamptz,
  total_contatos  integer NOT NULL DEFAULT 0,
  total_enviados  integer NOT NULL DEFAULT 0,
  total_erros     integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE broadcast_recipients (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  broadcast_id  uuid NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status        msg_status NOT NULL DEFAULT 'PENDENTE',
  erro          text,
  enviado_em    timestamptz
);
CREATE INDEX ON broadcast_recipients (broadcast_id, status);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  tipo        text NOT NULL,   -- LEAD_PRONTO|COBRANCA_ATENDIMENTO|PRE_AGENDAMENTO|CAPTACAO|...
  titulo      text NOT NULL,
  corpo       text,
  lead_id     uuid REFERENCES leads(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  lida        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notifications (tenant_id, lida, created_at DESC);

-- =====================================================================
-- 8. INTEGRACOES E EVENTOS
-- =====================================================================

CREATE TABLE integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tipo          text NOT NULL,   -- CRM|XML|META_ADS|ERP|GOOGLE_BUSINESS
  provedor      text,            -- vista|jetimob|kenlo|imoview|...
  config        jsonb NOT NULL DEFAULT '{}',
  secret_enc    bytea,
  ativo         boolean NOT NULL DEFAULT true,
  ultimo_sync   timestamptz,
  ultimo_erro   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tipo, provedor)
);

CREATE TABLE crm_dispatch_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tentativa     smallint NOT NULL DEFAULT 1,
  http_status   integer,
  request       jsonb,
  response      jsonb,
  sucesso       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON crm_dispatch_log (lead_id, created_at DESC);

CREATE TABLE events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id     uuid,
  conversation_id uuid,
  tipo        text NOT NULL,   -- LEAD_CRIADO|LEAD_QUALIFICADO|VISITA_AGENDADA|...
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON events (tenant_id, tipo, created_at DESC);
CREATE INDEX ON events (lead_id);

-- =====================================================================
-- 9. TEMPO REAL (substitui Supabase Realtime)
-- =====================================================================

CREATE OR REPLACE FUNCTION notify_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'msg:' || NEW.tenant_id::text,
    json_build_object(
      'event',           'message.created',
      'conversation_id', NEW.conversation_id,
      'message_id',      NEW.id,
      'direcao',         NEW.direcao,
      'created_at',      NEW.created_at
    )::text
  );
  RETURN NEW;
END $$;

CREATE TRIGGER trg_notify_message
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION notify_message();

CREATE OR REPLACE FUNCTION notify_conversation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'conv:' || NEW.tenant_id::text,
    json_build_object(
      'event',   'conversation.updated',
      'id',      NEW.id,
      'status',  NEW.status,
      'modo',    NEW.modo
    )::text
  );
  RETURN NEW;
END $$;

CREATE TRIGGER trg_notify_conversation
AFTER UPDATE ON conversations
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status
   OR OLD.modo IS DISTINCT FROM NEW.modo
   OR OLD.responsavel_id IS DISTINCT FROM NEW.responsavel_id)
EXECUTE FUNCTION notify_conversation();

-- =====================================================================
-- 10. BUSCA HIBRIDA DE IMOVEIS (tool do agente)
-- =====================================================================

CREATE OR REPLACE FUNCTION buscar_imoveis(
  p_tenant        uuid,
  p_operacao      operacao DEFAULT NULL,
  p_tipo          text     DEFAULT NULL,
  p_cidade        text     DEFAULT NULL,
  p_bairros       text[]   DEFAULT NULL,
  p_preco_min     numeric  DEFAULT NULL,
  p_preco_max     numeric  DEFAULT NULL,
  p_quartos_min   smallint DEFAULT NULL,
  p_vagas_min     smallint DEFAULT NULL,
  p_embedding     vector(1536) DEFAULT NULL,
  p_limite        integer  DEFAULT 3
)
RETURNS TABLE (
  id uuid, codigo_externo text, titulo text, tipo text, operacao operacao,
  preco numeric, condominio numeric, quartos smallint, vagas smallint,
  area_util numeric, bairro text, cidade text, url_anuncio text,
  fotos jsonb, score real
)
LANGUAGE sql STABLE AS $$
  SELECT p.id, p.codigo_externo, p.titulo, p.tipo, p.operacao,
         COALESCE(p.preco, p.preco_locacao), p.condominio, p.quartos, p.vagas,
         p.area_util, p.bairro, p.cidade, p.url_anuncio, p.fotos,
         CASE WHEN p_embedding IS NULL THEN 1.0
              ELSE 1 - (e.embedding <=> p_embedding) END::real AS score
  FROM properties p
  LEFT JOIN property_embeddings e ON e.property_id = p.id
  WHERE p.tenant_id = p_tenant
    AND p.status = 'DISPONIVEL'
    AND (p_operacao    IS NULL OR p.operacao IN (p_operacao, 'AMBOS'))
    AND (p_tipo        IS NULL OR unaccent(lower(p.tipo)) = unaccent(lower(p_tipo)))
    AND (p_cidade      IS NULL OR unaccent(lower(p.cidade)) = unaccent(lower(p_cidade)))
    AND (p_bairros     IS NULL OR p.bairro = ANY(p_bairros))
    AND (p_preco_min   IS NULL OR COALESCE(p.preco, p.preco_locacao) >= p_preco_min)
    AND (p_preco_max   IS NULL OR COALESCE(p.preco, p.preco_locacao) <= p_preco_max)
    AND (p_quartos_min IS NULL OR p.quartos >= p_quartos_min)
    AND (p_vagas_min   IS NULL OR p.vagas   >= p_vagas_min)
  ORDER BY score DESC, p.destaque DESC, p.updated_at DESC
  LIMIT p_limite;
$$;

-- =====================================================================
-- 11. RLS
-- =====================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'teams','users','whatsapp_accounts','message_templates','owners','properties',
    'property_embeddings','developments','contacts','leads','conversations','messages',
    'labels','conversation_labels','internal_notes','availability_rules','visit_settings',
    'visits','ai_config','essential_questions','qualifying_questions','lead_answers',
    'business_knowledge','guarantees','required_documents','departments','reengage_rules',
    'scheduled_jobs','broadcasts','broadcast_recipients','notifications','integrations',
    'crm_dispatch_log','events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id())
       WITH CHECK (tenant_id = current_tenant_id());', t);
  END LOOP;
END $$;

-- Papel da aplicacao: nao pode ignorar RLS (nao usar superuser na API)
-- CREATE ROLE imobi_app LOGIN PASSWORD '...';
-- GRANT USAGE ON SCHEMA public TO imobi_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO imobi_app;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO imobi_app;

-- =====================================================================
-- 12. TRIGGERS updated_at
-- =====================================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenants','users','whatsapp_accounts','message_templates','properties',
    'developments','contacts','leads','conversations','visits'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_touch_%I BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION touch_updated_at();', t, t);
  END LOOP;
END $$;