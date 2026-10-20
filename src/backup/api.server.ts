// ============================================================================
// [SERVER] API das Server Functions do módulo "Backup & Restauração".
//
// ARQUIVO AUTOCONTIDO: este módulo é dividido pelo compilador do TanStack Start
// (?tss-serverfn-split) e por isso possui APENAS imports de node_modules —
// nenhum import relativo/alias do projeto. Os helpers (auth, crypto, conexão,
// cliente admin do Supabase) estão co-locados abaixo das Server Functions.
//
// Sessão administrativa: senha única em env (BACKUP_ADMIN_PASS), cookie
// HttpOnly assinado com HMAC-SHA256, válida por 8h.
// Toda Server Function protegida chama exigirAdminSessao() na primeira linha
// do handler — o compilador elimina o corpo no build client, então a lógica
// privilegiada nunca alcança o navegador.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { getCookie, deleteCookie, setCookie, getRequestIP } from "@tanstack/react-start/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import net from "node:net";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Tipos de saída (sem segredos)
// ---------------------------------------------------------------------------
export type InstanciaResumo = {
  id: string;
  nome: string;
  cliente_id: string | null;
  project_ref: string;
  supabase_url: string | null;
  db_host: string;
  db_port: number;
  db_user: string;
  db_name: string;
  ambiente: "producao" | "homologacao" | "desenvolvimento";
  ativo: boolean;
  status_conexao: "desconhecido" | "ok" | "falha";
  status_detalhe: string | null;
  credencial_ok: boolean;
  ultimo_backup_em: string | null;
  criado_em: string;
};

export type AgendamentoResumo = {
  id: string;
  instance_id: string;
  frequencia: "diario" | "semanal" | "mensal" | "personalizado";
  dia_semana: number | null;
  dia_mes: number | null;
  hora: string;
  fuso: string;
  retencao_dias: number;
  ativo: boolean;
  proxima_execucao: string | null;
  ultima_execucao_em: string | null;
  ultimo_resultado: string | null;
  falhas_consecutivas: number;
  total_backups: number;
};

export type ResultadoTesteConexao = {
  ok: boolean;
  detalhe: string;
  latencia_ms: number | null;
};

// ===========================================================================
// HELPERS — não exportados (só vivem dentro dos handlers no servidor)
// ===========================================================================

// ---------------------------------------------------------------------------
// Sessão admin (cookie HttpOnly + HMAC)
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

// Controle anti-força bruta (por processo; suficiente para uso interno)
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

