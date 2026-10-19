-- ============================================================================
-- CORREÇÃO DA RPC get_config_por_dominio — diretório JVA Sistemas
-- Projeto Supabase: hepvdpktubhcklerdvqb (rodar no SQL Editor deste projeto)
--
-- Regra atual (2026-10-19):
--   • O domínio responde SEMPRE pelo cliente que o cadastrou — mesmo inativo.
--   • Não existe conceito de "primário": um domínio = um cliente.
--   • Empate só em caso de erro de cadastro (mesmo domínio em 2 clientes):
--     vence o cadastro MAIS RECENTE — corrigir o dup no painel.
-- NÃO altera tabelas nem dados cadastrados — apenas reescreve a função.
--
-- Parâmetro: p_dominio text (hostname, ex.: "meupedix-cardapiodigital.lovable.app")
-- Retorno:   linhas com supabase_url, supabase_anon_key, ativo, nome_fantasia
-- ============================================================================

-- Para aplicar: copie TODO este arquivo e execute no SQL Editor do Supabase.
-- Depois rode os testes contidos nas linhas finais comentadas.

DROP FUNCTION IF EXISTS public.get_config_por_dominio(text);

CREATE OR REPLACE FUNCTION public.get_config_por_dominio(p_dominio text)
RETURNS TABLE (
  supabase_url      text,
  supabase_anon_key text,
  ativo             boolean,
  nome_fantasia     text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  WITH dominios_norm AS (
    SELECT
      d.cliente_id,
      d.created_at,
      -- Normaliza o domínio salvo (pode estar gravado com protocolo/porta/caminho,
      -- ex.: "http://localhost:8080") para casar com o hostname puro passado pelo app.
      regexp_replace(regexp_replace(regexp_replace(regexp_replace(
        split_part(split_part(lower(btrim(coalesce(d.dominio, ''))), '/', 1), '?', 1),
        '^[a-z0-9]+://', ''), ':[0-9]+$', ''), '^www\.', ''), '\s', '') AS dominio_norm
    FROM public.dominios d
  ),
  alvo AS (
    SELECT regexp_replace(regexp_replace(regexp_replace(regexp_replace(
      split_part(split_part(lower(btrim(coalesce(p_dominio, ''))), '/', 1), '?', 1),
      '^[a-z0-9]+://', ''), ':[0-9]+$', ''), '^www\.', ''), '\s', '') AS dominio_norm
  )
  SELECT
    c.supabase_url,
    c.supabase_anon_key,
    c.ativo,
    c.nome_fantasia
  FROM dominios_norm d
  JOIN alvo a           ON d.dominio_norm = a.dominio_norm
  JOIN public.clientes c ON c.id = d.cliente_id
  -- Sem filtro de ativo: o cliente certo responde mesmo inativo.
  -- Sem is_primary: o domínio pertence ao cliente que o cadastrou.
  -- Empate (mesmo domínio em 2 clientes, por erro de cadastro) resolve
  -- para o cadastramento MAIS RECENTE — corrigir o dup no painel.
  ORDER BY d.created_at DESC NULLS LAST
  LIMIT 1;
$$;

-- O DROP acima apaga os grants da função antiga; reotorga acesso ao anon
-- (a chave pública usada pelos apps MeuPedix/Silun via REST do Supabase).
GRANT EXECUTE ON FUNCTION public.get_config_por_dominio(text) TO anon, authenticated;

-- ============================================================================
-- TESTES após aplicar (deve retornar 1 linha do cliente Marcao lanches):
--
-- SELECT * FROM public.get_config_por_dominio('meupedix-cardapiodigital.lovable.app');
-- SELECT * FROM public.get_config_por_dominio('id-preview--eee322ef-a722-45c5-9adb-031a0d7d1d61.lovable.app');
-- SELECT * FROM public.get_config_por_dominio('http://localhost:8080');  -- hostnames com protocolo/porta também casam
--
-- Cliente INATIVO também deve responder (a RPC não filtra por ativo).
-- Se o mesmo domínio estiver em 2 clientes, vence o cadastro MAIS RECENTE.
-- ============================================================================
