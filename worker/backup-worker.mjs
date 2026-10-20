// ============================================================================
// WORKER DE BACKUPS — JVA SISTEMAS
// Executado pelo GitHub Actions (`.github/workflows/backup-worker.yml`) a cada
// 5 minutos ou manualmente. Requer Node 20+ e `pg_dump`/`pg_restore`
// (postgresql-client) no PATH.
//
// O QUE FAZ
//   1. Recupera leases expirados e reenfileira jobs travados.
//   2. Reivindica jobs 'pendente' com concessão atômica (RPC SKIP LOCKED).
//   3. Para cada job:
//        - Decifra a senha do banco (AES-256-GCM, chave-mestre env
//          BACKUP_CRYPTO_KEY — igual a src/backup/api.server.ts).
//        - Executa pg_dump --format=custom --no-owner --no-acl. A senha vai por
//          env PGPASSWORD — NUNCA em argumentos de linha de comando.
//        - Valida integridade estrutural com pg_restore --list (+ inventário).
//        - Calcula SHA-256 e tamanho.
//        - Envia o .dump ao bucket PRIVADO 'backups' (curl; service_role no
//          header Authorization — nenhum segredo no argv).
//        - Registra backup_files, conclui o job, atualiza a instância, o
//          agendamento e aplica retenção — nunca apagando o último backup
//          válido da instância.
//        - Falhas ficam registradas (sanitizadas, sem segredos) e reenfileiradas
//          até max_tentativas.
//   RESTAURACAO (FASE 7): processa os restore_jobs em duas etapas —
//        1) precheck (pendente_precheck): baixa o .dump, valida SHA-256,
//           inventoria o dump, sonda o destino via SQL e grava o relatório em
//           restore_jobs.precheck; fica 'aguardando_confirmacao'. NUNCA altera
//           o destino nesta etapa.
//        2) execução (pendente, só depois da confirmação admin digitando o
//           nome da instância): faz backup de segurança do destino primeiro,
//           roda pg_restore --clean --if-exists (limitado por --schema no
//           Modo A; com --exclude-schema dos schemas gerenciados no Modo B) e
//           valida contagens pós-restore. Schemas gerenciados do Supabase
//           (auth, storage, realtime etc.) NUNCA são substituídos.
//
// Secrets pré-requisito no GitHub Actions:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKUP_CRYPTO_KEY
// ============================================================================

import { execFileSync } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Configuração (env)
// ---------------------------------------------------------------------------
const SB_URL = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "").replace(
  /\/+$/,
  "",
);
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";
const CRYPTO_KEY = process.env.BACKUP_CRYPTO_KEY ?? "";
const LIMITE_JOBS_POR_RUN = 3;
const LIMITE_PRECHECKS_POR_RUN = 3;
const LIMITE_RESTORES_POR_RUN = 2;
const LIMITE_ARQUIVOS_POR_LOOP = 200;
const TIMEOUT_PG_DUMP_MS = 15 * 60 * 1000;
const TIMEOUT_UPLOAD_MS = 10 * 60 * 1000;
const TIMEOUT_PG_RESTORE_MS = 30 * 60 * 1000;
const TIMEOUT_DOWNLOAD_MS = 10 * 60 * 1000;
const TIMEOUT_SQL_MS = 60 * 1000;

// Schemas gerenciados pelo Supabase: nunca restaurados por cima (Modo B
// exclui; Modo A rejeita como alvo). 'extensions' fica fora da migração
// porque pertence ao destino do projeto.
const SCHEMAS_GERENCIADOS = [
  "auth",
  "storage",
  "realtime",
  "graphql_public",
  "supabase_functions",
  "supabase_realtime",
  "net",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "datalog",
  "extensions",
];

function log(mensagem) {
  process.stdout.write(`[${new Date().toISOString()}] ${mensagem}\n`);
}

function logErro(mensagem) {
  process.stderr.write(`[${new Date().toISOString()}] ${mensagem}\n`);
}

function escapeRegExp(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Nunca exibir segredos em logs. */
function sanitizar(texto) {
  return String(texto ?? "")
    .replaceAll(SB_KEY, "*SERVICE_KEY*")
    .replaceAll(CRYPTO_KEY, "*CRYPTO_KEY*")
    .replace(/\bPGPASSWORD\s*=\s*\S+/gi, "PGPASSWORD=****")
    .replace(/postgres(?:ql)?\s*:\/\/[^\s'"`]+/gi, "postgres://****")
    .replace(/(password\s*[=:]\s*)(\S+)/gi, "$1****");
}

// ---------------------------------------------------------------------------
// Cliente REST mínimo do Supabase (service_role; uso exclusivo em produção)
// ---------------------------------------------------------------------------
async function dbRpc(nome, params) {
  const resposta = await fetch(`${SB_URL}/rest/v1/rpc/${nome}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(params ?? {}),
  });
  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`RPC ${nome} falhou (HTTP ${resposta.status}): ${sanitizar(corpo)}`);
  }
  const texto = await resposta.text();
  return texto ? JSON.parse(texto) : null;
}

async function dbSelect(tabela, params) {
  const consulta = new URLSearchParams(params);
  const resposta = await fetch(`${SB_URL}/rest/v1/${tabela}?${consulta.toString()}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: "application/json" },
  });
  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`SELECT ${tabela} falhou (HTTP ${resposta.status}): ${sanitizar(corpo)}`);
  }
  return resposta.json();
}

async function dbInsert(tabela, registro) {
  const resposta = await fetch(`${SB_URL}/rest/v1/${tabela}`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.pgrst.object+json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(registro),
  });
  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`INSERT ${tabela} falhou (HTTP ${resposta.status}): ${sanitizar(corpo)}`);
  }
  return resposta.json();
}

async function dbUpdate(tabela, registro, filtro) {
  const resposta = await fetch(`${SB_URL}/rest/v1/${tabela}?${filtro}`, {
    method: "PATCH",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(registro),
  });
  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`PATCH ${tabela} falhou (HTTP ${resposta.status}): ${sanitizar(corpo)}`);
  }
}