function criptografar(texto: string): string {
  const chave = chaveMestre();
  const iv = randomBytes(12);
  const cifra = createCipheriv("aes-256-gcm", chave, iv);
  const dados = Buffer.concat([cifra.update(texto, "utf8"), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [
    FORMATO_BLOB,
    iv.toString("base64"),
    tag.toString("base64"),
    dados.toString("base64"),
  ].join(":");
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
    return null; // chave trocada, blob corrompido ou tag inválida
  }
}

/** Remove segredos de mensagens de erro antes de guardar/devolver. */
function sanitizarMensagem(mensagem: string): string {
  return mensagem
    .replace(/(postgres(?:ql)?:\/\/[^\s]+)/gi, "postgres://****")
    .replace(/(PGPASSWORD\s*=\s*\S+)/gi, "PGPASSWORD=****")
    .replace(/(password(?:\s*[:=]\s*)?)([^\s]+)/gi, "$1****");
}

// ---------------------------------------------------------------------------
// Cliente admin do banco central (service_role via env — NUNCA anon)
// ---------------------------------------------------------------------------
const CENTRAL_URL = "https://hepvdpktubhcklerdvqb.supabase.co";

function serviceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? "";
  if (!key) {
    throw new Error(
      "SERVICE_KEY_NAO_CONFIGURADA: defina SUPABASE_SERVICE_ROLE_KEY nas variáveis de ambiente do servidor (Vercel). Nunca use a anon key nas tabelas backup_*.",
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

// ---------------------------------------------------------------------------
// Teste de conexão (TCP puro — sem binários pg no Vercel)
// ---------------------------------------------------------------------------
function testarTcp(host: string, port: number, timeoutMs: number): Promise<ResultadoTesteConexao> {
  return new Promise((resolve) => {
    const inicio = Date.now();
    const socket = new net.Socket();
    let encerrado = false;

    const finalizar = (ok: boolean, detalhe: string) => {
      if (encerrado) return;
      encerrado = true;
      socket.destroy();
      resolve({
        ok,
        detalhe: sanitizarMensagem(detalhe),
        latencia_ms: ok ? Date.now() - inicio : null,
      });
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finalizar(true, `Porta ${port} acessível em ${host}.`));
    socket.once("timeout", () =>
      finalizar(false, `Tempo esgotado (${timeoutMs}ms) conectando em ${host}:${port}.`),
    );
    socket.once("error", (erro: NodeJS.ErrnoException) => {
      const mapas: Record<string, string> = {
        ENOTFOUND: "Host não encontrado (DNS). Verifique o db_host.",
        ECONNREFUSED: "Conexão recusada. Verifique a porta / projeto pausado.",
        ETIMEDOUT: "Host não respondeu (firewall / projeto pausado).",
        EHOSTUNREACH: "Rota indisponível até o host.",
      };
      finalizar(false, mapas[erro.code ?? ""] ?? erro.message);
    });
    socket.connect(port, host);
  });
}

// ---------------------------------------------------------------------------
// Auditoria (nunca bloqueia a operação principal)
// ---------------------------------------------------------------------------
async function auditoria(acao: string, refId: string | null, detalhes: unknown) {
  try {
    await getAdminDb()
      .from("backup_audit_logs")
      .insert({
        acao,
        origem: "painel",
        referencia: refId ? { id: refId } : null,
        detalhes: detalhes ?? null,
      });
  } catch {
    // auditoria nunca deve bloquear a operação principal
  }
}

// ===========================================================================
// SESSÃO
// ===========================================================================
export const backupSessaoAtual = createServerFn({ method: "GET" }).handler(async () => {
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

export const backupLogin = createServerFn({ method: "POST" })
  .validator(
    z.object({
      senha: z.string().min(1, "Informe a senha de administrador."),
    }),
  )
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
    await auditoria("sessao.login", null, { resultado: "ok" });
    return { ok: true };
  });

export const backupLogout = createServerFn({ method: "POST" }).handler(async () => {
  await exigirAdminSessao();
  encerrarSessaoAdmin();
  return { ok: true };
});

// ===========================================================================
// INSTÂNCIAS — CRUD (senha criptografada no servidor; nunca retorna ao front)
// ===========================================================================
const validatorInstancia = z.object({
  nome: z.string().min(2).max(80),
  cliente_id: z.string().uuid().nullable().optional(),
  project_ref: z
    .string()
    .regex(/^[a-z0-9]{20}$/, "Identificador do projeto deve ter 20 letras/números."),
  supabase_url: z.string().url().startsWith("https://").max(200).nullable().optional(),
  db_host: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-zA-Z0-9.\-_:]+$/, "Host inválido."),
  db_port: z.number().int().min(1).max(65535).default(5432),
  db_user: z.string().min(1).max(63).default("postgres"),
  db_name: z.string().min(1).max(63).default("postgres"),
  ambiente: z.enum(["producao", "homologacao", "desenvolvimento"]),
  credencial: z.string().min(4).max(200).nullable().optional(), // senha do banco postgres
});

const SEM_SENDA = (row: Record<string, unknown>) => {
  const { credencial_cripto: _oculta, ...visivel } = row;
  return visivel as InstanciaResumo;
};

export const backupCriarInstancia = createServerFn({ method: "POST" })
  .validator(validatorInstancia)
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: nova, error } = await db
      .from("backup_instances")
      .insert({
        nome: data.nome,
        cliente_id: data.cliente_id ?? null,
        project_ref: data.project_ref,
        supabase_url: data.supabase_url ?? null,
        db_host: data.db_host,
        db_port: data.db_port,
        db_user: data.db_user,
        db_name: data.db_name,
        ambiente: data.ambiente,
        credencial_cripto: data.credencial ? criptografar(data.credencial) : null,
        credencial_ok: Boolean(data.credencial),
      })
      .select()
      .single();
    if (error) throw new Error(sanitizarMensagem(error.message));
    await auditoria("instancia.criar", nova.id, { nome: data.nome, ambiente: data.ambiente });
    return SEM_SENDA(nova);
  });

