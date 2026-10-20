-- ============================================================================
-- MIGRAÃ‡ÃƒO â€” LOG DE EXECUÃ‡ÃƒO + DESTINO DO BACKUP
--
-- Rode no Supabase SQL Editor do projeto CENTRAL (hepvdpktubhcklerdvqb).
-- O que faz:
--   1. backup_jobs.log_execucao  â€” log passo a passo gravado pelo worker
--                                  (pg_dump â†’ validaÃ§Ã£o â†’ upload â†’ conclusÃ£o).
--   2. backup_instances.storage_prefix â€” pastinha/prefixo de destino do backup
--                                  no bucket privado 'backups'. Vazio = usa o
--                                  project_ref (comportamento anterior).
--   3. Ajusta o claim (backup_reivindicar_job) para devolver a coluna nova.
--
-- Idempotente: pode rodar mais de uma vez sem quebrar.
-- ============================================================================

ALTER TABLE backup_jobs
  ADD COLUMN IF NOT EXISTS log_execucao text;

ALTER TABLE backup_instances
  ADD COLUMN IF NOT EXISTS storage_prefix text NOT NULL DEFAULT '';

-- Normaliza prefixo: sem barras nas pontas, minÃºsculo, sÃ³ [a-z0-9._\/-]
UPDATE backup_instances
   SET storage_prefix = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(storage_prefix, '/+$', ''), '^/+', ''))
 WHERE storage_prefix ~ '(^/+|/+$)';

-- O claim (reivindicar_job) jÃ¡ retorna SELECT *; nenhuma alteraÃ§Ã£o exigida.
-- Confirma (idempotente) que as colunas existem:

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'backup_jobs' AND column_name = 'log_execucao') THEN
    RAISE EXCEPTION 'Coluna backup_jobs.log_execucao nÃ£o foi criada';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'backup_instances' AND column_name = 'storage_prefix') THEN
    RAISE EXCEPTION 'Coluna backup_instances.storage_prefix nÃ£o foi criada';
  END IF;
END $$;

SELECT 'OK â€” migraÃ§Ã£o aplicada' AS resultado;

