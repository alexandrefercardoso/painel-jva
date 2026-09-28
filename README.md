# Painel JVA

crie um projeto novo PAINEL

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/8e2e7efd-2505-486b-9a92-637016cc07ce).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Keep-alive do Supabase

O plano gratuito do Supabase pausa o banco após um período de inatividade. Para
evitar isso, este repositório inclui um GitHub Action (`.github/workflows/keep-alive.yml`)
que faz um ping no banco via RPC a cada 3 dias (também pode ser executado manualmente
na aba *Actions* do GitHub).

**Configuração necessária:**

1. Crie a tabela/função no Supabase executando o script em `migration-keep-alive.sql`
   (SQL Editor do painel do Supabase).
2. Em GitHub > **Settings** > **Secrets and variables** > **Actions**, cadastre o secret
   **`SUPABASE_PROJECTS`**.
3. O valor do secret deve ter **uma linha por projeto**, no formato:

   ```
   https://SEU-PROJETO.supabase.co|SEU_ANON_KEY
   https://OUTRO-PROJETO.supabase.co|OUTRO_ANON_KEY
   ```

   Use a URL do projeto e a **anon key** pública (Project Settings > API). NUNCA use a
   `service_role` key nesse secret, pois ela é exposta no workflow do GitHub.
4. O arquivo `migration-keep-alive.sql` também pode ser incluído no link de migração
   do Supabase/dashboard, mas a execução manual no SQL Editor é a forma mais simples.
