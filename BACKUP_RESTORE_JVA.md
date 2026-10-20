# Backup & Restauração — JVA Sistemas

Módulo administrativo do painel para **backup real (pg_dump)** e **restauração controlada
(pg_restore)** entre instâncias Supabase, com agendamento automático, armazenamento privado,
auditoria e confirmação destrutiva.

> Arquivos-chave:
>
> - Painel (Server Functions autocontidas): `src/backup/api.server.ts`
> - Ponte cliente: `src/lib/backup-api.ts`
> - UI: `src/routes/backup.tsx` (rota `/backup`)
> - Worker (GitHub Actions): `worker/backup-worker.mjs` + `.github/workflows/backup-worker.yml`
> - Banco central: `sql/backup_restore_schema.sql` (executar no SQL Editor do projeto
>   **hepvdpktubhcklerdvqb**)

---

## 1. Arquitetura

```
+---------------------------------------------------------------+
| Painel (Vercel)                                               |
|  • Login admin (senha única em env, cookie HttpOnly HMAC 8h)  |
|  • Instâncias/agendamentos (CRUD), Backup agora, Downloads    |
|  • Server Functions → service_role do banco CENTRAL           |
+---------------------------+-----------------------------------+
                            | REST (service_role)
                            v
+---------------------------------------------------------------+
| Supabase CENTRAL (hepvdpktubhcklerdvqb)                       |
|  backup_instances / backup_schedules / backup_jobs            |
|  backup_files / restore_jobs / backup_audit_logs              |
|  RPCs: reivindicar_job (SKIP LOCKED + lease), proxima_execucao|
|  Bucket PRIVADO 'backups' (5 GB/arquivo, sem políticas sobre) |
+---------------------------+-----------------------------------+
                            | reivindica jobs pendentes
                            v
+---------------------------------------------------------------+
| Worker (GitHub Actions — ubuntu-latest, a cada 5 min)         |
|  pg_dump/pg_restore 17; curl; node backup-worker.mjs          |
|  backup: dump → SHA-256 → pg_restore --list → upload → files  |
|  agendamento: dispara jobs automáticos vencidos (FASE 6)      |
|  restore: precheck → aguardando confirmação → execução segura |
+---------------------------------------------------------------+
```

- **Nenhuma tabela central (`clientes`, `modulos`, `dominios`) é alterada.**
- O frontend nunca lê as tabelas `backup_*` (RLS + REVOKE para anon/authenticated);
  tudo passa pelas Server Functions no servidor.
- O worker usa `service_role` apenas via Secrets do GitHub — nenhum segredo em logs,
  argv ou código do cliente.

## 2. Segurança

| Camada                     | Controle                                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Painel                     | senha única (`BACKUP_ADMIN_PASS`) + cookie HttpOnly assinado (HMAC SHA-256), sessão 8h, rate limit 10 falhas/5 min                           |
| Credenciais das instâncias | AES-256-GCM (`v1:iv:tag:cifrado`), chave-mestre `BACKUP_CRYPTO_KEY` (derivada `sha256("jva-backup::"+KEY)`) — idêntica no Vercel e no worker |
| Transferências             | senha do banco sempre por env `PGPASSWORD`, **nunca** em argv; service_role somente em headers HTTP                                          |
| Bundle do cliente          | verificação automatizada: nenhum marcador de segredo (`BACKUP_ADMIN_PASS`, `BACKUP_CRYPTO_KEY`, `SERVICE_ROLE`, `createHmac`…) sai no bundle |
| Download                   | URLs assinadas com validade de 15 min, geradas e auditadas no backend                                                                        |
| Auditoria                  | `backup_audit_logs` (login, CRUD, backup, download, retenção, restore)                                                                       |
| Banco                      | RLS + FORCE + REVOKE em todas as tabelas `backup_*`; bucket sem policies ( service_role só interno)                                          |

Schemas **gerenciados do Supabase intocáveis** (nunca DROP/restauração por cima em nenhum modo):
`auth`, `storage`, `realtime`, `graphql_public`, `supabase_functions`, `supabase_realtime`, `net`,
`vault`, `pgsodium`, `pgsodium_masks`, `datalog`, `extensions`.

## 3. Instalação

### 3.1 SQL no banco central (uma vez)

Rodar `sql/backup_restore_schema.sql` no **SQL Editor** do projeto central. O script é
idempotente; se você já rodou uma versão anterior, rode novamente (o RPC
`restore_reivindicar_job` foi atualizado para conceder também prechecks).

### 3.2 Environment Variables — Vercel

| Variável                              | Uso                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `SUPABASE_SERVICE_ROLE_KEY`           | Server Functions (CRUD `backup_*`, urls assinadas, auditoria)              |
| `BACKUP_ADMIN_PASS` (≥ 8)             | senha de acesso ao módulo                                                  |
| `BACKUP_CRYPTO_KEY` (≥ 32 aleatórios) | chave-mestre da criptografia de credenciais — **mesma nos GitHub Secrets** |

### 3.3 Secrets — GitHub Actions

| Secret                      | Uso                                                     |
| --------------------------- | ------------------------------------------------------- |
| `SUPABASE_URL`              | `https://hepvdpktubhcklerdvqb.supabase.co`              |
| `SUPABASE_SERVICE_ROLE_KEY` | fila + storage do banco central                         |
| `BACKUP_CRYPTO_KEY`         | decifra credenciais das instâncias (idêntica ao Vercel) |

> Se trocar `BACKUP_CRYPTO_KEY`, as credenciais gravadas deixam de decifrar — recadastre-as no painel.

## 4. Operação — Backups

