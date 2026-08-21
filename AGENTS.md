<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Regras Fixas de Arquitetura (ATUALIZADO)

1. **Configuração Supabase (`src/lib/painel-db.ts`)**:
   - As constantes `DEFAULT_URL` (`https://hepvdpktubhcklerdvqb.supabase.co`) e `DEFAULT_ANON_KEY` são fixas e representam o banco central da JVA Sistemas. Não alterar nem remover essas credenciais.

2. **Estrutura de Dados Consolidada (3 tabelas)**:
   - **`clientes`**: Tabela única com todos os dados (base + configuração produto + MeuPedix + Silun/empresa + modulos_contratados array).
   - **`modulos`**: Catálogo universal de apps (slug, nome, url_base, etc).
   - **`dominios`**: Tabela de endereços (dominio, cliente_id, modulo_associado).

3. **Fluxo de Módulos**:
   - Apps são separados e consultam URLs do Supabase (global para Silun, cliente p/ MeuPedix).
   - O campo `modulos_contratados` (array de slugs) no cliente define o que está liberado.
   - O campo `dominios.modulo` (slug) associa o domínio ao app específico.

