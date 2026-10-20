-- ============================================================================
-- MIGRAÇÃO: restore_reivindicar_job com concessão de prechecks (FASE 7)
--
-- PROBLEMA: o banco central tem a versão antiga da função — apenas
--   restore_reivindicar_job(p_lease_minutos)
-- mas o worker chama com { p_status, p_lease_minutos } para conceder tanto
-- prechecks ('pendente_precheck') quanto execuções ('pendente').
--
-- COMO APLICAR: Supabase (projeto central hepvdpktubhcklerdvqb) →
--   SQL Editor → rodar este script inteiro.
--
-- O CREATE OR REPLACE cria uma NOVA sobrecarga (p_status, p_lease_minutos);
-- a antiga (p_lease_minutos) continua válida — nada quebra no meio do caminho.
-- Reexecutar este script é seguro (idempotente).
-- ============================================================================

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
  UPDATE public.restore_jobs r
     SET status = 'executando',
         lease_expirar = now() + make_interval(mins => p_lease_minutos),
         iniciado_em   = coalesce(r.iniciado_em, now())
   WHERE r.id = (
     SELECT pj.id FROM public.restore_jobs pj
      WHERE pj.status = p_status
      FOR UPDATE SKIP LOCKED
   ) RETURNING r.*;
END;
$$;

-- Acesso do worker (service_role) — reforça a concessão caso RLS restrinja
GRANT EXECUTE ON FUNCTION public.restore_reivindicar_job(text, integer) TO service_role;

-- Confirmação rápida: deve listar as duas sobrecargas da função
SELECT p.proname, pg_get_function_arguments(p.oid) AS assinatura
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'restore_reivindicar_job'
 ORDER BY 2;