export const backupEditarInstancia = createServerFn({ method: "POST" })
  .validator(validatorInstancia.extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const updates: Record<string, unknown> = {
      nome: data.nome,
      cliente_id: data.cliente_id ?? null,
      project_ref: data.project_ref,
      supabase_url: data.supabase_url ?? null,
      db_host: data.db_host,
      db_port: data.db_port,
      db_user: data.db_user,
      db_name: data.db_name,
      ambiente: data.ambiente,
    };
    if (data.credencial !== undefined && data.credencial !== null && data.credencial !== "") {
      updates.credencial_cripto = criptografar(data.credencial);
      updates.credencial_ok = true;
    }
    const { data: editada, error } = await db
      .from("backup_instances")
      .update(updates)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw new Error(sanitizarMensagem(error.message));
    await auditoria("instancia.editar", data.id, { campos: Object.keys(updates) });
    return SEM_SENDA(editada);
  });

export const backupExcluirInstancia = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { error } = await db.from("backup_instances").delete().eq("id", data.id);
    if (error) throw new Error(sanitizarMensagem(error.message));
    await auditoria("instancia.excluir", data.id, null);
    return { ok: true };
  });

export const backupAtivarInstancia = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid(), ativo: z.boolean() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const { error } = await getAdminDb()
      .from("backup_instances")
      .update({ ativo: data.ativo })
      .eq("id", data.id);
    if (error) throw new Error(sanitizarMensagem(error.message));
    await auditoria("instancia.ativar", data.id, { ativo: data.ativo });
    return { ok: true };
  });

export const backupListarInstancias = createServerFn({ method: "GET" }).handler(
  async (): Promise<InstanciaResumo[]> => {
    await exigirAdminSessao();
    const { data, error } = await getAdminDb()
      .from("backup_instances")
      .select("*")
      .order("nome", { ascending: true });
    if (error) throw new Error(sanitizarMensagem(error.message));
    return (data ?? []).map(SEM_SENDA);
  },
);

export const backupTestarConexao = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: inst, error } = await db
      .from("backup_instances")
      .select()
      .eq("id", data.id)
      .single();
    if (error || !inst) throw new Error("Instância não encontrada.");

    const senha = descriptografar((inst as { credencial_cripto?: string }).credencial_cripto);
    if (!senha) {
      throw new Error(
        "SEM_CREDENCIAL: cadastre a senha do banco postgres antes de testar a conexão.",
      );
    }

    // Teste atual: TCP (DNS + porta). O teste de autenticação real acontece
    // no worker, com pg_dump — nunca com a credencial no frontend.
    const resultado = await testarTcp(inst.db_host, inst.db_port, 10_000);

    await db
      .from("backup_instances")
      .update({
        status_conexao: resultado.ok ? "ok" : "falha",
        status_detalhe: resultado.detalhe,
      })
      .eq("id", inst.id);

    await auditoria("instancia.testar_conexao", inst.id, {
      resultado: resultado.ok ? "ok" : "falha",
      latencia_ms: resultado.latencia_ms,
    });

    return resultado;
  });

// ===========================================================================
// AGENDAMENTOS
// ===========================================================================
const validatorAgendamento = z.object({
  instance_id: z.string().uuid(),
  frequencia: z.enum(["diario", "semanal", "mensal", "personalizado"]),
  dia_semana: z.number().int().min(0).max(6).nullable().optional(),
  dia_mes: z.number().int().min(1).max(28).nullable().optional(),
  hora: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  fuso: z.string().min(2).max(64),
  retencao_dias: z.number().int().min(1).max(365).default(30),
});