1. **Instâncias** (`/backup` → Instâncias): cadastre `project_ref`, host/porta/user/db
   (papel `postgres`) e a senha — gravada só cifrada. Ative a instância.
2. **Backup agora** (aba Backups): enfileira `backup_jobs` (`manual`); o worker executa:
   `pg_dump --format=custom --no-owner --no-acl` → validação estrutural (`pg_restore --list`)
   → SHA-256 → upload em `backups/<project_ref>/<nome>.dump` → `backup_files` (validado).
   - Nome do arquivo: `cliente_instancia_YYYYMMDD_HHMMSS.dump`.
3. **Histórico/arquivos**: baixar (URL 15 min), verificar integridade (existência + tamanho),
   excluir (bloqueado se for o único válido da instância).
4. **Agendamentos** (1 por instância): `diario`/`semanal` (dia 0–6)/`mensal` (dia 1–28),
   `HH:MM` com fuso (padrão America/Sao_Paulo), retenção 1–365 dias (padrão 30).
   O worker dispara o job `automatico` vencido, avança `proxima_execucao` (disparos perdidos
   são pulados), contabiliza `total_backups`/`falhas_consecutivas` e aplica **retenção** —
   apaga arquivos `automatico` vencidos **após** confirmar que existe cópia nova íntegra;
   o backup mais recente válido é **jamais** removido.

## 5. Operação — Restauração

Fluxo em duas portas de segurança (worker, nunca no navegador):

1. **Pré-verificação**: baixa o `.dump`, confere SHA-256, inventaria schemas/tabelas e sonda
   o destino (contagens por schema) → relatório com conflitos e avisos. Nada é alterado.
2. **Confirmação**: o admin digita o **nome exato da instância de destino**.
   - Modo A (`aplicação`): exige schemas selecionados após o relatório (só não-gerenciados).
   - Modo B (`migração`): restaura tudo **fora** dos schemas gerenciados.
3. **Execução**: backup de **segurança do destino antes** (completo no Modo B; dos schemas
   escolhidos no Modo A, gravado como tipo `seguranca`) → `pg_restore --no-owner --no-acl
--clean --if-exists` limitado por `--schema=<alvo>` (Modo A) ou `--exclude-schema` dos
   gerenciados (Modo B) → validação de contagens pós-restore → `log_execucao` com passos.

## 6. Limites e custos

| Limite                    | Valor                                                                        |
| ------------------------- | ---------------------------------------------------------------------------- |
| Storage por arquivo .dump | 5 GB (bucket `backups`)                                                      |
| Runner (GitHub Actions)   | 25 min/execução (workflow); pg_dump 15 min; pg_restore 30 min                |
| Jobs por execução         | 3 backups + 3 prechecks + 2 restaurações                                     |
| Cron                      | a cada 5 min; concorrência worker serializada (`concurrency: backup-worker`) |
| Pg client                 | `postgresql-client-17` (fallback 16), compatível com PG 15/17 (Supabase)     |

GitHub Actions gratuito: 2.000 min/mês em repositório privado — o cron de 5 min consome
~430–600 min/mês em runs vazios (<1 min cada); backups pesados entram nessa cota
(estourou a cota? considere um runner pago por minutos adicionais).

**Não é PITR**: cada `.dump` é um ponto no tempo custom-format; não há WAL/consistência
por segundo. Em bases com muita mudança, reduzir o intervalo entre agendamentos (diário,
com horas distintas em instâncias homologação/produção) é a mitigação disponível.

## 7. Diagnóstico

- **Jobs travados**: o worker recupera leases expirados automaticamente
  (`backup_recuperar_leases_expirados`), reenfileirando backups; restaurações expiradas
  vão para `falha`.
- **Falhas de conexão**: atualizam `backup_instances.status_conexao/status_detalhe`.
- **Logs por job**: `backup_jobs.erro`, `restore_jobs.log_execucao` (visíveis nas abas).
- **Ações**: aba _Actions_ do GitHub → run "Backup Worker" → log completo (segredos mascarados).
- **Auditoria completa**: `select * from backup_audit_logs order by criado_em desc limit 50;`
  no banco central.

## 8. Procedimentos de recuperação de desastre

1. **Instância perdida**: criar projeto Supabase novo → cadastrar no painel (Instâncias) com
   as credenciais novas → Restaurar: escolher o último `.dump` validado da instância antiga,
   destino o projeto novo, **Modo B** → digitar o nome do destino → worker executa
   (backup de segurança antes) → validar contagens no relatório final.
2. **Se a `BACKUP_CRYPTO_KEY` for trocada** (ou credencial "indecifrável"): recadastrar a senha da
   instância no painel (recriptografa com a chave atual).
3. **Storage corrompido/arquivo divergente**: a verificação de integridade marcará divergência;
   gere novo backup imediatamente e trate o arquivo antigo como perdido.

## 9. Checklist pós-deploy

- [ ] `sql/backup_restore_schema.sql` executado no SQL Editor do central.
- [ ] Vercel: `SUPABASE_SERVICE_ROLE_KEY`, `BACKUP_ADMIN_PASS`, `BACKUP_CRYPTO_KEY`.
- [ ] GitHub Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BACKUP_CRYPTO_KEY`.
- [ ] Login no módulo `/backup` → cadastrar instância → **Testar conexão** (TCP) → ativar.
- [ ] **Backup agora** → conferir job `concluido` + arquivo "íntegro" → baixar `.dump`.
- [ ] Criar restauração de teste para instância descartável (Modo A, schema `public`) →
      confirmar digitando o nome → validar contagens depois.
- [ ] Criar um agendamento e conferir o disparo automático no dia seguinte (aba Actions).
