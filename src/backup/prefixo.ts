/**
 * Sanitiza o prefixo de destino do backup (pasta no bucket):
 * minúsculas, sem acentos, espaços → "_" e descarta outros símbolos.
 *
 * Usado tanto no servidor (schema Zod) quanto no formulário, para que
 * qualquer origem de dados seja aceita e normalizada da mesma forma.
 */
export function sanitizarPrefixoDestino(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._/-]+/g, "")
    .replace(/^\/+|\/+$/g, "")
    .slice(0, 120);
}