export const backupCriarAgendamento = createServerFn({ method: "POST" })
  .validator(validatorAgendamento)
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: schedule, error } = await db
      .from("backup_schedules")
      .upsert(
        {
          instance_id: data.instance_id,
          frequencia: data.frequencia,
          dia_semana: data.dia_semana ?? null,
          dia_mes: data.dia_mes ?? null,
          hora: data.hora,
          fuso: data.fuso,
          retencao_dias: data.retencao_dias,
          ativo: true,
          falhas_consecutivas: 0,
        },
        { onConflict: "instance_id" },
      )
      .select()
      .single();
    if (error) throw new Error(sanitizarMensagem(error.message));

    // Calcula a próxima execução no fuso configurado (RPC no banco central)
    const { data: prox } = await db.rpc("backup_proxima_execucao", {
      p_frequencia: data.frequencia,
      p_dia_semana: data.dia_semana ?? null,
      p_dia_mes: data.dia_mes ?? null,
      p_hora: data.hora,
      p_fuso: data.fuso,
    });
    if (prox) {
      await db.from("backup_schedules").update({ proxima_execucao: prox }).eq("id", schedule.id);
    }
    await auditoria("agendamento.criar", schedule.id, { instance_id: data.instance_id });
    return schedule as unknown as AgendamentoResumo;
  });

export const backupAtivarAgendamento = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid(), ativo: z.boolean() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const { error } = await getAdminDb()
      .from("backup_schedules")
      .update({ ativo: data.ativo })
      .eq("id", data.id);
    if (error) throw new Error(sanitizarMensagem(error.message));
    await auditoria("agendamento.ativar", data.id, { ativo: data.ativo });
    return { ok: true };
  });

export const backupListarAgendamentos = createServerFn({ method: "GET" }).handler(
  async (): Promise<AgendamentoResumo[]> => {
    await exigirAdminSessao();
    const { data, error } = await getAdminDb()
      .from("backup_schedules")
      .select("*")
      .order("proxima_execucao", { ascending: true });
    if (error) throw new Error(sanitizarMensagem(error.message));
    return (data ?? []) as unknown as AgendamentoResumo[];
  },
);

// ===========================================================================
// BACKUP MANUAL + HISTÓRICO + DOWNLOAD + INTEGRIDADE (FASE 4/5)
// A execução real fica no worker (GitHub Actions) — o painel só enfileira
// o job em backup_jobs; o worker reivindica via RPC com lease atômico.
// ===========================================================================
export type BackupJobResumo = {
  id: string;
  instance_id: string;
  instance_nome: string;
  tipo: "manual" | "automatico";
  status: "pendente" | "executando" | "validando" | "concluido" | "falha" | "cancelado";
  tentativas: number;
  max_tentativas: number;
  erro: string | null;
  versao_pg_dump: string | null;
  arquivo_id: string | null;
  iniciado_em: string | null;
  finalizado_em: string | null;
  criado_em: string;
  criado_por: string;
};

export type BackupArquivoResumo = {
  id: string;
  instance_id: string;
  instance_nome: string;
  job_id: string | null;
  nome_arquivo: string;
  tamanho_bytes: number | null;
  sha256: string | null;
  tipo: "manual" | "automatico" | "seguranca";
  validado: boolean;
  validado_em: string | null;
  criado_em: string;
};

export const backupCriarBackup = createServerFn({ method: "POST" })
  .validator(z.object({ instance_id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: inst, error } = await db
      .from("backup_instances")
      .select()
      .eq("id", data.instance_id)
      .single();
    if (error || !inst) throw new Error("Instância não encontrada.");
    if (!inst.ativo)
      throw new Error("INSTANCIA_INATIVA: ative a instância antes de executar backups.");
    if (!inst.credencial_ok) {
      throw new Error(
        "SEM_CREDENCIAL: cadastre a senha do banco postgres da instância antes de executar backups.",
      );
    }

    // Proteção contra execução simultânea na mesma instância
    const { data: emAndamento } = await db
      .from("backup_jobs")
      .select("id")
      .eq("instance_id", data.instance_id)
      .in("status", ["pendente", "executando", "validando"])
      .limit(1);
    if (emAndamento && emAndamento.length > 0) {
      throw new Error(
        "OPERACAO_EM_ANDAMENTO: já existe um backup em execução (ou na fila) para esta instância.",
      );
    }

    const { data: job, error: erroJob } = await db
      .from("backup_jobs")
      .insert({
        instance_id: data.instance_id,
        tipo: "manual",
        status: "pendente",
        criado_por: "admin",
      })
      .select("id")
      .single();
    if (erroJob || !job)
      throw new Error(sanitizarMensagem(erroJob?.message ?? "Falha ao enfileirar"));

    await auditoria("backup.criar_job", data.instance_id, { job_id: job.id, tipo: "manual" });
    return { ok: true as const, job_id: job.id as string };
  });

