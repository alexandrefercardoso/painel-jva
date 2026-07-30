import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const CONFIG_KEY = "jva.supabase.config";
const SESSION_KEY = "jva.session";

export type PainelConfig = { url: string; anonKey: string };

export function getConfig(): PainelConfig | null {
  if (typeof window === "undefined") return null;
  const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const envKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;
  if (envUrl && envKey) return { url: envUrl, anonKey: envKey };
  const raw = window.localStorage.getItem(CONFIG_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PainelConfig;
    return parsed.url && parsed.anonKey ? parsed : null;
  } catch {
    return null;
  }
}

export function setConfig(config: PainelConfig) {
  window.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  client = null;
}

export function clearConfig() {
  window.localStorage.removeItem(CONFIG_KEY);
  client = null;
}

let client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  const config = getConfig();
  if (!config) throw new Error("Conexão com o Supabase não configurada.");
  if (!client) {
    client = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export type Sessao = { id: string; login: string };

export function getSession(): Sessao | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Sessao;
  } catch {
    return null;
  }
}

export function setSession(session: Sessao) {
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession() {
  window.localStorage.removeItem(SESSION_KEY);
}

const LOGIN_COLUNAS = ["email", "usuario", "username", "login"];
const SENHA_COLUNAS = ["senha", "password"];

/** Login simples direto na tabela profiles (uso pessoal, sem Supabase Auth). */
export async function login(usuario: string, senha: string): Promise<Sessao> {
  const supabase = getClient();
  const { data, error } = await supabase.from("profiles").select("*");
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const alvo = rows.find((row) => {
    const loginOk = LOGIN_COLUNAS.some(
      (col) => typeof row[col] === "string" && (row[col] as string).toLowerCase() === usuario.toLowerCase(),
    );
    const senhaOk = SENHA_COLUNAS.some((col) => typeof row[col] === "string" && row[col] === senha);
    return loginOk && senhaOk;
  });

  if (!alvo) throw new Error("Usuário ou senha inválidos.");
  const sessao: Sessao = {
    id: String(alvo.id ?? usuario),
    login: usuario,
  };
  setSession(sessao);
  return sessao;
}

export type Cliente = {
  id: string;
  nome_fantasia: string | null;
  supabase_url: string | null;
  supabase_anon_key: string | null;
  valor_mensal: number | null;
  dia_vencimento: number | null;
  status_pagamento: string | null;
  observacoes: string | null;
  ativo: boolean | null;
};

export type Dominio = {
  id: string;
  cliente_id: string;
  dominio: string | null;
};
