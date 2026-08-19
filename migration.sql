-- Tabela para gerenciar múltiplos domínios por cliente
CREATE TABLE IF NOT EXISTS public.dominios_cliente (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id uuid NOT NULL REFERENCES public.clientes(id) ON DELETE CASCADE,
    dominio text NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- Permissões para a nova tabela
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dominios_cliente TO authenticated;
GRANT ALL ON public.dominios_cliente TO service_role;

-- Habilitar RLS
ALTER TABLE public.dominios_cliente ENABLE ROW LEVEL SECURITY;

-- Política simples (como o painel é para uso pessoal e usa anon key com RLS básico ou service role no backend)
-- Como o usuário pediu para manter o padrão dele (profiles com senha simples), assumimos acesso authenticated/anon conforme configurado no painel-db.ts
CREATE POLICY "Permitir tudo para autenticados" ON public.dominios_cliente
    FOR ALL TO authenticated USING (true);