export const backupListarOperacoes = createServerFn({ method: "GET" }).handler(
  async (): Promise<BackupJobResumo[]> => {
    await exigirAdminSessao();
    const { data, error } = await getAdminDb()
      .from("backup_jobs")
      .select("*, instance:backup_instances(nome)")
      .order("criado_em", { ascending: false })
      .limit(30);
    if (error) throw new Error(sanitizarMensagem(error.message));
    return (data ?? []).map((row) => {
      const { instance, ...rest } = row as Record<string, unknown> & {
        instance: { nome: string } | null;
      };
      return { ...rest, instance_nome: instance?.nome ?? "—" } as unknown as BackupJobResumo;
    });
  },
);

export const backupListarArquivos = createServerFn({ method: "GET" }).handler(
  async (): Promise<BackupArquivoResumo[]> => {
    await exigirAdminSessao();
    const { data, error } = await getAdminDb()
      .from("backup_files")
      .select("*, instance:backup_instances(nome)")
      .order("criado_em", { ascending: false })
      .limit(200);
    if (error) throw new Error(sanitizarMensagem(error.message));
    return (data ?? []).map((row) => {
      const { instance, ...rest } = row as Record<string, unknown> & {
        instance: { nome: string } | null;
      };
      return { ...rest, instance_nome: instance?.nome ?? "—" } as unknown as BackupArquivoResumo;
    });
  },
);

/** URL temporária autorizada (15 min), gerada e auditada no servidor. */
export const backupCriarUrlDownload = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: arquivo, error } = await db
      .from("backup_files")
      .select()
      .eq("id", data.id)
      .single();
    if (error || !arquivo) throw new Error("Arquivo não encontrado.");

    const { data: assinada, error: erroUrl } = await db.storage
      .from("backups")
      .createSignedUrl(arquivo.storage_path, 900);
    if (erroUrl || !assinada?.signedUrl) {
      throw new Error(sanitizarMensagem(erroUrl?.message ?? "Falha ao gerar URL temporária."));
    }

    await auditoria("backup.download", arquivo.instance_id, { arquivo_id: arquivo.id });
    return { ok: true as const, url: assinada.signedUrl as string };
  });

export const backupVerificarArquivo = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: arquivo, error } = await db
      .from("backup_files")
      .select()
      .eq("id", data.id)
      .single();
    if (error || !arquivo) throw new Error("Arquivo não encontrado.");

    const { data: assinada, error: erroUrl } = await db.storage
      .from("backups")
      .createSignedUrl(arquivo.storage_path, 60);
    if (erroUrl || !assinada?.signedUrl) {
      throw new Error(
        sanitizarMensagem(erroUrl?.message ?? "Falha ao conferir o arquivo no armazenamento."),
      );
    }

    const resposta = await fetch(assinada.signedUrl, { method: "HEAD" });
    const tamanhoRemoto = Number(resposta.headers.get("content-length") ?? 0);
    const ok =
      resposta.ok &&
      tamanhoRemoto > 0 &&
      (arquivo.tamanho_bytes ?? 0) > 0 &&
      tamanhoRemoto === arquivo.tamanho_bytes;

    if (ok && !arquivo.validado) {
      await db
        .from("backup_files")
        .update({ validado: true, validado_em: new Date().toISOString() })
        .eq("id", arquivo.id);
    }
    await auditoria("backup.verificar", arquivo.instance_id, {
      arquivo_id: arquivo.id,
      resultado: ok ? "ok" : "divergencia",
    });

    return {
      ok,
      detalhe: ok
        ? `Arquivo íntegro: ${tamanhoRemoto} bytes conferidos no armazenamento.`
        : `Divergência: HTTP ${resposta.status}, remoto ${tamanhoRemoto} bytes × registrado ${arquivo.tamanho_bytes ?? 0}.`,
    };
  });

