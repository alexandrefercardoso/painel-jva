# Project Knowledge — Painel JVA Sistemas

## Regras de Arquitetura Fixas

### 1. Modelo de Banco de Dados Multi-Produto
- **Tabela Core (`clientes`)**:
  - Campos comuns: `nome_fantasia`, `contato`, `telefone`, `email_contato`, `valor_mensal`, `dia_vencimento`, `status_pagamento`, `observacoes`, `ativo`, `produto`.
  - O campo `produto` aceita `'meupedix'` ou `'silun'` (validados pela restrição PostgreSQL `clientes_produto_check`).

- **Tabela de Extensão 1 (`clientes_meupedix`)**:
  - Relacionada 1:1 por `cliente_id`.
  - Armazena `email_login_supabase`, `supabase_url`, `supabase_anon_key`.
  - Salvamento obrigatório com `upsert` na chave `cliente_id`.

- **Tabela de Extensão 2 (`clientes_silun`)**:
  - Relacionada 1:1 por `cliente_id`.
  - Armazena `empresa_id` (UUID/texto) e `modulos_contratados` (`string[]`).
  - Módulos aceitos: `["Núcleo", "PDV", "Cereais", "Rural", "Transportadora", "Defensivo"]`.
  - Salvamento obrigatório com `upsert` na chave `cliente_id`.

### 2. Regras de Interface (UI)
- **Seleção de Produto**:
  - Campo obrigatório no topo do formulário de cliente (`MeuPedix` / `Silun`).
  - Habilitado no cadastro (`novo = true`), bloqueado na edição (`novo = false`).
- **Campos do MeuPedix**: E-mail login Supabase, Supabase URL e Supabase Anon Key.
- **Campos do Silun**: ID da Empresa (Silun) e Checkboxes dos Módulos Contratados.
- **Seção Domínios**: Deve ser exibida **exclusivamente** quando `produto === 'MeuPedix'`.

### 3. Credenciais do Banco Central JVA
- Em `src/lib/painel-db.ts`, as constantes `DEFAULT_URL` (`https://hepvdpktubhcklerdvqb.supabase.co`) e `DEFAULT_ANON_KEY` são fixas e representam o projeto central de diretórios da JVA Sistemas. Não alterar nem remover essas credenciais.