async function dbDelete(tabela, filtro) {
  const resposta = await fetch(`${SB_URL}/rest/v1/${tabela}?${filtro}`, {
    method: "DELETE",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: "return=minimal" },
  });
  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`DELETE ${tabela} falhou (HTTP ${resposta.status}): ${sanitizar(corpo)}`);
  }
}

async function removerDoStorage(storagePath) {
  const url = `${SB_URL}/storage/v1/object/backups/${storagePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const resposta = await fetch(url, {
    method: "DELETE",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!resposta.ok) {
    const corpo = await resposta.text();
    throw new Error(`storage DELETE falhou (HTTP ${resposta.status}): ${sanitizar(corpo)}`);
  }
}

async function auditoria(acao, referencia, detalhes) {
  try {
    await dbInsert("backup_audit_logs", {
      acao,
      origem: "worker",
      referencia: referencia ?? null,
      detalhes: detalhes ?? null,
    });
  } catch (e) {
    logErro(`Auditoria falhou (não bloqueia): ${sanitizar(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Criptografia (compatível 1:1 com src/backup/api.server.ts)
// ---------------------------------------------------------------------------
function descriptografar(blob) {
  const partes = String(blob ?? "").split(":");
  if (partes.length !== 4 || partes[0] !== "v1") return null;
  const [, ivB64, tagB64, dadoB64] = partes;
  const chave = createHash("sha256").update(`jva-backup::${CRYPTO_KEY}`).digest();
  try {
    const decifra = createDecipheriv("aes-256-gcm", chave, Buffer.from(ivB64, "base64"));
    decifra.setAuthTag(Buffer.from(tagB64, "base64"));
    const dados = Buffer.concat([decifra.update(Buffer.from(dadoB64, "base64")), decifra.final()]);
    return dados.toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function versaoPgDump() {
  return execFileSync("pg_dump", ["--version"], { encoding: "utf8" }).trim();
}

function slug(valor) {
  const limpo = String(valor ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return limpo || "instancia";
}

/** Padrão: cliente_instancia_YYYYMMDD_HHMMSS.dump (carimbo UTC do job). */
function nomeArquivoBackup(instanceNome, criadoEm) {
  const fonte = new Date(criadoEm ?? new Date().toISOString());
  const stampe = Number.isNaN(fonte.getTime()) ? new Date() : fonte;
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${stampe.getUTCFullYear()}${pad(stampe.getUTCMonth() + 1)}${pad(stampe.getUTCDate())}` +
    `_${pad(stampe.getUTCHours())}${pad(stampe.getUTCMinutes())}${pad(stampe.getUTCSeconds())}`;
  return `${slug(instanceNome)}_${stamp}.dump`;
}

function sha256Arquivo(caminho) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const fluxo = fs.createReadStream(caminho);
    fluxo.on("data", (bloco) => hash.update(bloco));
    fluxo.on("error", reject);
    fluxo.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Inventário estrutural do dump (pg_restore --list):
 * total de entradas, distribuição por tipo de objeto e schemas presentes.
 */
function inventarioDoDump(caminhoDump) {
  const toc = execFileSync("pg_restore", ["--list", caminhoDump], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const porTipo = new Map();
  const schemas = new Set();
  let entradas = 0;
  for (const linha of toc.split("\n")) {
    // Formato: "<id>; <seção> <oid> <TIPO> <schema> <nome> <dono> <..."
    const m = /^(\d+);\s+(\d+)\s+(\d+)\s+([A-Z][A-Z _]+)\s+([^\s]+)\s+([^\s]+)/.exec(linha);
    if (!m) continue;
    entradas++;
    const tipo = m[4].trim();
    const schema = m[5];
    porTipo.set(tipo, (porTipo.get(tipo) ?? 0) + 1);
    if (schema !== "-") schemas.add(schema);
  }
  return { entradas, porTipo: Object.fromEntries(porTipo), schemas: Array.from(schemas) };
}

function falhaDeConexao(mensagem) {
  return /(ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|could not connect|connection refused|no pg_hba)/i.test(
    mensagem,
  );
}

/** Baixa o .dump do bucket privado para o diretório temporário (service auth). */
async function baixarDump(arquivo, dirTemp) {
  const caminho = path.join(dirTemp, arquivo.nome_arquivo);
  const url = `${SB_URL}/storage/v1/object/backups/${arquivo.storage_path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  execFileSync(
    "curl",
    ["-sf", url, "-H", `Authorization: Bearer ${SB_KEY}`, "-H", `apikey: ${SB_KEY}`, "-o", caminho],
    { timeout: TIMEOUT_DOWNLOAD_MS, stdio: ["ignore", "ignore", "pipe"] },
  );
  const stat = fs.statSync(caminho);
  if (stat.size === 0) throw new Error("Download do .dump retornou arquivo vazio.");
  return { caminho, tamanho: stat.size, stat };
}

/** Consulta somente-leitura no destino (psql), sempre com senha em env. */
function psqlConsulta(instancia, senha, sql) {
  const saida = execFileSync(
    "psql",
    [
      "-h",
      String(instancia.db_host),
      "-p",
      String(instancia.db_port),
      "-U",
      String(instancia.db_user),
      "-d",
      String(instancia.db_name),
      "-At",
      "-F",
      "\t",
      "-c",
      sql,
    ],
    {
      env: { ...process.env, PGPASSWORD: senha },
      timeout: TIMEOUT_SQL_MS,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return saida.trim();
}

/**
 * Inventário detalhado do dump por schema (para o precheck):
 * nº de tabelas (estrutura), nº de TABLE DATA (dados) e nomes das tabelas.
 */
function objetosDoDump(caminhoDump) {
  const toc = execFileSync("pg_restore", ["--list", caminhoDump], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const porSchema = new Map();

  function caixa(schema) {
    if (!porSchema.has(schema)) {
      porSchema.set(schema, { tabelas: 0, dados: 0, outros: 0, nomes_tabelas: [] });
    }
    return porSchema.get(schema);
  }

  for (const linha of toc.split("\n")) {
    // "215; 1259 16386 TABLE public clientes ..." | "... TABLE DATA public dados ..."
    const m = /^(\d+);\s+\d+\s+\d+\s+(TABLE DATA|TABLE|[A-Z][A-Z _]*?)\s+([^\s]+)\s+([^\s]+)/.exec(
      linha,
    );
    if (!m) continue;
    const tipo = m[2].trim();
    const schema = m[3];
    const nome = m[4];
    if (tipo === "TABLE") {
      const c = caixa(schema);
      c.tabelas += 1;
      c.nomes_tabelas.push(nome);
    } else if (tipo === "TABLE DATA") {
      caixa(schema).dados += 1;
    } else {
      caixa(schema).outros += 1;
    }
  }

  const convertido = {};
  for (const [schema, c] of porSchema) {
    convertido[schema] = {
      tabelas: c.tabelas,
      dados: c.dados,
      outros: c.outros,
      nomes_tabelas: c.nomes_tabelas,
    };
  }
  return { porSchema: convertido };
}

// ---------------------------------------------------------------------------
// Processamento de um job
// ---------------------------------------------------------------------------
async function processarJob(job) {
  log(`Job ${job.id} — início`);
  const passos = [];
  const passo = async (texto) => {
    passos.push(`[${new Date().toISOString().slice(11, 19)}] ${texto}`);
    log(texto);
    // Persiste o log no job (visível no painel em tempo quase real)
    try {
      await dbUpdate("backup_jobs", { log_execucao: passos.join("\n") }, `id=eq.${job.id}`);
    } catch (e) {
      logErro(`Falha ao gravar log_execucao do job: ${sanitizar(e)}`);
    }
  };
  await passo(`Job recebido pela fila (tentativa ${job.tentativas ?? 1}/${job.max_tentativas ?? 2}).`);
  const instancias = await dbSelect("backup_instances", {
    id: `eq.${job.instance_id}`,
    select: "*",
    limit: "1",
  });
  const instancia = instancias?.[0];
  if (!instancia) {
    await finalizarFalha(job, "Instância não encontrada.");
    return;
  }
  if (!instancia.ativo) {
    await finalizarFalha(job, "Instância desativada — backup não executado.");
    return;
  }

  const senha = descriptografar(instancia.credencial_cripto);
  if (!senha) {
    await finalizarFalha(
      job,
      "CREDENCIAL_INDECIFRAVEL: a senha armazenada não pôde ser decifrada (BACKUP_CRYPTO_KEY alterada?). Recrie a credencial no painel.",
    );
    return;
  }

  const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), "jva-backup-"));
  try {
    const nomeArquivo = nomeArquivoBackup(instancia.nome, job.criado_em);
    const caminhoDump = path.join(dirTemp, nomeArquivo);

    // Destino no bucket: prefixo configurável da instância (fallback project_ref)
    const destinoBase = String(instancia.storage_prefix ?? "").trim() || instancia.project_ref;

    await passo(
      `Conectando em ${instancia.db_host}:${instancia.db_port}/${instancia.db_name} (destino do dump: backups/${destinoBase}/)`,
    );

    // 1. pg_dump — senha via PGPASSWORD (env), nunca no argv do processo
    const versao = versaoPgDump();
    log(`pg_dump: ${versao}`);
    await passo(`pg_dump iniciando (${versao.split(" ").slice(0, 2).join(" ")})`);
    execFileSync(
      "pg_dump",
      [
        "--format=custom",
        "--no-owner",
        "--no-acl",
        "--host",
        String(instancia.db_host),
        "--port",
        String(instancia.db_port),
        "--username",
        String(instancia.db_user),
        "--dbname",
        String(instancia.db_name),
        "--file",
        caminhoDump,
      ],
      {
        env: { ...process.env, PGPASSWORD: senha },
        timeout: TIMEOUT_PG_DUMP_MS,
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    const stat = fs.statSync(caminhoDump);
    if (stat.size === 0) throw new Error("pg_dump produziu arquivo vazio.");
    await passo(`pg_dump concluído — arquivo com ${stat.size} bytes`);

    // 2. Estado validando: após gerar o dump, entra em fase de validação
    await dbUpdate("backup_jobs", { status: "validando" }, `id=eq.${job.id}`);

    // 3. Validação estrutural + inventário
    const inventario = inventarioDoDump(caminhoDump);
    log(`Dump íntegro: ${inventario.entradas} entradas; schemas: ${inventario.schemas.join(", ")}`);
    await passo(
      `Validei integridade estrutural: ${inventario.entradas} entradas (${inventario.schemas.length} schemas)`,
    );

    // 4. Checksum + tamanho
    const sha256 = await sha256Arquivo(caminhoDump);
    await passo(`SHA-256 calculado: ${sha256}`);

    // 5. Upload ao bucket privado 'backups' (segredos só no header)
    const storagePath = `${destinoBase}/${nomeArquivo}`;
    execFileSync(
      "curl",
      [
        "-sf",
        "-X",
        "POST",
        `${SB_URL}/storage/v1/object/backups/${storagePath
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        "-H",
        `Authorization: Bearer ${SB_KEY}`,
        "-H",
        `apikey: ${SB_KEY}`,
        "-H",
        "Content-Type: application/octet-stream",
        "--data-binary",
        `@${caminhoDump}`,
      ],
      { timeout: TIMEOUT_UPLOAD_MS, stdio: ["ignore", "ignore", "pipe"] },
    );
    log(`Upload concluído: backups/${storagePath}`);
    await passo(`Upload concluído no bucket privado: backups/${storagePath}`);

    // 6. Registro do arquivo (audit: origem já cobre 'worker')
    const arquivo = await dbInsert("backup_files", {
      instance_id: instancia.id,
      job_id: job.id,
      nome_arquivo: nomeArquivo,
      storage_path: storagePath,
      tamanho_bytes: stat.size,
      sha256,
      tipo: job.tipo === "automatico" ? "automatico" : "manual",
      validado: true,
      validado_em: new Date().toISOString(),
      inventario: {
        entradas: inventario.entradas,
        porTipo: inventario.porTipo,
        schemas: inventario.schemas,
        versao_pg_dump: versao,
      },
    });
    await passo(`Arquivo registrado (backup_files ${arquivo.id.slice(0, 8)}…).`);

    // 7. Conclui o job
    const inicioMs = Date.parse(job.iniciado_em ?? job.criado_em ?? "") || Date.now();
    const duracaoSeg = Math.max(0, Math.round((Date.now() - inicioMs) / 1000));
    await dbUpdate(
      "backup_jobs",
      {
        status: "concluido",
        arquivo_id: arquivo.id,
        versao_pg_dump: versao,
        finalizado_em: new Date().toISOString(),
        erro: null,
        duracao_seg: duracaoSeg,
        log_execucao: passos.join("\n"),
      },
      `id=eq.${job.id}`,
    );

    // 8. Instância: último backup + conectividade OK
    await dbUpdate(
      "backup_instances",
      { ultimo_backup_em: new Date().toISOString(), status_conexao: "ok", status_detalhe: null },
      `id=eq.${instancia.id}`,
    );

    // 9. Agendamento (executor programado): contadores + próxima execução
    if (job.schedule_id) await atualizarSnapshotAgendamento(job.schedule_id, true);

    // 10. Retenção: removida a cópia anterior JÁ confirmada a nova integridade
    if (job.tipo === "automatico") await aplicarRetencao(instancia.id);

    await auditoria("backup.concluido", instancia.id, {
      job_id: job.id,
      arquivo_id: arquivo.id,
      tamanho_bytes: stat.size,
      sha256,
      entradas_inventario: inventario.entradas,
    });
    log(
      `Job ${job.id} — concluído em ${duracaoSeg}s (${stat.size} bytes, sha256 ${sha256.slice(0, 12)}…)`,
    );
  } catch (erro) {
    let mensagem = sanitizar(erro?.message ?? String(erro)).slice(0, 800);
    if (mensagem.includes("server version mismatch")) {
      mensagem += " — O pg_dump do worker é mais antigo que o servidor. O workflow "
        + "backup-worker.yml sobe o cliente PostgreSQL via pgdg; confira se o job "
        + "executou o passo 'Garantir PostgreSQL Client 17' e se o pg_dump é da versão "
        + "igual/superior à do servidor (busque 'pg_dump: detail: server version').";
    }
    logErro(`Job ${job.id} falhou: ${mensagem}`);
    passos.push(`[FALHA] ${mensagem}`);

    if (falhaDeConexao(mensagem)) {
      try {
        await dbUpdate(
          "backup_instances",
          { status_conexao: "falha", status_detalhe: mensagem.slice(0, 400) },
          `id=eq.${instancia.id}`,
        );
      } catch (e2) {
        logErro(`Falha ao atualizar status da instância: ${sanitizar(e2)}`);
      }
    }
    if (job.schedule_id) {
      try {
        await atualizarSnapshotAgendamento(job.schedule_id, false);
      } catch (e) {
        logErro(`Falha ao atualizar agendamento: ${sanitizar(e)}`);
      }
    }
    await finalizarFalha(job, mensagem);
  } finally {
    try {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

async function finalizarFalha(job, mensagemSanitizada) {
  const reenfileira = (job.tentativas ?? 1) < (job.max_tentativas ?? 2);
  await dbUpdate(
    "backup_jobs",
    reenfileira
      ? { status: "pendente", erro: mensagemSanitizada, lease_expirar: null }
      : {
          status: "falha",
          erro: mensagemSanitizada,
          finalizado_em: new Date().toISOString(),
          lease_expirar: null,
        },
    `id=eq.${job.id}`,
  );
  // Anexa a falha ao log (se existir coluna log_execucao)
  try {
    const atuais = await dbSelect("backup_jobs", {
      id: `eq.${job.id}`,
      select: "log_execucao",
      limit: "1",
    });
    if (atuais?.length) {
      const base = atuais[0].log_execucao ? `${atuais[0].log_execucao}\n` : "";
      await dbUpdate(
        "backup_jobs",
        { log_execucao: `${base}[FALHA] ${mensagemSanitizada}`.slice(0, 12000) },
        `id=eq.${job.id}`,
      );
    }
  } catch {
    // coluna pode não existir ainda — sem bloqueio
  }
  await auditoria("backup.falha", job.instance_id, {
    job_id: job.id,
    erro: mensagemSanitizada.slice(0, 400),
    reenfileirado: reenfileira,
  });
}

/**
 * Snapshot do agendamento após conclusão ou falha:
 * contadores, último resultado e próxima execução calculada no fuso.
 */
async function atualizarSnapshotAgendamento(scheduleId, sucesso) {
  const linhas = await dbSelect("backup_schedules", {
    id: `eq.${scheduleId}`,
    select: "*",
    limit: "1",
  });
  const sched = linhas?.[0];
  if (!sched) return;

  const { data: proxima } = await dbRpc("backup_proxima_execucao", {
    p_frequencia: sched.frequencia,
    p_dia_semana: sched.dia_semana ?? null,
    p_dia_mes: sched.dia_mes ?? null,
    p_hora: sched.hora,
    p_fuso: sched.fuso,
  });

  await dbUpdate(
    "backup_schedules",
    {
      ultima_execucao_em: new Date().toISOString(),
      proxima_execucao: proxima ?? null,
      ultimo_resultado: sucesso ? "concluido" : "falha",
      falhas_consecutivas: sucesso ? 0 : (sched.falhas_consecutivas ?? 0) + 1,
      total_backups: sucesso ? (sched.total_backups ?? 0) + 1 : (sched.total_backups ?? 0),
    },
    `id=eq.${scheduleId}`,
  );
}

/**
 * Retenção (padrão 30 dias; configurável no agendamento):
 *   • apaga APENAS arquivos 'automatico' mais antigos que retencao_dias;
 *   • NUNCA apaga o arquivo válido mais recente da instância;
 *   • nunca apaga backups 'seguranca' (restauração, FASE 7) nem 'manual'.
 */
async function aplicarRetencao(instanceId) {
  const linhas = await dbSelect("backup_schedules", {
    instance_id: `eq.${instanceId}`,
    select: "retencao_dias",
    limit: "1",
  });
  const retencaoDias = linhas?.[0]?.retencao_dias ?? 30;
  const cutoff = new Date(Date.now() - retencaoDias * 86_400_000).toISOString();

  const arquivos = await dbSelect("backup_files", {
    instance_id: `eq.${instanceId}`,
    tipo: "eq.automatico",
    validado: "eq.true",
    select: "id,storage_path,nome_arquivo,criado_em",
    order: "criado_em.desc",
    limit: String(LIMITE_ARQUIVOS_POR_LOOP),
  });
  if (!arquivos?.length) return;

  for (const arquivo of arquivos.slice(1)) {
    // arquivos[0] = mais recente — jamais segue para exclusão
    if ((arquivo.criado_em ?? "") >= cutoff) continue;
    try {
      await removerDoStorage(arquivo.storage_path);
      await dbDelete("backup_files", `id=eq.${arquivo.id}`);
      log(`Retenção: excluído ${arquivo.nome_arquivo} (criado em ${arquivo.criado_em})`);
      await auditoria("backup.retencao", instanceId, {
        arquivo_id: arquivo.id,
        nome_arquivo: arquivo.nome_arquivo,
      });
    } catch (e) {
      logErro(`Retenção falhou para ${arquivo.nome_arquivo}: ${sanitizar(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// FASE 6 — DISPENSADOR DOS AGENDAMENTOS
// Cria backup_jobs automáticos para agendamentos vencidos e avança
// proxima_execucao (p_a_partir = agora — disparos perdidos são pulados).
// ---------------------------------------------------------------------------
async function avancarProxima(sched) {
  const { data: proxima } = await dbRpc("backup_proxima_execucao", {
    p_frequencia: sched.frequencia,
    p_dia_semana: sched.dia_semana ?? null,
    p_dia_mes: sched.dia_mes ?? null,
    p_hora: sched.hora,
    p_fuso: sched.fuso,
    p_a_partir: new Date().toISOString(),
  });
  if (proxima) {
    await dbUpdate("backup_schedules", { proxima_execucao: proxima }, `id=eq.${sched.id}`);
  }
  return proxima ?? null;
}

async function dispararAgendamentos() {
  const scheds = await dbSelect("backup_schedules", {
    ativo: "eq.true",
    select: "*",
    limit: "200",
  });
  if (!scheds?.length) return 0;
  const agora = Date.now();
  let disparados = 0;
  for (const sched of scheds) {
    try {
      if (!sched.proxima_execucao) {
        // Primeira configuração: apenas calcula a próxima execução
        await avancarProxima(sched);
        continue;
      }
      if (new Date(sched.proxima_execucao).getTime() > agora) continue;

      const linhas = await dbSelect("backup_instances", {
        id: `eq.${sched.instance_id}`,
        select: "*",
        limit: "1",
      });
      const instancia = linhas?.[0];
      if (!instancia || !instancia.ativo || !instancia.credencial_ok) {
        await avancarProxima(sched);
        log(
          `Agendamento pulado — instância ${instancia?.nome ?? sched.instance_id} inativa ou sem credencial.`,
        );
        await auditoria("agendamento.pulado", sched.instance_id, { schedule_id: sched.id });
        continue;
      }

      // Não empilhar jobs: se a instância já tem operação em andamento, só avança
      const em = await dbSelect("backup_jobs", {
        instance_id: `eq.${sched.instance_id}`,
        status: "in.(pendente,executando,validando)",
        select: "id",
        limit: "1",
      });
      await avancarProxima(sched);
      if (em?.length) continue;

      await dbInsert("backup_jobs", {
        instance_id: sched.instance_id,
        schedule_id: sched.id,
        tipo: "automatico",
        status: "pendente",
        criado_por: "agendamento",
      });
      disparados++;
      log(`Backup automático enfileirado para ${instancia.nome}.`);
      await auditoria("backup.agendado", sched.instance_id, { schedule_id: sched.id });
    } catch (e) {
      logErro(`Dispatch do agendamento ${sched.id ?? ""} falhou: ${sanitizar(e)}`);
    }
  }
  if (disparados > 0) log(`Agendamentos disparados nesta execução: ${disparados}.`);
  return disparados;
}

// ---------------------------------------------------------------------------
// FASE 7 — RESTAURAÇÃO ENTRE INSTÂNCIAS
// duas etapas no worker:
//   precheck  → baixa o dump, valida SHA-256, inventoria e sonda o destino;
//               grava restore_jobs.precheck e para em 'aguardando_confirmacao'.
//   execução  → (após confirmação admin) backup de segurança do destino,
//               pg_restore --clean --if-exists limitado por schema (Modo A) ou
//               excluzo dos schemas gerenciados (Modo B) e validação pós.
// ---------------------------------------------------------------------------
function agoraLog() {
  return new Date().toISOString().slice(11, 19);
}

async function carregarContexto(job) {
  const arquivoLinhas = await dbSelect("backup_files", {
    id: `eq.${job.backup_file_id}`,
    select: "*",
    limit: "1",
  });
  const arquivo = arquivoLinhas?.[0];
  if (!arquivo) throw new Error("Arquivo de backup não encontrado.");
  if (!arquivo.validado) throw new Error("O arquivo de backup ainda não foi validado.");
  const destinoLinhas = await dbSelect("backup_instances", {
    id: `eq.${job.destino_instance_id}`,
    select: "*",
    limit: "1",
  });
  const destino = destinoLinhas?.[0];
  if (!destino) throw new Error("Instância de destino não encontrada.");
  if (!destino.ativo || !destino.credencial_ok) {
    throw new Error("Instância de destino inativa ou sem credencial cadastrada.");
  }
  if (destino.id === job.origem_instance_id) {
    throw new Error("O destino precisa ser diferente da origem do backup.");
  }
  return { arquivo, destino };
}

async function processarPrecheck(job) {
  log(`Precheck de restauração ${job.id} — início`);
  let dirTemp = null;
  try {
    const { arquivo, destino } = await carregarContexto(job);

    // Blindagem duplicada (o painel também valida): schemas gerenciados nunca
    const alvos = (job.schemas_alvo ?? []).filter(Boolean);
    const proibidos = alvos.filter((s) => SCHEMAS_GERENCIADOS.includes(String(s).toLowerCase()));
    if (job.modo === "aplicacao") {
      if (proibidos.length > 0) {
        throw new Error(
          `Schemas gerenciados jamais são restaurados por cima: ${proibidos.join(", ")}.`,
        );
      }
      // Sem schemas ainda é válido: o precheck lista o que existe no dump
      // para o admin selecionar antes de confirmar.
    }

    dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), "jva-precheck-"));

    // 1. Download + integridade (SHA-256 do storage contra registro)
    const { caminho } = await baixarDump(arquivo, dirTemp);
    const shaLocal = await sha256Arquivo(caminho);
    if (arquivo.sha256 && shaLocal !== arquivo.sha256) {
      throw new Error(
        `Integridade: SHA-256 divergente (registro ${arquivo.sha256.slice(0, 12)}…, local ${shaLocal.slice(0, 12)}…).`,
      );
    }

    // 2. Inventário do dump
    const dump = objetosDoDump(caminho);
    const nomeSchemasDump = Object.keys(dump.porSchema);

    // 3. Sonda o destino (espera senha do próprio destino para conectar)
    const senha = descriptografar(destino.credencial_cripto);
    if (!senha) {
      throw new Error(
        "CREDENCIAL_INDECIFRAVEL: a senha do destino não pôde ser decifrada. Recadastre a credencial.",
      );
    }
    const sqlSchemas =
      "SELECT n.nspname || chr(9) || count(c.oid) FROM pg_namespace n " +
      "LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r' " +
      "WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' " +
      "GROUP BY n.nspname ORDER BY n.nspname;";
    const sqlTabelas =
      "SELECT n.nspname || '.' || c.relname FROM pg_class c " +
      "JOIN pg_namespace n ON n.oid = c.relnamespace " +
      "WHERE c.relkind = 'r' AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema';";
    const destinoRaw = psqlConsulta(destino, senha, sqlSchemas);
    const destinoSchemas = {};
    for (const linha of destinoRaw.split("\n")) {
      if (!linha) continue;
      const [schema, total] = linha.split("\t");
      destinoSchemas[schema] = Number(total) || 0;
    }
    const destinoTabelas = psqlConsulta(destino, senha, sqlTabelas).split("\n").filter(Boolean);

    // 4. Conflitos: tabelas do dump que já existem no destino (serão trocadas)
    const tabelaNoDestino = new Set(destinoTabelas);
    const schemasAvaliados =
      job.modo === "aplicacao"
        ? alvos
        : nomeSchemasDump.filter((s) => !SCHEMAS_GERENCIADOS.includes(s));
    const conflitos = [];
    for (const schema of schemasAvaliados) {
      const info = dump.porSchema[schema];
      if (!info) continue;
      const presentes = info.nomes_tabelas.filter((nome) =>
        tabelaNoDestino.has(`${schema}.${nome}`),
      );
      const tabelasDestino = destinoSchemas[schema] ?? 0;
      if (presentes.length > 0 || tabelasDestino > 0) {
        conflitos.push({
          schema,
          tabelas_no_dump: info.tabelas,
          tabelas_no_destino: tabelasDestino,
          tabelas_substituidas: presentes,
        });
      }
    }

    // 5. Avisos que o admin precisa ler antes de confirmar
    const avisos = [];
    const gerenciadosNoDump = nomeSchemasDump.filter((s) => SCHEMAS_GERENCIADOS.includes(s));
    if (gerenciadosNoDump.length > 0) {
      avisos.push(
        `O dump contém schemas gerenciados (${gerenciadosNoDump.join(", ")}) — eles são IGNORADOS na restauração; auth/storage do destino permanecem intactos.`,
      );
    }
    if (conflitos.length > 0) {
      avisos.push(
        "Há tabelas com o mesmo nome no destino: elas serão APAGADAS e recriadas (--clean --if-exists limitado aos schemas do job).",
      );
    }
    if (job.modo === "migracao") {
      avisos.push(
        "Modo B (migração): restaura TODOS os objetos fora dos schemas gerenciados. Auth (usuários/sessões) e Storage (arquivos) do destino permanecem os atuais.",
      );
    }
    avisos.push(
      "Um backup de segurança do destino será criado automaticamente ANTES da restauração.",
    );

    if (job.modo === "aplicacao") {
      for (const schema of alvos) {
        if (!dump.porSchema[schema]) {
          throw new Error(
            `Schema "${schema}" não existe no dump; schemas disponíveis: ${nomeSchemasDump.join(", ")}.`,
          );
        }
      }
    }

    const precheck = {
      gerado_em: new Date().toISOString(),
      arquivo: {
        nome_arquivo: arquivo.nome_arquivo,
        criado_em: arquivo.criado_em,
        tamanho_bytes: arquivo.tamanho_bytes,
        sha256: arquivo.sha256,
      },
      destino: {
        nome: destino.nome,
        project_ref: destino.project_ref,
        schemas: destinoSchemas,
      },
      dump: {
        schemas: nomeSchemasDump.map((s) => ({
          nome: s,
          gerenciado: SCHEMAS_GERENCIADOS.includes(s),
          ...dump.porSchema[s],
        })),
      },
      schemas_alvo: job.modo === "aplicacao" ? alvos : [],
      modo: job.modo,
      conflitos,
      avisos,
      ok: true,
    };

    await dbUpdate(
      "restore_jobs",
      { status: "aguardando_confirmacao", precheck },
      `id=eq.${job.id}`,
    );
    log(`Precheck ${job.id} concluído — aguardando confirmação admin.`);
    await auditoria("restore.precheck", destino.id, { restore_job_id: job.id, ok: true });
  } catch (e) {
    const mensagem = sanitizar(e?.message ?? String(e)).slice(0, 800);
    logErro(`Precheck ${job.id} falhou: ${mensagem}`);
    try {
      await dbUpdate(
        "restore_jobs",
        { status: "falha_precheck", erro: mensagem },
        `id=eq.${job.id}`,
      );
    } catch (e2) {
      logErro(`Falha ao marcar falha_precheck: ${sanitizar(e2)}`);
    }
    await auditoria("restore.precheck", job.destino_instance_id ?? null, {
      restore_job_id: job.id,
      ok: false,
      erro: mensagem.slice(0, 400),
    });
  } finally {
    if (dirTemp) {
      try {
        fs.rmSync(dirTemp, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }
}

async function processarExecucaoRestore(job) {
  log(`Restauração ${job.id} — início`);
  const dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), "jva-restore-"));
  const passos = [];
  const paso = (texto) => {
    passos.push(`[${agoraLog()}] ${texto}`);
    log(texto);
  };
  const inicioMs = Date.now();
  try {
    const { arquivo, destino } = await carregarContexto(job);
    if (!job.confirmado_em)
      throw new Error("Restauração sem confirmação administrativa registrada.");

    const senhaDestino = descriptografar(destino.credencial_cripto);
    if (!senhaDestino) {
      throw new Error(
        "CREDENCIAL_INDECIFRAVEL: senha do destino não decifrou. Recadastre a credencial.",
      );
    }
    const alvos = (job.schemas_alvo ?? []).filter(Boolean);
    if (job.modo === "aplicacao" && alvos.length === 0) {
      throw new Error("Modo A (aplicação) exige ao menos um schema alvo.");
    }

    const agoraMarc = (base) => {
      const d = new Date(base ?? new Date().toISOString());
      const pad = (n) => String(n).padStart(2, "0");
      return (
        `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
      );
    };

    // -----------------------------------------------------------------
    // 1. BACKUP DE SEGURANÇA DO DESTINO — obrigatório antes de qualquer troca
    // -----------------------------------------------------------------
    paso(`Backup de segurança do destino "${destino.nome}" iniciando`);
    const nomeSeg = `${slug(destino.nome)}_seguranca_${agoraMarc()}.dump`;
    const caminhoSeg = path.join(dirTemp, nomeSeg);
    const argsSeg = [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--host",
      String(destino.db_host),
      "--port",
      String(destino.db_port),
      "--username",
      String(destino.db_user),
      "--dbname",
      String(destino.db_name),
      "--file",
      caminhoSeg,
    ];
    if (job.modo === "aplicacao") {
      // só os schemas que serão substituídos
      for (const schema of alvos) argsSeg.push("--schema", schema);
    }
    execFileSync("pg_dump", argsSeg, {
      env: { ...process.env, PGPASSWORD: senhaDestino },
      timeout: TIMEOUT_PG_DUMP_MS,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const statSeg = fs.statSync(caminhoSeg);
    if (statSeg.size === 0)
      throw new Error("Backup de segurança do destino saiu vazio — restauração abortada.");
    const shaSeg = await sha256Arquivo(caminhoSeg);
    const inventarioSeg = inventarioDoDump(caminhoSeg);
    const pathSeg = `${String(destino.storage_prefix ?? "").trim() || destino.project_ref}/seguranca/${nomeSeg}`;
    execFileSync(
      "curl",
      [
        "-sf",
        "-X",
        "POST",
        `${SB_URL}/storage/v1/object/backups/${pathSeg
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        "-H",
        `Authorization: Bearer ${SB_KEY}`,
        "-H",
        `apikey: ${SB_KEY}`,
        "-H",
        "Content-Type: application/octet-stream",
        "--data-binary",
        `@${caminhoSeg}`,
      ],
      { timeout: TIMEOUT_UPLOAD_MS, stdio: ["ignore", "ignore", "pipe"] },
    );
    const arquivoSeguranca = await dbInsert("backup_files", {
      instance_id: destino.id,
      job_id: null,
      nome_arquivo: nomeSeg,
      storage_path: pathSeg,
      tamanho_bytes: statSeg.size,
      sha256: shaSeg,
      tipo: "seguranca",
      validado: true,
      validado_em: new Date().toISOString(),
      inventario: {
        entradas: inventarioSeg.entradas,
        porTipo: inventarioSeg.porTipo,
        schemas: inventarioSeg.schemas,
        escopo: job.modo === "aplicacao" ? alvos : "completo-do-destino",
      },
    });
    paso(`Backup de segurança concluído: ${nomeSeg} (${statSeg.size} bytes)`);
    await dbUpdate("restore_jobs", { backup_seguranca_id: arquivoSeguranca.id }, `id=eq.${job.id}`);

    // -----------------------------------------------------------------
    // 2. Download do dump de origem + conferência de integridade
    // -----------------------------------------------------------------
    paso(`Download do backup de origem: ${arquivo.nome_arquivo}`);
    const { caminho } = await baixarDump(arquivo, dirTemp);
    const shaLocal = await sha256Arquivo(caminho);
    if (arquivo.sha256 && shaLocal !== arquivo.sha256) {
      throw new Error(
        `Integridade: SHA-256 divergente (registro ${arquivo.sha256.slice(0, 12)}…, local ${shaLocal.slice(0, 12)}…).`,
      );
    }
    paso("Digest SHA-256 conferido — arquivo íntegro");

    // -----------------------------------------------------------------
    // 3. pg_restore — SEM --create; --clean apenas no escopo permitido
    // -----------------------------------------------------------------
    paso(
      `pg_restore iniciando (modo ${job.modo === "aplicacao" ? "A · aplicação" : "B · migração"})`,
    );
    const argsRestore = [
      "--no-owner",
      "--no-acl",
      "--clean",
      "--if-exists",
      "--host",
      String(destino.db_host),
      "--port",
      String(destino.db_port),
      "--username",
      String(destino.db_user),
      "--dbname",
      String(destino.db_name),
    ];
    if (job.modo === "aplicacao") {
      for (const schema of alvos) {
        if (SCHEMAS_GERENCIADOS.includes(String(schema).toLowerCase())) {
          throw new Error(`Blindagem: schema gerenciado "${schema}" na lista de alvo.`);
        }
        argsRestore.push(`--schema=${schema}`);
      }
    } else {
      for (const schema of SCHEMAS_GERENCIADOS) argsRestore.push(`--exclude-schema=${schema}`);
    }
    argsRestore.push(caminho);

    try {
      execFileSync("pg_restore", argsRestore, {
        env: { ...process.env, PGPASSWORD: senhaDestino },
        timeout: TIMEOUT_PG_RESTORE_MS,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      paso("pg_restore concluído com sucesso");
    } catch (e) {
      const visor = String(e?.stderr ?? e?.message ?? "")
        .split("\n")
        .slice(-12)
        .join(" | ");
      throw new Error(`pg_restore reportou erro: ${sanitizar(visor).slice(0, 600)}`);
    }

    // -----------------------------------------------------------------
    // 4. Validação pós-restore (contagens por schema no destino)
    // -----------------------------------------------------------------
    paso("Validando contagens de tabelas no destino");
    await dbUpdate(
      "restore_jobs",
      { status: "validando", log_execucao: passos.join("\n") },
      `id=eq.${job.id}`,
    );
    const sqlSchemas =
      "SELECT n.nspname || chr(9) || count(c.oid) FROM pg_namespace n " +
      "LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r' " +
      "WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema' " +
      "GROUP BY n.nspname ORDER BY n.nspname;";
    const destinoDepois = {};
    for (const linha of psqlConsulta(destino, senhaDestino, sqlSchemas).split("\n")) {
      if (!linha) continue;
      const [schema, total] = linha.split("\t");
      destinoDepois[schema] = Number(total) || 0;
    }
    paso(`Tabelas no destino após a restauração: ${JSON.stringify(destinoDepois)}`);

    const duracaoSeg = Math.round((Date.now() - inicioMs) / 1000);
    await dbUpdate(
      "restore_jobs",
      {
        status: "concluido",
        finalizado_em: new Date().toISOString(),
        duracao_seg: duracaoSeg,
        log_execucao: passos.join("\n"),
        erro: null,
      },
      `id=eq.${job.id}`,
    );
    log(`Restauração ${job.id} — concluída em ${duracaoSeg}s`);
    await auditoria("restore.concluido", destino.id, {
      restore_job_id: job.id,
      modo: job.modo,
      backup_seguranca_id: arquivoSeguranca.id,
      duracao_seg: duracaoSeg,
    });
  } catch (e) {
    const mensagem = sanitizar(e?.message ?? String(e)).slice(0, 800);
    logErro(`Restauração ${job.id} falhou: ${mensagem}`);
    try {
      await dbUpdate(
        "restore_jobs",
        {
          status: "falha",
          erro: mensagem,
          finalizado_em: new Date().toISOString(),
          duracao_seg: Math.round((Date.now() - inicioMs) / 1000),
          log_execucao: passos.join("\n"),
        },
        `id=eq.${job.id}`,
      );
    } catch (e2) {
      logErro(`Falha ao marcar restore_jobs falha: ${sanitizar(e2)}`);
    }
    await auditoria("restore.falha", job.destino_instance_id ?? null, {
      restore_job_id: job.id,
      erro: mensagem.slice(0, 400),
    });
  } finally {
    try {
      fs.rmSync(dirTemp, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function principal() {
  if (!SB_URL || !SB_KEY) {
    logErro(
      "Secrets ausentes: defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no job do GitHub Actions.",
    );
    process.exitCode = 1;
    return;
  }
  if (!CRYPTO_KEY) {
    logErro(
      "Secret ausente: defina BACKUP_CRYPTO_KEY (a mesma do Vercel) para decifrar credenciais.",
    );
    process.exitCode = 1;
    return;
  }

  log(`Worker iniciado (${versaoPgDump()}; até ${LIMITE_JOBS_POR_RUN} backup(s)/run)`);

  // 1. Recupera leases travados (worker que morreu antes de concluir)
  try {
    const recuperados = await dbRpc("backup_recuperar_leases_expirados", {});
    if (recuperados) {
      log(
        `Leases expirados: reenfileirados backup=${recuperados.reenfileirados_backup ?? 0}, restauração=${recuperados.reenfileirados_restauracao ?? 0}`,
      );
    }
  } catch (e) {
    logErro(`Recuperação de leases falhou: ${sanitizar(e)}`);
  }

  // 2. Dispensa agendamentos vencidos (FASE 6 — backups automáticos)
  let agendadosDisparados = 0;
  try {
    agendadosDisparados = await dispararAgendamentos();
  } catch (e) {
    logErro(`Dispatcher de agendamentos falhou: ${sanitizar(e)}`);
  }

  // 3. Processa backups manuais/automáticos pendentes (com lease atômico)
  let processados = 0;
  for (;;) {
    if (processados >= LIMITE_JOBS_POR_RUN) break;
    const reivindicados = await dbRpc("backup_reivindicar_job", { p_lease_minutos: 120 });
    const job = Array.isArray(reivindicados) ? reivindicados[0] : null;
    if (!job) break;
    processados++;
    await processarJob(job);
  }

  // 4. Prechecks de restauração (FASE 7 — etapa não-destrutiva)
  let prechecks = 0;
  for (;;) {
    if (prechecks >= LIMITE_PRECHECKS_POR_RUN) break;
    const reivindicados = await dbRpc("restore_reivindicar_job", {
      p_status: "pendente_precheck",
      p_lease_minutos: 120,
    });
    const job = Array.isArray(reivindicados) ? reivindicados[0] : null;
    if (!job) break;
    prechecks++;
    await processarPrecheck(job);
  }

  // 5. Execuções de restauração confirmadas pelo admin
  let restauracoes = 0;
  for (;;) {
    if (restauracoes >= LIMITE_RESTORES_POR_RUN) break;
    const reivindicados = await dbRpc("restore_reivindicar_job", {
      p_status: "pendente",
      p_lease_minutos: 180,
    });
    const job = Array.isArray(reivindicados) ? reivindicados[0] : null;
    if (!job) break;
    restauracoes++;
    await processarExecucaoRestore(job);
  }

  log(
    `Execução encerrada — ${processados} backup(s), ${prechecks} precheck(s), ${restauracoes} restauração(ões), ${agendadosDisparados} agendamento(s) disparado(s).`,
  );
}

principal().catch((erro) => {
  logErro(sanitizar(erro?.stack ?? erro?.message ?? String(erro)));
  process.exitCode = 1;
});