export const backupExcluirArquivo = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: arquivo, error } = await db
      .from("backup_files")
      .select()
      .eq("id", data.id)
      .single();
    if (error || !arquivo) throw new Error("Arquivo não encontrado.");

    // Nunca apagar o último backup válido da instância (mesmo por ação manual)
    if (arquivo.validado) {
      const { data: outrosValidos } = await db
        .from("backup_files")
        .select("id")
        .eq("instance_id", arquivo.instance_id)
        .neq("id", arquivo.id)
        .eq("validado", true)
        .limit(1);
      if (!outrosValidos || outrosValidos.length === 0) {
        throw new Error(
          "ULTIMO_BACKUP_VALIDO: este é o único backup válido da instância. Gere um novo backup antes de excluí-lo.",
        );
      }
    }

    const { error: erroStorage } = await db.storage.from("backups").remove([arquivo.storage_path]);
    // Se o objeto já não existe no storage, segimos com a exclusão do registro
    if (erroStorage) {
      const msg = sanitizarMensagem(erroStorage.message);
      if (!msg.includes("does not exist")) throw new Error(msg);
    }

    const { error: erroDelete } = await db.from("backup_files").delete().eq("id", arquivo.id);
    if (erroDelete) throw new Error(sanitizarMensagem(erroDelete.message));

    await auditoria("backup.excluir", arquivo.instance_id, { arquivo_id: arquivo.id });
    return { ok: true };
  });

// ===========================================================================
// RESTAURAÇÃO ENTRE INSTÂNCIAS (FASE 7)
// Fluxo: precheck no worker → relatório + aguardando confirmação → admin
// digita o NOME da instância de destino (confirmação destrutiva) → fila
// 'pendente' → worker faz backup de segurança e restaura (--clean --if-exists
// somente no escopo permitido; schemas gerenciados do Supabase JAMAIS).
// ===========================================================================
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

export type RestorePrecheck = {
  gerado_em: string;
  arquivo: {
    nome_arquivo: string;
    criado_em: string;
    tamanho_bytes: number | null;
    sha256: string | null;
  };
  destino: { nome: string; project_ref: string; schemas: Record<string, number> };
  dump: {
    schemas: Array<{
      nome: string;
      gerenciado: boolean;
      tabelas: number;
      dados: number;
      outros: number;
      nomes_tabelas: string[];
    }>;
  };
  schemas_alvo: string[];
  modo: string;
  conflitos: Array<{
    schema: string;
    tabelas_no_dump: number;
    tabelas_no_destino: number;
    tabelas_substituidas: string[];
  }>;
  avisos: string[];
  ok: boolean;
};

export type RestoreOperacaoResumo = {
  id: string;
  backup_file_id: string;
  origem_instance_id: string;
  destino_instance_id: string;
  origem_nome: string;
  destino_nome: string;
  arquivo_nome: string;
  modo: "aplicacao" | "migracao";
  schemas_alvo: string[];
  status:
    | "pendente_precheck"
    | "falha_precheck"
    | "aguardando_confirmacao"
    | "pendente"
    | "executando"
    | "validando"
    | "concluido"
    | "falha"
    | "cancelado";
  precheck: RestorePrecheck | null;
  confirmado_em: string | null;
  backup_seguranca_id: string | null;
  erro: string | null;
  log_execucao: string | null;
  duracao_seg: number | null;
  criado_em: string;
  finalizado_em: string | null;
};

