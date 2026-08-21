# Project Knowledge — Painel JVA Sistemas

## Regras de Arquitetura Fixas

### 1. Modelo de Banco de Dados Consolidado
- **Tabela Core (`clientes`)**:
  - Armazena dados de cliente e configurações dos produtos (Silun e MeuPedix).
  - Campos: `nome_fantasia`, `contato`, `telefone`, `email_contato`, `valor_mensal`, `dia_vencimento`, `status_pagamento`, `observacoes`, `ativo`, `produto`, `empresa_id` (Silun), `email_login_supabase`, `supabase_url`, `supabase_anon_key`, `modulos_contratados` (string[]), `modo`.

- **Tabela de Catálogo (`modulos`)**:
  - Armazena o catálogo de apps disponíveis (nome, slug, url_base, ícone, etc).

- **Tabela de Domínios (`dominios`)**:
  - Relacionada a `clientes`. Armazena os endereços de acesso.
  - Possui campo `modulo` para associar o domínio a um app específico (ex: `silun`, `portal`, ou slug de um módulo).

### 2. Regras de Interface (UI)
- **Seleção de Produto**: Campo obrigatório no topo do formulário.
- **Formulário Unificado**: Campos comuns e específicos (configurações Supabase, ID Empresa, Módulos) exibidos de forma organizada na mesma tela.
- **Seção Domínios**: Exibida para ambos os produtos, permitindo associar o domínio a um app (módulo).

### 3. Credenciais do Banco Central JVA
- Em `src/lib/painel-db.ts`, as constantes `DEFAULT_URL` (`https://hepvdpktubhcklerdvqb.supabase.co`) e `DEFAULT_ANON_KEY` são fixas e representam o projeto central. Não alterar.
