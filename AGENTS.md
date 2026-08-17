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

## Regras Fixas de Arquitetura (NÃO ALTERAR NO LOVABLE)

1. **Configuração Supabase (`src/lib/painel-db.ts`)**:
   - As constantes `DEFAULT_URL` (`https://hepvdpktubhcklerdvqb.supabase.co`) e `DEFAULT_ANON_KEY` são fixas e representam o banco central da JVA Sistemas. Não alterar nem remover essas credenciais.

2. **Estrutura Multi-Produto (`clientes`, `clientes_meupedix`, `clientes_silun`)**:
   - O campo `produto` na tabela `clientes` aceita em minúsculas `'meupedix'` ou `'silun'` (devido à restrição `clientes_produto_check`).
   - Dados do Supabase do cliente MeuPedix devem ser salvos na tabela `clientes_meupedix` usando `upsert` com `onConflict: 'cliente_id'`.
   - Dados de módulos e ID de empresa do cliente Silun devem ser salvos na tabela `clientes_silun` usando `upsert` com `onConflict: 'cliente_id'`.
   - A seção de **Domínios** deve aparecer **exclusivamente** quando `produto === 'MeuPedix'`.