export const restoreCriarPrecheck = createServerFn({ method: "POST" })
  .validator(
    z.object({
      backup_file_id: z.string().uuid(),
      destino_instance_id: z.string().uuid(),
      modo: z.enum(["aplicacao", "migracao"]),
      schemas_alvo: z.array(z.string().min(1).max(63)).max(20).default([]),
    }),
  )
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();

    const { data: arquivo, error: erroArquivo } = await db
      .from("backup_files")
      .select()
      .eq("id", data.backup_file_id)
      .single();
    if (erroArquivo || !arquivo) throw new Error("Backup de origem não encontrado.");
    if (!arquivo.validado) {
      throw new Error(
        "Backup não validado: verifique a integridade do arquivo antes de restaurar.",
      );
    }

    const { data: destino, error: erroDestino } = await db
      .from("backup_instances")
      .select()
      .eq("id", data.destino_instance_id)
      .single();
    if (erroDestino || !destino) throw new Error("Instância de destino não encontrada.");
    if (!destino.ativo) throw new Error("A instância de destino está desativada.");
    if (!destino.credencial_ok) {
      throw new Error("Cadastre a credencial da instância de destino antes de restaurar.");
    }
    if (destino.id === arquivo.instance_id) {
      throw new Error("O destino precisa ser uma instância DIFERENTE da origem do backup.");
    }

    const schemasAlvo = Array.from(new Set(data.schemas_alvo.map((s) => s.trim()).filter(Boolean)));
    if (data.modo === "aplicacao") {
      // Pode vir vazio: o precheck lista os schemas existentes no dump para
      // seleção posterior (restoreAtualizarSchemas). Gerenciados jamais.
      const proibidos = schemasAlvo.filter((s) => SCHEMAS_GERENCIADOS.includes(s.toLowerCase()));
      if (proibidos.length > 0) {
        throw new Error(
          `Schemas gerenciados do Supabase são intocáveis na restauração: ${proibidos.join(", ")}.`,
        );
      }
    }

    // Um restore ativo por vez por instância de destino
    const { data: ativos } = await db
      .from("restore_jobs")
      .select("id")
      .eq("destino_instance_id", data.destino_instance_id)
      .in("status", [
        "pendente_precheck",
        "aguardando_confirmacao",
        "pendente",
        "executando",
        "validando",
      ])
      .limit(1);
    if (ativos && ativos.length > 0) {
      throw new Error(
        "RESTORE_EM_ANDAMENTO: já existe uma restauração ativa para esta instância de destino.",
      );
    }

    const { data: job, error: erroJob } = await db
      .from("restore_jobs")
      .insert({
        backup_file_id: data.backup_file_id,
        origem_instance_id: arquivo.instance_id as string,
        destino_instance_id: data.destino_instance_id,
        modo: data.modo,
        schemas_alvo: data.modo === "aplicacao" ? schemasAlvo : [],
        status: "pendente_precheck",
      })
      .select("id")
      .single();
    if (erroJob || !job)
      throw new Error(sanitizarMensagem(erroJob?.message ?? "Falha ao criar precheck"));

    await auditoria("restore.criar_precheck", destino.id, {
      restore_job_id: job.id,
      arquivo_id: arquivo.id,
      modo: data.modo,
    });
    return { ok: true as const, job_id: job.id as string };
  });

export const restoreListarOperacoes = createServerFn({ method: "GET" }).handler(
  async (): Promise<RestoreOperacaoResumo[]> => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data, error } = await db
      .from("restore_jobs")
      .select("*")
      .order("criado_em", { ascending: false })
      .limit(50);
    if (error) throw new Error(sanitizarMensagem(error.message));

    // Nomeia origem/destino/arquivo fora dos joins (evita nomes de FK fixos)
    const [inst, arqs] = await Promise.all([
      db.from("backup_instances").select("id, nome"),
      db.from("backup_files").select("id, nome_arquivo"),
    ]);
    const mapaInst = new Map((inst.data ?? []).map((i) => [i.id, i.nome]));
    const mapaArq = new Map((arqs.data ?? []).map((a) => [a.id, a.nome_arquivo]));

    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      return {
        ...(r as unknown as RestoreOperacaoResumo),
        origem_nome: mapaInst.get(r.origem_instance_id as string) ?? "—",
        destino_nome: mapaInst.get(r.destino_instance_id as string) ?? "—",
        arquivo_nome: mapaArq.get(r.backup_file_id as string) ?? "—",
      };
    });
  },
);

export const restoreObterPrecheck = createServerFn({ method: "GET" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }): Promise<RestoreOperacaoResumo> => {
    await exigirAdminSessao();
    const { data: job, error } = await getAdminDb()
      .from("restore_jobs")
      .select("*")
      .eq("id", data.id)
      .single();
    if (error || !job) throw new Error("Operação de restauração não encontrada.");
    const r = job as unknown as Record<string, unknown>;
    return r as unknown as RestoreOperacaoResumo;
  });

