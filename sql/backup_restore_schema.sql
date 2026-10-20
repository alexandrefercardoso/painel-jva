-- ============================================================================
-- BACKUP & RESTAURAÇÃO — SCHEMA ADMINISTRATIVO DO PAINEL JVA
-- Projeto Supabase: hepvdpktubhcklerdvqb (rodar no SQL Editor deste projeto)
--
-- Cria as tabelas `backup_*` (não conflitam com clientes / modulos / dominios),
-- índices, RLS restritiva e o RPC de concessão de jobs usado pelo worker.
--
-- ACESSO:
--   • anon / authenticated: BLOQUEADOS (revoke + RLS sem políticas).
--     O painel NUNCA lê estas tabelas direto — toda leitura/escrita acontece via
--     Server Functions no servidor (service_role) ou pelo worker (service_role).
--   • service_role: acesso pleno (chave só em env do Vercel / secrets do GitHub).
--
-- Não altera as tabelas centrais clientes, modulos e dominios (apenas FK opcional).
-- Idempotente: pode rodar novamente sem reproduzir dados.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- TRIGGER updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backup_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1) INSTÂNCIAS SUPABASE CADASTRADAS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_instances (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome               text NOT NULL,
  cliente_id         uuid REFERENCES public.clientes(id) ON DELETE SET NULL,
  project_ref        text NOT NULL,            -- ref do projeto Supabase (ex.: aqxxxxxxxxxxxxxxxxx)
  supabase_url       text,                     -- URL pública (https://ref.supabase.co)
  db_host            text NOT NULL,            -- host PostgreSQL (ex.: db.ref.supabase.com)
  db_port            integer NOT NULL DEFAULT 5432,
  db_user            text NOT NULL DEFAULT 'postgres',
  db_name            text NOT NULL DEFAULT 'postgres',
  -- senha do banco postgres criptografada (AES-256-GCM, ver src/server/backup/crypto.ts).
  -- NUNCA gravar senha em texto puro; NUNCA retornar este campo ao frontend.
  credencial_cripto  text,
  credencial_ok      boolean NOT NULL DEFAULT false,  -- existe senha cadastrada?
  ambiente           text NOT NULL DEFAULT 'producao'
                     CHECK (ambiente IN ('producao','homologacao','desenvolvimento')),
  ativo              boolean NOT NULL DEFAULT true,
  status_conexao     text NOT NULL DEFAULT 'desconhecido'
                     CHECK (status_conexao IN ('desconhecido','ok','falha')),
  status_detalhe     text,                     -- mensagem do último teste de conexão
  ultimo_backup_em   timestamptz,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_instances_project_ref_unico UNIQUE (project_ref)
);

COMMENT ON COLUMN public.backup_instances.credencial_cripto IS
  'AES-256-GCM em base64 "v1:iv:tag:cífrado". Chave-mestre apenas em env do servidor (BACKUP_CRYPTO_KEY).';

CREATE TRIGGER trg_backup_instances_updated_at
  BEFORE UPDATE ON public.backup_instances
  FOR EACH ROW EXECUTE FUNCTION backup_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) AGENDAMENTOS (1 por instância)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_schedules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id         uuid NOT NULL REFERENCES public.backup_instances(id) ON DELETE CASCADE,
  frequencia          text NOT NULL CHECK (frequencia IN ('diario','semanal','mensal','personalizado')),
  dia_semana          integer CHECK (dia_semana BETWEEN 0 AND 6),   -- 0=domingo
  dia_mes             integer CHECK (dia_mes BETWEEN 1 AND 28),     -- clampado (meses curtos)
  hora                text NOT NULL DEFAULT '03:00',                -- "HH:MM" no fuso configurado
  fuso                text NOT NULL DEFAULT 'America/Sao_Paulo',
  retencao_dias       integer NOT NULL DEFAULT 30 CHECK (retencao_dias BETWEEN 1 AND 365),
  ativo               boolean NOT NULL DEFAULT true,
  proxima_execucao    timestamptz,
  ultima_execucao_em  timestamptz,
  ultimo_resultado    text,                       -- 'concluido' | 'falha' | 'cancelado' | null
  falhas_consecutivas integer NOT NULL DEFAULT 0,
  total_backups       integer NOT NULL DEFAULT 0,
  criado_em           timestamptz NOT NULL DEFAULT now(),
  atualizado_em       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT backup_schedules_instance_unica UNIQUE (instance_id)
);

