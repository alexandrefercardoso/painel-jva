import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const CONFIG_KEY = "jva.supabase.config";

// [LOVABLE: LOCKED ARCHITECTURE - DO NOT EDIT OR REMOVE]
// Projeto Supabase fixo do painel (usado quando não há variáveis de ambiente).
const DEFAULT_URL = "https://hepvdpktubhcklerdvqb.supabase.co";
const DEFAULT_ANON_KEY = "sb_publishable_bhj08eHfAOnjwHWuLDZWjw_ZmBaCbFy";

export type PainelConfig = { url: string; anonKey: string };

export function getConfig(): PainelConfig | null {
  const envUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || DEFAULT_URL;
  const envKey =
    ((import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined) || DEFAULT_ANON_KEY;
  if (envUrl && envKey) return { url: envUrl, anonKey: envKey };
  if (typeof window === "undefined") return null;

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

export function isConfigured(): boolean {
  return getConfig() !== null;
}

export const MSG_SEM_CONFIG =
  "Supabase não configurado: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY nas variáveis de ambiente da Vercel e faça um novo deploy.";

let client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  const config = getConfig() ?? {
    url: "https://placeholder.supabase.co",
    anonKey: "placeholder-anon-key",
  };
  if (!client) {
    client = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}


export type ModoTipo = "compartilhado" | "individual";

export type Produto = {
  id: string;
  slug: string;
  nome: string;
  ativo: boolean | null;
  ordem: number | null;
};

// Produtos padrão usados quando a tabela 'produtos' não existe ou está vazia.
export const PRODUTOS_PADRAO: Produto[] = [
  { id: "meupedix", slug: "meupedix", nome: "MeuPedix", ativo: true, ordem: 1 },
  { id: "silun", slug: "silun", nome: "Silun", ativo: true, ordem: 2 },
];

export async function carregarProdutos(): Promise<Produto[]> {
  try {
    const { data, error } = await getClient()
      .from("produtos")
      .select("*")
      .order("ordem", { ascending: true });
    if (!error && data && data.length > 0) return data as Produto[];
  } catch {
    // tabela ainda não criada — usa os produtos padrão
  }
  return PRODUTOS_PADRAO;
}

export type Cliente = {
  id: string;
  nome_fantasia: string | null;
  contato: string | null;
  telefone: string | null;
  email_contato: string | null;
  valor_mensal: number | null;
  dia_vencimento: number | null;
  status_pagamento: string | null;
  observacoes: string | null;
  ativo: boolean | null;
  produto: string | null;
  empresa_id: string | null;
  email_login_supabase: string | null;
  supabase_url: string | null;
  supabase_anon_key: string | null;
  modulos_contratados: string[] | null;
  modo: ModoTipo | null;
};

export type Modulo = {
  id: string;
  slug: string;
  nome: string;
  descricao: string | null;
  cor_icone: string | null;
  arquivo_svg: string | null;
};

export const OPCOES_MODO: ModoTipo[] = ["compartilhado", "individual"];

export type Dominio = {
  id: string;
  cliente_id: string;
  dominio: string | null;
  modulo: string | null;
  is_primary: boolean | null;
  created_at?: string;
};
