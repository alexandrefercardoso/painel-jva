// ============================================================================
// [SERVER] API das Server Functions do módulo "SQL Multi-Banco".
//
// ARQUIVO AUTOCONTIDO (mesma regra de src/backup/api.server.ts): este módulo é
// dividido pelo compilador do TanStack Start e por isso possui APENAS imports
// de node_modules — nenhum import relativo/alias do projeto. Sessão, cripto e
// helpers são co-locados aqui com a MESMA implementação do backup, para que a
// credencial dos bancos desencripte do mesmo jeito e a sessão admin seja
// COMPARTILHADA (mesmo cookie) entre os módulos Backup e SQL.
//
// Funcionalidade: colar um script SQL, selecionar N instâncias (catálogo
// `backup_instances`) e aplicar o script em todas elas — com teste em
// transação descartada (dry-run), confirmação destrutiva digitada e auditoria.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { getCookie, deleteCookie, setCookie, getRequestIP } from "@tanstack/react-start/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Tipos de saída (sem segredos — nunca retornam host/senha completos)
// ---------------------------------------------------------------------------
export type SqlAlvoResumo = {
  id: string;
  nome: string;
  cliente_id: string | null;
  project_ref: string;
  ambiente: "producao" | "homologacao" | "desenvolvimento";
  db_host: string;
  db_port: number;
  db_name: string;
  status_conexao: "desconhecido" | "ok" | "falha";
};

export type SqlResultadoComando = {
  comando: string;
  linhas: number | null;
};

export type SqlLinhaPreview = Record<string, string | null>;

export type SqlPreview = {
  colunas: string[];
  linhas: SqlLinhaPreview[];
};

export type SqlResultadoAlvo = {
  id: string;
  nome: string;
  status: "ok" | "falha";
  duracao_ms: number;
  comandos: SqlResultadoComando[];
  /** rolagem feita no modo "Testar"; execução real nunca descarta */
  descartado: boolean;
  preview: SqlPreview | null;
  erro: string | null;
};

export type SqlResultadoExecucao = {
  executado: boolean; // false = modo teste (rollback)
  resultados: SqlResultadoAlvo[];
};

export type ResultadoTesteSql = {
  ok: boolean;
  detalhe: string;
  latencia_ms: number | null;
  servidor: string | null; // versão do Postgres
};

// ===========================================================================
// HELPERS (duplicados de backup/api.server.ts — arquivo autocontido)
// ===========================================================================

// ---------------------------------------------------------------------------
// Sessão admin (mesmo cookie do backup — sessão compartilhada entre módulos)
// ---------------------------------------------------------------------------
const COOKIE = "backup_admin_sess";
const TTL_MS = 1000 * 60 * 60 * 8; // 8h

type TokenPayload = { exp: number; n: number };

function segredo(): string {
  const pass = process.env.BACKUP_ADMIN_PASS;
  if (!pass || pass.length < 8) {
    throw new Error(
      "ADMIN_NAO_CONFIGURADO: defina BACKUP_ADMIN_PASS (mín. 8 caracteres) nas variáveis de ambiente do servidor (Vercel).",
    );
  }
  return pass;
}

function assinar(payload: string): string {
  return createHmac("sha256", segredo()).update(payload).digest("base64url");
}