CREATE TRIGGER trg_backup_schedules_updated_at
  BEFORE UPDATE ON public.backup_schedules
  FOR EACH ROW EXECUTE FUNCTION backup_set_updated_at();

CREATE INDEX idx_backup_schedules_pendentes
  ON public.backup_schedules (proxima_execucao)
  WHERE ativo = true;

-- ---------------------------------------------------------------------------
-- 3) ESTADOS / JOBS DE BACKUP
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id      uuid NOT NULL REFERENCES public.backup_instances(id) ON DELETE CASCADE,
  schedule_id      uuid REFERENCES public.backup_schedules(id) ON DELETE SET NULL,
  tipo             text NOT NULL DEFAULT 'manual' CHECK (tipo IN ('manual','automatico')),
  status           text NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente','executando','validando','concluido','falha','cancelado')),
  tentativas       integer NOT NULL DEFAULT 0,
  max_tentativas   integer NOT NULL DEFAULT 2 CHECK (max_tentativas BETWEEN 1 AND 5),
  lease_expirar    timestamptz,          -- concessão do worker; evita execução duplicada
  erro             text,
  versao_pg_dump   text,
  arquivo_id       uuid,                 -- preenchido após upload do .dump
  iniciado_em      timestamptz,
  finalizado_em    timestamptz,
  criado_por       text NOT NULL DEFAULT 'admin',  -- 'admin' | 'agendamento'
  criado_em        timestamptz NOT NULL DEFAULT now(),
  atualizado_em    timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_backup_jobs_updated_at
  BEFORE UPDATE ON public.backup_jobs
  FOR EACH ROW EXECUTE FUNCTION backup_set_updated_at();

CREATE INDEX idx_backup_jobs_instancia ON public.backup_jobs (instance_id, criado_em DESC);
CREATE INDEX idx_backup_jobs_pendentes ON public.backup_jobs (criado_em) WHERE status = 'pendente';

-- ---------------------------------------------------------------------------
-- 4) ARQUIVOS .DUMP (metadados; conteúdo vive no bucket privado 'backups')
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_files (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id    uuid NOT NULL REFERENCES public.backup_instances(id) ON DELETE CASCADE,
  job_id         uuid REFERENCES public.backup_jobs(id) ON DELETE SET NULL,
  nome_arquivo   text NOT NULL,                 -- cliente_instancia_YYYYMMDD_HHMMSS.dump
  storage_path   text NOT NULL,                 -- caminho no bucket 'backups'
  tamanho_bytes  bigint CHECK (tamanho_bytes IS NULL OR tamanho_bytes >= 0),
  sha256         text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  tipo           text NOT NULL DEFAULT 'manual' CHECK (tipo IN ('manual','automatico','seguranca')),
  validado       boolean NOT NULL DEFAULT false, -- integridade estrutural confirmada?
  validado_em    timestamptz,
  inventario     jsonb,                          -- schemas/tabelas cobertas pelo dump
  criado_em      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_backup_files_instancia ON public.backup_files (instance_id, criado_em DESC);
CREATE INDEX idx_backup_files_sha256    ON public.backup_files (sha256);

-- ---------------------------------------------------------------------------
-- 5) RESTAURAÇÕES ENTRE INSTÂNCIAS
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.restore_jobs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_file_id         uuid NOT NULL REFERENCES public.backup_files(id) ON DELETE RESTRICT,
  origem_instance_id     uuid NOT NULL REFERENCES public.backup_instances(id) ON DELETE RESTRICT,
  destino_instance_id    uuid NOT NULL REFERENCES public.backup_instances(id) ON DELETE RESTRICT,
  modo                   text NOT NULL DEFAULT 'aplicacao'
                         CHECK (modo IN ('aplicacao','migracao')),
  schemas_alvo           text[] NOT NULL DEFAULT '{public}',  -- schemas executados no Modo A
  status                 text NOT NULL DEFAULT 'pendente_precheck'
                         CHECK (status IN ('pendente_precheck','falha_precheck','aguardando_confirmacao',
                                           'pendente','executando','validando','concluido','falha','cancelado')),
  precheck               jsonb,               -- relatório de pré-verificação
  confirmacao_texto      text,                -- nome da instância digitado (produção)
  confirmado_em          timestamptz,
  backup_seguranca_id    uuid REFERENCES public.backup_files(id) ON DELETE SET NULL,
  erro                   text,
  log_execucao           text,
  iniciado_em            timestamptz,
  finalizado_em          timestamptz,
  duracao_seg            integer,
  lease_expirar          timestamptz,
  criado_em              timestamptz NOT NULL DEFAULT now(),
  atualizado_em          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN public.restore_jobs.schemas_alvo IS
  'Schemas restaurados no Modo A. Schemas gerenciados do Supabase (auth, storage, realtime, graphql_public, supabase_functions etc.) NUNCA são alvo de DROP/replace.';

