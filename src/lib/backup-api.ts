// [CLIENT] Ponte do frontend para as Server Functions do módulo de backup.
// Nenhum segredo transita por aqui além da senha de login (que o servidor
// valida). Erros das Server Functions chegam como mensagem de texto.

import {
  backupAtivarAgendamento,
  backupAtivarInstancia,
  backupCriarAgendamento,
  backupCriarBackup,
  backupCriarInstancia,
  backupCriarUrlDownload,
  backupEditarInstancia,
  backupExcluirArquivo,
  backupExcluirInstancia,
  backupListarAgendamentos,
  backupListarArquivos,
  backupListarInstancias,
  backupListarOperacoes,
  backupTestarConexao,
  backupVerificarArquivo,
  restoreAtualizarSchemas,
  restoreCancelar,
  restoreConfirmar,
  restoreCriarPrecheck,
  restoreListarOperacoes,
  restoreObterPrecheck,
  type AgendamentoResumo,
  type InstanciaResumo,
} from "@/backup/api.server";
import { backupLogin, backupLogout, backupSessaoAtual } from "@/backup/api.server";
import type { ResultadoTesteConexao } from "@/backup/api.server";

export type {
  AgendamentoResumo,
  BackupArquivoResumo,
  BackupJobResumo,
  InstanciaResumo,
  RestoreOperacaoResumo,
  RestorePrecheck,
  ResultadoTesteConexao,
} from "@/backup/api.server";
export type { ResultadoTesteConexao as ResultadoConexao } from "@/backup/api.server";

/** Normaliza o erro de uma Server Function para exibição. */
export function erroMensagem(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Erro inesperado. Tente novamente.";
}

export const sessaoBackup = {
  atual: () => backupSessaoAtual(),
  login: (senha: string) => backupLogin({ data: { senha } }),
  logout: () => backupLogout(),
};

export const instanciasApi = {
  listar: () => backupListarInstancias(),
  criar: (dados: Partial<InstanciaResumo> & { credencial?: string }) =>
    backupCriarInstancia({
      data: {
        nome: dados.nome!,
        cliente_id: dados.cliente_id ?? null,
        project_ref: dados.project_ref!,
        supabase_url: dados.supabase_url ?? null,
        db_host: dados.db_host!,
        db_port: dados.db_port ?? 5432,
        db_user: dados.db_user || "postgres",
        db_name: dados.db_name || "postgres",
        ambiente: dados.ambiente ?? "producao",
        credencial: dados.credencial || null,
        storage_prefix: dados.storage_prefix ?? "",
      },
    }),
  editar: (dados: Partial<InstanciaResumo> & { id: string; credencial?: string }) =>
    backupEditarInstancia({
      data: {
        id: dados.id,
        nome: dados.nome!,
        cliente_id: dados.cliente_id ?? null,
        project_ref: dados.project_ref!,
        supabase_url: dados.supabase_url ?? null,
        db_host: dados.db_host!,
        db_port: dados.db_port ?? 5432,
        db_user: dados.db_user || "postgres",
        db_name: dados.db_name || "postgres",
        ambiente: dados.ambiente ?? "producao",
        credencial: dados.credencial || null,
        storage_prefix: dados.storage_prefix ?? "",
      },
    }),
  excluir: (id: string) => backupExcluirInstancia({ data: { id } }),
  ativar: (id: string, ativo: boolean) => backupAtivarInstancia({ data: { id, ativo } }),
  testar: (id: string) => backupTestarConexao({ data: { id } }),
};

export const agendamentosApi = {
  listar: () => backupListarAgendamentos(),
  criar: (dados: {
    instance_id: string;
    frequencia: AgendamentoResumo["frequencia"];
    dia_semana: number | null;
    dia_mes: number | null;
    hora: string;
    fuso: string;
    retencao_dias: number;
  }) =>
    backupCriarAgendamento({
      data: {
        instance_id: dados.instance_id,
        frequencia: dados.frequencia,
        dia_semana: dados.dia_semana ?? null,
        dia_mes: dados.dia_mes ?? null,
        hora: dados.hora,
        fuso: dados.fuso || "America/Sao_Paulo",
        retencao_dias: dados.retencao_dias || 30,
      },
    }),
  ativar: (id: string, ativo: boolean) => backupAtivarAgendamento({ data: { id, ativo } }),
};

// ---------------------------------------------------------------------------
// Backups (FASE 4/5): fila, operações, arquivos, download, integridade, exclusão
// ---------------------------------------------------------------------------
export const backupsApi = {
  /** Enfileira "Executar Backup Agora" na instância (worker cuida da execução). */
  iniciar: (instance_id: string) => backupCriarBackup({ data: { instance_id } }),
  listarOperacoes: () => backupListarOperacoes(),
  listarArquivos: () => backupListarArquivos(),
  urlDownload: (id: string) => backupCriarUrlDownload({ data: { id } }),
  verificar: (id: string) => backupVerificarArquivo({ data: { id } }),
  excluir: (id: string) => backupExcluirArquivo({ data: { id } }),
};

// ---------------------------------------------------------------------------
// Restauração (FASE 7): precheck → relatório → confirmação digitada → execução
// ---------------------------------------------------------------------------
export const restoreApi = {
  precheck: (payload: {
    backup_file_id: string;
    destino_instance_id: string;
    modo: "aplicacao" | "migracao";
    schemas_alvo: string[];
  }) => restoreCriarPrecheck({ data: payload }),
  listar: () => restoreListarOperacoes(),
  obter: (id: string) => restoreObterPrecheck({ data: { id } }),
  atualizarSchemas: (id: string, schemas_alvo: string[]) =>
    restoreAtualizarSchemas({ data: { id, schemas_alvo } }),
  confirmar: (id: string, confirmacao_texto: string) =>
    restoreConfirmar({ data: { id, confirmacao_texto } }),
  cancelar: (id: string) => restoreCancelar({ data: { id } }),
};
