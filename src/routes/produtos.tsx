import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PainelLayout } from "@/components/PainelLayout";
import { getClient, isConfigured, MSG_SEM_CONFIG, type Produto } from "@/lib/painel-db";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/produtos")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Produtos — JVA Sistemas" },
      { name: "description", content: "Gerenciar o catálogo de produtos disponíveis no cadastro de clientes." },
      { property: "og:title", content: "Produtos — JVA Sistemas" },
      { property: "og:description", content: "Gerenciar o catálogo de produtos disponíveis no cadastro de clientes." },
      { property: "og:type", content: "website" },
    ],
  }),
  component: () => (
    <PainelLayout>
      <AdminProdutos />
    </PainelLayout>
  ),
});

const vazio = { slug: "", nome: "" };

function AdminProdutos() {
  const [produtos, setProdutos] = useState<Produto[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [tabelaAusente, setTabelaAusente] = useState(false);
  const [carregando, setCarregando] = useState(true);

  const [modalAberto, setModalAberto] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [form, setForm] = useState(vazio);
  const [salvando, setSalvando] = useState(false);

  const carregar = async () => {
    const { data, error } = await getClient()
      .from("produtos")
      .select("*")
      .order("ordem", { ascending: true });
    if (error) {
      // PGRST205 = tabela não existe no cache de esquema do PostgREST
      if (
        (error as { code?: string }).code === "PGRST205" ||
        (error.message.includes("produtos") && error.message.includes("schema cache"))
      ) {
        setTabelaAusente(true);
      } else {
        setErro(error.message);
      }
    } else {
      setProdutos((data ?? []) as Produto[]);
    }
    setCarregando(false);
  };

  useEffect(() => {
    if (!isConfigured()) {
      setErro(MSG_SEM_CONFIG);
      setCarregando(false);
      return;
    }
    carregar();
  }, []);

  const abrirNovo = () => {
    setEditandoId(null);
    setForm(vazio);
    setModalAberto(true);
  };

  const abrirEdicao = (p: Produto) => {
    setEditandoId(p.id);
    setForm({ slug: p.slug, nome: p.nome });
    setModalAberto(true);
  };

  const salvar = async () => {
    const slug = form.slug.trim().toLowerCase();
    const nome = form.nome.trim();
    if (!slug || !nome) {
      setErro("Informe o slug e o nome do produto.");
      return;
    }
    setSalvando(true);
    setErro(null);

    const payload = { slug, nome };
    const { error } = editandoId
      ? await getClient().from("produtos").update(payload).eq("id", editandoId)
      : await getClient().from("produtos").insert({ ...payload, ativo: true, ordem: produtos.length + 1 });

    if (error) {
      setErro(error.message);
    } else {
      setModalAberto(false);
      toast.success(editandoId ? "Produto atualizado." : "Produto criado.");
      await carregar();
    }
    setSalvando(false);
  };

  const remover = async (p: Produto) => {
    if (!confirm(`Remover o produto "${p.nome}" do catálogo? O produto já atribuído nos clientes permanece salvo.`)) return;
    const { error } = await getClient().from("produtos").delete().eq("id", p.id);
    if (error) setErro(error.message);
    else await carregar();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/" className="text-sm text-muted-foreground hover:underline">← Voltar</Link>
          <h1 className="text-xl font-semibold text-foreground">Produtos</h1>
        </div>
        <Button onClick={abrirNovo}>Novo produto</Button>
      </div>

      <p className="text-sm text-muted-foreground">
        O slug é o valor salvo no campo produto de cada cliente (em minúsculas, sem espaços).
      </p>

      {erro && <p className="text-sm text-destructive">{erro}</p>}
      {tabelaAusente && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium text-foreground">Tabela 'produtos' não encontrada</p>
          <p className="mt-1 text-muted-foreground">
            O SQL de criação ainda não foi executado neste projeto Supabase. Abra o <strong>SQL Editor</strong> no Dashboard e execute:
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs">{`CREATE TABLE IF NOT EXISTS public.produtos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,
  ordem INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO public.produtos (slug, nome, ordem) VALUES
  ('meupedix', 'MeuPedix', 1),
  ('silun', 'Silun', 2)
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE public.produtos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "produtos_liberado" ON public.produtos
  FOR ALL TO anon USING (true) WITH CHECK (true);`}</pre>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={async () => {
              setCarregando(true);
              setTabelaAusente(false);
              await carregar();
            }}
          >
            Recarregar
          </Button>
        </div>
      )}
      {carregando && <p className="text-sm text-muted-foreground">Carregando...</p>}

      <div className="overflow-hidden rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Nome</th>
              <th className="px-4 py-2 font-medium">Slug</th>
              <th className="px-4 py-2 font-medium text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {produtos.map((p) => (
              <tr key={p.id} className="border-b last:border-0 hover:bg-muted/40">
                <td className="px-4 py-2 font-medium">{p.nome}</td>
                <td className="px-4 py-2">
                  <Badge variant="outline" className="font-mono">{p.slug}</Badge>
                </td>
                <td className="px-4 py-2 text-right">
                  <Button variant="ghost" size="sm" onClick={() => abrirEdicao(p)}>Editar</Button>
                  <Button variant="ghost" size="sm" onClick={() => remover(p)}>Remover</Button>
                </td>
              </tr>
            ))}
            {!carregando && produtos.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                  Nenhum produto no catálogo.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={modalAberto} onOpenChange={setModalAberto}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editandoId ? "Editar produto" : "Novo produto"}</DialogTitle>
            <DialogDescription>
              O produto aparecerá no combo de cadastro de clientes.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-sm font-medium">Nome</label>
              <Input
                placeholder="Ex: MeuPedix"
                value={form.nome}
                onChange={(e) => setForm((f) => ({ ...f, nome: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Slug</label>
              <Input
                placeholder="ex: meupedix"
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                Salvo no banco em minúsculas. Produtos já existentes usam "meupedix" e "silun".
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setModalAberto(false)}>
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={salvando}>
              {salvando ? "Salvando..." : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
