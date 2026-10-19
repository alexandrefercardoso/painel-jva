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

// Normaliza o domínio igual à RPC get_config_por_dominio:
// remove protocolo, caminho, porta, "www." e espaços — funciona em minúsculas.
export function normalizaDominio(valor: string | null): string {
  let v = (valor ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (!v) return "";
  v = v.split("?")[0];
  v = v.replace(/^[a-z0-9]+:\/\//, "");
  v = v.split("/")[0];
  v = v.replace(/:\d+$/, "");
  v = v.replace(/^www\./, "");
  return v;
}

export type DonoDominio = { cliente_id: string; nome: string | null };

// Identifica se um domínio já pertence a OUTRO cliente (regra: 1 domínio = 1 cliente).
export async function donoDoDominio(
  valor: string,
  clienteId?: string | null,
): Promise<DonoDominio | null> {
  const norm = normalizaDominio(valor);
  if (!norm) return null;
  let query = getClient().from("dominios").select("cliente_id, dominio");
  if (clienteId) query = query.neq("cliente_id", clienteId);
  const { data, error } = await query;
  if (error || !data) return null;
  const conflito = data.find((d) => normalizaDominio(d.dominio ?? "") === norm);
  if (!conflito) return null;
  const { data: donoData } = await getClient()
    .from("clientes")
    .select("nome_fantasia")
    .eq("id", conflito.cliente_id)
    .maybeSingle();
  return {
    cliente_id: conflito.cliente_id,
    nome: (donoData as { nome_fantasia: string | null } | null)?.nome_fantasia ?? conflito.cliente_id,
  };
}
