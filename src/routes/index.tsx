import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PainelLayout } from "@/components/PainelLayout";
import { getClient, carregarProdutos, isConfigured, MSG_SEM_CONFIG, type Cliente, type Produto } from "@/lib/painel-db";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "JVA Sistemas — Painel de Clientes" },
      { name: "description", content: "Painel interno para gerir clientes, mensalidades e domínios da JVA Sistemas." },
      { property: "og:title", content: "JVA Sistemas — Painel de Clientes" },
      { property: "og:description", content: "Painel interno para gerir clientes, mensalidades e domínios da JVA Sistemas." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: () => (
    <PainelLayout>
      <ListaClientes />
    </PainelLayout>
  ),
});

export function StatusPagamentoBadge({ valor }: { valor: string | null }) {
  const variant = valor === "em_dia" ? "default" : valor === "atrasado" ? "destructive" : "secondary";
  const rotulo = valor === "em_dia" ? "Em dia" : valor === "atrasado" ? "Atrasado" : valor === "cancelado" ? "Cancelado" : "—";
  return <Badge variant={variant}>{rotulo}</Badge>;
}

export function ProdutoBadge({ valor, produtos }: { valor: string | null; produtos: Produto[] }) {
  const valorLower = valor?.toLowerCase() ?? "";
  const produto = produtos.find((p) => p.slug.toLowerCase() === valorLower);
  const rotulo = produto?.nome ?? (valor ? valor.charAt(0).toUpperCase() + valor.slice(1) : "—");
  if (valorLower === "silun") {
    return <Badge variant="outline" className="border-purple-500/40 bg-purple-500/10 text-purple-700 dark:text-purple-400">{rotulo}</Badge>;
  }
  return <Badge variant="outline" className="border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-400">{rotulo}</Badge>;
}

function ListaClientes() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [clonandoId, setClonandoId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const carregarClientes = async () => {
    const { data, error } = await getClient()
      .from("clientes")
      .select("*")
      .order("nome_fantasia", { ascending: true });
    if (error) setErro(error.message);
    else setClientes((data ?? []) as Cliente[]);
    setCarregando(false);
  };

  useEffect(() => {
    if (!isConfigured()) {
      setErro(MSG_SEM_CONFIG);
      setCarregando(false);
      return;
    }
    carregarClientes();
    carregarProdutos().then(setProdutos);
  }, []);

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return clientes;
    return clientes.filter((c) => (c.nome_fantasia ?? "").toLowerCase().includes(termo));
  }, [clientes, busca]);

  const clonarCliente = async (cliente: Cliente) => {
    const nomeBase = cliente.nome_fantasia || "(sem nome)";
    const confirmacao = confirm(
      `Clonar o registro do cliente "${nomeBase}"?\n\nOs domínios NÃO são copiados: cada domínio pertence a um único cliente e deve ser cadastrado manualmente no novo cliente.`,
    );
    if (!confirmacao) return;

    setClonandoId(cliente.id);
    setErro(null);
    setMsg(null);

    try {
      // Gera um nome único (cópia, cópia 2, cópia 3...)
      const nomesExistentes = new Set(
        clientes.map((c) => (c.nome_fantasia ?? "").toLowerCase()),
      );
      let novoNome = `${nomeBase} (cópia)`;
      let contador = 2;
      while (nomesExistentes.has(novoNome.toLowerCase())) {
        novoNome = `${nomeBase} (cópia ${contador})`;
        contador++;
      }

      const sb = getClient();

      // Cria o novo cliente com os mesmos dados (sem id)
      const payloadCore = {
        produto: cliente.produto,
        nome_fantasia: novoNome,
        contato: cliente.contato,
        telefone: cliente.telefone,
        email_contato: cliente.email_contato,
        valor_mensal: cliente.valor_mensal,
        dia_vencimento: cliente.dia_vencimento,
        status_pagamento: cliente.status_pagamento,
        observacoes: cliente.observacoes,
        ativo: cliente.ativo,
        empresa_id: cliente.empresa_id,
        email_login_supabase: cliente.email_login_supabase,
        supabase_url: cliente.supabase_url,
        supabase_anon_key: cliente.supabase_anon_key,
        modulos_contratados: cliente.modulos_contratados,
        modo: cliente.modo,
      };

      const { data: novoCliente, error: erroCliente } = await sb
        .from("clientes")
        .insert(payloadCore)
        .select()
        .maybeSingle();

      if (erroCliente || !novoCliente) {
        setErro(erroCliente?.message || "Erro ao clonar cliente.");
        return;
      }

      setMsg(`Cliente "${novoNome}" criado. Cadastre manualmente os domínios dele (1 domínio = 1 cliente).`);
      await carregarClientes();
    } finally {
      setClonandoId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Clientes</h1>
        <Button asChild>
          <Link to="/clientes/$id" params={{ id: "novo" }}>
            Novo cliente
          </Link>
        </Button>
      </div>

      {msg && <p className="text-sm text-muted-foreground">{msg}</p>}

      <Input placeholder="Buscar por nome fantasia..." value={busca} onChange={(e) => setBusca(e.target.value)} className="max-w-sm bg-background" />

      {erro && <p className="text-sm text-destructive">{erro}</p>}
      {carregando && <p className="text-sm text-muted-foreground">Carregando...</p>}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Nome fantasia</th>
              <th className="px-4 py-2 font-medium">Produto</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Pagamento</th>
              <th className="px-4 py-2 font-medium">Valor mensal</th>
              <th className="px-4 py-2 font-medium">Vencimento</th>
              <th className="px-4 py-2 font-medium text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {filtrados.map((cliente) => (
              <tr key={cliente.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-4 py-2">
                  <Link to="/clientes/$id" params={{ id: String(cliente.id) }} className="font-medium text-foreground hover:underline">
                    {cliente.nome_fantasia ?? "(sem nome)"}
                  </Link>
                </td>
                <td className="px-4 py-2">
                  <ProdutoBadge valor={cliente.produto} produtos={produtos} />
                </td>
                <td className="px-4 py-2">
                  <Badge variant={cliente.ativo ? "default" : "secondary"}>{cliente.ativo ? "Ativo" : "Inativo"}</Badge>
                </td>
                <td className="px-4 py-2">
                  <StatusPagamentoBadge valor={cliente.status_pagamento} />
                </td>
                <td className="px-4 py-2">
                  {cliente.valor_mensal !== null && cliente.valor_mensal !== undefined
                    ? `R$ ${cliente.valor_mensal.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "—"}
                </td>
                <td className="px-4 py-2">{cliente.dia_vencimento ?? "—"}</td>
                <td className="px-4 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={clonandoId === cliente.id}
                    onClick={() => clonarCliente(cliente)}
                  >
                    {clonandoId === cliente.id ? "Clonando..." : "Clonar"}
                  </Button>
                </td>
              </tr>
            ))}
            {!carregando && filtrados.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-muted-foreground">
                  Nenhum cliente encontrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

