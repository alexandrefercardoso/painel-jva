-- ============================================================================
-- REMOVER DOMÍNIOS DUPLICADOS E CRIAR UNICIDADE DE DOMÍNIO
-- Projeto Supabase: hepvdpktubhcklerdvqb (rodar no SQL Editor deste projeto)
--
-- Regra: 1 domínio = 1 cliente. A RPC get_config_por_dominio não tem
-- "primário" nem desempate por ativo — o domínio pertence ao cliente que
-- o cadastrou. A restrição UNIQUE abaixo blinda isso no banco.
-- ============================================================================

-- 1) Limpeza: domínios que a Demonstracao tinha em duplicata com a Marcao lanches
--    (já aplicado manualmente em 2026-10-19; mantido aqui como registro).
DELETE FROM public.dominios
WHERE cliente_id = '0f0b32ad-be1e-48e9-b3ca-44bc1b9d66f7'  -- Demonstracao
  AND dominio IN (
    'meupedix-entregador.vercel.app',
    'meupedixmesa.vercel.app',
    'http://localhost:8080',
    'meupedixpainel.vercel.app',
    'meupedix-cardapiodigital.vercel.app',
    'meupedix-cardapiodigital.lovable.app'
  );

-- 2) Restrição: cada valor de dominio só pode existir UMA vez na tabela.
--    Se houver qualquer duplicata restante, esta linha falha e indica quais:
--    SELECT dominio, count(*) FROM public.dominios GROUP BY 1 HAVING count(*) > 1;
ALTER TABLE public.dominios DROP CONSTRAINT IF EXISTS dominios_dominio_key;
ALTER TABLE public.dominios ADD CONSTRAINT dominios_dominio_key UNIQUE (dominio);

-- ============================================================================
-- TESTES após aplicar:
--
-- SELECT * FROM public.get_config_por_dominio('meupedixpainel.vercel.app');
--   → deve retornar Marcao lanches (tmheapviezuqezfpqctp.supabase.co)
-- SELECT * FROM public.get_config_por_dominio('http://localhost:3031/');
--   → deve retornar Demonstracao (cfzxlsbchdpcbgdtdwza.supabase.co)
-- ============================================================================