/** Seleção/alteração dos schemas do Modo A — só enquanto aguarda confirmação. */
export const restoreAtualizarSchemas = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id: z.string().uuid(),
      schemas_alvo: z.array(z.string().min(1).max(63)).max(20),
    }),
  )
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: job } = await db
      .from("restore_jobs")
      .select("status, modo")
      .eq("id", data.id)
      .single();
    if (!job) throw new Error("Operação de restauração não encontrada.");
    const r = job as unknown as { status: string; modo: string };
    if (r.status !== "aguardando_confirmacao") {
      throw new Error("Os schemas só podem ser definidos enquanto aguarda confirmação.");
    }
    if (r.modo !== "aplicacao") {
      throw new Error("Só o Modo A (aplicação) permite escolher schemas.");
    }
    const schemasAlvo = Array.from(new Set(data.schemas_alvo.map((s) => s.trim()).filter(Boolean)));
    const proibidos = schemasAlvo.filter((s) => SCHEMAS_GERENCIADOS.includes(s.toLowerCase()));
    if (proibidos.length > 0) {
      throw new Error(
        `Schemas gerenciados jamais podem ser restaurados por cima: ${proibidos.join(", ")}.`,
      );
    }
    const { error: erroUpd } = await db
      .from("restore_jobs")
      .update({ schemas_alvo: schemasAlvo })
      .eq("id", data.id);
    if (erroUpd) throw new Error(sanitizarMensagem(erroUpd.message));
    await auditoria("restore.anexa_schemas", null, {
      restore_job_id: data.id,
      schemas: schemasAlvo,
    });
    return { ok: true as const };
  });

export const restoreConfirmar = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid(), confirmacao_texto: z.string().min(1).max(120) }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: job, error } = await db.from("restore_jobs").select().eq("id", data.id).single();
    if (error || !job) throw new Error("Operação de restauração não encontrada.");
    const r = job as unknown as Record<string, unknown>;
    if (r.status !== "aguardando_confirmacao") {
      throw new Error("Esta restauração não está aguardando confirmação.");
    }

    // Confirmação destrutiva: digitar o NOME da instância de destino
    if (r.modo === "aplicacao" && ((r.schemas_alvo as string[] | null)?.length ?? 0) === 0) {
      throw new Error("Modo A: selecione os schemas a restaurar antes de confirmar.");
    }
    const { data: destino } = await db
      .from("backup_instances")
      .select("nome")
      .eq("id", r.destino_instance_id as string)
      .single();
    const nomeDestino = (destino?.nome ?? "").trim();
    const digitado = data.confirmacao_texto.trim();
    if (!nomeDestino || digitado !== nomeDestino) {
      throw new Error(
        `CONFIRMACAO_INVALIDA: digite exatamente o nome da instância de destino ("${nomeDestino}") para liberar a restauração.`,
      );
    }

    const { error: erroUpd } = await db
      .from("restore_jobs")
      .update({
        status: "pendente",
        confirmado_em: new Date().toISOString(),
        confirmacao_texto: digitado,
      })
      .eq("id", data.id);
    if (erroUpd) throw new Error(sanitizarMensagem(erroUpd.message));

    await auditoria("restore.confirmado", r.destino_instance_id as string, {
      restore_job_id: data.id,
      modo: r.modo,
    });
    return { ok: true as const };
  });

export const restoreCancelar = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    await exigirAdminSessao();
    const db = getAdminDb();
    const { data: job, error } = await db
      .from("restore_jobs")
      .select("status")
      .eq("id", data.id)
      .single();
    if (error || !job) throw new Error("Operação de restauração não encontrada.");
    const status = (job as unknown as { status: string }).status;
    if (!["pendente_precheck", "aguardando_confirmacao", "pendente"].includes(status)) {
      throw new Error("Só é possível cancelar restaurações ainda não iniciadas.");
    }
    const { error: erroUpd } = await db
      .from("restore_jobs")
      .update({ status: "cancelado", finalizado_em: new Date().toISOString() })
      .eq("id", data.id);
    if (erroUpd) throw new Error(sanitizarMensagem(erroUpd.message));
    await auditoria("restore.cancelado", null, { restore_job_id: data.id });
    return { ok: true as const };
  });