CREATE TRIGGER trg_restore_jobs_updated_at
  BEFORE UPDATE ON public.restore_jobs
  FOR EACH ROW EXECUTE FUNCTION backup_set_updated_at();

CREATE INDEX idx_restore_jobs_instancia_destino ON public.restore_jobs (destino_instance_id, criado_em DESC);
CREATE INDEX idx_restore_jobs_pendentes         ON public.restore_jobs (criado_em)
  WHERE status IN ('pendente_precheck','pendente');

-- ---------------------------------------------------------------------------
-- 6) AUDITORIA
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.backup_audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acao        text NOT NULL,
  origem      text NOT NULL DEFAULT 'painel' CHECK (origem IN ('painel','worker','system')),
  referencia  jsonb,     -- ids envolvidos (instância, job, arquivo, destino)
  detalhes    jsonb,     -- dados adicionais — SEMVALOR sensível (secrets mascarados)
  criado_em   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_backup_audit_criado_em ON public.backup_audit_logs (criado_em DESC);
CREATE INDEX idx_backup_audit_acao      ON public.backup_audit_logs (acao);

-- ---------------------------------------------------------------------------
-- RLS + GRANTS: lock-down total para anon/authenticated
-- ---------------------------------------------------------------------------
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'backup_instances','backup_schedules','backup_jobs',
      'backup_files','restore_jobs','backup_audit_logs'
    ]) AS nome
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated;', r.nome);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', r.nome);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', r.nome);
    EXECUTE format(
      'CREATE POLICY "service_role_administra_%s" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);',
      r.nome, r.nome);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- CÁLCULO DA PRÓXIMA EXECUÇÃO (com fuso horário)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.backup_proxima_execucao(text, integer, integer, text, text, timestamptz);
