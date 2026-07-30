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
