# Project Knowledge & Architecture Guidelines — JVA Sistemas

This repository uses a strict multi-product architecture connected to Supabase.
All AI assistants (including Lovable) MUST strictly follow these rules:

## 1. Database Architecture (modelo atual — consolidado em 2026-08-20)
- Core table: `clientes` contém TODOS os campos do cliente, inclusive as antigas
  colunas de extensão: `nome_fantasia`, `contato`, `telefone`, `email_contato`,
  `valor_mensal`, `dia_vencimento`, `status_pagamento`, `observacoes`, `ativo`,
  `produto` (slug em minúsculas; veja tabela `produtos` abaixo),
  `empresa_id`, `modulos_contratados`, `email_login_supabase`,
  `supabase_url`, `supabase_anon_key`, `modo`.
- Tabela `produtos`: catálogo flexível de produtos (`id`, `slug` UNIQUE, `nome`,
  `ativo`, `ordem`). O combo "Produto" do cadastro de clientes lê esta tabela;
  se ela não existir, usam-se os padrões `meupedix`/`silun` (fallback em código).
  O check `clientes_produto_check` pode limitar slugs — ao criar um produto novo,
  ajuste ou remova essa regra no Supabase.
- As tables de extensão `clientes_meupedix` e `clientes_silun` **NÃO EXISTEM MAIS**
  (foram consolidadas dentro de `clientes`). NUNCA crie queries/upserts contra elas.
- Domínios: tabela `dominios` (`cliente_id` → `clientes.id`, `dominio`, `modulo`, `is_primary`).
- RPC `get_config_por_dominio(p_dominio text)`: resolve domínio → configuração do
  cliente (lê `dominios` + `clientes`, somente com `ativo = true`).

## 2. UI & Conditional Rendering
- The **Produto** field is a required select at the top of the client form.
  - Allowed values: `MeuPedix` / `Silun`.
  - Unlocked on creation (`novo = true`), locked/disabled on edit (`novo = false`).
- **MeuPedix**: Renders Supabase login email, Supabase URL, and Supabase anon key.
- **Silun**: Renders Silun Company ID and Módulos contratados checkboxes.
- **Domínios section**: Displayed **ONLY** when `produto === "MeuPedix"`.

## 3. Central Supabase Project Configuration
- In `src/lib/painel-db.ts`, `DEFAULT_URL` (`https://hepvdpktubhcklerdvqb.supabase.co`) and `DEFAULT_ANON_KEY` are fixed credentials for the JVA directory. DO NOT remove or overwrite them.