function criarToken(): string {
  const payload: TokenPayload = {
    exp: Date.now() + TTL_MS,
    n: Date.now() + randomBytes(4).readUInt32BE(0),
  };
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${b64}.${assinar(b64)}`;
}

function tokenValido(token: string | undefined): boolean {
  if (!token) return false;
  const [b64, sig] = token.split(".");
  if (!b64 || !sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(assinar(b64));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as TokenPayload;
    return typeof payload.exp === "number" && payload.exp > Date.now();
  } catch {
    return false;
  }
}

const RATE_LIMIT_MS = 1000 * 60 * 5;
const tentativasLogin = new Map<string, { count: number; bloqueadoAte: number }>();

function verificarRateLimitLogin(ip: string): { ok: boolean; aguardarSeg: number } {
  const agora = Date.now();
  const item = tentativasLogin.get(ip);
  if (item && item.bloqueadoAte > agora) {
    return { ok: false, aguardarSeg: Math.ceil((item.bloqueadoAte - agora) / 1000) };
  }
  return { ok: true, aguardarSeg: 0 };
}

function registrarFalhaLogin(ip: string) {
  const agora = Date.now();
  const item = tentativasLogin.get(ip);
  const count = (item?.count ?? 0) + 1;
  if (count >= 10) {
    tentativasLogin.set(ip, { count: 0, bloqueadoAte: agora + RATE_LIMIT_MS });
  } else {
    tentativasLogin.set(ip, { count, bloqueadoAte: agora });
  }
}

function conferirSenhaAdmin(senha: string): boolean {
  const esperada = Buffer.from(segredo(), "utf8");
  const proposta = Buffer.from(senha ?? "", "utf8");
  if (proposta.length !== esperada.length) return false;
  return timingSafeEqual(proposta, esperada);
}

function adminAutenticado(): boolean {
  return tokenValido(getCookie(COOKIE));
}

async function exigirAdminSessao() {
  if (!adminAutenticado()) {
    throw new Error("NAO_AUTORIZADO: sessão de administrador ausente ou expirada.");
  }
}

function iniciarSessaoAdmin() {
  setCookie(COOKIE, criarToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: TTL_MS / 1000,
    path: "/",
  });
}

function encerrarSessaoAdmin() {
  deleteCookie(COOKIE, { path: "/" });
}

// ---------------------------------------------------------------------------
// Criptografia de credenciais (AES-256-GCM; formato "v1:iv:tag:cifrado")
// Implementação idêntica ao backup — precisa decifrar os mesmos blobs.
// ---------------------------------------------------------------------------
const FORMATO_BLOB = "v1";

function chaveMestre(): Buffer {
  const raw = process.env.BACKUP_CRYPTO_KEY;
  if (!raw || raw.length < 16) {
    throw new Error(
      "CRYPTO_NAO_CONFIGURADO: defina BACKUP_CRYPTO_KEY (mín. 32 caracteres aleatórios) nas variáveis de ambiente do servidor (Vercel).",
    );
  }
  return createHash("sha256").update(`jva-backup::${raw}`).digest();
}

function descriptografar(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const partes = blob.split(":");
  if (partes.length !== 4 || partes[0] !== FORMATO_BLOB) return null;
  const [, ivB64, tagB64, dadoB64] = partes;
  try {
    const decifra = createDecipheriv("aes-256-gcm", chaveMestre(), Buffer.from(ivB64, "base64"));
    decifra.setAuthTag(Buffer.from(tagB64, "base64"));
    const dados = Buffer.concat([decifra.update(Buffer.from(dadoB64, "base64")), decifra.final()]);
    return dados.toString("utf8");
  } catch {
    return null;
  }
}

/** Remove segredos de mensagens de erro antes de guardar/devolver. */
function sanitizarMensagem(mensagem: string): string {
  return mensagem
    .replace(/(postgres(?:ql)?:\/\/[^\s]+)/gi, "postgres://****")
    .replace(/(PGPASSWORD\s*=\s*\S+)/gi, "PGPASSWORD=****")
    .replace(/(password(?:\s*[:=]\s*)?)([^\s]+)/gi, "$1****");
}

/** Máscara de host para exibição (mantém tld final, oculta o meio). */
function mascararHost(host: string): string {
  const partes = host.split(".");
  if (partes.length <= 3) return host;
  return `${partes[0]}….${partes.slice(-2).join(".")}`;
}

// ---------------------------------------------------------------------------
// Cliente admin do banco central (service_role via env)
// ---------------------------------------------------------------------------
const CENTRAL_URL = "https://hepvdpktubhcklerdvqb.supabase.co";

function serviceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";
  if (!key) {
    throw new Error(
      "SERVICE_KEY_NAO_CONFIGURADA: defina SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente do servidor (Vercel).",
    );
  }
  return key;
}

function serviceUrl(): string {
  return process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? CENTRAL_URL;
}

let adminClient: SupabaseClient | null = null;

function getAdminDb(): SupabaseClient {
  if (!adminClient) {
    adminClient = createClient(serviceUrl(), serviceKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return adminClient;
}

function SEM_SENDA(row: Record<string, unknown>): SqlAlvoResumo {
  return {
    id: row.id as string,
    nome: row.nome as string,
    cliente_id: (row.cliente_id as string | null) ?? null,
    project_ref: row.project_ref as string,
    ambiente: row.ambiente as SqlAlvoResumo["ambiente"],
    db_host: mascararHost(String(row.db_host ?? "")),
    db_port: Number(row.db_port ?? 5432),
    db_name: String(row.db_name ?? "postgres"),
    status_conexao: (row.status_conexao as SqlAlvoResumo["status_conexao"]) ?? "desconhecido",
  };
}

// ---------------------------------------------------------------------------
// Auditoria (reaproveita a tabela backup_audit_logs; nunca bloqueia)
// ---------------------------------------------------------------------------
async function auditoria(acao: string, refId: string | null, detalhes: unknown) {
  try {
    await getAdminDb()
      .from("backup_audit_logs")
      .insert({ acao, origem: "painel", referencia: refId ? { id: refId } : null, detalhes });
  } catch {
    // auditoria nunca deve bloquear a operação principal
  }
}

// ---------------------------------------------------------------------------
// Conexão com a instância (node-postgres, credencial descriptografada)
// ---------------------------------------------------------------------------

type InstRow = Record<string, unknown> & { id: string };

async function obterInstancia(id: string): Promise<InstRow> {
  const { data, error } = await getAdminDb()
    .from("backup_instances")
    .select()
    .eq("id", id)
    .single();
  if (error || !data) throw new Error("Instância não encontrada.");
  if (!data.ativo) throw new Error(`Instância "${data.nome}" está desativada.`);
  return data as InstRow;
}

type ConexaoSql = {
  client: pg.Client;
  servidor: string;
};

async function conectarInstancia(inst: InstRow, statementTimeoutMs: number): Promise<ConexaoSql> {
  const senha = descriptografar((inst as { credencial_cripto?: string }).credencial_cripto);
  if (!senha) {
    throw new Error(
      `SEM_CREDENCIAL: a instância "${String(inst.nome ?? "")}" não tem senha cadastrada.`,
    );
  }
  const client = new pg.Client({
    host: String(inst.db_host ?? ""),
    port: Number(inst.db_port ?? 5432),
    user: String(inst.db_user ?? "postgres"),
    database: String(inst.db_name ?? "postgres"),
    password: senha,
    ssl: { rejectUnauthorized: false }, // Supabase usa CA dinâmica; host é controlado no cadastro
    connectionTimeoutMillis: 15_000,
    statement_timeout: statementTimeoutMs,
  });
  await client.connect();
  const r = await client.query("SELECT version() AS v");
  const servidor = String((r.rows[0] as { v?: string })?.v ?? "").split(" on ")[0] || "Postgres";
  return { client, servidor };
}

/** Executa o script com guardas; devolve resultados dos comandos. */
async function rodarScriptSql(
  client: pg.Client,
  texto: string,
  transacao: boolean,
): Promise<{ comandos: SqlResultadoComando[]; preview: SqlPreview | null }> {
  if (transacao) await client.query("BEGIN");
  try {
    const resultado = (await client.query(
      // Texto puro → protocolo "simple query" → aceita vários comandos
      // separados por ";" de uma vez só.
      texto,
    )) as unknown as Array<{
      command: string;
      rowCount: number | null;
      rows: Record<string, unknown>[];
      fields: { name: string }[];
    }>;
    const lista = Array.isArray(resultado) ? resultado : [resultado];

    const comandos: SqlResultadoComando[] = lista.map((r) => ({
      comando: `${r.command || "OK"}`,
      linhas: r.rowCount ?? null,
    }));

    // Pré-visualização de SELECT: no máximo 20 linhas × 8 colunas
    let preview: SqlPreview | null = null;
    for (const r of lista) {
      if (Array.isArray(r.rows) && r.rows.length > 0 && r.fields?.length) {
        const colunas = r.fields.slice(0, 8).map((f) => f.name);
        preview = {
          colunas,
          linhas: r.rows.slice(0, 20).map((linha) => {
            const saida: Record<string, string | null> = {};
            for (const c of colunas) {
              const valor = (linha as Record<string, unknown>)[c];
              saida[c] =
                valor === null || valor === undefined
                  ? null
                  : typeof valor === "object"
                    ? JSON.stringify(valor)
                    : String(valor).slice(0, 120);
            }
            return saida;
          }),
        };
        break;
      }
    }

    if (transacao) await client.query("COMMIT");
    return { comandos, preview };
  } catch (e) {
    if (transacao) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // conexão já pode ter caído
      }
    }
    throw e;
  }
}

// ===========================================================================
// SESSÃO
// ===========================================================================
export const sqlSessaoAtual = createServerFn({ method: "GET" }).handler(async () => {
  let problema: string | null = null;
  try {
    getAdminDb();
  } catch (e) {
    problema = sanitizarMensagem(e instanceof Error ? e.message : String(e));
  }
  return {
    autenticado: adminAutenticado(),
    backendConfigurado: problema === null,
    backendProblema: problema,
    url: serviceUrl(),
  };
});

export const sqlLogin = createServerFn({ method: "POST" })
  .validator(z.object({ senha: z.string().min(1, "Informe a senha de administrador.") }))
  .handler(async ({ data }) => {
    const ip = getRequestIP({ xForwardedFor: true }) ?? "0.0.0.0";
    const limite = verificarRateLimitLogin(ip);
    if (!limite.ok) {
      throw new Error(
        `MUITAS_TENTATIVAS: aguarde ${limite.aguardarSeg}s antes de tentar novamente.`,
      );
    }
    if (!conferirSenhaAdmin(data.senha)) {
      registrarFalhaLogin(ip);
      throw new Error("SENHA_INVALIDA: senha de administrador incorreta.");
    }
    iniciarSessaoAdmin();
    await auditoria("sessao.login", null, { resultado: "ok", modulo: "sql" });
    return { ok: true };
  });

export const sqlLogout = createServerFn({ method: "POST" }).handler(async () => {
  await exigirAdminSessao();
  encerrarSessaoAdmin();
  return { ok: true };
});

// ===========================================================================
// ALVOS — instâncias aptas (ativas + com credencial), sem segredos
// ===========================================================================
export const sqlListarAlvos = createServerFn({ method: "GET" }).handler(
  async (): Promise<SqlAlvoResumo[]> => {
    await exigirAdminSessao();
    const { data, error } = await getAdminDb()
      .from("backup_instances")
      .select()
      .eq("ativo", true)
      .eq("credencial_ok", true)
      .order("ambiente", { ascending: true })
      .order("nome", { ascending: true });
    if (error) throw new Error(sanitizarMensagem(error.message));
    return (data ?? []).map((row) => SEM_SENDA(row as Record<string, unknown>));
  },
);

// ===========================================================================
// TESTE DE CONEXÃO REAL (autentica no Postgres, SELECT version())
// ===========================================================================
export const sqlTestarAlvo = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }): Promise<ResultadoTesteSql> => {
    await exigirAdminSessao();
    const inicio = Date.now();
    let client: pg.Client | null = null;
    try {
      const inst = await obterInstancia(data.id);
      const { client: c, servidor } = await conectarInstancia(inst, 10_000);
      client = c;
      const latencia = Date.now() - inicio;

      await getAdminDb()
        .from("backup_instances")
        .update({ status_conexao: "ok", status_detalhe: servidor })
        .eq("id", data.id);

      await auditoria("sql.testar_alvo", data.id, { resultado: "ok", latencia_ms: latencia });

      return {
        ok: true,
        detalhe: `Autenticado e conectado (${servidor}).`,
        latencia_ms: latencia,
        servidor,
      };
    } catch (e) {
      const msg = sanitizarMensagem(e instanceof Error ? e.message : String(e));
      try {
        await getAdminDb()
          .from("backup_instances")
          .update({ status_conexao: "falha", status_detalhe: msg })
          .eq("id", data.id);
      } catch {
        // ignora falha de atualização de status
      }
      return { ok: false, detalhe: msg, latencia_ms: Date.now() - inicio, servidor: null };
    } finally {
      try {
        await client?.end();
      } catch {
        // ignora
      }
    }
  });

// ===========================================================================
// VALIDAÇÃO (dry-run) e EXECUÇÃO do script nos bancos selecionados
// Roda sequencialmente, um banco por vez, resultado independente por banco.
// ===========================================================================
const validatorRodar = z.object({
  sql: z
    .string()
    .min(1, "Informe o script SQL.")
    .max(500_000, "Script muito grande (máx. 500 KB)."),
  alvos: z.array(z.string().uuid()).min(1, "Selecione ao menos um banco.").max(50),
  /** modo "teste" → BEGIN … ROLLBACK (nada persiste) */
  modo: z.enum(["teste", "executar"]),
  /** executar definitivo: exige confirmação digitada "EXECUTAR" */
  confirmacao: z.string().max(120).optional().nullable(),
  transacao: z.boolean().default(true), // tudo-ou-nada por banco
  timeout_seg: z.number().int().min(5).max(600).default(120),
});

export const sqlRodar = createServerFn({ method: "POST" })
  .validator(validatorRodar)
  .handler(async ({ data }): Promise<SqlResultadoExecucao> => {
    await exigirAdminSessao();

    const confirmacaoObrigatoria = "EXECUTAR";
    if (data.modo === "executar") {
      if ((data.confirmacao ?? "").trim() !== confirmacaoObrigatoria) {
        throw new Error(
          "CONFIRMACAO_INVALIDA: digite EXECUTAR no diálogo de confirmação para aplicar em definitivo.",
        );
      }
    }

    const transacaoExternal = data.transacao;
    const executadoDefinitivo = data.modo === "executar";
    // Auditoria do que foi pedido (script truncado) — antes de rodar
    await auditoria(executadoDefinitivo ? "sql.executar_inicio" : "sql.testar_inicio", null, {
      alvos: data.alvos.length,
      modo: data.modo,
      transacao: transacaoExternal,
      script: data.sql.slice(0, 2000),
    });

    const resultados: SqlResultadoAlvo[] = [];

    for (const id of data.alvos) {
      const inicio = Date.now();
      const base: SqlResultadoAlvo = {
        id,
        nome: id,
        status: "ok",
        duracao_ms: 0,
        comandos: [],
        descartado: !executadoDefinitivo,
        preview: null,
        erro: null,
      };
      let client: pg.Client | null = null;
      try {
        const inst = await obterInstancia(id);
        base.nome = String(inst.nome ?? id);

        const { client: c, servidor } = await conectarInstancia(
          inst,
          Math.min(data.timeout_seg, 600) * 1000,
        );
        client = c;

        const { comandos, preview } = await rodarScriptSql(client, data.sql, transacaoExternal);
        base.comandos = comandos;
        base.preview = preview;
        base.duracao_ms = Date.now() - inicio;
        base.nome = `${base.nome} (${servidor})`;

        await auditoria(executadoDefinitivo ? "sql.executar_ok" : "sql.testar_ok", id, {
          duracao_ms: base.duracao_ms,
          comandos: comandos.slice(0, 30),
        });
      } catch (e) {
        base.status = "falha";
        base.duracao_ms = Date.now() - inicio;
        base.erro = sanitizarMensagem(e instanceof Error ? e.message : String(e));
        await auditoria(executadoDefinitivo ? "sql.executar_falha" : "sql.testar_falha", id, {
          erro: base.erro,
        });
      } finally {
        try {
          await client?.end();
        } catch {
          // ignora
        }
      }
      resultados.push(base);
    }

    await auditoria(executadoDefinitivo ? "sql.executar_fim" : "sql.testar_fim", null, {
      total: resultados.length,
      ok: resultados.filter((r) => r.status === "ok").length,
      falhas: resultados.filter((r) => r.status === "falha").length,
    });

    return { executado: executadoDefinitivo, resultados };
  });
