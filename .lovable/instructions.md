# Project Knowledge & Architecture Guidelines — JVA Sistemas

This repository uses a strict multi-product architecture connected to Supabase.
All AI assistants (including Lovable) MUST strictly follow these rules:

## 1. Database Architecture & Extension Tables
- Core table: `clientes` (contains common fields: `nome_fantasia`, `contato`, `telefone`, `email_contato`, `valor_mensal`, `dia_vencimento`, `status_pagamento`, `observacoes`, `ativo`, `produto`).
- Check constraint: `clientes_produto_check` enforces lowercase `'meupedix'` or `'silun'` for column `produto`.
- Extension table 1: `clientes_meupedix` (1-to-1 with `clientes` via `cliente_id` primary key).
  - Contains: `email_login_supabase`, `supabase_url`, `supabase_anon_key`.
  - Saving MUST use `.upsert(payload, { onConflict: "cliente_id" })`.
- Extension table 2: `clientes_silun` (1-to-1 with `clientes` via `cliente_id` primary key).
  - Contains: `empresa_id`, `modulos_contratados` (array of strings: `["Núcleo", "PDV", "Cereais", "Rural", "Transportadora", "Defensivo"]`).
  - Saving MUST use `.upsert(payload, { onConflict: "cliente_id" })`.

## 2. UI & Conditional Rendering
- The **Produto** field is a required select at the top of the client form.
  - Allowed values: `MeuPedix` / `Silun`.
  - Unlocked on creation (`novo = true`), locked/disabled on edit (`novo = false`).
- **MeuPedix**: Renders Supabase login email, Supabase URL, and Supabase anon key.
- **Silun**: Renders Silun Company ID and Módulos contratados checkboxes.
- **Domínios section**: Displayed **ONLY** when `produto === "MeuPedix"`.

## 3. Central Supabase Project Configuration
- In `src/lib/painel-db.ts`, `DEFAULT_URL` (`https://hepvdpktubhcklerdvqb.supabase.co`) and `DEFAULT_ANON_KEY` are fixed credentials for the JVA directory. DO NOT remove or overwrite them.
