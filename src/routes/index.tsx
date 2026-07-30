import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { PainelLayout } from "@/components/PainelLayout";
import { getClient, isConfigured, MSG_SEM_CONFIG, type Cliente } from "@/lib/painel-db";
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

function ListaClientes() {
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [busca, setBusca] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    if (!isConfigured()) {
      setErro(MSG_SEM_CONFIG);
      setCarregando(false);
      return;
    }
    getClient()
      .from("clientes")
      .select("*")
      .order("nome_fantasia", { ascending: true })
      .then(({ data, error }) => {
        if (error) setErro(error.message);
        else setClientes((data ?? []) as Cliente[]);
        setCarregando(false);
      });
  }, []);

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    if (!termo) return clientes;
    return clientes.filter((c) => (c.nome_fantasia ?? "").toLowerCase().includes(termo));
  }, [clientes, busca]);

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

      <Input placeholder="Buscar por nome fantasia..." value={busca} onChange={(e) => setBusca(e.target.value)} className="max-w-sm bg-background" />

      {erro && <p className="text-sm text-destructive">{erro}</p>}
      {carregando && <p className="text-sm text-muted-foreground">Carregando...</p>}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Nome fantasia</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Pagamento</th>
              <th className="px-4 py-2 font-medium">Valor mensal</th>
              <th className="px-4 py-2 font-medium">Vencimento</th>
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
              </tr>
            ))}
            {!carregando && filtrados.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
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
