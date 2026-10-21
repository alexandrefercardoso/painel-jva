// [CLIENT] Ponte do frontend para as Server Functions do módulo "SQL Multi-Banco".
// Nenhum segredo transita por aqui além da senha de login (validada no servidor).

import {
  sqlListarAlvos,
  sqlLogin,
  sqlLogout,
  sqlRodar,
  sqlSessaoAtual,
  sqlTestarAlvo,
  type SqlAlvoResumo,
  type SqlLinhaPreview,
  type SqlResultadoExecucao,
  type SqlResultadoAlvo,
  type ResultadoTesteSql,
} from "@/sql/api.server";

export type {
  SqlAlvoResumo,
  SqlLinhaPreview,
  SqlResultadoExecucao,
  SqlResultadoAlvo,
  SqlResultadoComando,
  SqlPreview,
  ResultadoTesteSql,
} from "@/sql/api.server";

/** Normaliza o erro de uma Server Function para exibição. */
export function erroMensagemSql(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Erro inesperado. Tente novamente.";
}

export const sessaoSql = {
  atual: () => sqlSessaoAtual(),
  login: (senha: string) => sqlLogin({ data: { senha } }),
  logout: () => sqlLogout(),
};

export const alvosApi = {
  listar: () => sqlListarAlvos(),
  testar: (id: string) => sqlTestarAlvo({ data: { id } }),
};

export const executorApi = {
  /** Executa o script em modo teste: BEGIN → script → ROLLBACK (nada persiste). */
  teste: async (payload: {
    sql: string;
    alvos: string[];
    transacao: boolean;
    timeout_seg: number;
  }): Promise<SqlResultadoExecucao> =>
    sqlRodar({ data: { ...payload, modo: "teste", confirmacao: null } }),
  /** Executa em definitivo: exige confirmação digitada "EXECUTAR". */
  executar: async (payload: {
    sql: string;
    alvos: string[];
    confirmacao: string;
    transacao: boolean;
    timeout_seg: number;
  }): Promise<SqlResultadoExecucao> => sqlRodar({ data: { ...payload, modo: "executar" } }),
};

// Alias em pt-BR usado pela rota
export type AlvoSql = SqlAlvoResumo;
export type ResultadoAlvoSql = SqlResultadoAlvo;