CREATE OR REPLACE FUNCTION public.backup_proxima_execucao(
  p_frequencia text,
  p_dia_semana integer,
  p_dia_mes    integer,
  p_hora       text,
  p_fuso       text,
  p_a_partir   timestamptz DEFAULT now()
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_hora      integer := coalesce(split_part(p_hora, ':', 1)::integer, 3);
  v_min       integer := coalesce(split_part(p_hora, ':', 2)::integer, 0);
  v_agora     timestamp := (p_a_partir AT TIME ZONE coalesce(p_fuso, 'America/Sao_Paulo'));
  v_candidata timestamp;
  v_dia       integer;
  v_alvo      integer;
BEGIN
  IF p_frequencia = 'diario' OR p_frequencia = 'personalizado' THEN
    v_candidata := date_trunc('day', v_agora) + make_interval(hours => v_hora, mins => v_min);
    IF v_candidata <= v_agora THEN
      v_candidata := v_candidata + interval '1 day';
    END IF;
    RETURN v_candidata AT TIME ZONE coalesce(p_fuso, 'America/Sao_Paulo');

  ELSIF p_frequencia = 'semanal' THEN
    v_alvo := coalesce(p_dia_semana, 0);
    FOR i IN 0..7 LOOP
      v_candidata := date_trunc('day', v_agora) + make_interval(days => i, hours => v_hora, mins => v_min);
      IF v_candidata > v_agora AND EXTRACT(DOW FROM v_candidata)::integer = v_alvo THEN
        RETURN v_candidata AT TIME ZONE coalesce(p_fuso, 'America/Sao_Paulo');
      END IF;
    END LOOP;
    RETURN (v_agora + interval '7 days') AT TIME ZONE coalesce(p_fuso, 'America/Sao_Paulo');

  ELSIF p_frequencia = 'mensal' THEN
    v_dia := coalesce(p_dia_mes, 1);
    IF v_dia > 28 THEN v_dia := 28; END IF;
    FOR i IN 0..13 LOOP
      v_candidata := date_trunc('month', v_agora)
                     + make_interval(months => i, days => v_dia - 1, hours => v_hora, mins => v_min);
      IF v_candidata > v_agora THEN
        RETURN v_candidata AT TIME ZONE coalesce(p_fuso, 'America/Sao_Paulo');
      END IF;
    END LOOP;
    RETURN (v_agora + interval '31 days') AT TIME ZONE coalesce(p_fuso, 'America/Sao_Paulo');
  END IF;

  RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- CONCESSÃO ATÔMICA DE JOBS (usada exclusivamente pelo worker)
-- Evita execução duplicada: FOR UPDATE SKIP LOCKED + lease com prazo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.backup_reivindicar_job(p_lease_minutos integer DEFAULT 120)
RETURNS SETOF public.backup_jobs
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.backup_jobs j
     SET status = 'executando',
         lease_expirar = now() + make_interval(mins => p_lease_minutos),
         iniciado_em   = coalesce(j.iniciado_em, now()),
         tentativas    = j.tentativas + 1
   WHERE j.id = (
     SELECT pj.id FROM public.backup_jobs pj
      WHERE pj.status = 'pendente'
      FOR UPDATE SKIP LOCKED
   )
   RETURNING j.* INTO v_id;
  RETURN QUERY SELECT * FROM public.backup_jobs WHERE id = v_id;
END;
$$;

-- Jobs de restauração: concede tanto PRECHECKS ('pendente_precheck') quanto
-- EXECUÇÕES ('pendente', já confirmadas pelo admin no painel)
CREATE OR REPLACE FUNCTION public.restore_reivindicar_job(
  p_status        text    DEFAULT 'pendente',
  p_lease_minutos integer DEFAULT 120
)
RETURNS SETOF public.restore_jobs
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
  IF p_status NOT IN ('pendente','pendente_precheck') THEN
    RAISE EXCEPTION 'status invalido para concessao: % (use pendente ou pendente_precheck)', p_status;
  END IF;
  RETURN QUERY
  UPDATE public.restore_jobs r
     SET status = 'executando',
         lease_expirar = now() + make_interval(mins => p_lease_minutos),
         iniciado_em   = coalesce(r.iniciado_em, now())
   WHERE r.id = (
     SELECT pj.id FROM public.restore_jobs pj
      WHERE pj.status = p_status
      FOR UPDATE SKIP LOCKED
   )
   RETURNING r.*;
END;
$$;

-- Recupera leases expirados (worker morreu) e reenfileira com controle de tentativas
CREATE OR REPLACE FUNCTION public.backup_recuperar_leases_expirados()
RETURNS TABLE (reenfileirados_backup bigint, reenfileirados_restauracao bigint)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE v_b bigint; v_r bigint;
BEGIN
  UPDATE public.backup_jobs j
     SET status = CASE WHEN j.tentativas >= j.max_tentativas THEN 'falha' ELSE 'pendente' END,
         erro   = CASE WHEN j.tentativas >= j.max_tentativas
                       THEN coalesce(j.erro,'') || ' | lease expirado sem conclusão do worker'
                       ELSE j.erro END,
         lease_expirar = NULL
   WHERE j.status = 'executando'
     AND j.lease_expirar < now();
  GET DIAGNOSTICS v_b = ROW_COUNT;

  UPDATE public.restore_jobs r
     SET status = 'falha',
         erro   = coalesce(r.erro,'') || ' | lease expirado sem conclusão do worker',
         lease_expirar = NULL
   WHERE r.status IN ('executando','pendente')
     AND r.lease_expirar IS NOT NULL
     AND r.lease_expirar < now();
  GET DIAGNOSTICS v_r = ROW_COUNT;

  RETURN QUERY SELECT v_b, v_r;
END;
$$;

-- ---------------------------------------------------------------------------
-- BUCKET PRIVADO DE ARQUIVOS .DUMP (armazenamento independente das instâncias)
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('backups', 'backups', false, 5368709120, NULL)   -- 5 GB por arquivo
ON CONFLICT (id) DO NOTHING;

-- Sem políticas no bucket 'backups': anon/authenticated ficam bloqueados
-- por padrão. Somente service_role (Server Functions + worker) acessa, e
-- downloads acontecem por URLs de curta duração assinadas no backend.

-- ============================================================================
-- TESTES após aplicar:
--
-- SELECT public.backup_proxima_execucao('diario',   NULL, NULL, '03:00', 'America/Sao_Paulo');
-- SELECT public.backup_proxima_execucao('semanal',  1,    NULL, '05:30', 'America/Sao_Paulo');  -- segundas
-- SELECT public.backup_proxima_execucao('mensal',   NULL, 1,    '02:00', 'UTC');
-- SELECT reenfileirados_backup, reenfileirados_restauracao FROM public.backup_recuperar_leases_expirados();
--
-- As tabelas devem estar vazias e bloqueadas para anon:
-- SELECT * FROM public.backup_instances;  -- com anon key REST: deve negar (401/403)
-- ============================================================================
